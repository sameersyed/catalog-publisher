'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {buildCompletionResults} = require('./process-queue');

const claim = {requests: [
  {requestId: 'request-1', ticker: 'TIGR'},
  {requestId: 'request-2', ticker: 'CRM'}
]};

test('marks only successfully published tickers complete', () => {
  assert.deepEqual(buildCompletionResults(claim, {
    succeeded: ['TIGR'], failures: [{ticker: 'CRM', error: 'issuer failed'}]
  }, ''), [
    {requestId: 'request-1', status: 'COMPLETE', error: ''},
    {requestId: 'request-2', status: 'FAILED', error: 'issuer failed'}
  ]);
});

test('marks every claimed request failed when validation, commit, or push fails', () => {
  assert.deepEqual(buildCompletionResults(claim, {succeeded: ['TIGR', 'CRM'], failures: []},
    'catalog validation failed'), [
    {requestId: 'request-1', status: 'FAILED', error: 'catalog validation failed'},
    {requestId: 'request-2', status: 'FAILED', error: 'catalog validation failed'}
  ]);
});
