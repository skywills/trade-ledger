# TradeLedger

A single-user, local-first journal for IBKR Flex CSV exports. One production
container serves the compiled React frontend and the Fastify API on the same
origin and port (default `3000`), storing all state under a writable `/data`
volume. Inference is optional: the journal imports, rebuilds, reviews and
displays without any model server, and a model service is never required for
readiness.

For a step-by-step install, configuration and first-run walkthrough, see
[`docs/SETUP.md`](docs/SETUP.md). For how the project is tested and how the
acceptance checks map to tests, see [`docs/TEST-PLAN.md`](docs/TEST-PLAN.md).

## Dashboard and analytics

Open **Dashboard** for three views:

- **Overview** (`/dashboard`): realized P&L, win rate, closed/current-open counts, cumulative/monthly trends, strategy and underlying attribution, and recent trades.
- **Analysis** (`/dashboard/analysis`): performance and transaction sections, exact symbol/underlying/type/asset-class filters, outcome/group drill-downs, and paginated source-linked records.
- **Reports** (`/dashboard/reports`): period reviews, data-quality notes, unsaved review notes, and browser Print / Save as PDF.

Choose one currency and either broker-reported or reconstructed P&L. Closed-trade performance uses the strategy close date; transaction activity uses execution dates. Current-open counts describe the active build, even when viewing an older period. Missing amounts remain unavailable and coverage is shown. Fees/credits retain their signs and are not subtracted again from P&L. Cumulative P&L and realized drawdown are closed-trade measures, not account equity or unrealized valuation.

Filters are preserved in the URL. CSV exports cover the full selected scope rather than the visible page and retain exact decimal values and build/ledger provenance. If the active build changes during a drill-down/export, refresh analytics before continuing. Reports default to the current month unless an explicit period is supplied. Review notes are local to the report view, unsaved, and included in print.

The estimated broker-P&L count links to the affected completed lifecycles or
strategy components. Lifecycle timelines show allocated broker amounts and their
source rows. Settlement review findings link to affected lifecycles; see
[SPXW Flex evidence fields](docs/SPXW-FLEX.md) for the required companion exports
and the current cash-settlement import limitation.

## Reviewing covered-call connections

**Review** and **Lifecycles** group related call fills into one connection review.
Open **Review connection** to see the share lifecycle, chronological trades,
contract quantities and coverage required. The preview checks the change in an
isolated journal before enabling **Confirm connection**. Matching Agent connection
proposals use the same review panel and still require your confirmation.

Choose **Keep trades separate** when the calls are independent. Confirmation
saves the decision and updates the journal; **Undo connection** is available in
the result panel while no later decisions have been saved. Undo retains the
original decision in history. Interrupted requests can be retried without saving
the decision twice. Use **Advanced adjustments** to split individual fills,
correct source quantities, or revise an earlier decision.

## Requirements

- Node.js `22.19.0` (the app pins `>=22.19.0`). Docker is optional but is how
  the production image is built and smoked.
- No GPU and no bundled model server or weights. The image ships only the app.
- Local storage for SQLite. Do not run the data directory on a network
  filesystem: SQLite WAL requires local persistent storage.

## Quick start with Docker

```bash
docker compose up --build
# open http://localhost:3000
```

Compose binds host `127.0.0.1:3000` (loopback only), mounts the named
`journal-data` volume at `/data`, and maps `host.docker.internal` to the host
gateway. It starts no model server and holds no cloud key.

Run the image directly:

```bash
docker build -t trade-ledger .
docker run --rm -p 127.0.0.1:3000:3000 \
  -v journal-data:/data \
  -e ALLOWED_ORIGIN=http://localhost:3000 \
  trade-ledger
```

