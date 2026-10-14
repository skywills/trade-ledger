# Whole-repository code review — IBKR trade journal

Date: 2026-10-14

Reviewed branch: `main`

Reviewed HEAD: `812427c` (`docs: add setup and test-plan guides`)

Status: **17 verified findings — six P1 fixed; eleven P2 open**

## Scope and method

Reviewed the current implementation across imports, normalization, ledger identity/revisions, decisions, strategies/accounting, rebuilds, HTTP, browser workflows, AI profiles/transport/analysis, storage, maintenance and packaging. This was a repository review, not a review limited to a Git diff.

Requirements were checked against the [approved design](../superpowers/specs/2026-10-13-ibkr-trade-journal-design.md), [implementation plan](../superpowers/plans/2026-10-13-ibkr-trade-journal.md) and [test plan](../TEST-PLAN.md). Code discovery used the codebase knowledge graph, followed by source inspection and focused synthetic reproductions. Independent reviewers covered ledger/imports, AI/operations and HTTP/browser workflows.

P1 denotes a high-priority correctness defect affecting authoritative evidence, exposure or financial results. P2 denotes a medium-priority correctness, recovery, integration or required-workflow defect. The original review found all 17 issues open. A subsequent verification and fix pass confirmed every finding and resolved R01–R06. R07–R17 remain open. Historical reproductions below describe the reviewed baseline; the resolution section records current behavior.

## Original review verification and limitations

These checks describe the baseline before fixes. Final combined results are recorded in the P1 resolution section.

| Check | Result |
| --- | --- |
| `npm test` | PASS — 16 files, 242 tests. |
| `npm run check:all` | PASS — lint and type checks; nonblocking Biome diagnostics remained. |
| Focused synthetic reproductions | Confirmed financial/ledger, import, restore, context-budget and gateway-authentication defects described below. |
| Build / production smoke | Not run during this review. |
| Browser suite | Not run during this review. |
| Docker suite | Not run during this review. |
| Live broker / live model / deployment | Not tested. |

Passing existing tests does not establish acceptance for the failing cases below. Temporary synthetic probes did not change repository source or retained user data. Source locations refer to reviewed HEAD and may move after fixes. This review does not certify exhaustive correctness, dependency vulnerability status or deployment readiness.

## Independent verification pass — 2026-10-14

The user requested verification of every finding before fixing P1. All 17 were rechecked against `812427c` before application changes. All are confirmed, with the evidence qualifications below. R04's production reproduction is clarified: explicit group assignments establish the retained strategy IDs before the merge; a plain automatic-group merge does not demonstrate the currency defect because provisional IDs follow a different path.

| Finding | Verdict | Fresh evidence |
| --- | --- | --- |
| R01 | Confirmed | Production row normalizer, identity resolver and revision resolver: reversed source order leaves active quantities 2 and 3 (total 5). Synthetic source IDs encode the cross-import ordering. |
| R02 | Confirmed | Real import → full build → exclusion decision → projection build: excluded spread remains, status active, stale false. |
| R03 | Confirmed | Real stock import and full rebuild: October 1 close matches October 10 opening; complete closed strategy, reconstructed P/L 20. |
| R04 | Confirmed | Real USD/EUR import, explicit retained group assignments and merge, then full rebuild: one strategy, cashflow −300, no validation issue. |
| R05 | Confirmed | Preview → commit → normalization: unknown detail row is quarantined in raw evidence but ledger issues are empty. |
| R06 | Confirmed | Production normalization/identity/revisions: T1/E1 and T2/E1 both active; E1-only source binds to first TradeID with warning-only alias conflict. |
| R07 | Confirmed | Modified app-generated archives with consistent manifest/checksums: non-SQLite snapshot restores; valid snapshot missing a database-referenced original also restores. |
| R08 | Confirmed | Production startAnalysis and synthetic endpoint: 4,096-context/512-output profile sends 168,657-byte system prompt for 50 valid evidence rows. |
| R09 | Confirmed | Persisted running analysis survives store reopen unchanged; in-memory subscriber absent. SSE nontermination follows the inspected persisted-status branch; a live SIGKILL/SSE test was not run. |
| R10 | Confirmed | Saved Anthropic cloud profile → production testProfile → synthetic messages endpoint receives Bearer auth and no x-api-key; upstream rejects it. |
| R11 | Confirmed | Real preview/commit of Quantity=abc: preview errors and retained parse errors empty; subsequent normalization rejects quantity. |
| R12 | Confirmed | Playwright probe: one upload action sends commit immediately; forwarded preview marked committable false is still committed by the UI. |
| R13 | Confirmed | Playwright probe: View rows opens import-only URL and displays zero source-row details. |
| R14 | Confirmed | Real 101-strategy browser/API probe: page 1 returns 100 USD strategies, page 2 contains an EUR sentinel; Journal displays 100 rows, no page controls, no sentinel and no EUR filter option. |
| R15 | Confirmed | Existing targeted integration test passes while asserting SPLIT_NOT_APPLIED; schema/source has no child allocation mapping. |
| R16 | Confirmed | Real parser/preview/commit/normalization: execution-shaped O;ST weak row becomes a lot, zero executions, no diagnostic. |
| R17 | Confirmed | Real preview/commit/normalization: Conid-only row produces missing_field.Symbol and no execution. |

