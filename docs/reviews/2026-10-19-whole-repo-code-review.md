# Whole-repository code review — TradeLedger

Date: 2026-10-19

Reviewed branch: `main`

Reviewed HEAD: `a90a92c` (`Merge pull request #8 from skywills/feature/trade-lifecycles`)

Status: **12 high/medium findings open — no critical findings**

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
