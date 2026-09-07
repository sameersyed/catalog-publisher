#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const zlib = require('zlib');

const SEC_BASE = 'https://data.sec.gov';
const TICKER_MAP = 'https://www.sec.gov/files/company_tickers.json';
const USER_AGENT = process.env.SEC_USER_AGENT;
const OUTPUT = path.resolve(process.argv[2] || '.');
const TICKERS = (process.argv[3] || 'CRM,ORCL').split(',').map(value => value.trim().toUpperCase());
const ALLOWED_FORMS = new Set(['10-Q', '10-K']);
const SIC_BLOCKED = sic => Number(sic) >= 6000 && Number(sic) <= 6799;
const TAGS = [
  'CashAndCashEquivalentsAtCarryingValue',
  'AvailableForSaleSecuritiesDebtSecuritiesCurrent',
  'MarketableSecuritiesCurrent',
  'AccountsReceivableNetCurrent',
  'AccountsNotesAndLoansReceivableNetCurrent',
  'InventoryNet',
  'OperatingLeaseLiabilityCurrent',
  'LongTermDebtCurrent',
  'ShortTermBorrowings',
  'AccruedSalariesCurrentAndNoncurrent',
  'EmployeeRelatedLiabilitiesCurrent',
  'TaxesPayableCurrent',
  'AccountsPayableAndOtherAccruedLiabilitiesCurrent',
  'AccountsPayableCurrent',
  'LiabilitiesCurrent',
  'ContractWithCustomerLiabilityCurrent',
  'DeferredRevenueCurrent'
];

if (!USER_AGENT) throw new Error('SEC_USER_AGENT is required.');

function request(url) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    https.get(url, {headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate'
    }}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const encoded = Buffer.concat(chunks);
        if (response.statusCode !== 200) {
          reject(new Error(`${url} returned HTTP ${response.statusCode}`));
          return;
        }
        const encoding = response.headers['content-encoding'];
        let body;
        try {
          body = encoding === 'gzip' ? zlib.gunzipSync(encoded) :
            encoding === 'deflate' ? zlib.inflateSync(encoded) : encoded;
          resolve({
            json: JSON.parse(body.toString('utf8')),
            source: {
              url,
              retrievedAt: new Date().toISOString(),
              bytes: body.length,
              sha256: crypto.createHash('sha256').update(body).digest('hex'),
              latencyMs: Date.now() - started
            }
          });
        } catch (error) {
          reject(new Error(`${url} returned invalid JSON: ${error.message}`));
        }
      });
    }).on('error', reject);
  });
}

function normalizeCik(value) {
  return String(value).replace(/\D/g, '').padStart(10, '0');
}

function currentFilings(submissions) {
  const recent = submissions.filings && submissions.filings.recent;
  if (!recent) throw new Error('SEC submissions response is missing filings.recent.');
  return recent.form.map((form, index) => ({
    form,
    filingDate: recent.filingDate[index],
    reportDate: recent.reportDate[index],
    accession: recent.accessionNumber[index],
    primaryDocument: recent.primaryDocument[index]
  })).filter(item => ALLOWED_FORMS.has(item.form) && item.filingDate && item.reportDate && item.accession)
    .sort((left, right) => right.filingDate.localeCompare(left.filingDate));
}

function selectUniqueFact(companyFacts, taxonomy, tag, unit, filing) {
  const rows = companyFacts.facts && companyFacts.facts[taxonomy] &&
    companyFacts.facts[taxonomy][tag] && companyFacts.facts[taxonomy][tag].units &&
    companyFacts.facts[taxonomy][tag].units[unit] || [];
  const candidates = rows.filter(item => item.accn === filing.accession &&
    item.form === filing.form && item.end === filing.reportDate);
  const values = [...new Set(candidates.map(item => Number(item.val)))]
    .filter(value => Number.isFinite(value) && value >= 0);
  return values.length === 1 ? values[0] : null;
}

function selectShares(companyFacts, filing) {
  const rows = companyFacts.facts && companyFacts.facts.dei &&
    companyFacts.facts.dei.EntityCommonStockSharesOutstanding &&
    companyFacts.facts.dei.EntityCommonStockSharesOutstanding.units &&
    companyFacts.facts.dei.EntityCommonStockSharesOutstanding.units.shares || [];
  const candidates = rows.filter(item => item.accn === filing.accession &&
    item.form === filing.form && item.end <= filing.filingDate)
    .sort((left, right) => right.end.localeCompare(left.end));
  const value = candidates.length ? Number(candidates[0].val) : NaN;
  return Number.isFinite(value) && value > 0 ? {value, asOfDate: candidates[0].end} : null;
}

async function main() {
  fs.mkdirSync(path.join(OUTPUT, 'catalog', 'issuers'), {recursive: true});
  const tickerResponse = await request(TICKER_MAP);
  const tickerEntries = Object.values(tickerResponse.json);
  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: tickerResponse.source,
    issuers: {}
  };
  for (const ticker of TICKERS) {
    const matches = tickerEntries.filter(item => String(item.ticker).toUpperCase() === ticker);
    if (matches.length !== 1) throw new Error(`${ticker} resolved to ${matches.length} SEC ticker entries.`);
    const cik = normalizeCik(matches[0].cik_str);
    const [submissionsResponse, factsResponse] = await Promise.all([
      request(`${SEC_BASE}/submissions/CIK${cik}.json`),
      request(`${SEC_BASE}/api/xbrl/companyfacts/CIK${cik}.json`)
    ]);
    const submissions = submissionsResponse.json;
    if (!(submissions.tickers || []).map(value => String(value).toUpperCase()).includes(ticker)) {
      throw new Error(`${ticker} is not confirmed by SEC submissions for ${cik}.`);
    }
    const filings = currentFilings(submissions).slice(0, 4).map(filing => {
      const facts = {};
      TAGS.forEach(tag => {
        facts[tag] = selectUniqueFact(factsResponse.json, 'us-gaap', tag, 'USD', filing);
      });
      return {...filing, facts, sharesOutstanding: selectShares(factsResponse.json, filing)};
    });
    const artifact = {
      schemaVersion: 1,
      methodologyVersion: 'aaofi-investor-v1',
      ticker,
      issuer: submissions.name,
      cik,
      sic: submissions.sic,
      classification: SIC_BLOCKED(submissions.sic) ? 'UNSUPPORTED_ISSUER' : 'OPERATING_COMPANY',
      exchange: (submissions.exchanges || [])[0] || '',
      publishedAt: new Date().toISOString(),
      sources: {submissions: submissionsResponse.source, companyFacts: factsResponse.source},
      filings
    };
    const relativePath = `catalog/issuers/${cik}.json`;
    const artifactText = JSON.stringify(artifact, null, 2) + '\n';
    fs.writeFileSync(path.join(OUTPUT, relativePath), artifactText);
    index.issuers[ticker] = {
      cik,
      path: relativePath,
      sha256: crypto.createHash('sha256').update(artifactText).digest('hex'),
      classification: artifact.classification
    };
  }
  const indexText = JSON.stringify(index, null, 2) + '\n';
  fs.writeFileSync(path.join(OUTPUT, 'catalog', 'index.json'), indexText);
  console.log(JSON.stringify({output: OUTPUT, tickers: TICKERS,
    indexSha256: crypto.createHash('sha256').update(indexText).digest('hex')}, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
