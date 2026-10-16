# IBKR Trade Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker-ready trade journal with one-file IBKR imports, retained evidence and decisions, rebuildable strategy views, and configurable local LLM review.

**Architecture:** A standalone app at the repository root owns a SQLite ledger and serves a React frontend from a Node backend. Original imports and decisions survive normalization and projection rebuilds; new generations activate only after validation. `nax-agent` and `nax-ai` provide bounded, opt-in model analysis rather than accounting calculations.

**Tech Stack:** Node >=22.19.0, TypeScript ESM, Fastify 5.12.7, better-sqlite3 13.0.3, csv-parse 7.0.3, decimal.js 10.6.0, React/react-dom 19.3.0, Vite 8.3.4, @vitejs/plugin-react 6.1.2, @fastify/static 10.1.6, @fastify/multipart 10.1.3, tar 7.5.22, Zod 4.3.6, Vitest 4.1.11, Playwright 1.64.0, Biome 2.5.10, TypeScript 7.0.2, @nathapp/nax-agent and @nathapp/nax-ai 0.87.1. Pin exact versions and commit an app-local npm lockfile; resolve React/SQLite type-package versions during installation and pin them too. Use Node 22.19.0 for the minimum-runtime checks and the Docker runtime. No ORM, Redis, separate worker service, or inference server bundled into the app.

**Spec:** [IBKR trade journal design](../specs/2026-10-13-ibkr-trade-journal-design.md). Read this spec before executing any task; its self-contained scenarios A–D are test oracles, not dependencies on private files.

## Global Constraints

- “TypeScript Node >=22.19 backend, SQLite, and decimal arithmetic library.”
- “The application is separate from nax's orchestration domain and consumes public @nathapp/nax-agent and @nathapp/nax-ai APIs, pinned to matching exact versions.”
- “It is not a new lockstep-published nax package.”
- “Financial decimals use canonical TEXT, never SQLite REAL.”
- “Default upload limit is 20 MiB, configurable server-side; filenames never determine storage paths.”
- “Display USD using two decimals, rounding half away from zero; preserve source precision throughout calculations.”
- “No automatic cloud fallback.”
- “Rebuild never calls the LLM.”
- “Run as a non-root user.”
- “Persist SQLite, original imports, and transcript state under a writable /data volume.”
- “Use SQLite WAL on local persistent storage, one application replica, busy timeout, and serialized mutations.”
- “One production container serves compiled frontend and backend on configurable PORT (default 3000). Container binds 0.0.0.0; compose's example binds host 127.0.0.1.”
- Exclude Google Sheets integration, automatic downloads, live prices, automated trading, advanced payoff/risk calculations, and historical ODS import.
- Never commit private files or read Downloads during tests. This repository installs the libraries from npm; do not modify the nax source repository, release versions, agent internals, or library behavior.

## Review Focus

1. A broker ID repeated under another account must not merge transactions; test in Task 5.
2. An ST-coded execution with a TradeID must not be mistaken for a supporting lot; test in Task 3.
3. Equal contract/time/price partial fills with different execution IDs must not collapse; test in Task 5.
4. A rebuild finishing after a new decision must not activate stale allocations; test in Task 9.
5. An inference endpoint redirect must not forward trade data or credentials to another origin; test in Task 12.

---

## File structure and execution rules

All application paths below are relative to this standalone repository root. Run npm commands from the repository root. This is not a Bun workspace; Task 15 adds its own CI workflow.

| Directory/file | Responsibility |
| --- | --- |
| `src/shared/{domain,api,errors}.ts` | Runtime schemas and shared DTOs, decimal strings and stable references |
| `src/server/config.ts`, `main.ts`, `app.ts` | Configuration, process lifecycle, dependency composition |
| `src/server/storage/` | SQL migrations, retained records, writer queue and read snapshots |
| `src/server/imports/` | CSV decoding/classification, normalization, preview and source-file commits |
| `src/server/ledger/` | Deduplication, revisions and durable identity resolution |
| `src/server/decisions/` | Validated append-only user decisions and strategy registry |
| `src/server/strategies/` | Grouping, lifecycle links, allocation and decimal accounting |
| `src/server/builds/` | Candidate builds, invariant validation, activation and rollback |
| `src/server/http/` | Request validation, origin checks, routes, pagination and job events |
| `src/server/ai/` | Profiles, credential references, guarded transport, sessions and proposals |
| `src/server/maintenance/` | Snapshot backups, validated offline restore and shutdown recovery |
| `src/web/{journal,imports,transactions,review,maintenance}/` | Feature pages and components; shared navigation/API client in `src/web/` |
| `test/{fixtures,helpers,unit,integration}/`, `e2e/` | Synthetic fixtures, isolated databases, mocked inference and browser flows |
| `Dockerfile`, `compose.yaml`, `.dockerignore`, `.env.example`, `README.md` | Portable runtime and operator instructions |

Prefer explicit dependencies passed to functions; do not use process-global mutable databases or active model clients. Split files listed here further only when a single responsibility grows unwieldy. Tests exercise services with real temporary SQLite databases; mock external inference and crash hooks, not financial calculations.

### Shared interfaces (define in Task 1; maintain in later tasks)

