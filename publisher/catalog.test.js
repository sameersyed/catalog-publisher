'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const {artifactEntry, buildArtifact, extractInlineFacts, isSupportedSic, liabilityReconciliation,
  selectBatch, uniqueUniverse} = require('./lib/catalog');

function source(url) {
  return {url, retrievedAt: '2026-09-07T00:00:00.000Z', bytes: 100, sha256: 'a'.repeat(64)};
}

function fixture() {
  const recent = {form: ['10-Q'], filingDate: ['2026-05-02'], reportDate: ['2026-05-01'],
    accessionNumber: ['0000000001-26-000001'], primaryDocument: ['q.htm']};
  return {
    submissions: {json: {name: 'Example Inc.', sic: '3571', tickers: ['EXM'], exchanges: ['NYSE'],
      filings: {recent}}, source: source('https://data.sec.gov/submissions/CIK0000000001.json')},
    facts: {json: {facts: {'us-gaap': {CashAndCashEquivalentsAtCarryingValue: {units: {USD: [
      {accn: '0000000001-26-000001', form: '10-Q', end: '2026-05-01', val: 42}
    ]}}}, dei: {EntityCommonStockSharesOutstanding: {units: {shares: [
      {accn: '0000000001-26-000001', form: '10-Q', end: '2026-05-01', val: 10}
    ]}}}}}, source: source('https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json')}
  };
}

test('discovers and sorts unique SEC tickers', () => {
  assert.deepEqual(uniqueUniverse({0: {ticker: 'ZZZ', cik_str: 2}, 1: {ticker: 'AAA', cik_str: 1}}), [
    {ticker: 'AAA', cik: '0000000001'}, {ticker: 'ZZZ', cik: '0000000002'}
  ]);
  assert.deepEqual(uniqueUniverse({0: {ticker: 'DUP', cik_str: 1}, 1: {ticker: 'DUP', cik_str: 2}}), []);
});

test('selects resumable non-wrapping batches', () => {
  const universe = ['A', 'B', 'C'].map((ticker, index) => ({ticker, cik: String(index)}));
  assert.deepEqual(selectBatch(universe, {cursor: ''}, 2), {items: universe.slice(0, 2), nextCursor: 'B'});
  assert.deepEqual(selectBatch(universe, {cursor: 'B'}, 2), {items: universe.slice(2), nextCursor: ''});
  assert.deepEqual(selectBatch(universe, {cursor: 'Z'}, 2), {items: universe.slice(0, 2), nextCursor: 'B'});
});

test('builds a compact operating-company artifact and hash entry', () => {
  const data = fixture();
  const artifact = buildArtifact('EXM', '0000000001', data.submissions, data.facts,
    '2026-09-07T00:00:00.000Z');
  assert.equal(artifact.classification, 'OPERATING_COMPANY');
  assert.equal(artifact.methodologyVersion, 'aaofi-investor-v2');
  assert.equal(artifact.filings[0].facts.CashAndCashEquivalentsAtCarryingValue, 42);
  assert.equal(artifact.filings[0].sharesOutstanding.value, 10);
  const text = JSON.stringify(artifact) + '\n';
  assert.match(artifactEntry(artifact, 'catalog/issuers/0000000001.json', text).sha256, /^[a-f0-9]{64}$/);
});

test('classifies financial, fund, and REIT SICs as unsupported', () => {
  assert.equal(isSupportedSic('3571'), true);
  assert.equal(isSupportedSic('6021'), false);
  assert.equal(isSupportedSic('6798'), false);
});

test('publishes a verified foreign private issuer from a 20-F for Investor proxy review', () => {
  const data = fixture();
  data.submissions.json.sic = '6211';
  data.submissions.json.filings.recent.form = ['20-F'];
  const artifact = buildArtifact('EXM', '0000000001', data.submissions, data.facts,
    '2026-09-07T00:00:00.000Z');
  assert.equal(artifact.classification, 'FOREIGN_PRIVATE_ISSUER');
  assert.equal(artifact.filings[0].form, '20-F');
});

test('validates a catalog containing verified 20-F evidence', () => {
  const data = fixture();
  data.submissions.json.sic = '6211';
  data.submissions.json.filings.recent.form = ['20-F'];
  data.submissions.json.filings.recent.filingDate = ['2026-05-02'];
  data.submissions.json.filings.recent.reportDate = ['2026-05-01'];
  const artifact = buildArtifact('EXM', '0000000001', data.submissions, data.facts,
    '2026-09-07T00:00:00.000Z', [{text: '', source: source(
      'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/q.htm')}]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-validator-'));
  const relativePath = 'catalog/issuers/0000000001-exm.json';
  const text = JSON.stringify(artifact, null, 2) + '\n';
  fs.mkdirSync(path.join(root, 'catalog', 'issuers'), {recursive: true});
  fs.writeFileSync(path.join(root, relativePath), text);
  fs.writeFileSync(path.join(root, 'catalog', 'index.json'), JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-09-07T00:00:00.000Z',
    source: source('https://www.sec.gov/files/company_tickers.json'),
    issuers: {EXM: artifactEntry(artifact, relativePath, text)}
  }));
  try {
    const output = childProcess.execFileSync(process.execPath,
      [path.join(__dirname, 'validate-poc.js'), root], {encoding: 'utf8'});
    assert.match(output, /"status": "PASS"/);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('extracts issuer filing-table facts from dimensionless instant contexts', () => {
  const html = '<xbrli:context id="current"><xbrli:period><xbrli:instant>2026-03-28</xbrli:instant>' +
    '</xbrli:period></xbrli:context><ix:nonfraction name="us-gaap:OtherLiabilitiesCurrent" ' +
    'contextRef="current" scale="6">57,654</ix:nonfraction>';
  assert.equal(extractInlineFacts(html, {reportDate: '2026-03-28'}).OtherLiabilitiesCurrent,
    57654000000);
});

test('reconciles AAPL current liabilities while leaving other liabilities unresolved', () => {
  const result = liabilityReconciliation({LiabilitiesCurrent: 134641000000,
    AccountsPayableCurrent: 57349000000, OtherLiabilitiesCurrent: 57654000000,
    ContractWithCustomerLiabilityCurrent: 9331000000, CommercialPaper: 1997000000,
    LongTermDebtCurrent: 8310000000});
  assert.equal(result.status, 'PASS');
  assert.equal(result.delta, 0);
  assert.equal(result.items.find(item => item.tag === 'OtherLiabilitiesCurrent').treatment, 'UNRESOLVED');
});

test('reconciles ORCL issuer-specific current-liability tags', () => {
  const result = liabilityReconciliation({LiabilitiesCurrent: 40737000000,
    NotesPayableCurrent: 9887000000, AccountsPayableCurrent: 9474000000,
    EmployeeRelatedLiabilitiesCurrent: 1940000000, ContractWithCustomerLiabilityCurrent: 9881000000,
    OtherLiabilitiesCurrent: 9555000000}, '0001341439');
  assert.equal(result.status, 'PASS');
  assert.equal(result.delta, 0);
  assert.equal(result.items.find(item => item.tag === 'OtherLiabilitiesCurrent').amount, 9555000000);
  assert.equal(result.items.some(item => item.tag === 'OperatingLeaseLiabilityCurrent'), false);
});
