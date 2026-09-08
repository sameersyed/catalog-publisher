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
  'LesseeOperatingLeaseLiabilityPaymentsDueNextTwelveMonths',
  'LongTermDebtCurrent',
  'NotesPayableCurrent',
  'ShortTermBorrowings',
  'CommercialPaper',
  'AccruedSalariesCurrentAndNoncurrent',
  'EmployeeRelatedLiabilitiesCurrent',
  'TaxesPayableCurrent',
  'AccountsPayableAndOtherAccruedLiabilitiesCurrent',
  'AccountsPayableCurrent',
  'LiabilitiesCurrent',
  'OtherLiabilitiesCurrent',
  'ContractWithCustomerLiabilityCurrent',
  'DeferredRevenueCurrent'
];

const INLINE_TAGS = new Set(TAGS);
const ISSUER_MAPPINGS = {
  '0001341439': {otherLiabilitiesIncludes: ['OperatingLeaseLiabilityCurrent']}
};

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

function parseInlineNumber(value, attributes) {
  const raw = String(value).replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/gi, '')
    .replace(/,/g, '').trim();
  if (!raw || raw === '-' || raw === '—') return null;
  const number = Number(raw.replace(/^\((.*)\)$/, '-$1'));
  if (!Number.isFinite(number)) return null;
  const scale = Number((attributes.match(/\bscale=["'](-?\d+)["']/i) || [])[1] || 0);
  const sign = /\bsign=["']-["']/i.test(attributes) ? -1 : 1;
  const scaled = number * Math.pow(10, scale) * sign;
  return Number.isFinite(scaled) && scaled >= 0 ? scaled : null;
}

function extractInlineFacts(html, filing) {
  const contexts = new Set();
  const contextPattern = /<(?:xbrli:)?context\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/gi;
  let match;
  while ((match = contextPattern.exec(html))) {
    const body = match[2];
    const instant = (body.match(/<(?:xbrli:)?instant>(\d{4}-\d{2}-\d{2})<\/(?:xbrli:)?instant>/i) || [])[1];
    if (instant === filing.reportDate && !/<(?:xbrli:)?(?:segment|scenario)\b/i.test(body)) contexts.add(match[1]);
  }
  const found = {};
  const factPattern = /<ix:nonfraction\b([^>]*)>([\s\S]*?)<\/ix:nonfraction>/gi;
  while ((match = factPattern.exec(html))) {
    const attributes = match[1];
    const name = (attributes.match(/\bname=["'](?:[^:"']+:)?([^"']+)["']/i) || [])[1];
    const context = (attributes.match(/\bcontextref=["']([^"']+)["']/i) || [])[1];
    if (!INLINE_TAGS.has(name) || !contexts.has(context)) continue;
    const value = parseInlineNumber(match[2], attributes);
    if (value === null) continue;
    if (!found[name]) found[name] = new Set();
    found[name].add(value);
  }
  return Object.fromEntries(Object.entries(found).map(([tag, values]) =>
    [tag, values.size === 1 ? Array.from(values)[0] : null]));
}

function firstFact(facts, tags) {
  for (const tag of tags) {
    if (Number.isFinite(facts[tag]) && facts[tag] >= 0) return {tag, amount: facts[tag]};
  }
  return null;
}

function liabilityReconciliation(facts, cik) {
  const control = firstFact(facts, ['LiabilitiesCurrent']);
  if (!control) return null;
  const aggregate = firstFact(facts, ['AccountsPayableAndOtherAccruedLiabilitiesCurrent']);
  const trade = firstFact(facts, ['AccountsPayableCurrent']);
  const compensation = firstFact(facts,
    ['AccruedSalariesCurrentAndNoncurrent', 'EmployeeRelatedLiabilitiesCurrent']);
  const taxes = firstFact(facts, ['TaxesPayableCurrent']);
  const lease = firstFact(facts,
    ['OperatingLeaseLiabilityCurrent', 'LesseeOperatingLeaseLiabilityPaymentsDueNextTwelveMonths']);
  const termDebt = firstFact(facts, ['LongTermDebtCurrent', 'NotesPayableCurrent']);
  const shortDebt = firstFact(facts, ['ShortTermBorrowings', 'CommercialPaper']);
  const contract = firstFact(facts, ['ContractWithCustomerLiabilityCurrent', 'DeferredRevenueCurrent']);
  const other = firstFact(facts, ['OtherLiabilitiesCurrent']);
  const mapping = ISSUER_MAPPINGS[cik] || {};
  const nestedInOther = new Set(mapping.otherLiabilitiesIncludes || []);
  const items = [];
  const add = (item, treatment, label) => {
    if (item && item.amount > 0) items.push({...item, treatment, label});
  };
  if (aggregate) {
    add(compensation, 'DEDUCTED', 'Accrued employee compensation');
    add(taxes, 'DEDUCTED', 'Currently payable taxes');
    const known = (compensation && compensation.amount || 0) + (taxes && taxes.amount || 0);
    if (known > aggregate.amount) return null;
    add({tag: aggregate.tag, amount: aggregate.amount - known}, 'UNRESOLVED',
      'Unresolved payables and accruals');
  } else {
    add(trade, 'DEDUCTED', 'Trade accounts payable');
    add(compensation, 'DEDUCTED', 'Accrued employee compensation');
    add(taxes, 'DEDUCTED', 'Currently payable taxes');
  }
  add(lease, 'DEDUCTED', 'Current operating lease obligation');
  add(termDebt, 'DEDUCTED', 'Current debt obligation');
  add(shortDebt, 'DEDUCTED', 'Current short-term borrowing');
  add(contract, 'EXCLUDED', 'Deferred or unearned revenue');
  if (other) {
    items.splice(0, items.length, ...items.filter(item => !nestedInOther.has(item.tag)));
    add({tag: other.tag, amount: other.amount}, 'UNRESOLVED',
      'Other current liabilities excluding mapped subcomponents');
  }
  const classified = items.reduce((sum, item) => sum + item.amount, 0);
  return {control: control.amount, classified, delta: control.amount - classified, items,
    status: Math.abs(control.amount - classified) <= 1 ? 'PASS' : 'INCOMPLETE'};
}

function buildArtifact(ticker, cik, submissionsResponse, factsResponse, now, filingResponses) {
  const submissions = submissionsResponse.json;
  if (!(submissions.tickers || []).map(value => String(value).toUpperCase()).includes(ticker)) {
    throw new Error(`${ticker} is not confirmed by SEC submissions for ${cik}.`);
  }
  const filings = currentFilings(submissions).slice(0, 4).map((filing, index) => {
    const facts = {};
    const factSources = {};
    const inline = filingResponses && filingResponses[index] ?
      extractInlineFacts(filingResponses[index].text, filing) : {};
    TAGS.forEach(tag => {
      const companyFact = selectUniqueFact(factsResponse.json, 'us-gaap', tag, 'USD', filing);
      facts[tag] = companyFact === null ? (inline[tag] === undefined ? null : inline[tag]) : companyFact;
      if (facts[tag] !== null) factSources[tag] = companyFact === null ? 'INLINE_XBRL' : 'COMPANY_FACTS';
    });
    return {...filing, facts, factSources, liabilityReconciliation: liabilityReconciliation(facts, cik),
      filingSource: filingResponses && filingResponses[index] && filingResponses[index].source,
      sharesOutstanding: selectShares(factsResponse.json, filing)};
  });
  if (!filings.length) throw new Error(`${ticker} has no recent 10-Q or 10-K filing.`);
  return {
    schemaVersion: 1,
    methodologyVersion: 'aaofi-investor-v2',
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

module.exports = {artifactEntry, buildArtifact, currentFilings, extractInlineFacts, isSupportedSic,
  liabilityReconciliation, normalizeCik, selectBatch, selectShares, selectUniqueFact, uniqueUniverse};
