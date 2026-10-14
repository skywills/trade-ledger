# IBKR Trade Journal

A single-user, local-first journal for IBKR Flex CSV exports. One production
container serves the compiled React frontend and the Fastify API on the same
origin and port (default `3000`), storing all state under a writable `/data`
volume. Inference is optional: the journal imports, rebuilds, reviews and
displays without any model server, and a model service is never required for
readiness.

For a step-by-step install, configuration and first-run walkthrough, see
[`docs/SETUP.md`](docs/SETUP.md). For how the project is tested and how the
acceptance checks map to tests, see [`docs/TEST-PLAN.md`](docs/TEST-PLAN.md).

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
docker build -t ibkr-trade-journal .
docker run --rm -p 127.0.0.1:3000:3000 \
  -v journal-data:/data \
  -e ALLOWED_ORIGIN=http://localhost:3000 \
  ibkr-trade-journal
```

The container runs as UID/GID `1000` (non-root). Static assets live inside the
image, never on `/data`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `/data` (image) | Writable root for SQLite, imports, transcripts, backups. |
| `PORT` | `3000` | HTTP port; the container binds `0.0.0.0`. |
| `ALLOWED_ORIGIN` | required in production | Exact browser origin allowed for mutations (e.g. `http://localhost:3000`). |
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

- `env:NAME` reads the process environment variable `NAME`.
- `file:/secrets/key` reads an allowlisted file under `JOURNAL_SECRETS_DIR`.
  Mount that directory read-only, for example `./secrets:/secrets:ro`.

Responses expose only the credential's configured/missing status, never its
value. Unauthenticated local endpoints need no key; the app sends a documented
per-profile placeholder and never borrows an ambient cloud credential.

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

## Health

- `GET /health/live` reports process liveness.
- `GET /health/ready` reports database and migration readiness and is
  independent of any model service.

## Development and CI

```bash
npm ci
npm run check:all      # Biome + typecheck
npm test               # vitest (unit + integration)
npm run build          # server tsc + migrations + vite frontend
npm run test:e2e       # Playwright chromium (builds + boots the real server)
npm run test:docker    # compose config + real Docker smoke
```

`.github/workflows/ibkr-journal.yml` runs the same gates on Node 22.19.0 for
changes to the app, packaging, docs and specs. No release tooling is required.
