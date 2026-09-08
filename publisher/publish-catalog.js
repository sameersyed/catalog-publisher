#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const {artifactEntry, buildArtifact, currentFilings, selectBatch, uniqueUniverse} = require('./lib/catalog');

const SEC_BASE = 'https://data.sec.gov';
const TICKER_MAP = 'https://www.sec.gov/files/company_tickers.json';
const USER_AGENT = process.env.SEC_USER_AGENT;
const ROOT = path.resolve(process.argv[2] || process.cwd());
const BATCH_SIZE = positiveInteger(process.env.CATALOG_BATCH_SIZE || '250', 'CATALOG_BATCH_SIZE');
const REQUEST_INTERVAL_MS = positiveInteger(process.env.SEC_REQUEST_INTERVAL_MS || '150',
  'SEC_REQUEST_INTERVAL_MS');
const STATE_HOME = process.env.XDG_STATE_HOME || path.join(process.env.HOME, '.local', 'state');
const STATE_PATH = path.join(STATE_HOME, 'stock-evidence-catalog', 'state.json');
const INDEX_PATH = path.join(ROOT, 'catalog', 'index.json');
const REQUESTED_TICKERS = (process.env.CATALOG_TICKERS || '').split(',')
  .map(value => value.trim().toUpperCase()).filter(Boolean);
let nextRequestAt = 0;

if (!USER_AGENT || !/\S+@\S+\.\S+/.test(USER_AGENT)) {
  throw new Error('SEC_USER_AGENT must identify the application and include a monitored contact email.');
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function request(url) {
  const wait = Math.max(0, nextRequestAt - Date.now());
  if (wait) await sleep(wait);
  nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    https.get(url, {headers: {'User-Agent': USER_AGENT, Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate'}}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const encoded = Buffer.concat(chunks);
        if (response.statusCode !== 200) {
          reject(new Error(`${url} returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          const encoding = response.headers['content-encoding'];
          const body = encoding === 'gzip' ? zlib.gunzipSync(encoded) :
            encoding === 'deflate' ? zlib.inflateSync(encoded) : encoded;
          resolve({json: JSON.parse(body.toString('utf8')), source: {url,
            retrievedAt: new Date().toISOString(), bytes: body.length,
            sha256: crypto.createHash('sha256').update(body).digest('hex'),
            latencyMs: Date.now() - started}});
        } catch (error) {
          reject(new Error(`${url} returned invalid JSON: ${error.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function requestText(url) {
  const response = await requestBuffer(url);
  return {text: response.body.toString('utf8'), source: response.source};
}

async function requestBuffer(url) {
  const wait = Math.max(0, nextRequestAt - Date.now());
  if (wait) await sleep(wait);
  nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    https.get(url, {headers: {'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip, deflate'}}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const encoded = Buffer.concat(chunks);
        if (response.statusCode !== 200) return reject(new Error(`${url} returned HTTP ${response.statusCode}`));
        try {
          const encoding = response.headers['content-encoding'];
          const body = encoding === 'gzip' ? zlib.gunzipSync(encoded) :
            encoding === 'deflate' ? zlib.inflateSync(encoded) : encoded;
          resolve({body, source: {url, retrievedAt: new Date().toISOString(), bytes: body.length,
            sha256: crypto.createHash('sha256').update(body).digest('hex'), latencyMs: Date.now() - started}});
        } catch (error) {
          reject(new Error(`${url} could not be decoded: ${error.message}`));
        }
      });
    }).on('error', reject);
  });
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

function validExistingIndex(index) {
  if (!index || index.schemaVersion !== 1 || !index.issuers || typeof index.issuers !== 'object') {
    throw new Error('Existing catalog index is missing or invalid; refusing to replace it.');
  }
  return index;
}

async function publishIssuer(item, now) {
  const [submissionsResponse, factsResponse] = await Promise.all([
    request(`${SEC_BASE}/submissions/CIK${item.cik}.json`),
    request(`${SEC_BASE}/api/xbrl/companyfacts/CIK${item.cik}.json`)
  ]);
  const filings = currentFilings(submissionsResponse.json).slice(0, 4);
  const filingResponses = [];
  for (const filing of filings) {
    const accession = filing.accession.replace(/-/g, '');
    filingResponses.push(await requestText(`https://www.sec.gov/Archives/edgar/data/${Number(item.cik)}/${accession}/${filing.primaryDocument}`));
  }
  const artifact = buildArtifact(item.ticker, item.cik, submissionsResponse, factsResponse, now,
    filingResponses);
  const fileTicker = item.ticker.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const relativePath = `catalog/issuers/${item.cik}-${fileTicker}.json`;
  const text = JSON.stringify(artifact, null, 2) + '\n';
  writeAtomic(path.join(ROOT, relativePath), text);
  return artifactEntry(artifact, relativePath, text);
}

async function main() {
  const tickerResponse = await request(TICKER_MAP);
  const universe = uniqueUniverse(tickerResponse.json);
  if (!universe.length) throw new Error('SEC ticker universe is empty; refusing to update the catalog.');
  const state = readJson(STATE_PATH, {cursor: ''});
  const requested = new Set(REQUESTED_TICKERS);
  const batch = requested.size ? {items: universe.filter(item => requested.has(item.ticker)), nextCursor: state.cursor} :
    selectBatch(universe, state, BATCH_SIZE);
  if (requested.size && batch.items.length !== requested.size) {
    const found = new Set(batch.items.map(item => item.ticker));
    throw new Error('Ticker(s) not found in SEC universe: ' +
      Array.from(requested).filter(ticker => !found.has(ticker)).join(', '));
  }
  const index = validExistingIndex(readJson(INDEX_PATH, null));
  const nextIndex = {...index, generatedAt: new Date().toISOString(), source: tickerResponse.source,
    issuers: {...index.issuers}};
  const failures = [];
  let published = 0;
  for (const item of batch.items) {
    try {
      nextIndex.issuers[item.ticker] = await publishIssuer(item, new Date().toISOString());
      published += 1;
    } catch (error) {
      failures.push({ticker: item.ticker, cik: item.cik, error: error.message});
    }
  }
  if (!published) throw new Error(`No issuer was published; refusing to update the index. ${JSON.stringify(failures)}`);
  writeAtomic(INDEX_PATH, JSON.stringify(nextIndex, null, 2) + '\n');
  const runState = {cursor: batch.nextCursor, lastRunAt: new Date().toISOString(),
    mode: requested.size ? 'TARGETED' : 'UNIVERSE', universeSize: universe.length,
    attempted: batch.items.length, published,
    succeeded: batch.items.filter(item => !failures.some(failure => failure.ticker === item.ticker))
      .map(item => item.ticker), failures};
  writeAtomic(STATE_PATH, JSON.stringify(runState, null, 2) + '\n');
  console.log(JSON.stringify({status: failures.length ? 'PARTIAL' : 'PASS', universe: universe.length,
    attempted: batch.items.length, published, preserved: Object.keys(index.issuers).length,
    totalIndexed: Object.keys(nextIndex.issuers).length, nextCursor: batch.nextCursor,
    failures: failures.slice(0, 20)}, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
