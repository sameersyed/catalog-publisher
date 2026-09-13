# Stock Evidence Catalog Publisher POC

The workbook and private queue sources live in the separate
[`sameersyed/zakat-calculator`](https://github.com/sameersyed/zakat-calculator) repository. This
repository owns the home-VM publisher and its generated public SEC catalog.

For immediate processing on the VM, log in as `stock-evidence` and run:

```bash
run-stock-evidence
```

The canonical command source is `publisher/run-stock-evidence`; the VM exposes it through
`~/bin/run-stock-evidence`. See `publisher/README.md` for scheduling, secrets, logs, and recovery.

Dependency-free Node.js 16 proof of concept for Rocky Linux 9.

It publishes compact, point-in-time SEC filing evidence for consumption by the Zakat Calculator. This
POC covers CRM and ORCL only; it validates the acquisition and public-delivery architecture before any
full-universe or scheduled implementation.

```bash
SEC_USER_AGENT='ZakatCalculator/3.0 contact@example.com' \
  node publish-poc.js /path/to/catalog-publisher CRM,ORCL
node validate-poc.js /path/to/catalog-publisher
```

The publisher downloads SEC ticker, submissions, and Company Facts JSON; emits only compact
normalized artifacts; and records source URL, retrieval timestamp, response hash, and response size.
It does not publish market quotes or personal holdings.

See `DATA_NOTICE.md` for provenance and usage limitations.