Fresh baseline: `npm test` passed (16 files, 242 tests). A targeted existing browser import flow also passed. Temporary verification artifacts are under `/tmp` and are not repository fixtures: `ibkr-verify-root.ts`, `ibkr-verify-ledger.mts`, `ibkr-verify-ai-ops.mts`, `ibkr-verify-ai-context-restart.mts`, `ibkr-web-probe.mjs`, and `ibkr-r14-probe.mjs`. Their outcomes are summarized here so the report does not depend on those temporary files surviving. Permanent P1 regressions are linked in the resolution section below.

## P1 resolution and final verification

All P1 implementers used **gpt-6-luna with high effort**, as requested. Fixes are on `fix/review-p1-2026-10-14`. Each task added failing regressions before production changes, then passed focused tests and independent spec/quality review. Integrated review caught additional correction/chronology/acceptance edge cases; they were corrected and re-reviewed before completion.

| Finding | Resolution | Permanent regression coverage |
| --- | --- | --- |
| R01 | Fixed: dependency passes resolve correction chains independently of source order; missing/cyclic references and competing branches become errors instead of active phantom effects. Newly unlocked siblings are held until their shared predecessor can be checked. | [Ledger regressions](../../test/integration/review-p1-ledger.test.ts) |
| R02 | Fixed: projection-only rebuild verifies original normalization provenance and effective source inputs. Changed imports/inclusion/identity decisions return BUILD_INPUTS_CHANGED with full-rebuild guidance; metadata-only reuse remains valid. | [Build regressions](../../test/integration/review-p1-builds.test.ts) |
| R03 | Fixed: close order respects known chronology, and as-of inventory is separated from future/uncertain close reservations so they cannot double-spend or reverse historical exposure. Unknown timing remains unresolved when order cannot safely be established. | [Strategy regressions](../../test/integration/review-p1-strategies.test.ts) |
| R04 | Fixed: new decision acceptance and retained replay enforce account/currency boundaries, including absent/transitive merge targets and mixed-allocation payloads for new strategies. Accounting suppresses invalid totals and validation prevents activation. | [Strategy regressions](../../test/integration/review-p1-strategies.test.ts) |
| R05 | Fixed: included raw quarantine issues survive normalization with committed import/row references, reach projection review and suppress definitive reconstructed P/L. | [Ledger regressions](../../test/integration/review-p1-ledger.test.ts) |
| R06 | Fixed: conflicting execution aliases are held with error diagnostics instead of selecting an arbitrary TradeID. Explicit correction lineage with reused IDs remains supported; retained evidence is preserved. | [Ledger regressions](../../test/integration/review-p1-ledger.test.ts) |

Final checks on the combined P1 code:

| Check | Result |
| --- | --- |
| npm test | PASS — 19 files, 280 tests (38 more than baseline). |
| npm run check:all | PASS — lint/typecheck; the same nonblocking Biome warning and informational diagnostics remain. |
| npm run build | PASS — compiled backend/migrations and Vite frontend. |
| node scripts/smoke-built-server.mjs | PASS — migrations, exact npm start health, SIGTERM shutdown. |
| npm run test:e2e | PASS — all 19 Chromium tests. Color-environment warnings are nonblocking. |
| git diff --check | PASS. |
| Docker / live model / deployment | Not run in this pass. |

Scalability correction: an intermediate chronology implementation stored every pairwise edge. Independent review measured nearly eight million edges for 4,000 closes; that implementation was replaced before completion. Final ordering uses linear auxiliary storage, though comparisons remain quadratic. The reviewer's 4,000-close ordering probe used about 11 MiB heap at completion rather than about 223 MiB; the coordinator's complete 2,500-close grouping probe used about 13 MiB rather than about 111 MiB. These are synthetic measurements, not throughput guarantees.

