# Review Issue Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace blank duplicate review rows with actionable grouped findings.

**Architecture:** Persist optional reconciliation context while retaining raw issue records. Build a grouped API read model before pagination and render explicit owners.

**Tech Stack:** TypeScript, decimal.js, Vitest, Fastify, SQLite, React.

**Spec:** docs/superpowers/specs/2026-11-14-review-attribution.md

## Global Constraints

- Preserve imported source values, decisions, signed allocation quantities, and allocated net cash.
- Use decimal.js and decimal strings; never JavaScript number arithmetic for money.
- Do not substitute broker P&L for independently reconstructed P&L.
- Do not increase reconciliation tolerance or suppress the unexplained SOFI discrepancy.
- No new dependencies. No production database writes, deployment, or rebuild during plan execution.
- Preserve existing non-futures accounting and assignment/exercise completeness guards.

## Review Focus

- Legacy candidate_json={} must remain readable (Task 1).
- Shared sources with different allocation slices must not merge (Task 2).
- Identical amounts with different currencies or severity must not merge (Task 2).
- Pagination and agent issue keys must survive consolidation (Tasks 2–3).
- Stale/missing lifecycle responses must never attach the wrong owner (Task 3).

---
## File map

Context lives in `src/shared/domain.ts` and existing accounting emitters. Persist it through builds repository without a migration. A new server review module owns grouping; the HTTP route consumes it before slicing. React owns rendering, never monetary grouping.

### Task 1: Persist explicit reconciliation evidence

**Files:**
- Modify: `src/shared/domain.ts`
- Modify: `src/server/strategies/accounting.ts`
- Modify: `src/server/lifecycles/accounting.ts`
- Modify: `src/server/builds/repository.ts`
- Modify: `test/integration/builds.test.ts`
- Modify: `test/unit/accounting.test.ts`
- Modify: `test/unit/lifecycle-accounting.test.ts`

**Interfaces:** Add optional `Issue.reconciliation: ReconciliationContext`:
```ts
interface ReconciliationContext {
  version: 1;
  owners: Array<{ kind: "strategy" | "lifecycle"; id: string }>;
  slices: Array<{ executionKey: string; role: "open" | "close"; quantity: string; netCash: string }>;
  currency: string;
  brokerPnl: string;
  reconstructedPnl: string;
}
```
Existing Issue fields remain required and unchanged.

- [ ] **Step 1: Add failing assertions:** both emitters attach their owner, all exact slices, source references and compared amounts. A database save/load round trip preserves context; candidate_json `{}` yields absent context. Existing stable issue keys are unchanged (populate strategy sources after constructing its historical key).
- [ ] **Step 2: Run** `npm test -- test/unit/accounting.test.ts test/unit/lifecycle-accounting.test.ts test/integration/builds.test.ts`; expect new context assertions fail.
- [ ] **Step 3: Add the interface and populate emitters.** Sources come from the actual affected executions. Persist `{reconciliation: context}` in candidate_json, retaining any unrelated metadata; load it only when version/schema is valid. Unknown/invalid metadata must not erase the underlying issue. Use explicit validation rather than unchecked casts for the new metadata.
- [ ] **Step 4: Run** the Task 1 command; expect pass.
- [ ] **Step 5: Commit** Task 1 files with message `fix: preserve review reconciliation ownership and evidence`.

### Task 2: Group exact duplicate findings before API pagination

**Files:**
- Create: `src/server/review/group-issues.ts`
- Modify: `src/server/http/routes-review.ts`
- Create: `test/unit/review-group-issues.test.ts`
- Modify: `test/integration/review-p1-builds.test.ts`

**Interfaces:** Export `ReviewEntry = Issue & { issueKeys: string[]; owners: ReconciliationContext["owners"] }` and `groupReviewIssues(issues: readonly Issue[]): ReviewEntry[]`. No changes to raw projection. Context-free entries have `[issue.key]` and empty owners.

- [ ] **Step 1: Write failing assertions:** four synthetic findings (two strategy/lifecycle pairs) produce two entries; each contains two sorted issueKeys, both owners, and deduplicated sources. Reversed input order gives identical output. Different slices, currency, severity, amounts, or absent context do not combine. Decimal-equivalent strings such as `1` and `1.0` do combine. Duplicate slice multiplicity is retained. Non-PNL codes remain separate. With pageSize 1, API total is 2 and pages have distinct canonical keys.
- [ ] **Step 2: Run** `npm test -- test/unit/review-group-issues.test.ts test/integration/review-p1-builds.test.ts`; expect failure.
- [ ] **Step 3: Implement grouping** using a canonical sorted multiset of decimal-normalized slices plus code/severity/currency/amounts. Merge only PNL_RECONCILIATION entries with valid context, including all raw issueKeys; canonical key is the first sorted key. Route groups before sorting and pagination. Preserve other response envelope fields.
- [ ] **Step 4: Run** the Task 2 command; expect pass.
- [ ] **Step 5: Commit** Task 2 files with message `fix: consolidate equivalent review findings before pagination`.

### Task 3: Render ownership and retain diagnostics

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/review/ReviewPage.tsx`
- Modify: `src/web/review/AgentReview.tsx` only if needed to pass expanded issueKeys
- Modify: `test/integration/chat-review-tools.test.ts`
- Modify: `e2e/review-editor.spec.ts`
- Modify: `src/server/builds/service.ts` (`ALGORITHM_VERSION`)

**Interfaces:** Add a ReviewEntrySchema for ReviewEnvelope rather than requiring grouping fields on all IssueSchema consumers. Optional context in IssueSchema matches Task 1. Raw chat tools continue using raw keys; Review passes flattened unique issueKeys to its existing agent launch flow.

- [ ] **Step 1: Add failing browser assertions:** synthetic four findings render two rows; each links both owners with existing strategy/lifecycle navigation routes and expectedBuildId. Header is `Affected items`; no-owner record displays `Unattributed issue`. Show broker amount, reconstructed amount and signed reconstructed-minus-broker difference using decimal.js. A mismatched lifecycle build response never supplies owner labels; fall back to explicit ID. The agent launch includes all four raw keys. Add integration assertions that all four remain diagnosable, with source rows and context.
- [ ] **Step 2: Run** `npm test -- test/integration/chat-review-tools.test.ts` and `npx playwright test e2e/review-editor.spec.ts`; expect new rendering assertions fail. Follow existing e2e fixture setup; use only temporary stores.
- [ ] **Step 3: Update schemas and rendering.** Prefer explicit owners, retain legacy source inference only for context-free entries, and use IDs if names are unavailable. Do not label the option difference as rounding. Expand underlying issueKeys for Ask Agent without changing the raw chat tools' contracts.
- [ ] **Step 4: Increment build version** from v13 to v14 if this ships alone; reuse the futures plan's increment for a combined unshipped release. Add/adjust the existing stale-build test in `test/integration/builds.test.ts` to cover this version change.
- [ ] **Step 5: Run** `npm run check:all`, `npm test`, `npm run build`, and `npx playwright test e2e/review-editor.spec.ts`; require successful exit codes. Confirm no changes to live Docker data.
- [ ] **Step 6: Commit** Task 3 files with message `fix: show actionable reconciliation owners and diagnostics`.

## Combined release acceptance

Run these plans accounting-first when shipping together. Before accounting correction, the sanitized live-shaped fixture has four raw findings and two display entries. After correction, only the option pair remains: two raw findings and one display entry. The option entry retains difference 0.0210002 and both owner links. Rebuilding production is a separate deployment action, outside these plans.