```ts
type Id = string;
type DecimalText = string; // runtime validated; no JS Number arithmetic
type SourceRef = { importId: Id; rowNumber: number };
type Issue = { key: string; code: string; sources: SourceRef[]; severity: 'warning' | 'error' };
type Instrument = { key: string; assetClass: string; symbol: string; underlying: string | null;
  conid: string | null; expiry: string | null; strike: DecimalText | null;
  putCall: 'P' | 'C' | null; multiplier: DecimalText | null };
type Execution = { key: string; account: string; instrument: Instrument; date: string;
  rawDateTime: string; timezone: string | null; quantity: DecimalText; price: DecimalText | null;
  currency: string; netCash: DecimalText; proceeds: DecimalText | null;
  commission: DecimalText | null; taxes: DecimalText | null; basis: DecimalText | null;
  brokerPnl: DecimalText | null; action: 'open' | 'close' | 'mixed' | 'unknown';
  event: 'trade' | 'assignment' | 'exercise' | 'expiry' | 'cash_settlement' | 'unsupported';
  brokerIds: Record<string, string>; codes: string[]; sources: SourceRef[] };
type RawRow = { rowNumber: number; section: string | null; fields: Record<string,string>;
  kind: 'execution' | 'lot' | 'summary' | 'marker' | 'quarantine'; issues: Issue[] };
type ParsedImport = { hash: string; rows: RawRow[]; capabilities: string[]; issues: Issue[] };
type LedgerSnapshot = { id: Id; inputHash: string; executions: Execution[];
  lots: RawRow[]; issues: Issue[]; conflicts: number };
type Decision = { id: Id; sequence: number; kind: string; sources: SourceRef[];
  strategyIds: Id[]; payload: Record<string,unknown>; supersedesId: Id | null };
type Allocation = { strategyId: Id; executionKey: string; quantity: DecimalText;
  netCash: DecimalText; brokerPnl: DecimalText | null; pnlEstimated: boolean };
type Strategy = { id: Id; type: string; currency: string; description: string;
  openingDate: string | null; closeDate: string | null; expiry: string | null;
  expiryYear: number | null; status: 'open' | 'partially_closed' | 'closed' | 'unresolved';
  complete: boolean; openingAmount: DecimalText | null; cashflow: DecimalText | null;
  brokerPnl: DecimalText | null; reconstructedPnl: DecimalText | null;
  positions: { instrumentKey: string; quantity: DecimalText }[]; reasons: string[] };
type Projection = { ledgerId: Id; watermark: number; strategies: Strategy[];
  allocations: Allocation[]; links: { from: Id; to: Id; type: string; sources: SourceRef[] }[];
  issues: Issue[] };
type BuildResult = { id: Id; status: 'active' | 'stale' | 'failed' | 'cancelled'; issues: Issue[] };
```

`Store` is a server-only exported interface in storage/database.ts containing the better-sqlite3 database handle, dataDir/sourceRoot, writer queue, and lifecycle state; do not define it recursively as ReturnType of a function returning Store or expose it to browser imports.

Additional named service inputs/results must be exported beside their producing function, with Zod request schemas at HTTP boundaries. All monetary JSON uses strings. Issue codes are stable machine strings; UI copy explains them. Write the exact test assertions below plus the listed companion cases. Names such as `fixtures.spread` refer to Task 1's synthetic bytes; tasks define their own orchestration helpers rather than rely on invisible harness functions.

### Task 1: Standalone runnable app and public library compatibility

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.server.json`, `vite.config.ts`, `vitest.config.ts`, `biome.json`, `.gitignore`, `index.html`, `src/shared/domain.ts`, `src/shared/errors.ts`, `src/server/config.ts`, `src/server/main.ts`, `src/server/app.ts`, `src/web/main.tsx`, `src/web/App.tsx`, `test/fixtures/scenarios.ts`, `test/integration/bootstrap.test.ts`.

**Interfaces:** Produces `readConfig(env: NodeJS.ProcessEnv): AppConfig` with dataDir, port, allowedOrigin, uploadLimitBytes; `createApp(config: AppConfig): Promise<FastifyInstance>` initially exposing health; `fixtures: {spread: Uint8Array; assignment: Uint8Array; partialFills: Uint8Array; reduced: Uint8Array}` encoding spec scenarios A–C; shared domain types above. Later tasks extend app dependencies, not its externally used factory signature.

- [x] **Step 1: Write the failing bootstrap and consumer tests.**

```ts
expect(readConfig({ DATA_DIR: '/tmp/journal' }).port).toBe(3000);
expect(readConfig({}).uploadLimitBytes).toBe(20 * 1024 * 1024);
const app = await createApp(readConfig({ DATA_DIR: tempDir }));
expect((await app.inject('/health/live')).statusCode).toBe(200);
expect(typeof createAgentSession).toBe('function');
expect(typeof createClient).toBe('function');
await app.close();
```

Generate only synthetic fixture bytes with explicit signed quantities, IDs and accounting values from scenarios A–C. Require runtime config to reject malformed port/origin/size rather than silently default; default development dataDir is `.data`, not the user's home.

- [x] **Step 2: Run `npm test -- test/integration/bootstrap.test.ts`; expect FAIL for missing app/config exports.**
- [x] **Step 3: Implement the factory and setup.** Install exact stack versions above with `npm install --save-exact`, configure scripts `dev`, `build`, `start`, `test` (`vitest run`), `typecheck`, `check:all` (Biome + typecheck), `test:e2e`, `test:docker`. Use `tsx` for dev only and pin its resolved version. Use React Testing Library only if a component requires unit tests; browser flows are the UI acceptance gate. `build` runs server tsc plus Vite; `start` runs `node dist/server/main.js`. Public library imports must work from installed npm packages on Node, not source path aliases. Ignore `.data/`, test outputs, credentials and `.env`, retaining `.env.example`.
- [x] **Step 4: Run the targeted test, `npm run typecheck`, and `npm run build`; expect successful Node import and clean output.**
- [x] **Step 5: Commit only this task's files: `git commit -m "feat(journal): bootstrap standalone Node and React app"`.**

### Task 2: SQLite schema, retained evidence and writer serialization

**Files:** Create `src/server/storage/database.ts`, `migrations.ts`, `migrations/001_initial.sql`, `queue.ts`, `test/helpers/store.ts`, `test/integration/storage.test.ts`.

**Interfaces:** Produces `openStore(dataDir: string): Store`, `closeStore(store: Store): Promise<void>`, `write<T>(store: Store, operation: () => T): Promise<T>`, `createTestStore(): Promise<{store: Store; dataDir: string; dispose(): Promise<void>}>`. Store owns SQLite handle, source root and queue; only storage/services access SQL. Add `schema_migrations`, all spec tables, import previews, profile-check records and app default-profile pointer. Keys/FKs include generation IDs; raw evidence and decisions cannot cascade-delete with builds.

- [x] **Step 1: Write failing storage tests.**

```ts
expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);
expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
expect(store.db.prepare("SELECT type FROM pragma_table_info('strategy_views') WHERE name='opening_amount'").get()).toEqual({type:'TEXT'});
expect(tableNames(store.db)).toEqual(expect.arrayContaining(['imports','import_rows','identity_bindings','decisions','llm_profiles','builds']));
```

Also assert invalid cross-generation allocation FK rejection, rollback on failed write, ordered concurrent writes, reopen persistence, newer-schema refusal, and migration rerun idempotence. `tableNames` is a test-local SQL helper.

- [x] **Step 2: Run `npm test -- test/integration/storage.test.ts`; expect FAIL for missing database/migration.**
- [x] **Step 3: Implement schema and queue.** Use better-sqlite3 transactions, WAL, foreign keys and 5000 ms busy timeout; columnize filter/identity fields while retaining unknown source JSON. Queue operations cannot hold SQL transactions across awaits. Use a persisted `jobs` row for long operations; mark previously running jobs interrupted on startup. Task 9 owns candidate-build recovery.
- [x] **Step 4: Run the storage tests and `npm run typecheck`; expect all persistence, FK and queue assertions PASS.**
- [x] **Step 5: Commit `git commit -m "feat(journal): add versioned SQLite storage and writer queue"`.**

### Task 3: Flex CSV parsing, row classification and capability reporting

**Files:** Create `src/server/imports/csv.ts`, `headers.ts`, `classification.ts`, `normalization.ts`, `test/unit/csv.test.ts`.

**Interfaces:** Consumes shared types and fixture bytes. Produces `parseFlex(bytes: Uint8Array, limitBytes = 20971520): ParsedImport`; `normalizeExecution(row: RawRow, source: SourceRef, reportTimezone: string | null): {execution: Execution | null; issues: Issue[]}`. Import-local execution keys are source placeholders; Task 5 establishes canonical identity.

- [ ] **Step 1: Write failing parsing tests.**

```ts
expect(parseFlex(fixtures.spread).rows.filter(r=>r.kind==='execution')).toHaveLength(4);
expect(parseFlex(fixtures.spread).rows.filter(r=>r.kind==='lot')).toHaveLength(2);
expect(parseFlex(stCodedExecutionWithTradeId).rows[0].kind).toBe('execution');
expect(normalizeExecution(badDecimalRow, ref, null).execution).toBeNull();
```

Test BOM/CRLF, quoted commas and multiline descriptions, repeated accounts/headers, exact aliases from spec, semicolon-separated codes, no-ID lots versus zero-priced events, timezone preservation, malformed encoding, oversized bytes, null missing P/L versus explicit zero, and unknown columns. Add test-local synthetic variants rather than private files.

- [ ] **Step 2: Run `npm test -- test/unit/csv.test.ts`; expect FAIL for missing parser.**
- [ ] **Step 3: Implement streaming-safe CSV decoding and normalization.** Use csv-parse without numeric auto-casting, fatal UTF-8 decoding, field-name header detection and explicit row kinds. Dates normalize to ISO calendar values; never apply server timezone to unknown source times. Money uses decimal.js validation/canonicalization. Derive NetCash only from complete accounting operands. Unknown section/checksum semantics produce capability diagnostics; recognized row counts are checked, not guessed sums.
- [ ] **Step 4: Run parser tests and typecheck; expect all alias, lot, encoding and size cases PASS.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): parse Flex executions and supporting lots"`.**

