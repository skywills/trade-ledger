# Proposal evidence scope implementation plan

**Goal:** Allow a correction affecting a small part of a large journal to create a pending proposal card.

**Design:** Derive immutable evidence from the proposal's source, execution, strategy, import, lifecycle and campaign references instead of the conversation's initial issue selection. Keep the 2,000-row and row-size bounds, full-journal preview and acceptance validation, cancellation, and atomic state checks. Reuse a proposal run only when its evidence hash and journal state match the next proposal.

**Approach:** Increasing the global limit only moves the failure. Exposing an optional scope to the model leaves correctness dependent on prompting. Application-derived scope fixes the cause without changing the tool schema.

**Files:** `src/server/ai/evidence.ts`, a new `src/server/ai/proposal-evidence.ts`, `src/server/chat/tools/proposals.ts`, and proposal evidence/submission integration tests.

- [x] Add regression tests for attachment, membership and notes submissions above 2,000 executions, and distinct scopes in one turn. Run them and confirm the current failure.
- [x] Add explicit execution selection to the bounded snapshot builder and collect proposal references with an exhaustive kind switch. An explicitly empty selection means no trade evidence, never the full ledger.
- [x] Prepare evidence for every proposal; reuse a run only for matching state and evidence. Preserve full validation and atomic recording.
- [x] Cover supported reference shapes, relevant-scope overflow, unrelated seeded issues, and metadata-only proposals. Run targeted tests, the full suite, lint, typecheck and build.
- [x] Review the diff for incomplete evidence, changed validation behavior, state races and unrelated changes, then commit on `fix/proposal-evidence-scope`.

Validation: five new regressions failed against the original implementation and passed after the fix. Final full suite: 117 files, 1,131 tests passed. `npm run check:all` and `npm run build` passed; lint reported four existing warnings and 26 informational diagnostics in unrelated code. Independent read-only review found no blocking issues.

Evidence boundary: the snapshot contains directly referenced active executions and the current members of referenced strategies/lifecycles/campaigns. Excluded-import and superseded-decision references remain in the retained proposal; their historical data stays in the journal and full validation continues to use it. An excluded-import proposal/acceptance regression verifies that reinstatement still works.
