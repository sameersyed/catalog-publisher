#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || '.');
const indexPath = path.join(ROOT, 'catalog', 'index.json');
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

if (index.schemaVersion !== 1 || !index.generatedAt || !index.source || !index.issuers) {
  throw new Error('Catalog index schema is invalid.');
}
const seenCiks = new Set();
for (const [ticker, entry] of Object.entries(index.issuers)) {
  if (!/^[A-Z0-9-]+$/.test(ticker) || !/^\d{10}$/.test(entry.cik)) {
    throw new Error(`Invalid ticker or CIK in index: ${ticker}`);
  }
  const file = path.join(ROOT, entry.path);
  const text = fs.readFileSync(file, 'utf8');
  const digest = crypto.createHash('sha256').update(text).digest('hex');
  if (digest !== entry.sha256) throw new Error(`${ticker} artifact hash mismatch.`);
  const artifact = JSON.parse(text);
  if (artifact.schemaVersion !== 1 || artifact.ticker !== ticker || artifact.cik !== entry.cik ||
      artifact.methodologyVersion !== 'aaofi-investor-v2' || !artifact.sources ||
      !Array.isArray(artifact.filings) || !artifact.filings.length) {
    throw new Error(`${ticker} artifact schema is invalid.`);
  }
  for (const filing of artifact.filings) {
    if (!['10-Q', '10-K', '20-F'].includes(filing.form) || filing.filingDate < filing.reportDate ||
        !/^\d{10}-\d{2}-\d{6}$/.test(filing.accession) || !filing.facts) {
      throw new Error(`${ticker} has invalid filing metadata.`);
    }
    const expectedFilingUrl = `https://www.sec.gov/Archives/edgar/data/${Number(entry.cik)}/` +
      `${filing.accession.replace(/-/g, '')}/${filing.primaryDocument}`;
    if (!filing.filingSource || filing.filingSource.url !== expectedFilingUrl ||
        !/^\d{4}-\d{2}-\d{2}T/.test(filing.filingSource.retrievedAt) ||
        !Number.isFinite(Number(filing.filingSource.bytes)) || Number(filing.filingSource.bytes) <= 0 ||
        !/^[a-f0-9]{64}$/.test(filing.filingSource.sha256)) {
      throw new Error(`${ticker} has invalid filing-source provenance.`);
    }
    const reconciliation = filing.liabilityReconciliation;
    if (reconciliation && (!['PASS', 'INCOMPLETE'].includes(reconciliation.status) ||
        !Number.isFinite(Number(reconciliation.control)) ||
        !Number.isFinite(Number(reconciliation.classified)) ||
        !Number.isFinite(Number(reconciliation.delta)) || !Array.isArray(reconciliation.items) ||
        Math.abs(Number(reconciliation.control) - Number(reconciliation.classified) -
          Number(reconciliation.delta)) > 1)) {
      throw new Error(`${ticker} has invalid liability reconciliation.`);
    }
  }
  seenCiks.add(entry.cik);
}
console.log(JSON.stringify({status: 'PASS', issuers: Object.keys(index.issuers).length,
  uniqueCiks: seenCiks.size, generatedAt: index.generatedAt}, null, 2));
