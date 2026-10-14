# IBKR Trade Journal — Test Plan

This document describes how the journal is tested: the levels, the environments,
the synthetic data, the commands, and the mapping from the design's acceptance
checks to the tests that prove them. It complements [`docs/SETUP.md`](SETUP.md)
and the [README](../README.md).

The authoritative requirements live in
[`docs/superpowers/specs/2026-10-13-ibkr-trade-journal-design.md`](superpowers/specs/2026-10-13-ibkr-trade-journal-design.md)
(reference scenarios A–D and acceptance checks 1–20). When this plan and the
spec disagree, the spec wins.

---

## 1. Purpose and scope

Verify that the first release — imports, ledger normalization, strategy
consolidation, review/decisions, journal, rebuilds, backups, and the optional
AI boundary — behaves as specified, and that regressions are caught before
merge. Testing is **self-contained**: no private CSV/ODS files, no live broker
account, and no live model are required. Everything runs against synthetic
fixtures and a synthetic OpenAI-compatible server.

Out of scope for this release (and therefore not tested): Google Sheets
integration, automatic downloads, live prices, automated trading, advanced
payoff/risk math, and multi-user accounts.

---

## 2. Objectives

- Prove each of the 20 acceptance checks with at least one automated test.
- Prove the four reference scenarios (A–D) reconcile to their stated amounts.
- Prove financial invariants: canonical decimal TEXT (never float), exact
  allocation conservation, no over-allocation, null P/L distinct from zero, no
  cross-currency aggregation.
- Prove retention: decisions, notes, stop loss, exclusions, splits/merges and
  quarantined rows survive rebuild, backup and restore.
- Prove the AI boundary fails closed and that the manual workflow works with no
  model configured.
- Prove packaging: the Docker image builds, runs non-root, persists a volume
  across a graceful restart, and passes health checks.

---

## 3. Test levels

| Level | Tooling | Location | What it proves |
| --- | --- | --- | --- |
| Unit | Vitest (node env) | `test/unit/` | Pure functions: CSV parsing/normalization, decimal money math, proportional splits, projection validation, the actual-expiry collector. |
| Integration | Vitest (node env, real SQLite + real HTTP via `app.inject`) | `test/integration/` | Store schema, imports, ledger, decisions, builds, strategies, accounting, HTTP routes, models, analysis, backup/restore, bootstrap. |
| End-to-end (browser) | Playwright (chromium) | `e2e/` | The compiled frontend against a real booted server: import, journal, detail, review, rebuild, error/loading states, same-origin. |
| Container / packaging | Docker + Node scripts | `scripts/docker-smoke.mjs`, `scripts/smoke-built-server.mjs` | Image build, non-root, readiness, volume persistence, graceful SIGTERM, compiled-migration smoke. |
| Manual / optional | Node script | `scripts/local-model-smoke.mjs` | Optional roundtrip against a real local model server; never run in CI. |

There is **no enforced numeric coverage threshold**. Correctness is judged
against the acceptance checks; new behavior is expected to arrive with a test
that was watched to fail first (TDD).

---

## 4. Environments and prerequisites

- Node.js `22.19.0` (matches CI) and npm.
- Playwright chromium: `npx playwright install --with-deps chromium`.
- Docker + Docker Compose for `npm run test:docker`.
- A writable temporary directory; integration tests create isolated stores via
  `test/helpers/store.ts` and clean up after themselves.
- Local persistent disk for SQLite. Never run the suite's data directory on a
  network filesystem.

---

## 5. Test data and fixtures

All fixtures are synthetic and live in `test/fixtures/scenarios.ts`. They encode
the reference scenarios and the edge cases:

- The exported fixture tables `fixtures.spread`, `fixtures.partialFills`,
  `fixtures.roll`, `fixtures.reduced`, and `fixtures.assignment`.
- Helpers `buildExecutionTable(...)`, `executionRow(...)`, and the `base(...)`
  builders construct header-first Flex CSVs in memory.
- `test/helpers/inference-server.ts` is a synthetic OpenAI-compatible server
  used to exercise streaming tool calls, proposal validation, timeouts,
  cancellation, unauthenticated endpoints, and the absence of cloud fallback
  without any live model.