**Existing data needs a full rebuild after updating.** Parser/algorithm version strings remain unchanged. A projection-only rebuild can reuse pre-fix normalization when its source inputs are unchanged, so R01/R05/R06 corrections require regenerating that ledger. No existing user journal data was automatically changed by this fix pass. Conflicted evidence or incompatible retained decisions may require review/supersession before a valid replacement build can activate.

Timezone qualification: unzoned executions within the same report use their common wall-clock provenance. Across different reports/zones, clearly separated dates can establish order without assigning a timezone; close dates that remain ambiguous are held for review. Same-time closes consume available exposure deterministically.

Execution decisions: used the existing checkout on a dedicated branch to preserve the requested documentation; treated the user's explicit verify-then-fix instruction as authorization to execute the recorded plan; separated historical inventory from reservations; left existing data unchanged pending an explicit full rebuild. The practical costs are relocating uncommitted work if another workspace is preferred, reversible local code changes, conservative unresolved matches where evidence is insufficient, and the required full rebuild for old generations.

### Final pre-commit review — 2026-10-15

A fresh reviewer examined the full code, tests and documentation change set before the user-requested commit. Two reservation edge cases were confirmed and fixed before approval:

- **F01 (P2):** A known future opening before a reserved future close was ignored, leaving a valid +1 / −1 / +1 / −1 UTC sequence falsely unresolved. The production regression now yields one closed group with quantity 0, cashflow 20 and reconstructed P/L 20. Funding after the reserved close or with uncertain ordering cannot release earlier capacity; adverse tests explicitly include those openings in the retained group.
- **F02 (P1):** Known and uncertain reservations were combined using a maximum rather than preserving both demands. This allowed three closes against a two-unit opening. Separate uncertain demand is now added to the maximum known future deficit, so the excess automatic close remains unresolved and no opposite-sign inventory is created.

Both fixes use decimal quantities and preserve the linear auxiliary-memory ordering. The reviewer re-ran production import/decision/rebuild probes plus cases for shared replenishment, late funding, incomparable close ordering, separate uncertain demand and short-position mirroring. Final verdict: **approved, no remaining new P1/P2 blockers in this change set**. Original R07–R17 remain open. Final combined gates passed 280 unit/integration tests, lint/typecheck, build, compiled-server smoke and all 19 browser tests.

## High-priority findings — resolved after verification

### R01 — P1: Correction chains can duplicate active effects

**Location:** [revisions.ts](../../src/server/ledger/revisions.ts), lines 82–84 and 116–118.

Referencing transactions are ordered by source/import identifiers rather than revision dependencies. An unresolved reference immediately becomes an active standalone transaction and is not reconsidered after its predecessor is processed.

**Reproduction:** T1 has quantity 1; T2 corrects T1 to quantity 2 in import `z`; T3 corrects T2 to quantity 3 in import `a`. Processing T3 first leaves T2 and T3 active, giving quantity **5 instead of 3**, with only a warning.

**Required change:** Resolve reference chains in dependency order; unresolved or cyclic references must not silently contribute definitive active effects. Add multi-import, multi-hop correction coverage. Violates acceptance check 3.

### R02 — P1: Projection rebuilds can activate an obsolete ledger as current

**Location:** [builds/service.ts](../../src/server/builds/service.ts), lines 171–190 and 226–233.

Projection-only rebuilds verify the retained ledger's parser version but not whether its normalization inputs still match current imports and identity/inclusion decisions. The candidate receives the current input hash even when its ledger reflects older inputs.

**Reproduction:** Import scenario A, perform a full build, append an import-exclusion decision, then request a projection-only rebuild. The excluded spread remains visible and the result reports `active` with `stale: false`.

**Required change:** Verify normalization-input freshness before reusing a ledger, then reject or perform a full normalization when necessary. Violates the fixed-input build and stale-activation guarantees in acceptance check 9.

### R03 — P1: Closes can match openings that occur later

**Location:** [grouping.ts](../../src/server/strategies/grouping.ts), lines 475–497.

All opening drafts exist before close matching, and candidate selection checks contract, account, currency and quantity without checking chronology. Close processing is also ordered by execution key rather than event time.

**Reproduction:** An October 1 close and an October 10 opening for the same instrument produce a complete closed strategy whose close date precedes its opening date, with reconstructed P/L and no issue.

**Required change:** Match against exposure available at the close's event time, preserving timestamp/timezone uncertainty. Future openings must not establish missing prior history. Violates the consolidation and completeness requirements.

### R04 — P1: Strategy merges combine incompatible currencies

**Location:** [grouping.ts](../../src/server/strategies/grouping.ts), lines 668–698.

