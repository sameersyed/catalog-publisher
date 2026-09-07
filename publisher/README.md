# Stock Evidence Catalog Publisher

Dependency-free Node.js 16 publisher for Rocky Linux 9.

It incrementally publishes compact, point-in-time SEC filing evidence for consumption by the Zakat
Calculator. It discovers the ticker universe from the SEC, processes a resumable batch on each run,
and preserves every existing catalog entry. No ticker arguments are required.

```bash
SEC_USER_AGENT='ZakatCalculator/3.0 contact@example.com' \
  node publish-catalog.js /path/to/catalog-publisher
node validate-poc.js /path/to/catalog-publisher
```

The default batch is 250 issuers at a conservative request rate. Override the controls with
`CATALOG_BATCH_SIZE` and `SEC_REQUEST_INTERVAL_MS`. Progress and failures are stored under ignored
`~/.local/state/stock-evidence-catalog/state.json`; the next run resumes after the last attempted
ticker. Failed issuers do not
remove or overwrite prior index entries. Output files are written atomically.

The publisher does not commit or push. After a run, validate the complete catalog before publishing.
Treat validator failure as a hard stop.

`run-catalog-publisher.sh` is the scheduled entry point. It prevents overlapping runs, refuses to
touch a dirty catalog, claims up to 250 private queue requests, publishes only their unique tickers,
validates the catalog, and commits/pushes only validated catalog changes. Configure secrets outside
Git. Logs must be monitored for `PARTIAL`, validator failures, and push failures.

Install `stock-evidence-catalog.service` and `.timer` under `~/.config/systemd/user/`, and store the
contact header in mode-600 `~/.config/stock-evidence/catalog.env`:

```text
SEC_USER_AGENT=ZakatCalculator/3.0 contact@example.com
SEC_REQUEST_INTERVAL_MS=150
QUEUE_URL=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
QUEUE_ADMIN_TOKEN_FILE=/home/stock-evidence/.config/stock-evidence/queue-admin-token
PUBLISHER_GIT_NAME=Stock Evidence Publisher
PUBLISHER_GIT_EMAIL=contact@example.com
```

Enable lingering for the unprivileged account before relying on a user timer after logout. The timer
runs daily with a randomized delay. Requests remain queued while the VM is offline.

The publisher downloads SEC ticker, submissions, and Company Facts JSON; emits only compact
normalized artifacts; and records source URL, retrieval timestamp, response hash, and response size.
It does not publish market quotes or personal holdings.

See `DATA_NOTICE.md` for provenance and usage limitations.