The container runs as UID/GID `1000` (non-root). Static assets live inside the
image, never on `/data`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `/data` (image) | Writable root for SQLite, imports, transcripts, backups. |
| `HOST` | `127.0.0.1` (Node), `0.0.0.0` (image) | Listener bind address. The app has no authentication, so keep it on loopback outside a container. |
| `PORT` | `3000` | HTTP port. |
| `ALLOWED_ORIGIN` | required in production | Exact browser origin allowed for mutations (e.g. `http://localhost:3000`). |
| `ALLOWED_HOSTS` | unset | Extra comma-separated `host[:port]` values accepted in the `Host` header. The `ALLOWED_ORIGIN` host and `localhost`/`127.0.0.1`/`[::1]` are always accepted; any other Host gets `421 HOST_NOT_ALLOWED` (DNS-rebinding defence). |
| `UPLOAD_LIMIT_BYTES` | `20971520` (20 MiB) | Per-upload byte limit. |
| `STATIC_DIR` | `dist/web` in production | Optional override of the compiled frontend directory. |
| `JOURNAL_SECRETS_DIR` | unset | Optional allowlisted directory for mounted secret files (`file:` credential refs). |

Copy `.env.example` to `.env` for non-compose runs. Never place provider keys
in `.env` in the image; pass them at run time.

## Data, persistence and ownership

- SQLite uses WAL, a busy timeout, and serialized mutations; one application
  replica is required. Do not scale the service beyond one replica.
- All state lives under `/data`: the database, `originals/` imports,
  `transcripts/` and `backups/`.
- With a bind mount, the host directory must be owned by UID/GID `1000` so the
  non-root container can write it: `sudo chown -R 1000:1000 ./data`.
- A named volume is the simplest option (Docker sets ownership on first use).

## Credentials and secrets

Pass credentials through the environment or mounted secret files, never
through the image, a backup or a log. In a model profile:

- `env:NAME_API_KEY` reads the process environment variable `NAME_API_KEY`.
  Only uppercase names ending in `_API_KEY` (e.g. `OPENAI_API_KEY`) are
  allowed, so a profile can never read other process secrets.
- A `cloud` profile endpoint must use `https://` unless it is on loopback.
- `file:/secrets/key` reads an allowlisted file under `JOURNAL_SECRETS_DIR`.
  Mount that directory read-only, for example `./secrets:/secrets:ro`.

Responses expose only the credential's configured/missing status, never its
value. Unauthenticated local endpoints need no key; the app sends a documented
per-profile placeholder and never borrows an ambient cloud credential.

## Agent chat

The **Agent** page (`/chat`) is an optional conversational assistant over your
journal. It needs a verified default model profile (see Local inference) and
can read strategies, transactions, imports and review evidence through bounded
read-only tools. Performance tools use the dashboard's lifecycle/strategy units,
P&L basis, filters and exact decimal calculations. Connected trades and explicit
wheel campaigns have their own evidence tools.

- Analytics default to lifecycle results and broker P&L. Replies identify the
  selected currency; currencies and P&L bases are never combined or substituted.
- Current-position summaries use remaining strategy quantities, grouped by exact
  account, currency and instrument. Net and gross long/short quantities preserve
  offsetting holdings; contributors, lifecycle links and unresolved attribution
  have separate pages. Contributors report quantities once with lifecycle counts;
  linked IDs are retrieved through `section=lifecycle_links`. Unscoped unresolved counts disclose evidence that cannot satisfy the
  requested filters. These are journal quantities, not live values.
- Analytics exports return a clickable **Download CSV** link for all selected
  rows through the existing export route. Currency, basis and build are pinned;
  regenerate the link after a rebuild. Downloads start only on click. No export
  file is persisted and CSV bodies stay out of model context. Other model-authored
  links remain text.
- Drawdown describes cumulative completed-trade P&L, not account equity.
- Source rows include quarantined evidence. Raw field values are private,
  immutable data retrieved in Unicode-safe chunks; preview issues are paginated.
- Reads carry build provenance. A changed build rejects a pinned drill so the
  assistant can refresh its evidence. List pages have at most 50 rows and may
  shrink to fit the model; continuation points to the actual next row.