Merge consolidation takes one account/currency label and appends every merged draft's allocations. There is no compatibility guard preventing different currencies or accounts from entering the same strategy.

**Reproduction:** After explicitly assigning USD and EUR executions to retained groups, merging USD net cash −100 and EUR net cash −200 produces cashflow −300 under one currency label. `validateProjection()` returns no errors.

**Required change:** Validate account/currency compatibility at decision acceptance and projection validation. Never sum currencies without a verified FX policy. Violates acceptance checks 7 and 15.

### R05 — P1: Quarantined raw-row issues disappear during normalization

**Location:** [normalize.ts](../../src/server/ledger/normalize.ts), lines 264–289.

Normalization handles execution and lot rows but does not propagate existing issues from quarantined rows. Accounting consequently receives no error indicating that financial evidence was omitted.

**Reproduction:** Import scenario A plus a financial row with `LevelOfDetail=BOGUS`. Preview identifies quarantine, but normalization returns four executions, `issues=[]` and `conflicts=0`. Definitive reconstructed accounting remains possible and Review receives no quarantine diagnostic.

**Required change:** Carry included raw-row quarantine issues into ledger/build diagnostics and completeness checks. Existing accounting tests inject quarantine issues directly and miss this integration path. Violates acceptance checks 13 and 15.

### R06 — P1: Conflicting execution aliases still select an arbitrary identity

**Location:** [identity.ts](../../src/server/ledger/identity.ts), lines 165–200 and 239–252.

An execution-ID alias remains usable after conflicting TradeID registrations are detected. Alias conflict is a warning and is not counted as an identity conflict that blocks definitive accounting.

**Reproduction:** Within one account, T1/E1 and T2/E1 have identical financial payloads, followed by an E1-only occurrence. Two transactions remain active; the E1-only source binds to whichever TradeID registers first by source order.

**Required change:** Stop automatic alias binding for conflicted IDs, retain all sources and require explicit identity resolution before definitive totals. Violates the nonconflicting-alias and ambiguous-identity requirements.

## Medium-priority findings

### R07 — P2: Restore trusts archive metadata without validating SQLite

**Location:** [restore.ts](../../src/server/maintenance/restore.ts), lines 231–242.

Restore checks manifest-declared schema compatibility and checksums, then swaps directories without validating SQLite integrity, actual migrations or database references to original files.

**Reproduction:** An archive whose `journal.sqlite` contains `not a SQLite database`, with matching SHA/size and supported manifest schema version, restores successfully. `openStore()` then fails. Missing referenced originals can likewise evade manifest-only validation.

**Required change:** Open the staged database read-only, verify integrity and actual schema compatibility, and cross-check retained file references before replacing data. Violates the offline restore requirements and acceptance check 11.

### R08 — P2: Initial AI evidence bypasses the context budget

**Location:** [analysis.ts](../../src/server/ai/analysis.ts), lines 177–184 and 372.

The initial prompt serializes the first 50 evidence rows without accounting for the selected profile's context/output limits or the bounded-read byte cap.

**Reproduction:** A verified profile with context window 4,096 and maximum output 512 receives a 171,289-byte system prompt for 50 valid stock rows whose symbols each contain 1,000 CJK characters. Every individual row is below the evidence-row size limit; the combined request far exceeds the profile context.

**Required change:** Budget initial evidence using the same conservative byte/token accounting as subsequent batches, reserving instructions, tools and output. Violates acceptance check 18 and the plan's explicit context-budget requirement.

### R09 — P2: Interrupted analysis runs remain running after restart

**Location:** [database.ts](../../src/server/storage/database.ts), lines 27–33; [app.ts](../../src/server/app.ts), lines 166–167; [routes-analysis.ts](../../src/server/http/routes-analysis.ts), lines 190–213.

Startup recovers jobs/builds but does not terminate abandoned `ai_runs`. After a process is killed during analysis and restarted, the persisted run remains running while its in-memory session no longer exists; the event route can wait indefinitely.

**Required change:** Recover nonterminal analysis runs with an interrupted/failure diagnostic and make their event streams terminate. Violates crash recovery and bounded analysis lifetime requirements.

### R10 — P2: Gateway authentication ignores the provider protocol

**Location:** [transport.ts](../../src/server/ai/transport.ts), lines 180–192.

The gateway strips `x-api-key` and always injects `Authorization: Bearer …`; the configured protocol is not used for authentication injection.

**Reproduction:** A synthetic Anthropic messages endpoint receives Bearer authorization but no `x-api-key` for an API-key credential reference. Such a cloud profile cannot authenticate with the expected API-key header.

