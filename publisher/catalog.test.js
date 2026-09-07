'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {artifactEntry, buildArtifact, isSupportedSic, selectBatch, uniqueUniverse} = require('./lib/catalog');

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
