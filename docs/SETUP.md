# TradeLedger — Setup Guide

This guide walks through installing and running the journal end to end: from a
clean checkout to importing an IBKR Flex CSV and reviewing strategies. It is
the detailed companion to the [README](../README.md); when the two disagree,
the README's stated contract wins.

The journal is **single-user and local-first**. One process serves the compiled
React frontend and the Fastify API on the same origin and port (default
`3000`), and stores all state under a writable data directory (default `/data`
in the container, `.data` when run directly with Node). Inference is optional:
importing, rebuilding, reviewing and browsing all work with no model server.

---

## 1. What you need

| Requirement | Notes |
| --- | --- |
| Node.js `>=22.19.0` | Pinned by `package.json` (`engines`). Use Node 22.19.0 for parity with CI. |
| npm | Ships with Node. The lockfile is `package-lock.json`. |
| Docker + Docker Compose | Optional. Required only for the containerised run and `npm run test:docker`. |
| Local persistent disk | SQLite in WAL mode. **Do not** put the data directory on a network filesystem (NFS/SMB). |
| An IBKR Flex CSV | Activity Flex Query export containing the Trades/Executions section. See [section 6](#6-first-run-walkthrough). |
| A local model server | Optional. Only needed for the Agent chat page (Ollama, llama.cpp, LM Studio, etc.). |

No GPU, no bundled weights, and no cloud account are required.

---

## 2. Quick start with Docker (recommended)

```bash
docker compose up --build
# open http://localhost:3000
```

`compose.yaml` binds the host port to `127.0.0.1:3000` (loopback only), mounts
the named `journal-data` volume at `/data`, and maps `host.docker.internal` to
the host gateway so the container can reach a model server on the host. It
starts no model server and holds no cloud key.

Stop it with `Ctrl-C`; the named volume keeps your data between runs.

### Run the image without Compose

```bash
docker build -t trade-ledger .
docker run --rm -p 127.0.0.1:3000:3000 \
  -v journal-data:/data \
  -e ALLOWED_ORIGIN=http://localhost:3000 \
  trade-ledger
```

The container runs as UID/GID `1000` (non-root). Static assets live inside the
image; only `/data` is written at runtime.

### Using a bind mount instead of a named volume

A bind mount must be writable by UID/GID `1000`:

```bash
mkdir -p ./data
sudo chown -R 1000:1000 ./data
```

Then mount it with `-v "$PWD/data:/data"`. A named volume is simpler because
Docker sets ownership on first use.

---

## 3. Run locally with Node (no Docker)

```bash
npm ci                 # install the exact pinned dependency tree
npm run build          # compile the server + copy migrations + build the frontend
STATIC_DIR=dist/web npm start
# open http://localhost:3000
```

`STATIC_DIR=dist/web` makes the server serve the built single-page frontend on
the same origin. Without it, only the API is served. `ALLOWED_ORIGIN` defaults
to `http://localhost:3000` outside production, so no extra variable is needed
for a local run.

The default data directory is `.data` in the current working directory. To put
it elsewhere:

```bash
DATA_DIR=./journal-data STATIC_DIR=dist/web npm start
```

### Development mode (API only, auto-reload)

```bash
npm run dev            # tsx watch src/server/main.ts
```

`npm run dev` runs the TypeScript server with reload and serves the API only;
the browser UI is available after `npm run build` when `STATIC_DIR` is set. For
frontend changes, rebuild (`npm run build`) and reload.

---

## 4. Configuration

Copy `.env.example` to `.env` for non-Compose runs (never commit `.env`). The
container image already sets sensible defaults.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `/data` (image), `.data` (Node) | Writable root for the SQLite database, `originals/`, `transcripts/` and `backups/`. |
| `PORT` | `3000` | HTTP port. The container binds `0.0.0.0`; Compose maps it to host loopback only. |
| `ALLOWED_ORIGIN` | required in production | Exact browser origin allowed for mutations, e.g. `http://localhost:3000`. No path, no userinfo. |
| `ALLOWED_HOSTS` | unset | Extra comma-separated `host[:port]` values accepted in the `Host` header, e.g. `journal.lan:3000`. The `ALLOWED_ORIGIN` host and `localhost`/`127.0.0.1`/`[::1]` (any port) are always accepted. Every other Host, on every request, gets `421 HOST_NOT_ALLOWED`; this blocks DNS-rebinding reads. |
| `UPLOAD_LIMIT_BYTES` | `20971520` (20 MiB) | Per-upload byte limit. |
| `STATIC_DIR` | `dist/web` when `NODE_ENV=production` | Directory of compiled frontend assets to serve. |
| `JOURNAL_SECRETS_DIR` | unset | Allowlisted directory of mounted secret files that a profile's `file:` credential reference may read. |
| `NODE_ENV` | unset | Set to `production` in the image; also gates the `STATIC_DIR` default. |

The server fails closed on bad configuration: a non-numeric `PORT`, a malformed
`ALLOWED_ORIGIN`, or a missing `ALLOWED_ORIGIN` in production aborts startup
with a non-zero exit.

---

## 5. Where your data lives

Everything is under `DATA_DIR`:

- the SQLite database (WAL mode, serialized writes);
- `originals/` — the immutable, content-addressed uploaded CSVs;
- `transcripts/` — model run transcripts;
- `backups/` — backup archives created from the UI.

Run **one** application replica. SQLite WAL plus the serialized writer queue
require a single writer; do not scale the service horizontally.

Migrations run automatically before the server accepts traffic. If the
persisted schema is **newer** than the application supports, startup aborts and
readiness never reports ready — deploy a matching application version rather
than opening the store.

---

## 6. First-run walkthrough

1. **Start the app** (section 2 or 3) and open the origin you configured
   (`http://localhost:3000` by default).

2. **Import a Flex CSV.** Go to **Imports**, choose one or more `.csv` files
   under "CSV files", then click **Confirm import**. The preview reports counts
   (executions, lots, quarantined) and any capability or parse issues before
   anything is committed. Committing never deletes raw evidence, and
   re-uploading an identical file is idempotent.

   To produce the export in IBKR: Performance & Reports → Flex Queries →
   create an **Activity Flex Query**, include the **Trades** section (and the
   lot/open-position fields for cost basis), then export as **CSV**. Headers
   are matched by name, not position, and unknown columns are preserved
   verbatim. Recognized fields include:

   `ClientAccountID, AssetClass, Symbol, UnderlyingSymbol, Conid,
   CurrencyPrimary, TradeDate, DateTime, Quantity, TradePrice, Proceeds,
   IBCommission, Taxes, NetCash, FifoPnlRealized, CostBasis, Notes/Codes,
   IBOrderID, BrokerageOrderID, IBExecID, TradeID, Expiry, Strike, Put/Call,
   Multiplier, LevelOfDetail, OpenDateTime, PositionActionID, TimeZone,
   OrigOrderID, OrigTradeID, RelatedTradeID, ClosePrice, Open/CloseIndicator`.

   `Open/CloseIndicator` (`O`, `C`, or `C;O`) tells the journal whether a trade
   opens or closes a position; `Notes/Codes` takes precedence when it carries an
   `O`/`C` code. A row with no broker ids but an indicator is still imported as
   an execution. When the `Expiry`, `Strike` and `Put/Call` columns are absent,
   they are read from the OCC option symbol (for example
   `DELL  261016C00490000`).

   Aliases (`Price`, `Commission`, `Code`, `Date/Time`, `OrderID`, `ExecID`, `OpenCloseIndicator`)
   are accepted too.

3. **Build the journal.** After the first import, open **Maintenance** and click
   **Rebuild full**. Watch the job status until it is `complete`. The Journal
   page then shows one row per strategy.

4. **Review.** Open **Review** to see review items (ambiguous matches, missing
   openings, lifecycle gaps, conflicting evidence, and any contradictory
   retained decisions). Record decisions — notes, stop loss, manual
   allocations, identity bindings, import exclusions, etc. Financially
   consequential decisions show a confirmation preview first.

5. **Browse.** **Journal** lists strategies with source-precision amounts and
   P/L; click a row to open the strategy detail (allocations, lots, revision
   history, actual contract expiries). **Transactions** lists individual
   executions. Missing P/L displays as **Unavailable**, never zero.

6. **Maintenance** also hosts **Rollback** (restore a previous build id),
   **Backup**, and the model profile editor (section 7).

---

## 7. Optional: local AI inference

The Agent page is optional and never required for readiness. It uses the
**default** model profile, which must be verified (run the compatibility test).
Conversation transcripts are stored under `DATA_DIR/transcripts/chat`. Cloud
profiles need the confirmation checkbox before they can be made the default.
Configure a
profile under **Maintenance → Models**:

- **Name** — a label.
- **Mode** — `local` (uses a documented placeholder key and never borrows an
  ambient cloud credential) or `cloud`.
- **Endpoint** — the OpenAI-compatible base URL, including `/v1`.
- **Provider** / **Protocol** — the wire adapter to use.
- **Model id**, **Thinking levels**, **Context window**, **Max tokens**,
  **Timeout (s)** — model parameters.
- **Credential ref** — `env:NAME` reads environment variable `NAME`;
  `file:/absolute/path` reads an allowlisted file under `JOURNAL_SECRETS_DIR`.
  Leave empty for local endpoints that need no key.
- **Supports tools** — must be enabled for a profile to pass compatibility,
  because proposals are validated tool calls.

Endpoint arrangement matters: `localhost` inside the app container is the
**container**, not your host.

- Host inference server (via the Compose gateway):
  `http://host.docker.internal:11434/v1`. The host server must bind an address
  reachable from the container.
- Another service on the Compose network, e.g. `http://ollama:11434/v1`.

### Credentials and secrets

Pass credentials through the environment or mounted secret files — never
through the image, a backup, or a log. Responses expose only the credential's
configured/missing status, never its value.

```bash
# Pass a key via the environment
docker run --rm -p 127.0.0.1:3000:3000 -v journal-data:/data \
  -e ALLOWED_ORIGIN=http://localhost:3000 \
  -e MY_PROVIDER_KEY=sk-... \
  trade-ledger
# then set the profile credential ref to: env:MY_PROVIDER_KEY
```

```bash
# Or mount a secrets directory read-only and use file: refs
docker run --rm -p 127.0.0.1:3000:3000 -v journal-data:/data \
  -e ALLOWED_ORIGIN=http://localhost:3000 \
  -e JOURNAL_SECRETS_DIR=/secrets \
  -v "$PWD/secrets:/secrets:ro" \
  trade-ledger
# then set the profile credential ref to: file:/secrets/key
```

Optional manual smoke against a real local server (sends only a fixed
synthetic probe, writes no journal decision, never run in CI):

```bash
npm run build
LOCAL_MODEL_ENDPOINT=http://host.docker.internal:11434/v1 \
LOCAL_MODEL_ID=llama3.1 npm run smoke:local-model
```

---

## 8. Backup and restore

**Create a backup** from **Maintenance → Backup → Create backup**, then click
**Download archive** when the job completes. Backups pause commits long enough
to capture a consistent snapshot and include original files, transcripts and
retained decisions with checksums. Secrets are excluded.

Or use the CLI (it takes the data-directory lock, so stop the server first):

```bash
npm run backup -- --output ./backup.tar --data-dir ./data
```

**Restore is offline only** and refuses to run while an instance holds the
data-directory lock. It validates checksums, schema compatibility and
referenced-file completeness, and makes a pre-restore backup before swapping:

```bash
npm run restore -- --archive ./backup.tar --data-dir ./data
```

After a restore, reconfigure credentials — secrets are never stored in a
backup.

---

## 9. Health and operations

- `GET /health/live` — process liveness.
- `GET /health/ready` — database and migration readiness, independent of any
  model service.

The image defines a `HEALTHCHECK` against `/health/ready`. On `SIGINT`/`SIGTERM`
the server cancels in-flight builds and analyses, drains the writer queue, and
exits non-zero if draining fails so orchestrators can see an unclean stop.

### Exposing beyond the host

Terminate authentication at a user-managed reverse proxy and set
`ALLOWED_ORIGIN` to the public origin. Multi-user accounts are out of scope:
every authenticated visitor has the same single-user access. Cross-origin and
unexpected-content-type mutations are rejected; uploads and mutations must be
same-origin.

---

## 10. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Startup aborts: `ALLOWED_ORIGIN must be configured in production.` | You ran with `NODE_ENV=production` but no origin. Set `ALLOWED_ORIGIN` to the exact origin you browse (e.g. `http://localhost:3000`). |
| Every request returns 421 `HOST_NOT_ALLOWED` | The `Host` you browse is neither the `ALLOWED_ORIGIN` host nor loopback, e.g. a LAN name or a reverse proxy that rewrites `Host`. Set `ALLOWED_ORIGIN` to that origin or add the host to `ALLOWED_HOSTS`. |
| Mutations return 403 / cross-origin rejected | The browser origin does not match `ALLOWED_ORIGIN`. Match scheme, host and port exactly; no trailing slash or path. |
| Container cannot write `/data` (bind mount) | `sudo chown -R 1000:1000 ./data`, or switch to a named volume. |
| `SQLITE_BUSY` or corruption warnings | The data directory is on a network filesystem, or more than one replica is running. Use local disk and a single replica. |
| `better-sqlite3` fails to install/compile | Install a build toolchain (Python 3, `make`, `g++`) or use the Docker image, which pins the toolchain. |
| Startup aborts: persisted schema is newer | The database was written by a newer app version. Deploy the matching version; do not open it with an older build. |
| `/health/ready` is red but the app was healthy before | Check the data directory is writable and migrations completed. Readiness depends only on the database. |
| Agent page reports an unavailable model | Check the profile endpoint is reachable **from the container** (`host.docker.internal` for the host) and that **Supports tools** is enabled. |

---

## 11. Development and tests

```bash
npm ci
npm run check:all      # Biome + TypeScript typecheck
npm test               # vitest: unit + integration
npm run build          # server (tsc + migrations) + frontend (vite)
npm run test:e2e       # Playwright chromium: builds + boots the real server
npm run test:docker    # compose config check + real Docker smoke
npm run test:build-smoke   # build then smoke the compiled server + SIGTERM
```

`.github/workflows/trade-ledger.yml` runs the same gates on Node 22.19.0 for
changes to the app, packaging, docs and specs. No release tooling is required.


## Reset data or transfer model configuration

To start over with your current model setup, open **Maintenance → Reset journal
data**. Create/download a backup first if needed. Review the deletion counts,
type `RESET` and click **Confirm reset**. This clears imports (including staged
uploads and original CSVs), trades/builds, accounts, decisions, analysis runs,
conversations, transcripts and job history. It keeps model profiles, their
compatibility checks, the selected default, and existing backups. Wait for
uploads, replies, model checks and jobs to finish, including cancellation cleanup.
You can then upload your CSV files again without reconfiguring inference.

To move just model settings to a fresh database, use **Maintenance → Model
profiles → Export model configuration**. On the new instance, use **Import model
configuration** to choose the JSON file. Credential references and pricing are
included; API keys and verification results are excluded. Configure the referenced
environment variables or mounted files on the new instance, **Test** each profile,
then **Make default**. Imports add profiles and do not overwrite existing names.
Any invalid entry or name conflict rejects the whole file; rename conflicting
entries in the JSON before retrying. A default/cloud selection is never automatic.

Conversations also have **Rename conversation** and **Delete conversation**
controls in their header. Stop an active reply first. Conversation deletion
preserves accepted journal decisions.
