# Whole-repository code review — TradeLedger

Date: 2026-10-19

Reviewed branch: `main`

Reviewed HEAD: `a90a92c` (`Merge pull request #8 from skywills/feature/trade-lifecycles`)

Status: **R01–R12 resolved on `fix/review-2026-10-19` (one sub-point of R06 withdrawn as spec-conformant); R13 resolved by the build-job lifecycle follow-up; R14, R15, R17–R19, R21, R22 and R24 addressed in the low-severity follow-up; R23 stop-loss validation addressed, strategy splits remain open; R16 and R20 open**

See [Resolution — 2026-10-19](#resolution--2026-10-19) for the fixes, the review of those fixes, and the residual risks. The findings below describe the reviewed baseline `a90a92c`.

## Scope and method

Reviewed the whole repository (~33k lines under `src/`), not a Git diff. Five independent read-only reviewers covered:

1. Imports, ledger, storage, builds, jobs, maintenance (backup/restore) and `main.ts`
2. Strategies, P&L accounting, lifecycles, analytics, decisions and `src/shared`
3. HTTP, AI profiles/transport, chat and chat tools, Dockerfile/Compose (security focus)
4. React frontend (`src/web`)
5. Test suite and CI

R01, R02, R03, R10 and R11 were spot-checked against the source after the reviewers reported. The other findings come from reading the code. None were reproduced by running the app or synthetic tests.

Severity: **High** is a defect that can corrupt or block authoritative results. **Medium** is a correctness, recovery or exposure defect with a realistic trigger. **Low** is a minor defect or a hardening item.

## Quality gates

| Gate | Result |
|---|---|
| Lint (`biome check .`) | 0 errors, 4 warnings, 26 infos (e.g. `row.fields["TradeID"]` should use a literal key) |
| Typecheck (`tsc --noEmit`) | Clean |
| Unit and integration tests (`vitest run`) | 590 / 590 passed across 53 files |
| `npm audit --omit=dev` | 3 high: `node-forge` (GHSA-86w9-cpqp-85rv) via `@nathapp/nax-agent` → `@anthropic-ai/sandbox-runtime`. No fix available. |

## What is working well

- **Money math:** handled with `Decimal` and string canonicalization throughout. No `Number()` or float arithmetic on amounts, server or client.
- **Fees:** not double-counted. `netCash` already includes commissions, and `reconstructedPnl` is the sum of `netCash`.
- **Grouping order:** deterministic. Inputs are key-sorted, chronology uses a topological sort on a heap, and allocation ties break on `strategyId`.
- **Tar extraction:** rejects traversal, absolute paths and links. Backup download ids are regex-restricted.
- **Credentials:** API keys are never returned to the client. The inference gateway strips client auth headers, binds to loopback, rejects cross-origin redirects, and enforces size caps and timeouts.
- **Chat tools that change data:** `commit_import`, `rebuild` and `create_backup` need user approval (`approval: "always"`), so prompt injection through imported CSV data cannot change ledger state on its own.
- **Crash recovery:** `recoverChatThreads` resets threads and messages left running at shutdown.
- **Origin guard:** a global `onRequest` hook that runs before body parsing. It rejects a missing or `null` Origin.
- **Tests:** they exercise real SQLite, `app.inject` and a synthetic inference server. There are no mocks.

## Findings

### High

#### R01 — Manual allocations are not validated at submit time, so one bad decision fails every rebuild

- Files: `src/server/decisions/schemas.ts:47-52`, `src/server/decisions/service.ts:460-498`, `src/server/strategies/accounting.ts:384-438`, `src/server/builds/service.ts:313-334`
- Problem: `ManualAllocationRowSchema` only checks that `quantity` and `netCash` are decimal text. The `manual_allocation` service branch checks the source, the account/currency and existing-decision conflicts. It never compares each row's quantity, sign or cash against the execution.
- What happens: `validateProjection` raises `ALLOCATION_OVERFLOW`, `ALLOCATION_SIGN_MISMATCH` or `ALLOCATION_CASH_MISMATCH` as errors, so the build is marked `failed`.
- Scenario: a 10-share execution gets an allocation row of `quantity "100"`. The decision persists, and every later rebuild fails until the user supersedes it.
- Related: an unknown `allocations[].executionKey` silently falls back to the execution resolved from `payload.source` (`src/server/strategies/grouping.ts:475-481`). The conflict check (`service.ts:279-297`) only considers `payload.source`.
- Fix: at submit time, require that each execution exists, that quantity is non-zero with the execution's sign, and that cumulative quantity and cash stay within the execution. Reject unknown execution keys.

### Medium — correctness and recovery

#### R02 — A failed rebuild leaves a `running` candidate that rollback can activate

- File: `src/server/builds/service.ts:296-311`, `:417`
- Problem: `insertCandidate` runs before `computeProjection` and `persistProjection`, with no try/catch around them. If either throws (for example `LIFECYCLE_CONSERVATION`), the build row stays `running` until the next restart.
- What happens: `rollbackBuild` only refuses `failed` and `cancelled` builds, so a partial build can be made active. The status is also read outside the write transaction.
- Fix: on error, mark the build `failed`. Allow rollback only to `active` or `stale` builds, and re-check the status inside `switchActiveBuild`.

#### R03 — Restore hardening gaps, and restore likely fails in the Docker layout

- File: `src/server/maintenance/restore.ts:132-157`, `:175-191`, `:203-246`
- Lock: `assertNotLocked` only polls the data-dir lock and never acquires it. A server that starts between the last check and `swapIn` is replaced under itself.
- Unlisted files: `validateFiles` hashes only manifest-listed paths, but `extract` unpacks every safe entry. An extra `journal.sqlite-wal` ships into the live directory and SQLite replays it, which bypasses the SHA-256 check on `journal.sqlite`.
- No database check: the staged DB is never opened or integrity-checked. The schema version comes from the manifest, not the file.
- Docker layout: staging is created in `dirname(target)`, which is `/` when the data dir is `/data`, and UID 1000 cannot write there. Renaming a mount point (`renameSync(target, trash)`) fails with EBUSY or EXDEV. The real cause is then wrapped as `BACKUP_INVALID` (400).
- Fix:
  - Acquire the lock for the whole restore.
  - Reject any extracted path that is not in `manifest.files`.
  - Open the staged DB read-only and check its `user_version` and `PRAGMA integrity_check`.
  - Stage inside the data dir and swap its contents, or document restore as host-only.
  - Do not map filesystem errors to `BACKUP_INVALID`.

#### R04 — Overlapping re-exports can drop both copies of a trade

- File: `src/server/ledger/identity.ts:106-125`, `:330-339`
- Problem: the payload fingerprint includes fields that are not broker-stable: `timezone` (taken from the upload query, `src/server/http/routes-imports.ts:27-30`), `codes`, the inferred instrument multiplier, `proceeds` and `basis`.
- What happens: when two rows share a TradeID but have different fingerprints, the group is flagged `identity_conflict` and skipped entirely.
- Scenario: import January with timezone "America/New_York", then an overlapping Jan–Feb re-export with no timezone. Every overlapping trade drops out of the ledger.
- Fix: fingerprint only the financially significant, broker-stable fields.

#### R05 — `hasBasisTransfer` treats any non-null `CostBasis` as a basis transfer

- File: `src/server/strategies/accounting.ts:101-109`
- Problem: `CostBasis` is a required column (`src/server/imports/headers.ts:17`), and IBKR Flex likely fills it on ordinary closing rows.
- What happens: if it does, strategy-unit reconstructed P&L shows "Unavailable" almost everywhere. The only test (`test/unit/accounting.test.ts:269`) uses synthetic data. The default lifecycle mode is unaffected.
- Fix: confirm against a real export. If confirmed, restrict the check to assignment, exercise and unsupported events.

#### R06 — Lifecycle valuation snapshot selection and labelling

- File: `src/server/lifecycles/valuation.ts:48-57`, `:61-105`
- Snapshot selection: valuation picks the newest snapshot containing any mark, then fails with `VALUATION_MARKS_INCOMPLETE` if another open position is missing from it. This happens even when an older complete snapshot exists.
- Labelling: closed lifecycles report `reconstructedPnl − realizedBrokerPnl` as "unrealized". That reconciliation gap is not unrealized P&L.
- Fix: choose the newest snapshot that covers all open positions, or merge marks per instrument. Return `"0"` or `null` unrealized for closed lifecycles.

### Medium — security (local-first context)

#### R07 — No Host validation and no read protection: DNS rebinding can read the journal

- File: `src/server/http/origin.ts:16-18`
- Problem: only POST/PUT/PATCH/DELETE under `/api/` are guarded, and nothing validates the `Host` header.
- What happens: a rebinding page can read the model configuration, chat threads and their SSE streams, ledger data and backup downloads (`src/server/http/routes-maintenance.ts:34-48`). The write guard still holds.
- Fix: add an `onRequest` Host allowlist derived from `ALLOWED_ORIGIN` plus loopback. Apply it to every method.

#### R08 — Server binds `0.0.0.0` with no authentication

- File: `src/server/main.ts:43`
- Problem: only Compose's `127.0.0.1:3000` mapping keeps the app local. Running `npm start`, or `docker run -p 3000:3000`, exposes it to the LAN.
- What happens: any LAN host can pass the origin check by setting `Origin: http://localhost:3000` from curl.
- Fix: add a `HOST` setting that defaults to `127.0.0.1`. The Dockerfile sets `HOST=0.0.0.0`.

#### R09 — Credential exposure through model profiles

- Files: `src/server/ai/profiles.ts:139`, `:224-227`, `src/server/ai/credentials.ts:70-79`, `:161-163`
- Plain HTTP: cloud profiles accept `http:` endpoints, so `Authorization: Bearer <key>` goes in cleartext.
- Any env var: `env:ANY_NAME` refs resolve any environment variable. A profile with `endpoint=https://attacker` and `credentialRef=env:AWS_SECRET_ACCESS_KEY` sends that secret to the attacker.
- Likely route in: an imported `model-configuration.json` (`POST /api/models/configuration`).
- Fix: require `https:` for cloud mode unless the host is loopback. Restrict `env:` refs to a prefix or an allowlist. Show endpoints before an import is confirmed.

### Medium — frontend

#### R10 — `DecisionEditor` can double-submit

- File: `src/web/review/DecisionEditor.tsx:333-389`, buttons at `:752` and `:785`
- Problem: `submit()` has no in-flight guard or disabled state, and each call generates a new `clientRequestId`, so server idempotency cannot catch the repeat.
- What happens: a double-click records duplicate decisions, or produces a confusing `STALE_INPUT` error on the second request.
- Same pattern: `saveLifecycleDecision` (`src/web/lifecycles/api.ts:106-123`). If the rebuild after the decision POST fails, retrying appends the decision a second time.
- Fix: add a `submitting` state. Create one `clientRequestId` per preview and reuse it on retry. Split the decision and rebuild steps so a retry only repeats the rebuild.

#### R11 — `LifecycleDetail` keeps state across route changes

- File: `src/web/App.tsx:41`, `src/web/lifecycles/LifecycleDetail.tsx:45-49`
- Problem: the component is rendered without a `key`, so `campaignId`, `name`, `supersedesId` and `notice` carry over when navigating from lifecycle A to B.
- What happens: saving campaign membership on B posts A's selection.
- Fix: render with `key={second}`. `StrategyDetail` and `CampaignDetail` have the same pattern with lower impact.

#### R12 — `DecisionEditor` pickers silently cap at 100, and a failed fetch is hidden

- File: `src/web/review/DecisionEditor.tsx:87-92`, `:398`
- Problem: strategies, imports and executions are fetched with `pageSize=100`, and nothing tells the user the list is truncated. A failed transactions fetch is not checked, so the dropdowns render empty with no error.
- Fix: check `transactions.status`. Then add search or pagination, or show a "showing first 100" notice.

### Low

| ID | Finding | Location |
|---|---|---|
| R13 | A late cancel can be overwritten with `complete`; use `finishIfRunning`. If `jobs.progress` throws, `activeWork` leaks. | `src/server/builds/service.ts:576-586` |
| R14 | The import size limit ignores `config.uploadLimitBytes` (hardcoded 20 MiB default). Earlier previews leak until their TTL when a later file in the same request fails. | `src/server/imports/service.ts:311`, `:414` |
| R15 | A `DateTime` with a comma separator (`yyyy-MM-dd, HH:mm:ss`) is rejected, which quarantines every execution in the file. | `src/server/imports/normalization.ts:117-119` |
| R16 | The default analytics currency is the alphabetically first one (CAD before USD). | `src/server/analytics/scope.ts:135` |
| R17 | The monthly series has no bound; `from=0001-01-01&to=9999-12-31` generates about 120k months. | `src/server/analytics/aggregate.ts:97-131` |
| R18 | Raw internal error text is sent in SSE `error` frames and can include filesystem paths. | `src/server/chat/service.ts:493-511` |
| R19 | The SSE replay buffer copies up to 2000 frames on every token and is not cleared by `deleteThread`. There is no cap on concurrent SSE subscribers. | `src/server/chat/frames.ts:59-60`, `src/server/http/routes-chat.ts:157-186` |
| R20 | Local profiles have no endpoint host restrictions (SSRF, e.g. to `169.254.169.254`). Largely by design; document it or block link-local ranges. | `src/server/ai/profiles.ts:129-149` |
| R21 | `pollJob` cannot be cancelled and times out after 60 s while the job may still be running. `dashboard/api.ts` calls `.json()` before checking `response.ok`. | `src/web/api.ts:377-388`, `src/web/dashboard/api.ts:34`, `:91` |
| R22 | Strategy and import route ids are interpolated into API paths without encoding. | `src/web/strategies/StrategyDetail.tsx:28`, `src/web/imports/ImportsPage.tsx:25` |
| R23 | `StopLossSchema.price` has no non-negative check. `group_split` decisions are accepted but never applied; they only raise a `SPLIT_NOT_APPLIED` warning. | `src/server/decisions/schemas.ts:43`, `src/server/strategies/grouping.ts:537-548` |
| R24 | If `recordTurnStart` fails after the user message is appended, a retry with the same `clientMessageId` returns success with no turn started. | `src/server/chat/service.ts:161-173` |

### Design limit worth knowing

There is no FIFO lot matching. A close larger than any single opening group is not split across lots (`src/server/strategies/grouping.ts:797-801`). For example, selling 10 shares that were bought as 5 + 5 in separate orders becomes `MISSING_OPENING` or `AMBIGUOUS_CLOSE`. Both openings then stay in `currentOpen`, and the close forms its own unresolved strategy. This is conservative and correct, but it will be common in real stock accounts.

## Tests and CI

- **CI:** `.github/workflows/trade-ledger.yml` gates lint, typecheck, unit and integration tests, build, Playwright and the Docker smoke. `test:build-smoke` (the compiled-migration smoke) is not in CI.
- **Coverage is not measured:** there is no `@vitest/coverage-*` package and no coverage config. This conflicts with the project's 80% target.
- **Untested or lightly tested modules, by risk:**
  1. `src/server/storage/queue.ts`: the single-writer queue has no direct tests. It needs tests for continuing after an error, write ordering and rejecting work after close.
  2. `src/server/lifecycles/validate-decision.ts`, `decisions.ts`, `membership.ts`: only two rejection codes are tested.
  3. `src/server/main.ts`: the shutdown failure path has no test.
  4. `src/server/maintenance/cli.ts`: the backup/restore CLI has no tests.
  5. `src/server/ledger/revisions.ts`, `src/server/chat/turn.ts`: covered only indirectly.
  6. `src/server/imports/headers.ts`, `classification.ts`: no direct tests for header aliases or ambiguous columns.
- **Flaky patterns:**
  - Fixed sleeps used as assertions: `test/integration/chat.test.ts:536` (2700 ms), `e2e/dashboard.spec.ts:121` (`waitForTimeout(450)`), `e2e/journal.spec.ts:428`, `test/integration/chat-http.test.ts:133`, and 25–50 ms settles in the chat tests.
  - Playwright shares one server on fixed port 3210. `e2e/data-management.spec.ts` wipes the journal, and the specs that run after it only pass because of `workers: 1` and alphabetical file order.

## Maintainability

Follow-up: items 1 and 2 below are addressed by the [chronology and grouping refactor](#chronology-and-grouping-refactor--2026-10-19). The list describes the reviewed baseline.

1. `groupStrategies` in `src/server/strategies/grouping.ts` (1,180 lines) is a single function of about 850 lines, built from closures over shared maps. Split it into phases that take an explicit context object.
2. Three chronology helpers decide execution ordering with different rules: `compareExecutionTime` (`grouping.ts:88`), `compareLifecycleTime` (`lifecycles/chronology.ts`) and `latestExecutionBound` (`valuation.ts:12`). Consolidate them under one tested contract.
3. Performance as the journal grows:
   - `src/server/lifecycles/project.ts` repeats linear `find`/`some` lookups, which is quadratic overall.
   - `readCommittedRows` (`src/server/ledger/normalize.ts`) JSON-parses every import row on each full rebuild.
4. Build state changes (candidate, persist, activate, job finish) have no single failure path. R02 and R13 come from this. Restore trust rules are also assembled by hand (R03); one allowlist of restorable paths, shared with backup, would close those gaps.
5. Frontend:
   - `src/web/review/DecisionEditor.tsx` is about 790 lines with 15+ `useState` calls and a module-level mutable `log` array.
   - `src/web/api.ts` defines its own copies of schemas from `src/shared`.
   - `src/web/lifecycles/MembershipEditor.tsx` imports `src/server/strategies/allocation.ts` into the browser bundle; move `splitAmount` to `src/shared`.
   - The `generation === nonce` check in `useJson` (`src/web/api.ts:343`) never does anything.

## Recommended order

1. R01 and R02: data integrity.
2. R10 and R11: small frontend fixes.
3. R07 and R08 together: host allowlist plus `HOST` config.
4. R03: restore hardening.
5. Add coverage reporting and `test:build-smoke` to CI, then write `WriterQueue` tests.
6. R04 and R05: validate against a real IBKR export.

## Resolution — 2026-10-19

Branch: `fix/review-2026-10-19` (based on `a90a92c`). Every fix was written test-first, with a failing test before the change. A second, independent review of the fix diff was then run, and its follow-ups were applied.

### Per-finding status

| ID | Status | Fix | Tests | Commits |
|---|---|---|---|---|
| R01 | Fixed | `assertConservingAllocations` in `src/server/decisions/service.ts` rejects unknown execution keys (`UNKNOWN_EXECUTION`) and zero quantities. It then runs the build's own `validateProjection` with and without the candidate, and rejects only the `ALLOCATION_*` errors the candidate introduces, so submit and build cannot disagree. Superseded decisions are excluded. | `test/integration/decisions.test.ts` (2 new). Two existing tests that relied on invalid allocations were adjusted. | `2ff990c` |
| R02 | Fixed | `rebuild()` marks a thrown candidate `failed` with a `build:<code>` diagnostic and rethrows the original error. That still holds if marking it failed itself fails. Rollback accepts only `active`/`stale` builds and re-checks inside the write (`isRestorable` in `switchActiveBuild`). | `test/integration/builds.test.ts` (2 new, including a deterministic rollback race) | `07c0673`, `aee9569` |
| R03 | Fixed | **Lock and validation:** the data-dir lock is held for the whole restore. Unlisted archive entries are rejected before extraction. The staged DB is opened read-only for `integrity_check`, and its schema version is read from `schema_migrations`. **Swap:** staging now lives inside the data dir, and the swap goes entry by entry, so restore works on a `/data` mount point. The previous contents are kept in `<data>/.pre-restore-*`. **Errors:** filesystem failures return `RESTORE_FAILED` (500), not `BACKUP_INVALID`. **Interrupted swap:** a `.restore-in-progress` marker is written before the swap. Startup refuses with `RESTORE_INCOMPLETE` while it exists, instead of creating an empty journal. | `test/integration/restore-hardening.test.ts` (10). The `backup.test.ts` pre-restore test was updated. | `7d12910`, `39f602c` |
| R04 | Fixed | The fingerprint now covers account, raw datetime, quantity, price, currency, commission and the instrument's broker identifiers, with decimals compared by value. It was never persisted, so stored identities are unchanged. When duplicate rows merge, proceeds, taxes, basis and broker P&L are filled from whichever source has them, regardless of import order. | `test/integration/identity-fingerprint.test.ts` (7, covering both import orders) | `c3d18c3`, `7221279` |
| R05 | Fixed | Confirmed from the spec (cost basis is on every execution row) and the IBKR-shaped fixture (`CostBasis` set on ordinary trades). `hasBasisTransfer` now checks only assignment, exercise and unsupported events. | `test/unit/accounting.test.ts` (1 new, 1 updated) | `a6d7c37` |
| R06 | Fixed, one part withdrawn | Valuation uses the newest snapshot that marks every open position. Marks are still never combined across timestamps, and `VALUATION_MARKS_INCOMPLETE` is reported only when no snapshot is complete. **Withdrawn:** reporting closed-lifecycle unrealized P&L as `0`. The [lifecycle spec](../superpowers/specs/2026-10-18-trade-lifecycles-design.md) defines `unrealizedPnl = totalPnl − realizedBrokerPnl` as a labelled residual, so the original behaviour is kept. | `test/unit/lifecycle-valuation.test.ts` | `528fc4a`, `847aed4` |
| R07 | Fixed | A global Host allowlist hook returns 421 `HOST_NOT_ALLOWED` on every method and on static and SPA routes. It allows the `ALLOWED_ORIGIN` host, `ALLOWED_HOSTS`, and loopback on any port. | `test/integration/host-guard.test.ts` (8) | `108ffc9` |
| R08 | Fixed | New `HOST` setting, default `127.0.0.1`. The Dockerfile and Compose set `0.0.0.0` (Compose still publishes on loopback only). | `test/integration/host-guard.test.ts` | `e4c0b32` |
| R09 | Fixed | **https:** a cloud profile must use `https:` unless it is on loopback (`INSECURE_ENDPOINT`). This is checked on save and on import, and again when a connection opens, so profiles stored before the rule are covered too. **env refs:** `env:` credential refs must match `*_API_KEY`. | `test/integration/credential-hardening.test.ts` (7) | `762ac7d`, `56cb395`, `b6b9790` |
| R10 | Fixed | **DecisionEditor:** a ref-based in-flight guard, and buttons disabled while a request is pending. One `clientRequestId` per payload (keyed by JSON value), reused on retry and cleared after success. **Lifecycle saves:** the decision and the rebuild are separate calls, and "Retry rebuild" only rebuilds. | `e2e/review-editor.spec.ts` (5), `e2e/lifecycles.spec.ts` (3) | `e7b9e73` |
| R11 | Fixed | `key={second}` on `LifecycleDetail`, `CampaignDetail` and `StrategyDetail`. | `e2e/lifecycles.spec.ts` | `41e19a6` |
| R12 | Fixed | A failed transactions fetch shows the error panel. Pickers show "Showing the first N of T" when the API's `total` exceeds the page. The notice was chosen over fetching every page because the transaction count has no upper bound. | `e2e/review-editor.spec.ts` | `9ddfa26` |

### Review of the fixes

Three independent reviewers read the fix diff and found no high-severity issues. Their medium findings were handled as follows:

- **R04, applied:** merged duplicates used to keep the first row's values silently, which could hide a broker amount a later re-export carries. The merge now fills omitted amounts. The first version of the regression test passed only because of source ordering (`compareSources` sorts by `importId`), so it now runs in both import orders.
- **R06, applied:** zeroing closed-lifecycle unrealized P&L contradicted the spec, and was reverted.
- **R09, applied:** stored plain-http cloud profiles were not re-checked when used. They are now checked in `openModelConnection`.
- **R03, applied:** a crash mid-swap would let the next start create an empty journal silently. The new in-progress marker covers this.
- **R02, applied:** a failing failure-mark could replace the original error, which is now always the one surfaced.
- **R01, accepted:** the submit-time check regroups the whole ledger twice inside the write transaction. That is acceptable for a single-user journal. Revisit if ledgers grow large (see Maintainability 3).
- **Frontend:** no issues found.

### Behaviour changes to note

- **HOST default:** outside Docker the server now listens on `127.0.0.1`. Set `HOST=0.0.0.0` for LAN access.
- **ALLOWED_HOSTS:** behind a reverse proxy or a custom hostname, add the public host to `ALLOWED_HOSTS` (or `ALLOWED_ORIGIN`). Otherwise requests get 421. A Kubernetes `httpGet` probe sends the pod IP as Host and would need it allowed.
- **env credential names:** existing `env:` refs whose name does not end in `_API_KEY` now show as not configured, and fail with `CREDENTIAL_REF_NOT_ALLOWED`. Rename the variable, for example `HF_TOKEN` → `HF_API_KEY`.
- **Pre-restore copy location:** the pre-restore copy now lives inside the data dir (`.pre-restore-*`). It is never backed up or moved by a later restore, and it is deleted manually (see `docs/SETUP.md` §8).
- **Reconstructed P&L by strategy:** it is now available for ordinary closes that carry `CostBasis` (R05).

### Verification

Run on the final branch head:

| Gate | Result |
|---|---|
| Lint (`biome check`) | 0 errors; baseline 4 warnings and 26 infos unchanged |
| Typecheck | Clean |
| Unit and integration tests | 628 / 628 passed across 57 files (baseline 590 / 53) |
| Build and `scripts/smoke-built-server.mjs` | Passed |
| Playwright e2e | 72 / 72 passed |

### Still open

- **Low findings:** R16 (default currency), R20 (local endpoint trust policy), and R23 applied strategy splits remain open. R13 is resolved by the build-job lifecycle follow-up below; the other actionable low findings are addressed in the low-severity follow-up.
- **Tests and CI:** coverage reporting, compiled-server smoke in CI, direct `WriterQueue` tests, the identified chat/browser fixed-wait cleanup, and isolation between browser spec files are implemented in the reliability follow-up. The 80% whole-source coverage target and the other module-specific test gaps remain open.
- **R09 import UI:** showing endpoints before a model-configuration import is confirmed is not yet done (frontend).
- **R04:** validated with controlled overlapping copies of the retained export; confirmation with two independently generated overlapping exports, including `TradeID`, remains open. **R05:** confirmed against the retained export. See [Real-data validation](#real-data-validation--2026-10-19).


## Real-data validation — 2026-10-19

Validated the locally retained `2023.csv` source from the sibling runtime data directory against the current production import, normalization, identity, grouping and strategy-accounting code. The source contains 31 executions (4 stock, 27 option), with 19 opens and 12 closes. No account identifiers, broker identifiers, symbols or monetary amounts are reproduced here. All imports and ledger generations used disposable temporary databases, which were removed afterward; the live journal was not changed.

### R05 — confirmed for this export

- All 31 executions have a nonzero `CostBasis`, including all 12 ordinary closing trades. Normalization classifies all 31 as `trade`, rather than assignment, exercise or unsupported events.
- The import has no quarantined rows, identity conflicts or ledger issues. Grouping produces 8 complete closed strategies and 7 open strategies.
- All 8 complete closed strategies have reconstructed P&L equal to their allocated net cashflow. Accounting and projection validation report no issues.
- As a control, repeating the import with `CostBasis` removed from every row produces identical strategy status, completeness, opening amount, cashflow, broker P&L and reconstructed P&L.

This confirms that populated cost basis does not itself indicate a basis transfer, and that the R05 fix preserves reconstructed P&L for this export. The source has no assignment or exercise examples, so those cases remain covered by the existing synthetic regression tests.

### R04 — controlled overlap checks passed; independent exports still needed

Only one retained source export was available. Derived copies were used to exercise three changes independently: upload timezone (`America/New_York` versus unspecified), decimal formatting, and omitted `CostBasis`/`FifoPnlRealized`/`Proceeds`. Each pair was imported in both orders into fresh temporary storage. The CSV bytes differed, ensuring file-hash deduplication did not bypass execution identity resolution.

All six runs retained exactly 31 executions, with zero identity conflicts, two source references per execution, and the original financial values preserved, including broker amounts available in only one copy.

The export has `IBExecID` on every row and no `TradeID` column. These results validate the execution-ID identity path using actual source rows and controlled transformations; they do not establish which fields IBKR changes between independently generated exports or validate a real `TradeID` overlap. Full R04 real-data validation still requires two independently generated, overlapping Flex exports, preferably with `TradeID` included.

### Verification

- Disposable real-data harness: baseline, six overlap scenarios, and the cost-basis removal control passed.
- `npx vitest run test/integration/identity-fingerprint.test.ts test/unit/accounting.test.ts`: 28 tests passed across 2 files.
- No production code or private source data was added to the repository.


## Reliability follow-up — 2026-10-19

Implemented after the real-data validation above; included with the R13 follow-up PR.

### Test infrastructure

- Added six direct `WriterQueue` tests for serialized ordering, continuation after thrown/rejected work, drain semantics and close behavior. No queue production changes were needed.
- Added pinned V8 coverage tooling, a `test:coverage` script and whole-source HTML/LCOV/JSON summary reports, including unimported source. CI publishes coverage artifacts and runs the compiled-server migration smoke before browser acceptance.
- Browser specs use separate app processes, temporary journals and dynamic loopback ports, with two workers. The journal spec retains its explicit within-file serial scenario; other files no longer depend on its state or alphabetical ordering. The normal browser command builds first; CI reuses its verified build through `E2E_SKIP_BUILD=1`.
- Chat tests observe persisted approval state and delayed inference-handler completion instead of arbitrary settle sleeps. The SSE shutdown test awaits actual shutdown with bounded test timeout and failure-safe stream cleanup.
- Browser loading and stale-response checks use request gates. The stale-response test explicitly lets the earlier request complete after changing scope, so it exercises rejection of late results.
- The existing 1,500-row conservation correctness test has an explicit 20-second budget for instrumentation overhead; its fixture and assertions are unchanged. Biome ignores preexisting local `.claude` worktrees when scanning nested configurations.

### Verification and remaining coverage

| Check | Result |
|---|---|
| Lint and typecheck | Passed; existing 4 warnings and 26 infos unchanged |
| Unit/integration suite | 678 / 678 passed across 62 files |
| Coverage suite | 678 / 678 passed |
| Build and compiled-server smoke | Passed |
| Docker smoke | Passed: non-root UID, readiness, import, model profile and restart persistence |
| Playwright | 72 / 72 passed with 2 workers |
| Whole-source line coverage | 70.92% |
| Server line coverage | 89.15% |
| Web line coverage | 14.89% |
| WriterQueue coverage | 100% lines, statements, branches and functions |

The 80% whole-source target is still open. Browser execution is not included in the V8 unit/integration coverage report; no lower replacement threshold was introduced. Other module-specific test gaps listed in the original review remain follow-up work. Docker packaging was unchanged; its smoke check was rerun locally and passed for this follow-up.


## Chronology and grouping refactor — 2026-10-19

This addresses Maintainability items 1 and 2 above. The PR is based on `51c8036` and includes chronology/grouping code and tests; the earlier reliability and test-infrastructure work is separate.

### Shared execution chronology

`src/server/ledger/chronology.ts` owns timestamp interpretation, safe pairwise comparison and the conservative latest-execution bound. Strategy matching and close ordering use its comparator. The existing lifecycle comparator and valuation helper exports remain available through compatibility exports.

- Explicit UTC offsets and UTC aliases compare by actual instants. Fractional seconds compare numerically through nanosecond precision, including equivalent fractional spellings.
- Malformed calendar dates, times and offsets return unknown ordering or an unavailable bound. Parsing does not use the host timezone.
- Same-zone wall clocks and unzoned rows sharing a report retain their established comparison rules. Date-only evidence remains uncertain within its day; different clock frames retain the existing uncertainty envelope through two calendar days. Stable execution keys determine output order without establishing otherwise unknown chronology.
- Valuation retains the conservative latest possible time for unknown zones. Timed sub-millisecond evidence rounds its bound upward so a snapshot cannot predate the fill through millisecond truncation.
- Parsed evidence is cached for repeated grouping comparisons, with invalidation when timestamp/timezone inputs change; source provenance is checked live.

Regression tests reproduced explicit-offset strategy matching failures, invalid-date normalization, fractional ordering/equivalence and unsafe mixed-clock comparisons before correction. Integration caught an overly broad interval inference during the refactor; the established cross-clock uncertainty policy was restored and protected by direct tests.

Fresh pre-PR review found a P2 regression for a UTC date-only opening followed by a next-day explicit timestamp. UTC calendar days now compare their absolute interval bounds against exact instants, including offset crossings, while overlapping instants remain uncertain. Five direct boundary cases and a strategy-matching regression reproduced the defect before correction; independent re-review confirmed the fix.

### Explicit grouping phases

`groupStrategies` is now a 45-line entry point, including imports and documentation, that orchestrates explicit phases. Ten focused helper modules (64–203 lines each) hold context/indexes and consumption, retained decision parsing, allocation reservation, opening groups and unsupported inventory, close candidates, topological ordering, close matching, lifecycle/roll links and merge/finalization.

The public grouping API and resolver type remain compatible. Decimal arithmetic, allocation policy, durable identities, issue keys/sources, merge guards and phase order were retained. FIFO matching and `group_split` behavior were not changed.

Before extraction, complete projections were captured for all five synthetic broker fixtures in forward and reversed execution order. After extraction, all ten projections matched exactly, including allocations, positions, links and diagnostics. Four additional characterization tests cover partial closes, manual residual allocation, duplicate allocation diagnostics and retained merge identities. The existing input-dependent order of roll-link source references was preserved rather than normalized incidentally.

### Verification

| Check | Result |
|---|---|
| Unit/integration suite | 666 / 666 passed across 60 files (38 additional cases) |
| Lint and typecheck | Passed; baseline 4 warnings and 26 infos unchanged |
| Build and compiled-server smoke | Passed |
| Playwright | 72 / 72 passed with the base branch's browser setup |
| Chronology/grouping tests under Los Angeles and Kuala Lumpur host timezones | 32 / 32 passed in each timezone |
| Before/after broker-fixture comparison | Exact match for 5 fixtures in both input orders |
| Retained real-data validation | Passed: 31 executions, no conflicts, 8 complete closed strategies with reconstructed P&L; all six controlled overlap checks and basis-removal control passed |
| Independent reviews | One P2 chronology regression fixed; final chronology and grouping reviews have no remaining findings |

The 80% whole-source coverage target and other findings in this review remain separate follow-ups. This change retains the existing matching algorithm and adds cached timestamp parsing. No live journal data was changed. Verification above was repeated on an isolated checkout containing only this PR, without the earlier uncommitted reliability/test-infrastructure changes. Coverage results from that combined working tree are not claimed for this PR.


## R13 build-job lifecycle follow-up — 2026-10-19

- Rebuild jobs use `finishIfRunning`, and the legacy `finish` entry point delegates to that same conditional update. Completion cannot overwrite a cancellation or another terminal job state.
- Progress updates only affect running jobs, so a queued update cannot replace cancelled progress with `computing`.
- Job notification, progress, rebuild and completion share one failure-handling path. Progress failures release active-work registrations; if persisting failure also fails, the original error is surfaced and existing startup recovery handles the retained running row.
- A candidate made stale by changed inputs retains its stale build status, while its completed computation records a terminal `complete` job. Previously the job's `stale` status was never recognized as terminal by polling or SSE.
- Six deterministic integration tests cover the activation/completion cancellation race, progress-write failure and subsequent rebuild, original-error preservation, pre-candidate validation failure, queued progress after cancellation, and stale candidate completion. Database triggers and a real import provide the failure/race conditions without timing sleeps.

Verification on an isolated checkout of this commit: 672 unit/integration tests across 61 files passed; lint and typecheck passed with the existing 4 warnings and 26 infos.


## Low-severity follow-up — 2026-10-19

Branch: `fix/review-low-severity-followups`, based on merged PR #11 (`1774b67`).

| Finding | Resolution | Regression coverage |
|---|---|---|
| R14 | HTTP preview parsing receives the configured upload limit. Failed multipart requests discard only previews created by that request. Commit reparsing preserves accepted files larger than the default limit. | Real multipart uploads above 20 MiB, configured smaller limits, request-owned staging cleanup, and retained execution rows after commit. |
| R15 | ISO date/time parsing accepts the broker's comma separator without changing timezone interpretation. | Comma timestamps with seconds/fractions and invalid calendar dates. |
| R17 | Monthly chart and summary-export expansion rejects more than 1,200 months with `400 INVALID_ANALYTICS_QUERY`. The bound includes endpoints inferred from evidence; results are never silently truncated. | Explicit, one-sided and evidence-derived spans; 1,200-month boundary; year-9999 termination; real summary/export routes. |
| R18 | Session/turn/tool failures expose stable public messages and error codes. Unexpected internal exception text is excluded from model-facing tool results, SSE and persisted errors. | Filesystem and SQLite-trigger failures through the real chat service, including model-facing tool results. |
| R19 | Replay uses a ring bounded by 2,000 frames and 256 KiB per thread, with at most 128 cached threads. Streams are limited to eight per thread and 64 total; deletion clears replay and closes subscribers. Slow streams have a drain-aware 512 KiB pending queue; overflow disconnects and releases their slots. | Ordered eviction, replay bytes, global/per-thread admission and idempotent slot release, deletion EOF, large replay drainage, burst overflow and reconnection. |
| R21 | Job polling supports aborting observation and continues beyond 60 seconds while mounted. UI owners release polling on navigation/unmount. Analytics errors retain HTTP status even for malformed or non-JSON bodies. | Real browser/HTTP polling, abort cleanup, long-running jobs, non-JSON export failures and component navigation. |
| R22 | Browser strategy/import resource IDs are encoded in API paths and source links. | Reserved-character IDs through real browser requests. |
| R23, validation only | Negative stop-loss prices are rejected before retention, preserving arbitrary decimal precision and allowing zero. | Rejected negative prices leave no decision or metadata; zero/positive and large exact amounts remain supported. |
| R24 | Both messages and running thread state are accepted in one queued SQLite transaction, so failed setup cannot poison retry idempotency. | Failures during assistant insertion/state update, concurrent retries and exactly one retained turn. |

R16 currency preference and R20 endpoint restrictions require explicit product policies; their existing behavior is unchanged. Applying `group_split` needs a validated allocation mapping and replay semantics and remains a separate feature. Model-configuration endpoint confirmation, independent overlapping Flex exports with TradeID, and the 80% whole-source coverage target remain open.

### Verification

- Baseline on merged main: 678 tests passed.
- Final whole-source V8 coverage run: 710 tests passed across 64 files; line coverage 71.20%. Browser execution is reported separately and is not included in this coverage number.
- Full Chromium browser acceptance: 91 tests passed with two workers.
- Lint and typecheck passed with the existing four warnings and 26 informational diagnostics.
- Production build and compiled-server migration, health and SIGTERM smoke passed.
- Docker smoke passed: non-root UID, readiness, import, local model profile and restart persistence.
- Independent review: year-9999 month rollover, SSE subscription accounting/drain behavior, navigation ownership and tool-error sanitization were corrected and rechecked; no remaining findings in this fix set.

The real above-default-limit CSV regression parses over 20 MiB twice. Its initial 20-second timeout was exceeded under coverage instrumentation; the correctness test now has a documented 120-second budget. This is not a throughput guarantee. No live journal data was changed.


### Final PR #12 review corrections

A fresh review of `4650479` found three P2 regressions. All were reproduced by failing regressions before correction:

- **Route IDs:** the router passed encoded segments to detail components, which encoded them again for API requests. Dynamic route IDs now decode exactly once, malformed escapes render Not found, and journal links encode strategy IDs. Browser coverage uses actual App navigation, including reserved characters and a literal `%2F` inside an ID.
- **SSE overflow:** graceful `end()` released admission while a nonreading peer could leave its socket alive. Overflow now destroys the socket before releasing the slot. A native HTTP client that never reads the response reproduces the old failure and verifies immediate socket destruction; normal large replay still drains successfully.
- **Confirmed mutations after navigation:** observation cancellation could stop a multi-file import between commits or prevent a retained lifecycle decision from scheduling its rebuild. Confirmed imports now finish all commits and submit their full rebuild; accepted lifecycle decisions still submit their projection rebuild. Navigation stops polling and UI updates. Browser gates hold the initial commit/decision response, navigate through App, then verify durable follow-up requests without detached polling.

Final verification after these corrections: 710 unit/integration tests across 64 files passed with V8 coverage (71.20% whole-source lines); all 91 Chromium browser tests passed with two workers. Lint/typecheck, production build/compiled-server smoke, Docker restart-persistence smoke and diff formatting checks passed. Independent re-review confirmed all three P2 findings closed with no new findings.