### Task 4: Import preview, crash-safe original storage and commit

**Files:** Create `src/server/imports/service.ts`, `files.ts`, `test/integration/imports.test.ts`.

**Interfaces:** Consumes `parseFlex`, `write` and Store. Produces `previewImport(store: Store, input: {filename: string; bytes: Uint8Array; timezone: string | null}): Promise<ImportPreview>` (id, hash, capabilities, counts, issues); `commitImport(store: Store, previewId: Id): Promise<{importId: Id; duplicate: boolean}>`; `recoverImportFiles(store: Store): Promise<void>`; `listImports(store: Store): ImportSummary[]`. Preserve originals under hash-based paths inside dataDir.

- [ ] **Step 1: Write failing import tests.**

```ts
const p = await previewImport(store, {filename:'../../escape.csv', bytes:fixtures.spread, timezone:null});
const first = await commitImport(store, p.id);
expect((await commitImport(store, p.id)).importId).toBe(first.importId);
expect(listImports(store)).toHaveLength(1);
expect(readOriginal(store, first.importId)).toEqual(fixtures.spread);
```

`readOriginal` is a test-local lookup/read helper. Assert all original rows including quarantine persisted, exact-file repeated uploads remain idempotent, staged previews survive commit retry, no path traversal, failure before/after durable rename or SQL commit yields recoverable original/file metadata, and expired uncommitted previews clean up. Preview TTL is 24 hours; committed originals never expire.

- [ ] **Step 2: Run `npm test -- test/integration/imports.test.ts`; expect FAIL for missing service.**
- [ ] **Step 3: Implement two-phase file commit.** Stage bounded original bytes, flush/rename to content-addressed immutable destination before transactional database insertion, then mark preview committed. On crash orphan original bytes can be reclaimed only after checking no committed reference; missing committed files are corruption errors, never silently removed imports. Inject filesystem fault hooks only in the app service test seam. Expose issues before confirmation; commit does not require all rows to normalize.
- [ ] **Step 4: Run import tests and typecheck; expect idempotence and all crash-point cases PASS.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): retain crash-safe import evidence"`.**

### Task 5: Reproducible ledger, identity resolution and corrections

**Files:** Create `src/server/ledger/identity.ts`, `revisions.ts`, `normalize.ts`, `test/integration/ledger.test.ts`.

**Interfaces:** Consumes committed raw rows, normalizeExecution and retained identity decisions. Produces `normalizeLedger(store: Store, options: {parserVersion: string; decisionWatermark: number}): Promise<LedgerSnapshot>`; `readLedger(store: Store, ledgerId: Id): LedgerSnapshot`. The version implemented is `flex-v1`; unknown requested version throws `VERSION_UNAVAILABLE`.

- [ ] **Step 1: Write failing ledger tests.**

```ts
const ledger = await normalizeLedger(store, {parserVersion:'flex-v1', decisionWatermark:0});
expect(ledger.executions.filter(e=>e.instrument.underlying==='VIX').reduce((q,e)=>q.plus(e.quantity),new Decimal(0)).toString()).toBe('4');
expect(ledger.executions.map(e=>e.key)).toHaveLength(2);
expect(sameTradeIdOtherAccount.executions).toHaveLength(2);
```

Set up committed scenario C and re-exported duplicates using Task 4. Companion tests: multiple source occurrences per execution; TradeID↔ExecID alias matching; weak booked rows remain separate until accepted identity binding; original/correction/cancellation revisions with explicit references; missing later-window rows stay active; conflicting payloads create review and no silently active replacement; broker-ID leading zeros; import exclusion removes only its contribution; same input full re-normalization preserves financial content/source references.