- Capability discovery lists registered tools, approval modes, proposal kinds
  and limits. Live prices, Greeks, FX conversion, account equity reconstruction
  and multiplier corrections are unavailable.

- Imports, rebuilds and backups ask for your explicit **Allow** before they run.
- Decisions are never written by the agent directly; they are only created from
  proposals you accept.
- Decision history supports exact strategy, lifecycle, campaign and import
  references, with effective/superseded status computed before pagination.
- `preview_proposal` runs a hypothetical correction in an isolated temporary
  database with a full rebuild. It never changes the live journal. It can take
  roughly as long as a rebuild and has a 30-second cooperative timeout. A changed
  build or decision watermark discards the result; refresh evidence and rebuild
  stale data before retrying.
- `submit_proposal` repeats this validation before saving a pending card, with at
  most 20 cards per turn. Invalid proposals create no run or card. Each card
  shows the proposed changes; **Accept** revalidates the current journal before
  writing a decision. Preview totals do not guarantee later acceptance results.
- Supported proposals include allocations, identity bindings, explicit grouping,
  lifecycle events, notes, stop losses, group merges, import inclusion/exclusion,
  lifecycle attachments/membership/attachment rejection, wheel campaigns and
  campaign membership. `supersedesId` can replace a retained decision. Group
  splits (which lack allocation mappings), manual valuations, generic rejection
  proposals and multiplier corrections remain unsupported. Existing saved cards
  continue to work without a database migration.
- CSV files can be attached to a message for an import preview.
- Replies stream as the model generates them. Expand **Thinking** to see live
  thinking text when the provider supplies it, plus tool activity. Thinking is
  saved with the conversation and the block collapses when the reply finishes.
- Open a conversation to **Rename conversation** or **Delete conversation** in its header. Stop an active reply first. Deleting a conversation removes its messages and chat transcripts; accepted journal decisions remain.
- Each thread is capped at $5 of estimated cost and 1M generated tokens.

## Local inference

Two network arrangements are documented; `localhost` inside the app container
means the app container, not the host:

- Host inference server via the gateway:
  `http://host.docker.internal:11434/v1` (compose adds
  `host.docker.internal:host-gateway`). The host server must bind an address
  reachable from the container.
- Another service on the compose network, for example `http://ollama:11434/v1`.

A profile must declare tool support to pass compatibility, since proposals are
validated tool calls. An unavailable inference endpoint must not fail
readiness: `/health/ready` depends only on the database and migrations.

Optional manual smoke against a real local server (never run in CI, sends only
the fixed synthetic probe and writes no journal decision):

```bash
npm run build
LOCAL_MODEL_ENDPOINT=http://host.docker.internal:11434/v1 \
LOCAL_MODEL_ID=llama3.1 npm run smoke:local-model
```

## Reverse proxy and origin

When exposing the journal beyond the host, terminate authentication at a
user-managed reverse proxy and set `ALLOWED_ORIGIN` to the public origin.
Built-in multi-user accounts are out of scope: every authenticated visitor has
the same single-user access. Forwarded identity headers do not grant
authorization. Cross-origin and unexpected-content-type mutations are
rejected; uploads and mutations must be same-origin.

## Import fields

Flex CSV headers are matched by name (a header record is detected by field
names, not offsets). Recognized fields:

`ClientAccountID, AssetClass, Symbol, UnderlyingSymbol, Conid,
CurrencyPrimary, TradeDate, DateTime, Quantity, TradePrice, Proceeds,
IBCommission, Taxes, NetCash, FifoPnlRealized, CostBasis, Notes/Codes,
IBOrderID, BrokerageOrderID, IBExecID, TradeID, Expiry, Strike, Put/Call,
Multiplier, LevelOfDetail, OpenDateTime, PositionActionID, TimeZone,
OrigOrderID, OrigTradeID, RelatedTradeID`.

Aliases `Price`, `Commission`, `Code`, `Date/Time`, `OrderID` and `ExecID` are
accepted. Unknown columns are preserved verbatim. Summaries and `ST` lots
never inflate trades or P/L.

