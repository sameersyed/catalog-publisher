#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(process.env.CATALOG_ROOT || path.join(process.env.HOME, 'catalog-publisher'));
const QUEUE_URL = process.env.QUEUE_URL;
const ADMIN_TOKEN_FILE = process.env.QUEUE_ADMIN_TOKEN_FILE ||
  path.join(process.env.HOME, '.config', 'stock-evidence', 'queue-admin-token');
const STATE_HOME = process.env.XDG_STATE_HOME || path.join(process.env.HOME, '.local', 'state');
const RUN_STATE = path.join(STATE_HOME, 'stock-evidence-catalog', 'state.json');
const GIT_NAME = process.env.PUBLISHER_GIT_NAME || 'Stock Evidence Publisher';
const GIT_EMAIL = process.env.PUBLISHER_GIT_EMAIL;

let adminToken = '';

function loadConfiguration_() {
  if (!QUEUE_URL) throw new Error('QUEUE_URL is required.');
  if (!GIT_EMAIL || !/^\S+@\S+\.\S+$/.test(GIT_EMAIL)) throw new Error('PUBLISHER_GIT_EMAIL is required.');
  adminToken = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
}

function run(command, args, options) {
  childProcess.execFileSync(command, args, {stdio: 'inherit', ...options});
}

function get(body) {
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return new Promise((resolve, reject) => {
    https.get(`${QUEUE_URL}?payload=${encodeURIComponent(payload)}`, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          https.get(response.headers.location, redirected => {
            const redirectedChunks = [];
            redirected.on('data', chunk => redirectedChunks.push(chunk));
            redirected.on('end', () => parseResponse_(redirected, redirectedChunks, resolve, reject));
          }).on('error', reject);
          return;
        }
        parseResponse_(response, chunks, resolve, reject);
      });
    }).on('error', reject);
  });
}

function parseResponse_(response, chunks, resolve, reject) {
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    payload.ok ? resolve(payload) : reject(new Error(payload.error || 'Queue request failed.'));
  } catch (error) {
    reject(new Error(`Queue returned HTTP ${response.statusCode}: ${error.message}`));
  }
}

function buildCompletionResults(claim, state, pipelineError) {
  const succeeded = new Set(pipelineError ? [] : (state.succeeded || []));
  const errors = new Map((state.failures || []).map(item => [item.ticker, item.error]));
  return claim.requests.map(item => ({
    requestId: item.requestId,
    status: succeeded.has(item.ticker) ? 'COMPLETE' : 'FAILED',
    error: succeeded.has(item.ticker) ? '' : String(pipelineError || errors.get(item.ticker) ||
      'Publisher did not produce validated evidence.').slice(0, 500)
  }));
}

async function main() {
  const retryIds = process.argv.slice(2);
  if (retryIds.length) {
    const retried = await get({action: 'retry', adminToken, requestIds: retryIds});
    console.log(JSON.stringify({status: 'PASS', retried: retried.retried}, null, 2));
    return;
  }
  const claim = await get({action: 'claim', adminToken, limit: 250});
  if (!claim.requests.length) {
    console.log(JSON.stringify({status: 'PASS', claimed: 0}, null, 2));
    return;
  }
  const tickers = [...new Set(claim.requests.map(item => item.ticker))];
  let state = {succeeded: [], failures: []};
  let pipelineError = '';
  try {
    const dirty = childProcess.execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'catalog'],
      {encoding: 'utf8'}).trim();
    if (dirty) throw new Error('Catalog has uncommitted changes; refusing to process queue requests.');
    run(process.execPath, [path.join(ROOT, 'publisher', 'publish-catalog.js'), ROOT],
      {env: {...process.env, CATALOG_TICKERS: tickers.join(',')}});
    state = JSON.parse(fs.readFileSync(RUN_STATE, 'utf8'));
    run(process.execPath, [path.join(ROOT, 'publisher', 'validate-poc.js'), ROOT]);
    if (state.succeeded && state.succeeded.length) {
      run('git', ['-C', ROOT, 'add', 'catalog']);
      run('git', ['-C', ROOT, 'commit', '-m', 'Publish requested SEC evidence'],
        {env: {...process.env, GIT_AUTHOR_NAME: GIT_NAME, GIT_AUTHOR_EMAIL: GIT_EMAIL,
          GIT_COMMITTER_NAME: GIT_NAME, GIT_COMMITTER_EMAIL: GIT_EMAIL}});
      run('git', ['-C', ROOT, 'push']);
    }
  } catch (error) {
    pipelineError = String(error.message || error).slice(0, 500);
  }
  const results = buildCompletionResults(claim, state, pipelineError);
  await get({action: 'complete', adminToken, results});
  const succeeded = new Set(results.filter(item => item.status === 'COMPLETE').map(item => item.requestId));
  const errors = results.filter(item => item.status === 'FAILED');
  if (!succeeded.size) throw new Error('No claimed ticker was published.');
  console.log(JSON.stringify({status: errors.size ? 'PARTIAL' : 'PASS', claimed: claim.requests.length,
    published: succeeded.size, failed: errors.size}, null, 2));
}

if (require.main === module) {
  loadConfiguration_();
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {buildCompletionResults};