- [ ] **Step 2: Run `npm test -- test/integration/ledger.test.ts`; expect FAIL for missing normalizer.**
- [ ] **Step 3: Implement identity/revision resolution.** Deterministic raw-source order plus explicit revision evidence drives ordering, never upload time alone. Strong IDs are account-scoped and aliases unify only nonconflicting evidence. Preserve lot rows separately. Canonical keys and source bindings are stable across ledger generations; only unambiguous current revisions enter executions. Retain conflict/quarantine issues and mark totals incomplete. Do not treat a changed payload as a correction without evidence or a user identity decision.
- [ ] **Step 4: Run ledger/import tests and typecheck; expect scenario C, cross-account and correction cases PASS.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): normalize deduplicated revision-aware ledger"`.**

### Task 6: Retained decisions and stable strategy identities

**Files:** Create `src/server/decisions/schemas.ts`, `service.ts`, `registry.ts`, `test/integration/decisions.test.ts`.

**Interfaces:** Produces `appendDecision(store: Store, input: DecisionInput, expectedWatermark: number): Promise<Decision>`; `readDecisions(store: Store, watermark: number): Decision[]`; `decisionWatermark(store: Store): number`; `strategyId(store: Store, anchor: {account: string; openingKeys: string[]}): Id`. DecisionInput is a Zod discriminated union for all 10 spec kinds, each with stable refs/strategy IDs and explicitly typed payload. Exports `effectiveDecisions(decisions: Decision[]): Decision[]`.

- [ ] **Step 1: Write failing decision tests.**

```ts
expect(strategyId(store,{account:'A',openingKeys:['b','a']})).toBe(strategyId(store,{account:'A',openingKeys:['a','b']}));
const d = await appendDecision(store, notesInput, 0);
expect(d.sequence).toBe(1);
await expect(appendDecision(store, stopLossInput, 0)).rejects.toMatchObject({code:'STALE_INPUT'});
expect(readDecisions(store,1)[0].payload).toEqual(notesInput.payload);
```

Define input literals in the test using exported schema types. Assert source existence/quantity validation, supersession only of earlier decisions, conflicts not implicit last-writer allocation wins, splits/merges with explicit identity and metadata ownership, rejected evidence hashes retained, duplicate requests idempotent by client request ID, exclusion/reinclusion, and decision remapping after corrected quantity yields orphan review rather than changed grouping.

- [ ] **Step 2: Run `npm test -- test/integration/decisions.test.ts`; expect FAIL for missing retained services.**
- [ ] **Step 3: Implement transactionally ordered decisions and registry.** Identity-binding rows are materialized retained links backed by immutable decisions. Stable anchors hash account + sorted canonical opening refs; incomplete groups use retained source anchors. Metadata remains in retained decisions. Accept manual allocations only after validating against a fixed ledger snapshot; unrelated old metadata edits need not overrule valid current allocations.
- [ ] **Step 4: Run decisions/ledger tests and typecheck; expect stable identity and stale-write assertions PASS.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): preserve review decisions and strategy identities"`.**

### Task 7: Strategy grouping, closes and option lifecycle links

**Files:** Create `src/server/strategies/grouping.ts`, `matching.ts`, `lifecycle.ts`, `projection.ts`, `test/integration/strategies.test.ts`.

**Interfaces:** Consumes LedgerSnapshot, effective decisions and registry callback. Produces `groupStrategies(ledger: LedgerSnapshot, decisions: Decision[], resolveId: (account: string, keys: string[]) => Id): Projection`. Projection initially identifies legs/allocations/links; Task 8 completes amounts. Non-financial status classification is included here. All allocation roles retain the execution's signed units.

- [ ] **Step 1: Write failing scenario/grouping tests.**

```ts
expect(grouped.strategies.find(s=>s.type==='bull_put_spread')?.positions.every(p=>p.quantity==='0')).toBe(true);
expect(assignmentProjection.links.filter(l=>l.type==='assignment' || l.type==='exercise')).toHaveLength(2);
expect(reducedProjection.issues.map(i=>i.code)).toContain('LIFECYCLE_UNRESOLVED');
expect(rollProjection.strategies).toHaveLength(2);
```

Build ledgers using Tasks 4–5. Assert one verified opening group across fills, separate close/open roles within one order, same-symbol/expiry distinct openings, deterministic multi-open ambiguity rather than arbitrary FIFO, known lot references for closes, common vertical classifications from signed leg direction, mixed-expiry custom groups, partial closure, shares, expiration without assumed price source, explicit cash settlement, missing multiplier warnings, and unsupported corporate-action inventory blocking closure. Scenario B default retains separate linked option/stock strategies; accepted consolidation changes presentation without duplicating allocations.

- [ ] **Step 2: Run `npm test -- test/integration/strategies.test.ts`; expect FAIL for missing grouping.**
- [ ] **Step 3: Implement deterministic grouping and matching.** BrokerageOrderID proposes execution groups; validate account, currency, quantities and event actions before classification. Lot evidence resolves explicit closes; otherwise unique compatible known exposure can match and ambiguous matches require decisions. Apply retained manual allocations before automatic matching of the remainder. No missing opening invented. Unresolved groups get durable anchors; lifecycle actions validate contract/event/share-unit consistency. Record roll links without merging P/L.
- [ ] **Step 4: Run strategies/decisions tests and typecheck; expect A–C lifecycle and exposure assertions PASS.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): consolidate strategies and option lifecycle events"`.**

### Task 8: Decimal accounting, allocation conservation and journal values

**Files:** Create `src/server/strategies/accounting.ts`, `allocation.ts`, `src/shared/money.ts`, `test/unit/accounting.test.ts`, `test/integration/accounting.test.ts`.

**Interfaces:** Produces `accountProjection(ledger: LedgerSnapshot, projection: Projection): Projection`; `splitAmount(amount: DecimalText, parts: {strategyId: Id; quantity: DecimalText}[]): {strategyId: Id; amount: DecimalText}[]`; `formatMoney(value: DecimalText | null, currency: string): string`; `validateProjection(ledger: LedgerSnapshot, projection: Projection): Issue[]`. Split precision is source scale plus 18 fractional places, final residual assigned deterministically; displayed currency fraction digits come from Intl currency metadata with USD=2.

- [ ] **Step 1: Write failing accounting tests.**

```ts
expect(axon.openingAmount).toBe('-284.5018378');
expect(axon.cashflow).toBe('-451.6607454');
expect(axon.brokerPnl).toBe('-451.660745');
expect(formatMoney(axon.brokerPnl,'USD')).toBe('-451.66');
expect(formatMoney('-449.212451','USD')).toBe('-449.21');
expect(formatMoney(null,'USD')).toBe('Unavailable');
```

