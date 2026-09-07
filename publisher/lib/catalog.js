'use strict';

const crypto = require('crypto');

const ALLOWED_FORMS = new Set(['10-Q', '10-K']);
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

function normalizeCik(value) {
  return String(value).replace(/\D/g, '').padStart(10, '0');
}

function isSupportedSic(sic) {
  const value = Number(sic);
  return Number.isFinite(value) && !(value >= 6000 && value <= 6799);
}

function currentFilings(submissions) {
  const recent = submissions.filings && submissions.filings.recent;
  if (!recent || !Array.isArray(recent.form)) {
    throw new Error('SEC submissions response is missing filings.recent.');
  }
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
  const values = [...new Set(rows.filter(item => item.accn === filing.accession &&
    item.form === filing.form && item.end === filing.reportDate).map(item => Number(item.val)))]
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

function buildArtifact(ticker, cik, submissionsResponse, factsResponse, now) {
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
  if (!filings.length) throw new Error(`${ticker} has no recent 10-Q or 10-K filing.`);
  return {
    schemaVersion: 1,
    methodologyVersion: 'aaofi-investor-v1',
    ticker,
    issuer: submissions.name,
    cik,
    sic: submissions.sic,
    classification: isSupportedSic(submissions.sic) ? 'OPERATING_COMPANY' : 'UNSUPPORTED_ISSUER',
    exchange: (submissions.exchanges || [])[0] || '',
    publishedAt: now,
    sources: {submissions: submissionsResponse.source, companyFacts: factsResponse.source},
    filings
  };
}

function artifactEntry(artifact, relativePath, text) {
  return {
    cik: artifact.cik,
    path: relativePath,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    classification: artifact.classification
  };
}

function uniqueUniverse(tickerMap) {
  const entries = Object.values(tickerMap).map(item => ({
    ticker: String(item.ticker || '').trim().toUpperCase(),
    cik: normalizeCik(item.cik_str)
  })).filter(item => /^[A-Z0-9-]+$/.test(item.ticker) && /^\d{10}$/.test(item.cik));
  const counts = new Map();
  entries.forEach(item => counts.set(item.ticker, (counts.get(item.ticker) || 0) + 1));
  return entries.filter(item => counts.get(item.ticker) === 1)
    .sort((left, right) => left.ticker.localeCompare(right.ticker));
}

function selectBatch(universe, state, size) {
  if (!universe.length) return {items: [], nextCursor: ''};
  const start = state.cursor ? universe.findIndex(item => item.ticker > state.cursor) : 0;
  const offset = start < 0 ? 0 : start;
  const items = universe.slice(offset, offset + size);
  return {items, nextCursor: offset + items.length >= universe.length ? '' : items[items.length - 1].ticker};
}

module.exports = {artifactEntry, buildArtifact, currentFilings, isSupportedSic, normalizeCik,
  selectBatch, selectShares, selectUniqueFact, uniqueUniverse};
