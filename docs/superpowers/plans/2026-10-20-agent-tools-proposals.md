# Agent Tools: Proposal Validation and Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent explain retained decisions, preview corrections without live changes, and propose selected operations already supported by the backend.

**Architecture:** Add history queries and a disposable SQLite simulation service behind focused chat tools. Reuse appendDecision/rebuild on the isolated store for semantic validation; acceptance remains the sole path to a live decision. Complete the reads plan first; this release does not need the portfolio plan.

**Tech Stack:** Existing TypeScript, Zod, better-sqlite3 backup API, node:fs/promises, decimal.js, Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-agent-tool-expansion-design.md`, project-wide requirements and release 2. Review draft.

## Global Constraints

- Node.js >=22.19.0; use existing TypeScript, Zod, decimal.js, Fastify and Vitest.
- No new runtime dependencies or database migrations.
- Money and quantities remain decimal strings; null means unavailable, never zero.
- Never sum currencies together or silently fall back between P&L bases.
- Existing writes keep `approval: "always"`; decisions require explicit proposal acceptance.
- Existing tool names and existing proposal JSON remain compatible.
- A preview creates no live decision, identity, job, ai_run or build.
- Keep `profile: "none"`; do not add shell, arbitrary SQL, filesystem or generic network tools.
- Other project-wide requirements in the spec apply unchanged.

## Review Focus

- Full rebuild allocates IDs: every preview must leave live tables and active build unchanged (Task 2).
- A decision/import/build changes during simulation: discard the preview instead of blessing stale evidence (Task 2).
- A rejected or failed simulation: close the temporary database and delete its directory (Task 2).
- Superseded records outside a history page: effective status still reflects the full captured history (Task 1).
- Old proposal cards after schema expansion: render, accept and reject them without migration (Tasks 3–4).

---

## File structure

- Create `src/server/decisions/history.ts`: scoped history and effectiveness queries.
- Create `src/server/chat/tools/decisions.ts`: get_decision_history adapter.
- Create `src/server/ai/proposal-preview.ts`: snapshot/copy/append/rebuild/compare/cleanup coordinator.
- Create `src/shared/proposal-preview.ts`: typed preview result schema for tool and future UI consumers.
- Create `src/server/chat/tools/proposal-preview.ts`: preview_proposal adapter.
- Modify `src/server/ai/proposals.ts`: selected variants, supersession, reusable validation and current acceptance.
- Modify `src/server/chat/tools/{proposals,index}.ts`: validate before recording and register preview/history.
- Modify `src/shared/api.ts` and `src/web/review/ProposalList.tsx`: compatible transport and readable operation summaries.
- Modify `src/server/chat/instructions.ts`, `README.md`, existing tests and e2e/proposals.spec.ts.

### Task 1: Scoped decision history

**Files:** Create `src/server/decisions/history.ts`, `src/server/chat/tools/decisions.ts`, `test/integration/chat-decision-history.test.ts`; modify `src/server/chat/tools/index.ts`.

**Interfaces:**
- Consume readDecisions(store, watermark), effectiveDecisions and Task 1 snapshot helpers from the reads plan.
- Export `DecisionHistoryQuery` with optional kind, strategyId, lifecycleId, campaignId, importId and required offset/limit.
- Export `selectDecisionHistory(store: Store, watermark: number, query: DecisionHistoryQuery): {items: Array<Decision & {effective: boolean; supersededBy: string | null}>; total: number}`. Use the persisted Decision type from decisions/service.ts, which includes author/time metadata.
- Export `decisionHistoryTools(ctx: ChatToolContext): ChatTool[]` registering get_decision_history. Tool adds optional expectedBuildId and expectedWatermark; capture current watermark with the snapshot. Match references using typed kind-specific payload fields and top-level sources/strategyIds, never substring search over JSON. Filters intersect; newest sequence first.

- [x] **Step 1: Write failing tests.** Add `history_matches_exact_payload_references`, `superseded_status_survives_page_and_filter_boundaries`, `filters_do_not_match_substrings`, `rejects_changed_watermark`, and `returns_empty_history_without_build`. Assert full captured effectiveness before paging and proper nextOffset after byte shortening.

```ts
expect(prior).toMatchObject({ effective: false, supersededBy: replacement.id });
expect(current).toMatchObject({ effective: true, supersededBy: null });
expect(substringOnlyMatch.items).toEqual([]);
expect(emptyHistory).toMatchObject({ items: [], total: 0, nextOffset: null });
```
- [x] **Step 2: Verify failure.** Run `npx vitest run test/integration/chat-decision-history.test.ts`; expect missing selector/factory.
- [x] **Step 3: Implement history and adapter.** Capture decision history and metadata in one synchronous transaction. Compute effective IDs using existing semantics on all captured decisions; apply scope filters afterward. Register through the read guard. Include UNTRUSTED in the tool description because notes/rationales are user data.
- [x] **Step 4: Verify.** Run `npx vitest run test/integration/chat-decision-history.test.ts test/integration/analysis.test.ts`; expect exact reference matching and existing accept/reject behavior preserved.
- [x] **Step 5: Commit.** Stage task files and `git commit -m "feat: expose scoped decision history to the agent"`.

### Task 2: Isolated preview for existing proposal kinds

**Files:** Create `src/shared/proposal-preview.ts`, `src/server/ai/proposal-preview.ts`, `src/server/chat/tools/proposal-preview.ts`, `test/integration/proposal-preview.test.ts`; modify `src/server/chat/tools/index.ts`.

**Interfaces:**
- Export `ProposalPreviewSchema` and inferred `ProposalPreview` in shared/proposal-preview.ts. Result fields: valid:boolean; buildId:string; ledgerId:string; watermark:number; issues:Array<{code:string; severity:"warning"|"error"}>; impact:null | {before:PreviewTotals; after:PreviewTotals}.
- `PreviewTotals`: strategyCount:number; lifecycleCount:number|null; unresolvedStrategies:number; issueCounts:Array<{code:string; count:number}>; pnlByCurrency:Array<{currency:string; brokerPnl:string|null; reconstructedPnl:string|null; missingBrokerPnl:number; missingReconstructedPnl:number}>. Sort currencies/codes; preserve known coverage rather than treating null as zero.
- Export `previewProposal(store: Store, proposal: Proposal, expected: {buildId: string; watermark: number}, options?: {signal?: AbortSignal; now?: () => Date}): Promise<ProposalPreview>`.
- Export `proposalPreviewTools(ctx: ChatToolContext): ChatTool[]` registering preview_proposal with strict input `{proposal, expectedBuildId, expectedWatermark}`. Tool factory uses a 30-second AbortController timer, cleared in finally, and existing model output limits.

- [x] **Step 1: Write failing tests.** Add `preview_valid_notes_changes_no_live_tables`, `over_allocation_is_invalid_without_impact`, `full_rebuild_impacts_match_separate_test_store`, `stale_or_missing_build_requires_rebuild`, `concurrent_import_decision_or_activation_discards_result`, `cleanup_after_failure_or_abort`, and `unknown_pnl_stays_null_per_currency`. Compare all live rows in decisions, strategy/lifecycle identity tables, builds, jobs, ai_runs and active pointers before/after; do not compare database-file bytes under WAL.

```ts
expect(validPreview.valid).toBe(true);
expect(liveRowsAfter).toEqual(liveRowsBefore);
expect(overAllocated).toMatchObject({ valid: false, impact: null });
expect(overAllocated.issues).toContainEqual({ code: "OVER_ALLOCATION", severity: "error" });
expect(temporaryDirectoriesAfter).toEqual(temporaryDirectoriesBefore);
```
- [x] **Step 2: Verify failure.** Run `npx vitest run test/integration/proposal-preview.test.ts`; expect missing service/schema.
- [x] **Step 3: Implement the isolated coordinator.** Reject missing/stale live builds and mismatched watermark with explicit errors. Create a private temporary directory, copy the database using `store.db.backup`, open with openStore, then compare cloned build/watermark to the captured live state. No open SQLite transaction crosses await. Capture before totals from the clone; call validateProposal and appendDecision on the clone using proposalDecisionInput, followed by full rebuild with current parser/algorithm versions. Rebuild uses retained parsed database rows; do not copy or expose original CSV files. Convert domain validation errors into valid:false; propagate operational/timeout errors as tool errors. Treat a non-active/failed rebuild as invalid, never successful. Capture after totals and recheck live build/watermark/stale state before returning. Always closeStore and recursively remove only the created temporary directory in finally.
- [x] **Step 4: Verify.** Run `npx vitest run test/integration/proposal-preview.test.ts test/integration/chat-tools.test.ts`; expect side-effect, concurrency, cleanup and decimal tests passing. Confirm abort checks before backup, before append/rebuild and before returning; existing synchronous work is not claimed to be preemptible.
- [x] **Step 5: Commit.** Stage task files and `git commit -m "feat: preview agent corrections in an isolated store"`.

### Task 3: Selected proposal kinds and supersession

**Files:** Modify `src/server/ai/proposals.ts`, `src/server/chat/tools/proposals.ts`, `src/shared/api.ts`, `src/web/review/ProposalList.tsx`; create `src/server/ai/proposal-kinds.ts`, `test/integration/expanded-proposals.test.ts`.

**Interfaces:**
- Add group_merge, group_split, import_exclusion, import_inclusion, lifecycle_attachment, lifecycle_membership, lifecycle_attachment_rejection, wheel_campaign and wheel_campaign_membership to ProposalSchema. Reuse payload schemas from DecisionInputSchema.options and shared/lifecycles.ts instead of copying constraints.
- Add common `supersedesId: string | null`, default null for old JSON. Preserve sources/strategyIds/rationale defaults. Keep existing Proposal/ProposalKind imports compatible via re-exports.
- Export the supported proposal-kind metadata from proposal-kinds.ts; generate the model-facing kind enum and capability listing from it.
- `proposalDecisionInput(proposal: Proposal): DecisionInput` maps every supported kind and supersedesId; application-owned author and idempotency behavior stay as today. Generic rejection, lifecycle_valuation and multiplier fixes remain unsupported.
- ProposalList renders typed payload summaries: target group/member IDs and quantities, import action, campaign name/membership and supersession target. Render values as React text; no raw JSON-only acceptance cards.

- [x] **Step 1: Write failing tests.** Parameterize `each_added_kind_parses_previews_and_accepts` over all nine kinds using valid matching fixtures. Add `cross_account_or_currency_membership_is_invalid`, `partial_contract_and_overlapping_coverage_are_rejected`, `import_exclusion_changes_full_rebuild`, `supersession_replaces_prior_effect`, and `legacy_six_variants_keep_defaults`. Assert one decision after explicit acceptance and none after preview/submission alone.

```ts
expect(parsed.kind).toBe(kind);
expect(proposalDecisionInput(parsed).kind).toBe(kind);
expect(preview.valid).toBe(true);
expect(decisionsAfterPreview).toHaveLength(0);
expect(decisionsAfterAccept).toHaveLength(1);
expect(parsedLegacy.supersedesId).toBeNull();
```
- [x] **Step 2: Verify failure.** Run `npx vitest run test/integration/expanded-proposals.test.ts`; expect unknown kinds/supersedesId behavior failures.
- [x] **Step 3: Extend schema, mapping and rendering.** Extend ledger validation by kind without replacing appendDecision's deeper checks. Preview through Task 2 to exercise normalization/grouping/lifecycle constraints. Ensure conversion of saved legacy runs does not require new fields. Keep import inclusion/exclusion behind proposal acceptance, never a direct write tool.
- [x] **Step 4: Verify.** Run `npx vitest run test/integration/expanded-proposals.test.ts test/integration/proposal-preview.test.ts test/integration/analysis.test.ts test/integration/lifecycle-decisions.test.ts`; expect all new kinds and legacy validation passing. Run `npm run typecheck` to catch exhaustive UI/DTO union assumptions.
- [x] **Step 5: Commit.** Stage task files and `git commit -m "feat: expand agent proposals for retained correction operations"`.

### Task 4: Validate submission and exercise acceptance end to end

**Files:** Modify `src/server/chat/tools/proposals.ts`, `src/server/ai/runs.ts`, `src/server/chat/instructions.ts`, `README.md`, `test/integration/chat-tools.test.ts`, `test/integration/chat.test.ts`, `e2e/proposals.spec.ts`.

**Interfaces:**
- submit_proposal keeps its current top-level shape, plus optional supersedesId through Task 3's schema. Before persistence, call previewProposal with the freshly captured build/watermark. On invalid return a bounded error listing codes, with no card/run created.
- Add `recordValidatedProposal(store: Store, input: {runId: string; draft: RunDraft | null; submitted: SubmittedProposal; expected: {buildId: string; watermark: number}; maxProposals: number}): Promise<void>` in ai/runs.ts. In one synchronous writer transaction, check current build/watermark/stale state and proposal count, insert the run only when draft is supplied, and append the proposal. Reuse internal run SQL mapping; never call async insertRun from within the transaction. Replace ensureRun with `prepareRun(ctx: ChatToolContext): Promise<{runId: string; draft: RunDraft | null}>`, which constructs evidence/profile metadata but does not persist. This closes the validation-to-persistence race and prevents empty runs on rejection.
- acceptProposal continues to validate current ledger and decision watermark and use appendDecision; never reuse the clone's decision IDs. Existing accepted flags and rejection semantics remain unchanged.
- Cap remains MAX_PROPOSALS_PER_RUN=20; check it before starting an expensive preview and again before persistence. Failed validation does not consume the cap.

- [x] **Step 1: Write failing tests.** Add `invalid_submit_creates_no_run_or_card`, `valid_submit_creates_pending_card_without_decision`, `acceptance_revalidates_after_live_change`, and `twentieth_proposal_allowed_twenty_first_refused_without_preview`. Extend fake-inference integration to preview then submit a lifecycle attachment. In browser tests, assert a new kind shows payload details, Accept creates exactly one decision, Reject leaves the proposed correction unapplied, and a legacy notes card still works.

```ts
expect(invalidResult.isError).toBe(true);
expect(runsAfterInvalid).toHaveLength(0);
expect(pendingRun.proposals[0].accepted).toBe(false);
expect(decisionsBeforeAccept).toHaveLength(0);
expect(twentyFirstResult.isError).toBe(true);
expect(previewCallCountAfterLimit).toBe(previewCallCountBeforeLimit);
```

Add `live_change_before_atomic_record_creates_no_empty_run`: arrange a retained import/decision after preview and before recordValidatedProposal, then assert the call fails and both proposal/run counts remain unchanged.
- [x] **Step 2: Verify failure.** Run `npx vitest run test/integration/chat-tools.test.ts test/integration/chat.test.ts`; expect invalid submission accepted by old behavior.
- [x] **Step 3: Integrate and document.** Explain preview versus pending proposal versus accepted decision, stale-build recovery, unsupported valuations/multipliers and expected full-rebuild cost. Keep all new tools under existing read guards; preview creates temporary data only. Preserve reset-after-live-write behavior.
- [x] **Step 4: Verify release.** Run `npm run check:all`, `npm test`, `npm run test:e2e -- e2e/proposals.spec.ts e2e/chat.spec.ts`, and `npm run test:build-smoke`; expect exit 0 for each. Record simulation elapsed time for existing lifecycle fixtures without imposing a machine-dependent timing assertion.
- [x] **Step 5: Commit.** Stage task files and `git commit -m "feat: validate chat proposals before presenting acceptance cards"`.

## Handoff and self-review

Release 2 covers history, preview isolation, pre-submission validation, supersession
and nine additional operations. Manual valuation and generic rejection remain
explicitly deferred in the design; they are not implementation omissions. Every
Review Focus item has a corresponding named regression. Read and approve the
design/plan before execution; isolate implementation using the worktree workflow.


## Execution record (2026-10-20)

Implemented on `feat/agent-proposal-tools` from merged release 1 (`b3e8725`).
All four tasks completed. Release 3 is outside this branch.

- Ruling: added `ai/proposal-state.ts` so preview and atomic submission share
  the same synchronous build/watermark/staleness check. Cost if wrong: localized
  helper refactor.
- Ruling: deferred `group_split` after confirming the grouping engine emits
  `SPLIT_NOT_APPLIED` because its payload lacks allocation mappings. Eight added
  kinds (14 total) are available; capabilities and instructions disclose this
  limit. Cost if wrong: splitting needs a separate deterministic engine design.
- Submission saves evidence and a pending card atomically, checks cancellation
  after waiting for the writer, and creates a fresh run when immutable evidence
  changes. Rejected validation never consumes a card slot or creates an empty run.
- Verification: 850 unit/integration tests across 79 files; 9 targeted browser
  tests; `npm run check:all` and built-server smoke passed. Lint reports existing
  warnings/information without errors.
- Synthetic four-strategy lifecycle attachment preview: 47 ms on this machine.
  This is a small-fixture observation, not a performance guarantee.

### Final independent review

One whole-branch review found no Critical issue and one Important issue: reused
payloads stripped unknown keys. Fixed strict validation throughout proposal,
payload, source and nested allocation/target objects while reusing retained
scalar/array constraints. Eight regressions failed first, then passed; defaults
for valid legacy cards remain compatible. The full suite (850 tests), targeted
browser tests (9), lint/typecheck and built-server smoke passed after the fix.

Deferred minor: `full_rebuild_impacts_match_separate_test_store` currently checks
known unchanged notes totals rather than an independent store. Changed counts
are covered, but changed per-currency P&L/issues still need an independent
accept-and-rebuild comparison. This remains a test coverage limitation.

Review rulings uphold the split deferral above. Manual valuation, generic
rejection proposals, multiplier corrections and release 3 remain separate work;
cost if this scope decision is wrong: those capabilities remain unavailable
until implemented separately.