Assert closeDate=2026-09-25, half-away-from-zero ties, supporting lots not summed, zero versus null, one-minor-unit reconciliation threshold, estimated proportional P/L labeling, conserved residual for three-way splits, negative/short quantity partitioning without sign reversal, available broker P/L with missing openings but null reconstructed P/L, stock basis transfers distinct from net cash, mixed currencies without combined totals, 2027 expiry year versus 2026 opening, and over-allocation hard errors.

- [ ] **Step 2: Run `npm test -- test/unit/accounting.test.ts test/integration/accounting.test.ts`; expect FAIL for missing financial functions.**
- [ ] **Step 3: Implement exact decimal computations.** Never convert values to Number or SQLite SUM(REAL). Sum explicit opening NetCash then negate for journal amount. Only comparable complete lifecycle cashflow becomes reconstructed P/L. Populate expiry year/status/completeness and unresolved buckets; retain broker P/L separately. Validate signed allocation partitions and per-account/currency amounts including unresolved entries; conflicts/quarantine suppress definitive totals.
- [ ] **Step 4: Run accounting and strategy tests, then typecheck; expect all reference arithmetic and invariants PASS.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): calculate exact strategy accounting"`.**

### Task 9: Versioned builds, atomic activation and rollback

**Files:** Create `src/server/builds/service.ts`, `snapshot.ts`, `repository.ts`, `test/integration/builds.test.ts`.

**Interfaces:** Produces `rebuild(store: Store, input: {mode:'full'|'projection'; parserVersion:string; algorithmVersion:string; signal:AbortSignal}): Promise<BuildResult>`; `activeProjection(store: Store): {buildId: Id | null; stale: boolean; projection: Projection | null}`; `rollbackBuild(store: Store, buildId: Id): Promise<void>`; `recoverBuilds(store: Store): Promise<void>`. Algorithm version is `strategies-v1`. Add queue job coalescing for imports/decisions and long-operation progress events, captured by Task 10.

- [ ] **Step 1: Write failing build tests.**

```ts
const original = activeProjection(store).buildId;
await expect(rebuild(store,badVersionInput)).rejects.toMatchObject({code:'VERSION_UNAVAILABLE'});
expect(activeProjection(store).buildId).toBe(original);
expect((await rebuild(store,cancelledInput)).status).toBe('cancelled');
expect(staleCandidate.status).toBe('stale');
expect(activeProjection(store).buildId).toBe(original);
```

Create paused-build fault hooks to commit a new decision before activation. Assert full/projection rebuild financial equality, notes/rejections/identity bindings preserved after deleting projections and normalized rows, reader build consistency, hard invariant failure versus activatable warning, first build empty-state, interrupted startup recovery, batched job coalescing, rollback staleness, and no AI calls during rebuild.

- [ ] **Step 2: Run `npm test -- test/integration/builds.test.ts`; expect FAIL for missing build lifecycle.**
- [ ] **Step 3: Implement fixed manifests and atomic compare-and-switch.** Candidate persists with ledger generation and decision watermark; validate outside activation transaction, then compare current inputs and switch singleton pointer in one write. Do not monopolize the writer queue for the entire computation: snapshot first, compute outside queue, enqueue persistence/activation stages. Interrupted candidate generations are failed and never active; keep last valid data. Unknown historical versions reject explicitly.
- [ ] **Step 4: Run builds and existing domain tests, then typecheck; expect stale/cancelled candidates cannot activate.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): activate validated rebuild generations atomically"`.**

### Task 10: Validated HTTP API, pagination and job progress

**Files:** Create `src/shared/api.ts`, `src/server/http/origin.ts`, `routes-imports.ts`, `routes-journal.ts`, `routes-review.ts`, `routes-jobs.ts`, `events.ts`, `test/integration/http.test.ts`; Modify `src/server/app.ts`, `main.ts`.

**Interfaces:** Extend `createApp(config)` to compose Store and services. Produce `registerJournalRoutes(app: FastifyInstance, store: Store): Promise<void>` and equivalent imports/review/jobs registration functions. Export DTO schemas in shared/api.ts; list responses are `{items, page, pageSize, total, buildId, stale}`, with page>=1 and pageSize 1–100 (default 25). Job events use SSE with persisted terminal job state; browser reconnect reads current status.

- [ ] **Step 1: Write failing API tests with Fastify inject.**

```ts
expect((await app.inject('/api/journal?pageSize=101')).statusCode).toBe(400);
expect((await app.inject({method:'POST',url:'/api/builds',headers:{origin:'https://other.example'},payload:{mode:'full'}})).statusCode).toBe(403);
expect((await app.inject('/api/journal')).json().buildId).toBeNull();
expect((await app.inject('/health/ready')).statusCode).toBe(200);
```

Assert multipart 20 MiB bound before full buffering, malicious filenames, raw preview/commit provenance, server-side stale decision/proposal rejection (409), unsupported JSON types (415), no secret values in responses, build-consistent pagination, raw quarantine visibility without active ledger, client-request idempotency, cancellation and progress persistence. GET health must not require a running model.

- [ ] **Step 2: Run `npm test -- test/integration/http.test.ts`; expect FAIL for missing routes.**
- [ ] **Step 3: Implement routes and lifecycle.** Routes: `POST /api/imports/preview` (multipart files, per-file preview), `POST /api/imports/:previewId/commit`, `GET /api/imports`, `GET /api/imports/:id/rows`, `GET /api/transactions`, `GET /api/lots`, `GET /api/journal`, `GET /api/strategies/:id`, `GET /api/review`, `POST /api/decisions`, `POST /api/builds`, `POST /api/builds/:id/rollback`, `GET /api/jobs/:id`, `GET /api/jobs/:id/events`, `POST /api/jobs/:id/cancel`. Errors use `{code,message,issues}`. Require configured Origin for browser mutations; reject missing Origin on browser mutation API (operator CLI invokes services directly). SSE is GET; no WebSockets. Sort keys are allowlisted and parameterized. Health routes are `/health/live` and `/health/ready`; readiness follows migrations/data access only.
- [ ] **Step 4: Run API and import/build tests, then typecheck; expect size, origin, pagination and job assertions PASS.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): expose validated journal and review API"`.**

### Task 11: Usable journal, import, ledger and manual-review screens