**Required change:** Inject credentials according to the selected supported protocol while retaining endpoint isolation and secret redaction.

### R11 — P2: Import previews omit financial validation errors

**Location:** [imports/service.ts](../../src/server/imports/service.ts), lines 281–295.

Preview diagnostics come from CSV parsing/classification without execution normalization. An `EXECUTION` row with `Quantity=abc` previews as one execution, zero quarantined rows and no issues. Commit retains an execution row with empty parse errors; only a later build discovers the invalid decimal.

**Required change:** Include financial normalization diagnostics in preview and retained row errors so Imports exposes invalid evidence independently of successful rebuilding. Violates the requirement to identify affected rows before confirmation.

### R12 — P2: Browser uploads commit before the user reviews the preview

**Location:** [ImportsPage.tsx](../../src/web/imports/ImportsPage.tsx), lines 81–90.

The upload handler displays previews and immediately commits them in the same action. A user cannot inspect capabilities, account selection or row issues before retention; import deletion is outside the release scope.

**Required change:** Make preview and confirmation separate actions and respect each preview's committable status. This is independent of R11: a correct server preview still needs a confirmation step.

### R13 — P2: The import evidence link renders no rows

**Location:** [ImportsPage.tsx](../../src/web/imports/ImportsPage.tsx), lines 193 and 201–202.

“View rows” supplies only an import ID, while evidence rendering requires a row query parameter. Clicking the link displays no source rows, including quarantined rows that have no normalized execution.

**Required change:** Provide an import-row browser and links to individual evidence details. Violates independent quarantine visibility in acceptance check 13.

### R14 — P2: Journal browsing silently truncates at 100 strategies

**Location:** [JournalPage.tsx](../../src/web/journal/JournalPage.tsx), lines 25–35.

The page requests only the first 100 strategies, ignores the total and offers no pagination. Strategy 101 onward is inaccessible, and currencies present only on omitted pages are missing from the filter. Transactions, review, detail and decision selectors repeat the fixed-first-page pattern.

**Required change:** Implement pagination and server-backed filtering, including complete selectors where required by the decision workflow.

### R15 — P2: Retained split decisions do not split strategies

**Location:** [grouping.ts](../../src/server/strategies/grouping.ts), lines 295–305; [schemas.ts](../../src/server/decisions/schemas.ts), the group-split payload.

A split decision is retained but rebuilding only emits `SPLIT_NOT_APPLIED`. The payload names parent/child identities without defining their allocation mapping, so no child strategy exposure is produced.

**Required change:** Define a validated parent-to-child allocation mapping, apply it deterministically, and preserve explicit metadata ownership. Retaining the decision alone does not satisfy the approved split behavior or acceptance check 14.

### R16 — P2: ST/LT codes alone can exclude weak executions

**Location:** [classification.ts](../../src/server/imports/classification.ts), lines 54–55.

With no strong IDs or explicit detail level, an ST/LT code is sufficient to classify a row as a supporting lot. A row with the minimum financial execution fields and `Notes/Codes=O;ST` therefore loses its inventory/cash effect.

**Required change:** Require supporting-lot shape and fields in addition to codes. The design explicitly states that ST/LT alone is insufficient; uncertain rows must retain evidence for review.

### R17 — P2: Contract-only executions violate the minimum input contract

**Location:** [normalization.ts](../../src/server/imports/normalization.ts), line 233.

Symbol is required unconditionally. An otherwise valid execution with `Conid=123` and an empty Symbol is rejected with `missing_field.Symbol`, although the design allows a symbol or contract identifier.

**Required change:** Accept a supported contract identifier when Symbol is absent and preserve the absence in presentation. Update tests that currently assert unconditional Symbol quarantine.

## Documentation follow-up

The previous implementation status described a Task 2 scaffold despite Tasks 3–15 having implementation artifacts. The [status document](../IMPLEMENTATION_STATUS.md) has been updated to distinguish implementation presence, verified checks and open defects. The implementation-plan checkboxes for later tasks still need reconciliation against actual execution/review evidence.

## Recommended next work

R01–R06 are fixed and the combined code passed the checks above. Resolve R07–R17 next with regressions for the documented cases, and verify Docker/deployment behavior before declaring release readiness. Perform a full rebuild for existing data after updating the app.

One investigated concern remains unconfirmed: backup pauses the store writer queue while analysis uses an independent file transcript store. Concurrent transcript consistency needs an end-to-end test; it is not counted among the 17 confirmed findings. An initially suspected SSE framing defect was disproved by a runtime check and is not a finding.