No private user source file is committed as a fixture (acceptance check 12).

---

## 6. How to run

```bash
npm ci
npm run check:all          # Biome lint + TypeScript typecheck
npm test                   # Vitest: unit + integration (all of test/)
npm run build              # server (tsc + migrations) + frontend (vite)
npm run test:e2e           # Playwright: builds + boots the real server
npm run test:docker        # compose config check + real Docker smoke
npm run test:build-smoke   # build, then smoke the compiled server + SIGTERM
```

Focused runs:

```bash
npx vitest run test/integration/ledger.test.ts            # one file
npx vitest run -t "scenario C"                            # by test name
npx vitest run test/integration/decisions.test.ts -t "identity_binding"
npx playwright test e2e/journal.spec.ts -g "mixed-expiry" # one browser test
```

---

## 7. Test inventory

| File | Level | Focus |
| --- | --- | --- |
| `test/unit/csv.test.ts` | Unit | `parseFlex` layouts/BOM/CRLF/quoting/aliases; `normalizeExecution` quarantine rules. |
| `test/unit/accounting.test.ts` | Unit | `formatMoney` (USD 2dp, half away from zero), `splitAmount` residual, `distributeProportional`, `accountProjection`, `validateProjection` invariants. |
| `test/unit/expiries.test.ts` | Unit | `collectActualExpiries` drops null expiries. |
| `test/integration/storage.test.ts` | Integration | Foreign keys + WAL and the retained schema; cross-generation allocation FK rejection; retention when a projection build is deleted; write rollback and serialized writes; reopen persistence and newer-schema refusal; idempotent migrations. |
| `test/integration/imports.test.ts` | Integration | Preview, content-addressed original storage, commit, idempotent duplicate, quarantine visibility, crash recovery. |
| `test/integration/ledger.test.ts` | Integration | Dedup/aliasing, conflict handling, leading zeros, revisions, exclusion/reinclusion, deterministic re-normalization. |
| `test/integration/decisions.test.ts` | Integration | Append-only decisions, supersession, schema-path exclusion/inclusion, identity bindings, metadata, contradictory bindings and superseded splits surfaced as review. |
| `test/integration/builds.test.ts` | Integration | Versioned builds, candidate validation, atomic activation, stale/cancel, rollback, projection reuse, provisional identity wiring. |
| `test/integration/strategies.test.ts` | Integration | Grouping, closes, lifecycle/roll links, mixed expiry, unsupported inventory, manual allocation ordering, `SPLIT_NOT_APPLIED`. |
| `test/integration/accounting.test.ts` | Integration | End-to-end amounts over normalized ledgers: opening amount, cashflow, broker vs reconstructed P/L, reconciliation. |
| `test/integration/http.test.ts` | Integration | Route validation, pagination/sorting allowlists, same-origin/content-type, upload limit, review/journal/transactions/lots, SSE jobs. |
| `test/integration/models.test.ts` | Integration | Profile CRUD, loopback transport, mounted `file:` credentials, disabled-profile provenance, no routing leakage. |
| `test/integration/analysis.test.ts` | Integration | Bounded analysis, proposal acceptance/rejection, cloud confirmation and no fallback, analysis HTTP routes, fail-closed without breaking manual review. |
| `test/integration/backup.test.ts` | Integration | Consistent snapshot, checksums, secret exclusion, offline restore validation, pre-restore backup, lock refusal. |
| `test/integration/bootstrap.test.ts` | Integration | Runtime config defaults and malformed-config rejection, app creation and liveness, Nax public-export consumption, synthetic fixture integrity for scenarios A–C. |
| `test/integration/acceptance.test.ts` | Integration | Scenarios A–D reconstructed across a full re-normalization with decisions retained; journal backup/restore roundtrip; local profile vs the synthetic server with readiness independence; production static/SPA serving; newer-schema fail-closed; SIGTERM leaves the active build intact. |
| `e2e/journal.spec.ts` | E2E | 19 browser flows: empty state, import, dedupe, drilldown, multi-currency, Unavailable P/L, expiry year/Mixed, rebuild persistence, previews, stale write, loading/failure, error summary, keyboard, same-origin, SPA fallback. |
| `scripts/docker-smoke.mjs` | Container | Image build, non-root uid, readiness, import → 1 strategy, volume persistence across a graceful SIGTERM restart, stored local model profile. |
| `scripts/smoke-built-server.mjs` | Packaging | Compiled migrations create schema, `npm start` liveness, SIGTERM shutdown. |
| `scripts/local-model-smoke.mjs` | Manual | Optional real local-server probe (fixed synthetic payload, writes no decision). |