**Files:** Create `src/web/api.ts`, `navigation.tsx`, `styles.css`, `journal/JournalPage.tsx`, `journal/StrategyDetail.tsx`, `imports/ImportsPage.tsx`, `transactions/TransactionsPage.tsx`, `review/ReviewPage.tsx`, `review/DecisionEditor.tsx`, `maintenance/MaintenancePage.tsx`, `playwright.config.ts`, `e2e/journal.spec.ts`; Modify `src/web/App.tsx`.

**Interfaces:** Consumes shared DTO schemas and Task 10 routes. Produces `request<T>(path:string, schema: z.ZodType<T>, options?:RequestInit): Promise<T>` and React pages; server buildId/stale drives each view. Routing uses browser history with paths `/journal`, `/strategies/:id`, `/imports`, `/transactions`, `/review`, `/maintenance`; Fastify static fallback serves index.html only for frontend paths, never unknown `/api/*` routes.

- [ ] **Step 1: Write failing Playwright flows against a temporary app data directory.**

```ts
await page.getByRole('link',{name:'Imports'}).click();
await page.getByLabel('CSV files').setInputFiles({name:'spread.csv',mimeType:'text/csv',buffer:Buffer.from(fixtures.spread)});
await page.getByRole('button',{name:'Confirm import'}).click();
await page.getByRole('link',{name:'Journal'}).click();
await expect(page.getByRole('row').filter({hasText:'AXON'})).toContainText('-451.66');
```

Assert duplicate upload no extra strategy row; opening debit/credit -284.50; close date 2026-09-25; null displays Unavailable not zero; source-row drilldown; multi-currency filter without global summed P/L; add notes/stop loss then full rebuild retains them; manual identity/group/split/merge/lifecycle/exclusion/rejection edits preview allocations before confirmation; stale-write refresh; keyboard-operable labeled inputs and focused error summary; no active build, loading, stale and failure states. Test partial-close view and expiry Year 2027, stock no year.

- [ ] **Step 2: Run `npm run test:e2e -- e2e/journal.spec.ts`; expect FAIL for missing pages/actions.**
- [ ] **Step 3: Implement screens.** Journal columns: Open date, Close date, Status, Expiry, Year, Symbol/description, Quantity/remaining, Debit/credit, Broker realized P/L, Reconstructed P/L, Completeness. Display source precision in detail; never recompute money with JS Number in the browser. Provide separate lot tab and revision history, import issues/capability preview, review candidates and explicit quantity edits, metadata fields, and rebuild/rollback controls. Grouping editor lists stable refs with quantities; it never asks a user to edit JSON. Use confirmation previews for financially consequential manual decisions. Use a simple responsive table/detail layout, no dashboard chart or risk-field fabrication.
- [ ] **Step 4: Run browser flows, typecheck and build; expect user actions and persisted values PASS without AI configured.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): add journal import and manual reconciliation UI"`.**

### Task 12: Local model profiles, credential isolation and guarded transport

**Files:** Create `src/server/ai/profiles.ts`, `credentials.ts`, `transport.ts`, `catalog.ts`, `compatibility.ts`, `src/server/http/routes-models.ts`, `src/web/maintenance/ModelsPanel.tsx`, `test/helpers/inference-server.ts`, `test/integration/models.test.ts`; Modify `src/server/app.ts`, `src/shared/api.ts`, `src/web/maintenance/MaintenancePage.tsx`.

**Interfaces:** Produces `saveProfile(store:Store,input:ProfileInput,expectedRevision:number|null): Promise<LlmProfile>`; `selectDefaultProfile(store:Store,id:Id): Promise<void>`; `snapshotProfile(store:Store,id:Id): LlmProfileSnapshot`; `openModelConnection(profile:LlmProfileSnapshot,secrets:SecretResolver): Promise<ModelConnection>`; `testProfile(store:Store,id:Id,signal:AbortSignal): Promise<CompatibilityResult>`. ProfileInput/Snapshot export endpoint/model/provider/protocol/contextWindow/maxTokens/timeoutSeconds/supportsTools/thinkingLevels/credentialRef/local-or-cloud mode; limits validated positive with maxTokens<contextWindow. ModelConnection exposes session backend options, guarded baseUrl and `close(): Promise<void>`.

- [ ] **Step 1: Write failing model integration tests with synthetic OpenAI SSE servers.**

```ts
expect(snapshotProfile(store,localA.id).modelId).toBe('test-local-a');
expect((await testProfile(store,localA.id,signal)).status).toBe('verified');
expect((await testProfile(store,textOnly.id,signal)).reason).toBe('TOOLS_UNSUPPORTED');
expect(await otherOrigin.receivedRequests()).toHaveLength(0);
expect(await cloudServer.receivedRequests()).toHaveLength(0);
```

Assert two endpoints receive only their own profile calls; empty API key succeeds with documented local-only placeholder where adapter needs it; environment cloud key is never borrowed; credentials/header/URL secret redaction; manual model-ID entry; unreachable/timeout/malformed arguments versus no tool call; profile edit invalidates old compatibility check; cloud default cannot silently replace local selection; redirect to different origin does not forward requests or auth; saved profiles persist across restart.

- [ ] **Step 2: Run `npm test -- test/integration/models.test.ts`; expect FAIL for missing profile/transport services.**
- [ ] **Step 3: Implement isolated profile routing.** Initial local adapter ID is existing `openai`, protocol `openai-completions`; local catalog pricing is zero solely to satisfy required catalog fields, while app usage costSource remains unpriced unless the user explicitly supplies rates; arbitrary local model IDs use nax-agent's `ProviderCatalogOverride` shape. Map known schema fields from the public type, don't invent a provider ID `ollama`. Configure direct nax-ai compatibility calls with matching client/protocol override catalogs. Requests go through an ephemeral loopback gateway owned by ModelConnection: Node fetch `redirect:'manual'`, fixed configured upstream origin/base path, bounded response/timeout, private session token, and safe auth injection. This prevents library fetch redirects leaking evidence; unknown gateway paths are rejected. Client credentials use only the gateway token/local placeholder; upstream credentials remain in gateway memory. Reject URL userinfo; credential headers reference mounted/env secrets. No journal bytes in synthetic test calls. UI/API routes: CRUD-like retained/revisioned `/api/models`, `/api/models/default`, `/api/models/:id/test`; disabled profiles retain provenance, no destructive deletion. Record profile revision + endpoint + model tested. Model discovery is optional and omitted in first release; manual entry is required.
- [ ] **Step 4: Run models tests/typecheck and a public-library integration call on Node >=22.19; expect verified synthetic tool-call roundtrip and zero redirect/cloud requests.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): configure isolated local model profiles"`.**

