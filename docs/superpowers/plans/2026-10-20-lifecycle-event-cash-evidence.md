# Lifecycle Event Cash Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Withhold unsupported reconstructed lifecycle P&L for assignment/exercise events while preserving broker results, cashflow and complete physical-delivery lifecycles.

**Architecture:** Check event cash coverage against final lifecycle membership and validated physical delivery links. Unresolved events produce an explicit evidence warning and nullable reconstruction, independently of position closure and broker coverage. Propagate financial availability through valuation, review guidance and rebuild versioning.

**Tech Stack:** TypeScript, decimal.js, Vitest, React.

**Spec:** `docs/superpowers/specs/2026-10-18-trade-lifecycles-design.md` (Accounting and valuation), plus the user-approved investigation proposal in this conversation.

## Global Constraints

- Do not add a reported cost basis to cashflow.
- Do not use mark-to-market values in win-rate eligibility.
- Preserve execution cash, broker P&L, allocation conservation and estimated attribution.
- No settlement importer, fabricated cash, private-trade fixtures or new dependencies.
- Keep broker eligibility independent of unavailable reconstructed P&L.

## Review Focus

- Partial membership must not borrow delivery cash owned by another lifecycle.
- A link for another event in the same strategy must not certify an unmatched event.
- Duplicate/ambiguous delivery candidates must not certify multiple option events.
- Ordinary zero-cash expirations and real cashflow discrepancies retain their existing behavior.
- Missing reconstruction must propagate to valuation and analytics without hiding covered broker P&L.

---

### Task 1: Account for unresolved event cash evidence

**Files:**
- Create: `src/server/lifecycles/event-cash.ts`
- Modify: `src/server/lifecycles/accounting.ts`
- Test: `test/unit/lifecycle-event-cash.test.ts`, `test/unit/lifecycle-accounting.test.ts`, `test/integration/lifecycle-event-cash.test.ts`

**Interfaces:**
- Consumes: `LedgerSnapshot`, `Projection.links`, final `LifecycleMember[]`.
- Produces: `unresolvedEventCash(ledger: LedgerSnapshot, strategies: Projection, members: readonly LifecycleMember[]): LifecycleMember[]`.
- Produces: reason/issue `EVENT_CASH_UNRESOLVED`, retaining status, complete, cashflow and brokerPnl while withholding reconstructedPnl.

- [x] Step 1: Write synthetic tests for zero-cash assignment/exercise, explicit physical delivery, missing/partial/wrong-event delivery, ordinary discrepancies and expiry. Assert short credit 100 / broker -2400 and long debit -30 / broker 470 retain broker results and return null reconstruction with an evidence warning.
- [x] Step 2: Run `npx vitest run test/unit/lifecycle-event-cash.test.ts test/unit/lifecycle-accounting.test.ts`; expected new assertions fail because cash is currently treated as profit.
- [x] Step 3: Implement conservative physical event coverage from event-specific links/source identities, same account/currency/underlying, signed delivered quantity and owned slices. Do not certify an event just because its cash is nonzero or it has a stock neighbor. Preserve the existing complete wheel tests, strengthening fixture event links if missing.
- [x] Step 4: Run the same tests; expected PASS. Run existing lifecycle integration tests to catch presentation merges and attachments.
- [x] Step 5: Commit `fix: withhold lifecycle reconstruction without event cash evidence`.

### Task 2: Propagate availability to valuation, review and builds

**Files:**
- Modify: `src/server/lifecycles/valuation.ts`, `src/server/chat/tools/review.ts`, `src/web/lifecycles/connections.ts`, `src/server/builds/service.ts`
- Test: `test/unit/lifecycle-event-cash.test.ts`, `test/integration/chat-review-tools.test.ts`

**Interfaces:**
- Consumes: Task 1 nullable reconstruction and `EVENT_CASH_UNRESOLVED` reason.
- Produces: unavailable closed totals/residuals with explanatory reasons and estimated=true; unavailable open marked totals when event cash is unresolved; actionable review guidance; algorithm lifecycles-v8.

- [x] Step 1: Write failing tests asserting missing reconstruction yields null total/residual, estimated=true and the evidence reason; verified broker P&L remains eligible while reconstructed outcome is unavailable. Cover open marked holdings with unresolved historical events. Cover the sanitized report template for the new review issue.
- [x] Step 2: Run the relevant unit/integration tests; expected failures on valuation and report behavior.
- [x] Step 3: Implement availability propagation, readable labels/report guidance and algorithm version bump. Preserve real reconciliation warnings on otherwise complete cashflows.
- [x] Step 4: Run `npm test`, `npm run check:all`, `npm run build`; expected PASS. Replay relevant local CSV rows in temporary stores only, asserting SQQQ remains reconciled and SPXW gets evidence warnings, no invented P&L.
- [x] Step 5: Review the branch diff, resolve material findings, and commit `fix: propagate unavailable event reconstruction through lifecycle views`.

## Implementation record

- Implemented together as one atomic fix commit because event availability and its valuation consumers must ship together.
- Retained position completeness and broker eligibility; `EVENT_CASH_UNRESOLVED` governs reconstruction independently. The existing import model cannot reliably classify settlement type, so this reason does not assert that an unmatched event specifically represents cash settlement.
- Independent review found presentation merges could erase delivery self-links. The build now supplies the unmerged origin projection for evidence, and the helper resolves ownership by execution. A regression reproduces the failure and a retained-decision integration test verifies the production build path.
- Multiple membership slices of the same option execution are combined before checking delivery quantity; two different events cannot spend one delivery.
- Final verification: 922 tests across 89 files passed; `npm run check:all` passed with existing repository diagnostics; `npm run build` passed with its existing bundle-size warning; `git diff --check` passed.
- Isolated replay of 1,758 local sample executions retained 832 strategies. SQQQ reconciled; the only new event-evidence findings were the two SPXW legs. Existing pending-call-attachment findings remained.
- Scope limitation: the existing grouping representation can discard repeated manual-link provenance. Such cases remain conservatively unavailable. General retained-event evidence redesign, raw trade event reclassification and settlement importing remain outside this fix.
- No running journal data was changed. Deployment and a rebuild under `lifecycles-v8` are needed to update existing journal results.
