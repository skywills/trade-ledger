# Review P1 fixes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. The user requested `gpt-6-luna` with high effort for P1 fixes.

**Goal:** Verify all 17 reported findings and fix the six confirmed P1 financial/evidence defects, leaving P2 behavior outside this fix pass.

**Architecture:** Preserve retained raw evidence, source references and decisions. Correct normalization and projection boundaries using existing services and enforce invariants before build activation. Add focused regressions against real temporary SQLite stores and synthetic imports.

**Tech Stack:** Existing TypeScript/Fastify/SQLite/decimal.js app and Vitest; no dependency changes.

**Spec:** [Approved design](../specs/2026-10-13-ibkr-trade-journal-design.md) and [review findings R01–R06](../../reviews/2026-10-14-whole-repo-code-review.md).

## Global constraints

- Financial decimals use canonical TEXT, never SQLite REAL.
- Decisions refer to durable source/logical references rather than projection row IDs.
- No transaction disappears merely because it is absent from a later reporting window.
- Missing history stays unresolved; never invent opening transactions.
- Do not aggregate currencies without a verified FX conversion policy.
- A stale candidate is not activated. Crashes leave the old active generation intact.
- Rebuild never calls the LLM.
- Preserve the existing documentation changes. The initial fix pass leaves changes uncommitted for review; a subsequent explicit user request authorizes final review and commit. Remote writes and deployments are outside scope.

## Verification gate

- [x] Independently verify R01–R17 using current source, callers and synthetic reproductions.
- [x] Record verdict, command/output and scope limitations for each in the review report.
- [x] Dispatch fixes only after verification of all findings is recorded.

## Review focus

- Correction dependencies may span files in arbitrary UUID order; include multiple hops and permutations (Task 1).
- Conflicted execution aliases must not choose an arbitrary trade identity or produce definitive effects (Task 1).
- Quarantined financial evidence must reach ledger/build review and suppress definitive reconstructed results (Task 1).
- Closing history must respect event order, including same-day timestamps and uncertain timezone cases (Task 2).
- Account/currency mismatches must not enter a merged strategy through current or retained decisions (Task 2).
- Ledger reuse must detect source-affecting decisions/imports while permitting metadata-only projection rebuilds (Task 3).

## Task 1: Ledger evidence and revision integrity — R01, R05, R06

**Own:** `src/server/ledger/revisions.ts`, `identity.ts`, `normalize.ts`; new `test/integration/review-p1-ledger.test.ts` and ledger-specific tests if necessary. Do not modify strategy, build or decision service files concurrently.

**Interfaces:** Preserve `normalizeLedger`, `resolveIdentities`, `applyRevisions` and ledger snapshot interfaces. Downstream projections consume retained ledger issues/conflicts and active executions.

- [x] Write failing regressions for T1→T2→T3 across reversed source ordering (final active quantity 3), quarantine propagation and conflicting execution aliases.
- [x] Run the new tests before production changes and capture the expected failures.
- [x] Resolve revision dependencies deterministically, propagate quarantined source issues and fail closed on conflicting aliases while retaining evidence.
- [x] Verify reversals/cancellations, account isolation, valid alias deduplication and deterministic rebuild behavior using existing and new ledger tests.
- [x] Save a fix report with red/green evidence and obtain independent spec/quality review.

## Task 2: Strategy chronology and merge boundaries — R03, R04

**Own:** `src/server/strategies/grouping.ts`, `accounting.ts`, supporting strategy files; `src/server/decisions/service.ts` if acceptance validation needs it; new `test/integration/review-p1-strategies.test.ts` and strategy-specific tests as necessary. Coordinate any storage helper changes first.

**Interfaces:** Preserve `groupStrategies`, `accountProjection`, `validateProjection`, `appendDecision` API shapes. Do not silently convert or discard incompatible currency/account evidence.

- [x] Write failing tests for an October 1 close preceding an October 10 opening, same-day ordering, and incompatible account/currency merges through retained explicit groups.
- [x] Run before production edits and capture expected failures.
- [x] Respect chronological exposure during automatic matching; uncertain histories remain unresolved.
- [x] Reject incompatible new merges and prevent retained incompatible decisions from combining cash/exposure. Add hard validation as needed.
- [x] Verify valid same-account/same-currency merges and existing spread/lifecycle/roll behavior; save red/green evidence and obtain independent review.

## Task 3: Safe retained-ledger reuse — R02

**Own:** `src/server/builds/service.ts`, `snapshot.ts`, `repository.ts` as needed; new `test/integration/review-p1-builds.test.ts`. Do not edit ledger or strategy modules concurrently.

**Interfaces:** Preserve rebuild modes and parser/algorithm version checks. Reuse a retained ledger only when its normalization inputs are current; rejecting stale reuse is acceptable if the error instructs a full rebuild.

- [x] Write failing regressions for exclusion/inclusion, a new committed import and changed identity decisions before a projection-only rebuild.
- [x] Include metadata-only changes that must still permit safe projection reuse.
- [x] Run before production changes and capture expected failures.
- [x] Compare actual normalization inputs, not only parser version; preserve active generation on rejection/staleness and guard concurrent changes.
- [x] Run new and existing build tests; save red/green evidence and obtain independent review.

## Integration and completion

- [x] Independently review the complete P1 diff against this plan and the design, correcting any introduced P1/P2 regressions.
- [x] Run `npm test`, `npm run check:all` and `npm run build` on the final combined code.
- [x] Update the review/status documents with all verification verdicts, P1 resolution evidence and remaining P2 work.
- [x] Leave the complete result uncommitted on the fix branch for user review.

## Completion evidence

All 17 baseline findings confirmed. Six P1 fixes implemented by Luna high, with red/green regressions and independent reviews. Integrated review corrections include sibling dependency passes, mixed-timezone ordering, future-reservation sign safety, new-strategy allocation union validation and linear-memory chronology ordering. Final checks: 280 tests, lint/typecheck, build, compiled smoke and 19 browser tests pass. Docker not run. R07–R17 remain open. Existing installations need full rebuild; changes are on fix/review-p1-2026-10-14. The user subsequently requested final code review and commit.

## Final review and commit follow-up — 2026-10-15

The user authorized final code review followed by commit. Fresh full-diff review identified F01 (known replenishment before future reservations) and F02 (separate known and uncertain reservation demands); both received failing production regressions, fixes and scoped re-review approval. Final gates passed 280 tests, lint/typecheck, build, server smoke and 19 browser tests. Local commit of the approved change set is authorized on the existing fix branch; remote publication and deployment are outside this request.