### Task 13: Bounded nax-agent analysis and review proposals

**Files:** Create `src/server/ai/evidence.ts`, `tools.ts`, `proposals.ts`, `analysis.ts`, `src/server/http/routes-analysis.ts`, `src/web/review/AnalysisPanel.tsx`, `test/integration/analysis.test.ts`; Modify `src/server/app.ts`, `src/web/review/ReviewPage.tsx`, `src/shared/api.ts`.

**Interfaces:** Produces `startAnalysis(store:Store,input:{profileId:Id;buildId:Id;issueKeys:string[];cloudConfirmed:boolean},signal:AbortSignal): Promise<Id>`; `validateProposal(ledger:LedgerSnapshot,proposal:Proposal): Issue[]`; `acceptProposal(store:Store,runId:Id,proposalId:Id,expectedWatermark:number): Promise<Decision[]>`. Proposal is a discriminated union matching financial decisions from Task 6; validation reuses domain invariants. Evidence chunks carry stable references and hash; ai_run persists immutable profile/evidence snapshot.

- [ ] **Step 1: Write failing real-library/mock-endpoint tests.**

```ts
expect(run.profileSnapshot.modelId).toBe('test-local-a');
expect(run.status).toBe('proposal_ready');
expect(decisionWatermark(store)).toBe(0); // model proposals do not commit decisions
expect(validateProposal(ledger,overAllocated).map(i=>i.code)).toContain('OVER_ALLOCATION');
expect(offeredTools).not.toEqual(expect.arrayContaining(['Bash','Read','Write','GitCommit']));
```

Assert missing verification blocks agent job, cross-batch source references survive, synthetic prompt injection cannot access files or execute commands, stale snapshot fails acceptance, default-profile edit cannot mutate running job, model change creates a fresh session, cancellation/turn timeout/proposal parse error persists failure without decisions, usage/cost source not invented, no cloud fallback, explicit cloud choice requires confirmation, rebuild calls no model, and local endpoint down leaves manual UI functional. Inspect actual offered tool descriptors at mock endpoint, not only application tool names.

- [ ] **Step 2: Run `npm test -- test/integration/analysis.test.ts`; expect FAIL for missing analysis service.**
- [ ] **Step 3: Implement job analysis through public sessions.** Use `createAgentSession({backend:nativeBackend(...),profile:'none',instructions,tools,transcriptStore,turnTimeoutSeconds})`, omit workdir and do not set bashApproval/allowUnsandboxed. Repository code shows profile none retains universal private scratchpad/question tools; tests must allow only those bounded built-ins plus `inspect_transactions`, `inspect_positions`, `submit_proposal`, and must prove no general filesystem/shell access. Close session and gateway on every terminal path. Transcripts stay under dataDir; credentials never enter prompts. Context accounting uses conservative UTF-8 byte upper bound plus a reserved instruction/tool/output budget and max 50 evidence rows per batch; reject oversized single rows for manual review. Configurable defaults: 120 seconds per job, 4096 max output tokens, 8 model rounds, 16384 total generated tokens; stop via session.cancel on observed limits. Report that token/cost enforcement may overshoot by one provider response when counters arrive only after a round. Read tool payloads capped at 64 KiB. Fixed schemas validate IDs/allocations; no direct decision-writing tool. SSE job events include question requests; add `POST /api/analysis/:id/answer` mapping bounded user text to `session.answer(requestId,{text})`. Test answered, expired and cancelled question IDs; unanswered questions end with the job timeout, not an indefinitely running job. Routes `/api/analysis`, `/api/analysis/:id`, `/api/analysis/:id/accept`, `/api/analysis/:id/reject` integrate review UI. Acceptance routes append retained decisions only after revalidation.
- [ ] **Step 4: Run analysis/models/browser review tests and typecheck; expect model proposal review succeeds and forbidden tools/data movement fail.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): add bounded local AI reconciliation proposals"`.**

### Task 14: Consistent backup, offline restore and maintenance controls

**Files:** Create `src/server/maintenance/backup.ts`, `restore.ts`, `cli.ts`, `src/server/http/routes-maintenance.ts`, `test/integration/backup.test.ts`; Modify `src/server/main.ts`, `app.ts`, `src/web/maintenance/MaintenancePage.tsx`, `package.json`.

**Interfaces:** Produces `createBackup(store:Store,outputPath:string): Promise<BackupManifest>`; `restoreBackup(archivePath:string,targetDir:string): Promise<void>` (offline CLI only); `shutdown(store:Store,signal:AbortSignal): Promise<void>`. Manifest includes schema/app versions, exact file hashes, SQLite snapshot hash, decision watermark, profile records and transcript snapshots, excluding secrets. Add `npm run backup -- --output <path>` and `npm run restore -- --archive <path> --data-dir <path>`; backup CLI uses a stopped app or server job, never a competing live writer.

- [ ] **Step 1: Write failing backup/recovery tests.**

```ts
await createBackup(store,archive);
await restoreBackup(archive,freshDir);
expect(restored.decisions).toEqual(original.decisions);
expect(restored.projection.strategies).toEqual(original.projection.strategies);
expect(archiveEntries).not.toContain('secrets/provider-key');
await expect(restoreBackup(corruptArchive,freshDir)).rejects.toMatchObject({code:'BACKUP_INVALID'});
```

Assert raw originals/profiles/notes/rejections/source hashes survive; corrupted/missing files and newer schema reject before replacement; archive traversal/symlink entries reject; restore refuses running app via single-process lock; pre-restore backup created; in-flight import/decision changes never enter half a snapshot; mutable transcripts captured consistently by pausing analysis jobs or snapshotting transcript bytes under a short exclusive lock; SIGTERM leaves active build safe.

