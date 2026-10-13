# Task 2 report: SQLite storage

## RED/GREEN record

The first focused run was performed after adding the integration test and before adding storage modules:

```text
$ npm test -- test/integration/storage.test.ts
FAIL test/integration/storage.test.ts
Error: Cannot find module '../../src/server/storage/migrations.js'
Tests: 0
```

After implementing the migration, database, queue, and test-store helper, the focused suite reached green. One intermediate run exposed a missing required `strategy_views.status` value in the test fixture; the fixture was corrected and rerun successfully. Final focused assertions are included in the full run below.

## Final verification

```text
$ npm test
Test Files  2 passed (2)
Tests       18 passed (18)
```

```text
$ npm run check:all
> npm run lint
Checked 21 files in 15ms. No fixes applied.
> npm run typecheck
tsc --noEmit -p tsconfig.json
exit 0
```

```text
$ npm run test:build-smoke
> npm run build
vite build: 15 modules transformed; built dist/web/index.html and assets
Built SQLite migration, npm start health, and SIGTERM shutdown passed.
exit 0
```

The smoke uses a temporary `DATA_DIR` and an ephemeral port. It opens a fresh database through the compiled storage module, starts the exact `npm start` entrypoint, checks `/health/live`, sends SIGTERM, and confirms the endpoint stops responding. The SQL migration is copied alongside the compiled module during build.

```text
$ git diff --check
exit 0
```

## Changes

- `src/server/storage/migrations/001_initial.sql`: version-1 schema for retained imports/evidence, ledger generations, decisions, jobs, profiles, AI runs, builds, projections, previews, profile checks, and app pointers. Monetary values use `TEXT`; generation-scoped allocation foreign keys reject cross-generation rows. Raw evidence and decisions do not cascade with builds.
- `src/server/storage/migrations.ts`: transactional, idempotent migration runner that rejects a database newer than the supported schema.
- `src/server/storage/database.ts`: WAL, foreign keys, 5-second busy timeout, data/source directories, persisted-running-job interruption, store lifecycle, and synchronous transactional writes.
- `src/server/storage/queue.ts`: FIFO writer queue that drains before close.
- `test/helpers/store.ts`: isolated real SQLite store with cleanup.
- `test/integration/storage.test.ts`: real database checks for pragmas/schema, invalid cross-generation allocation, retained evidence/decisions, rollback, invocation-order writes, rejection of promise-returning transactions, reopen persistence, interrupted jobs, newer-schema refusal, and migration idempotence.
- `scripts/smoke-built-server.mjs`: compiled migration and npm-start HTTP/shutdown smoke.
- `package.json`: build copies SQL migrations to `dist/src/server/storage/migrations`, `start` targets the actual TypeScript output at `dist/src/server/main.js`, and `test:build-smoke` exposes the compiled smoke.

## Commit and concerns

Commit subject: `feat(journal): add versioned SQLite storage and writer queue`.

The existing TypeScript configuration emits under `dist/src/`; package `start` previously pointed at `dist/server/main.js`. The `start` path was corrected narrowly and is covered by the compiled smoke. No remaining Task 2 concerns were found.