---

## 8. Acceptance-check coverage

| # | Acceptance check (summary) | Primary tests |
| --- | --- | --- |
| 1 | Header-first/sectioned CSV parse; summaries and ST lots never inflate | `unit/csv.test.ts`, `integration/imports.test.ts`, `integration/acceptance.test.ts` |
| 2 | Overlapping imports preserve evidence without duplicating; partial fills distinct | `integration/ledger.test.ts` (re-export dedupe), `integration/imports.test.ts` |
| 3 | Corrections preserve old revisions; only explicit evidence replaces/reverses | `integration/ledger.test.ts` (revisions), `integration/storage.test.ts` |
| 4 | Scenario A reconciles 284.5018378 / -451.6607454; displayed -284.50 / -451.66; close 2026-09-25 | `integration/acceptance.test.ts`, `integration/accounting.test.ts`, `integration/builds.test.ts` |
| 5 | Scenario B lifecycle links reproduce PositionActionIDs; reduced export → review | `integration/strategies.test.ts` (lifecycle), `integration/acceptance.test.ts` |
| 6 | Scenario D reconciles source decimals; conflicting manual values stay review | `integration/acceptance.test.ts`, `unit/accounting.test.ts` (`formatMoney`) |
| 7 | Partial closure, multiple quantities, mixed expiries, assignment stock, missing openings, multi-currency | `integration/strategies.test.ts`, `integration/acceptance.test.ts`, `e2e/journal.spec.ts` |
| 8 | Rebuild preserves decisions/metadata/results and source traceability, no AI calls | `integration/builds.test.ts`, `integration/decisions.test.ts`, `integration/acceptance.test.ts`, `e2e` (notes/stop loss rebuild) |
| 9 | Failed/cancelled/concurrent/stale builds cannot corrupt or replace the active view | `integration/builds.test.ts`, `integration/acceptance.test.ts` |
| 10 | Invalid AI references/over-allocation rejected; manual works without AI | `integration/analysis.test.ts` |
| 11 | Docker build/run, health, migration, volume persistence, backup/restore | `scripts/docker-smoke.mjs` (`test:docker`), `integration/backup.test.ts`, `scripts/smoke-built-server.mjs` |
| 12 | No private files as fixtures; synthetic equivalents | `test/fixtures/scenarios.ts` (used by all tests) |
| 13 | Normalization deletable/recreatable; quarantined visible; scenario C | `integration/ledger.test.ts`, `integration/storage.test.ts`, `integration/imports.test.ts` |
| 14 | Rejections, splits/merges, notes, stop loss, exclusions, stale diagnostics survive rebuild + backup/restore | `integration/decisions.test.ts`, `integration/backup.test.ts`, `integration/acceptance.test.ts` |
| 15 | Opening/expiry years differ; null P/L ≠ zero; no cross-currency total | `unit/accounting.test.ts`, `integration/strategies.test.ts`, `e2e/journal.spec.ts` |
| 16 | Upload/parser limits, same-origin, bounded AI tools, secret exclusion, crash recovery | `integration/http.test.ts`, `integration/imports.test.ts`, `integration/analysis.test.ts`, `integration/models.test.ts`, `integration/backup.test.ts` |
| 17 | Two profiles with different endpoints; no provider-wide routing leakage | `integration/models.test.ts` |
| 18 | Synthetic OpenAI-compatible server: streaming tools, validation, context, timeout/cancel, unauthenticated, no cloud fallback | `test/helpers/inference-server.ts`, `integration/analysis.test.ts`, `integration/models.test.ts` |
| 19 | Optional real local smoke; compose-network and host-gateway config; restart preserves profiles and requires mounted creds | `scripts/local-model-smoke.mjs`, `integration/models.test.ts` (mounted file creds), `scripts/docker-smoke.mjs` |
| 20 | Changing the default model affects only new jobs; provenance retained; local failure leaves manual workflow functional | `integration/models.test.ts`, `integration/analysis.test.ts` |