- [ ] **Step 2: Run `npm test -- test/integration/backup.test.ts`; expect FAIL for missing snapshot services.**
- [ ] **Step 3: Implement consistency barrier and restore.** Queue a manifest snapshot barrier, pause source/decision mutations and transcript writes, use better-sqlite3 backup facility, copy referenced mutable transcript bytes into staging, then release lock and archive immutable originals/snapshot files with tar. Secrets are external files/env and excluded by allowlisted archive roots, not filename guessing. Restore extracts to validated staging, validates all hashes/schema, makes pre-restore backup, then swaps only a stopped instance's data directory. Online API creates/downloads backups and shows jobs; web restore only gives offline instructions. Single-process data-dir lock acquired at startup and honored by CLI, with verified stale-lock recovery after crash.
- [ ] **Step 4: Run backup/build/import recovery tests and typecheck; expect roundtrip and tamper rejection PASS.**
- [ ] **Step 5: Commit `git commit -m "feat(journal): add consistent backup and offline restore"`.**

### Task 15: Docker distribution, CI and full acceptance gates

**Files:** Create `Dockerfile`, `compose.yaml`, `.dockerignore`, `.env.example`, `README.md`, `scripts/docker-smoke.mjs`, `scripts/local-model-smoke.mjs`, `test/integration/acceptance.test.ts`, `.github/workflows/trade-ledger.yml`; Modify `package.json`, `src/server/app.ts` for production static serving, `src/server/main.ts` for process lock/readiness.

**Interfaces:** Produces one app image, runtime env `DATA_DIR=/data`, `PORT=3000`, `ALLOWED_ORIGIN=http://localhost:3000`, `UPLOAD_LIMIT_BYTES=20971520`; secret refs use `env:NAME` or allowlisted mounted file path. Docker build context is the repository root, no root workspace build needed. Compose maps `127.0.0.1:3000:3000`, a named /data volume and `host.docker.internal:host-gateway`.

- [ ] **Step 1: Write failing Docker and final acceptance tests.**

```ts
expect(containerUid).not.toBe('0');
expect(await fetchHealth('/health/ready')).toBe(200);
expect(await importedStrategyCount()).toBe(1);
await restartSameVolume();
expect(await importedStrategyCount()).toBe(1);
expect(await storedLocalModelId()).toBe('test-local-a');
```

The docker-smoke.mjs script defines these checks through Docker CLI and HTTP; test helpers must clean only uniquely labeled containers/volumes they create. Final acceptance.test.ts reconstructs scenarios A–D via service APIs, deletes normalized/projection data, full-rebuilds, verifies decisions/arithmetic, backs up and restores; inference server is synthetic. Test production SPA deep links, unknown API 404, migration failure readiness, SIGTERM, no model service readiness dependence, and same-origin import from actual browser.

- [ ] **Step 2: Run `npm run test:docker` and `npm test -- test/integration/acceptance.test.ts`; expect initial FAIL for missing Dockerfile/acceptance flow.**
- [ ] **Step 3: Implement portable packaging and operator docs.** Multi-stage `node:22.19.0-bookworm-slim`, `npm ci`, compile server and frontend, copy only runtime artifacts, production dependencies and migrations. Native SQLite dependency builds in matching Debian stages. Run UID/GID 1000 with writable named volume and static assets outside /data; document bind-mount ownership and no network-filesystem WAL. Set HEALTHCHECK for readiness. Compose has no model server/cloud key by default. Document host and compose-network inference URLs, optional real local smoke command, tool capability requirements, reverse-proxy authentication/origin setup, profile credential refs, import field list, duplicate/correction handling, backup/restore, explicit migration failures, and single replica. Optional real-model smoke sends only synthetic data and never changes journal decisions. App-specific CI installs pinned deps, runs typecheck/check:all/build/test/browser/Docker smoke on Node 22.19.0; path filters include app and relevant library/spec changes. No nax release tooling is part of this repository.
- [ ] **Step 4: Run from app: `npm ci`, `npm run check:all`, `npm test`, `npm run build`, `npm run test:e2e`, `npm run test:docker`; expect all exit 0.** This standalone repository has no root Bun workspace gates. The npm app gates above are authoritative; do not run or modify the nax monorepo. If Docker is unavailable, report its smoke check as unverified and do not claim Docker completion until a usable daemon/CI confirms it.
- [ ] **Step 5: Commit `git commit -m "feat(journal): ship Docker app with acceptance and CI gates"`.**

## Spec coverage and self-review

| Spec requirements / acceptance checks | Owning tasks |
| --- | --- |
| Scope, separate app/public packages, manual CSV, no Sheets | 1, 10–11, 15 |
| CSV formats, capabilities, limits, supporting lots, private-fixture isolation (1,12,16) | 1, 3–4, 10, 15 |
| Duplicate IDs, revisions, quarantine, identity, source evidence (2,3,13) | 2–6 |
| Stable decisions, split/merge, metadata/exclusions/rejections (8,14) | 6, 9, 11, 14 |
| Strategy/exposure/lifecycle, incomplete history and roll rules (4–7) | 7–8 |
| Decimal precision, null/zero/year, multicurrency (4,6,7,15) | 8, 11 |
| Atomic/stale/cancelled rebuilds and full re-normalization (8,9,13) | 5, 9 |
| API, SSE jobs, pagination, safe UI, same-origin checks (16) | 10–11 |
| Validated AI proposals and bounded tools (10,16,18) | 12–13 |
| Local/model profiles, isolation, immutable snapshots, no fallback (17–20) | 12–13, 15 |
| Docker, migrations, persistent restart, backup/restore (11,19) | 2, 14–15 |

Self-review procedure before handing this plan off: confirm all 20 spec acceptance checks map above; read every Task Interfaces block against its consumers; scan for undeclared test helpers, placeholder requirements and hardcoded financial model names; verify each of the five Review Focus cases appears in its owning task tests. Test snippets are minimal assertions, not complete test bodies: the fixture/setup choices are fixed by each task's inputs and Files block. No live broker/model credentials are prerequisites. All optional items are explicitly outside the required initial implementation (model discovery, live inference smoke) rather than hidden implementation gaps.

## Execution handoff

The plan contains 15 sequential tasks sharing ledger and allocation interfaces. Recommend **subagent-driven** execution: an independently reviewed financial boundary before proceeding is valuable because errors can appear plausible while silently double-counting or misallocating P/L. Native execution remains available with the same tests and one independent whole-branch review at the end. Do not start implementation until the user reviews this plan and selects the execution method. Create isolation at execution time using superpowers:using-git-worktrees, preserving existing user changes.

Plan self-review result: all 20 acceptance checks mapped, five Review Focus cases assigned tests, and public package/transport boundaries inspected. Store stays server-only to avoid a circular type/browser dependency. Model roundtrips verify actual offered tools; local catalog rates do not fabricate a billed cost. No product code has been implemented by writing this plan.