## Duplicates and corrections

- Re-uploading an identical file is idempotent: the commit reports
  `duplicate: true` and adds no second import or execution.
- Duplicate-looking fills with distinct execution IDs remain distinct
  (Scenario C).
- Corrections and cancellations are retained as revisions: the old revision is
  preserved and only an explicit correction replaces or reverses an active
  effect. Conflicting payloads surface as review rather than silently
  replacing data.
- An import can be excluded (and re-included) through a retained, reversible
  decision; raw evidence is never deleted.

## Migrations

Versioned SQL migrations run before the server accepts traffic. The server
fails closed on an incompatible schema: if the persisted schema is newer than
the application supports, startup aborts with a non-zero exit and readiness
never reports ready. Ship a matching application version rather than opening
the store.

## Backup and restore

- Backups pause commits long enough to capture a consistent snapshot, then
  include original files, transcripts and retained decisions with checksums.
  Secrets are excluded.
- Create a backup from the Maintenance UI (or `npm run backup`), then download
  the archive if needed.
- Restore is offline only and refuses to run while an instance holds the
  data-directory lock. It validates checksums, schema compatibility and
  referenced-file completeness, and makes a pre-restore backup before swapping:

  ```bash
  npm run restore -- --archive backup.tar --data-dir /data
  ```

- After restore, reconfigure credentials: secrets are never stored in a backup.

## Reset journal data and reuse model settings

In **Maintenance → Reset journal data**, review the counts, type `RESET`, and
choose **Confirm reset**. This permanently clears imports, staged uploads,
accounts, derived trades/builds, review decisions, analysis runs, conversations,
original CSV files, transcripts and job history. Model profiles, their current
compatibility checks/default selection, and existing backup archives are kept.
Create and download a backup first if you may need the journal again. Reset
refuses while uploads, model checks, replies or background jobs are active;
a cancelled job must finish stopping before reset can proceed.

For a separate fresh database, use **Maintenance → Model profiles → Export model
configuration**, then **Import model configuration** in the new instance. The
versioned JSON includes profile settings, pricing and credential references
(`env:NAME` / `file:/path`), never resolved keys or verification results. Supply
the referenced environment variables or secret files on the new instance, run
**Test**, and choose **Make default**. Import adds profiles atomically; an invalid
entry or an existing/duplicate name rejects the entire file without overwriting
anything. Rename conflicting entries in the JSON before importing. Export/import
does not automatically select a default or authorize cloud use.

Reset changes the running app's data without requiring a container restart.
It keeps the existing database file and schema; it does not erase retained backups.
If file cleanup fails after records are cleared, the app reports this explicitly;
fix data-directory permissions and repeat reset to finish removing the files.

## Health

- `GET /health/live` reports process liveness.
- `GET /health/ready` reports database and migration readiness and is
  independent of any model service.

## Development and CI

```bash
npm ci
npm run check:all      # Biome + typecheck
npm test               # vitest (unit + integration)
npm run test:coverage  # whole-source V8 coverage reports in coverage/
npm run build          # server tsc + migrations + vite frontend
npm run test:build-smoke # build + compiled-server migration smoke
npm run test:e2e       # Playwright chromium (builds + isolated servers per spec)
npm run test:docker    # compose config + real Docker smoke
```

`.github/workflows/trade-ledger.yml` runs coverage, uploads its reports, and runs
the compiled-server smoke before browser acceptance on Node 22.19.0. Browser
specs use separate temporary journals and dynamic loopback ports; the journal
spec retains its explicit serial scenario within that file. CI reuses the smoke
build with `E2E_SKIP_BUILD=1`. For local browser tests, omit that variable to build
first. No release tooling is required.

Coverage includes all TypeScript source, including files not imported by unit or
integration tests. Open `coverage/index.html` for the report; Playwright execution
is not included. The latest measured line coverage is 71.20% overall (89.82% for
server source), so the 80% whole-source target remains open. CI reports coverage
without enforcing a lower replacement threshold.