---

## 9. Reference scenarios

| Scenario | Oracle | Tests |
| --- | --- | --- |
| A — vertical spread across imports | One bull put spread; opening -284.50; close 2026-09-25; cashflow -451.6607454; broker P/L -451.660745; displayed -451.66; zero exposure; lots do not double | `integration/acceptance.test.ts`, `integration/accounting.test.ts`, `e2e` |
| B — assignment then exercise | Two lifecycle links; missing-option-history warnings; stock +100 → 0; no full option P/L from stock cash; reduced export → review | `integration/strategies.test.ts`, `integration/acceptance.test.ts` |
| C — partial fills and mixed roles | Equal fills total +4 and stay +4 across re-import; roll splits into episodes with optional link | `integration/ledger.test.ts`, `integration/strategies.test.ts`, `integration/acceptance.test.ts` |
| D — formatting/discrepancy | +4.223592 → +4.22; -449.212451 → -449.21 and -449.22 not adopted; 2027 expiry Year; shares no year; conflicting expiry → review | `integration/acceptance.test.ts`, `unit/accounting.test.ts`, `e2e` |

---

## 10. Entry / exit criteria

**Entry:** dependencies installed, `npm run check:all` clean, fixtures present.

**Exit (release-ready) when all hold:**

- `npm run check:all` exits 0 (Biome + typecheck).
- `npm test` passes (currently 242 Vitest tests across 16 files).
- `npm run build` exits 0.
- `npm run test:e2e` passes (19 Playwright tests).
- `npm run test:docker` prints PASS (non-root, readiness, 1 strategy, restart
  persistence, stored model id) with exit 0.
- Every acceptance check in section 8 has at least one green test.

**Fail:** any red gate blocks release. A failing merged result stops everything;
the branch and worktree stay put while the cause is investigated.

---

## 11. Continuous integration

`.github/workflows/ibkr-journal.yml` runs on pushes to `main` and on pull
requests that touch the app, packaging, docs or specs:

1. `npm ci`
2. `npm run check:all`
3. `npm test`
4. `npm run build`
5. `npx playwright install --with-deps chromium`
6. `npm run test:e2e`
7. `npm run test:docker`

CI uses Node `22.19.0` and no live model, cloud key, or broker account.

---

## 12. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Financial rounding drift | Decimal TEXT everywhere; `formatMoney` unit tests for half-away-from-zero; reconciliation at one minor unit. |
| Allocation over-count | `validateProjection` hard errors; `ALLOCATION_*` tests; over-allocation rejected at the decision boundary. |
| Silent data loss on re-import | Idempotent hashing + revision retention tests; raw evidence never deleted. |
| Non-deterministic rebuilds | Re-normalization determinism test compares two generations field-for-field. |
| Model leakage / cloud egress | Loopback gateway + synthetic inference server tests; no-fallback and mounted-credential tests; browser never receives secrets. |
| Container/packaging regressions | Real Docker smoke with a graceful SIGTERM restart assertion. |
| Cross-origin or upload abuse | Same-origin/content-type and upload-limit tests. |

---

## 13. Adding tests

- Follow TDD: write the failing test first, watch it fail for the right reason,
  then implement (see the project's `test-driven-development` workflow).
- Put pure logic in `test/unit/`, store/route logic in `test/integration/`, and
  user-visible flows in `e2e/`.
- Reuse `test/fixtures/scenarios.ts` and `test/helpers/`; do not add real
  broker data.
- Keep assertions on real behavior (real SQLite, real `app.inject`, the
  synthetic inference server) rather than on mocks.
- When a new acceptance-relevant behavior lands, add its row to section 8.
