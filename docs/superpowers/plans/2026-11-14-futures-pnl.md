# Futures P&L Reconstruction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct futures P&L without changing cash or hiding option differences.

**Architecture:** Add a pure shared calculation helper. Wire existing strategy and lifecycle amounts to it, preserving guards and existing public fields.

**Tech Stack:** TypeScript, decimal.js, Vitest, Fastify, SQLite, React.

**Spec:** docs/superpowers/specs/2026-11-14-futures-pnl.md

## Global Constraints

- Preserve imported source values, decisions, signed allocation quantities, and allocated net cash.
- Use decimal.js and decimal strings; never JavaScript number arithmetic for money.
- Do not substitute broker P&L for independently reconstructed P&L.
- Do not increase reconciliation tolerance or suppress the unexplained SOFI discrepancy.
- No new dependencies. No production database writes, deployment, or rebuild during plan execution.
- Preserve existing non-futures accounting and assignment/exercise completeness guards.

## Review Focus

- Missing commission/proceeds must yield unavailable (Task 1).
- Mixed currencies/accounts or unbalanced individual contracts must not net away (Task 1).
- Partial source allocations must scale amounts without cent rounding (Task 1).
- Futures expiry/settlement events must not be treated as ordinary trades (Task 1).
- Existing option discrepancies and incomplete lifecycle guards must survive (Task 2).

---
## File map

Create `src/server/strategies/reconstructed-pnl.ts` for pure reconstruction and `test/fixtures/futures-pnl.ts` for synthetic evidence. Modify the two accounting modules only at calculation/reason boundaries. Use existing build and analytics tests to validate persistence and consumers.

### Task 1: Shared reconstruction calculation

**Files:**
- Create: `src/server/strategies/reconstructed-pnl.ts`
- Create: `test/fixtures/futures-pnl.ts`
- Create: `test/unit/futures-pnl.test.ts`

**Interfaces:**
- Export `PnlSlice = { execution: Execution; quantity: string; netCash: string }`.
- Export `ReconstructionResult = { value: string | null; method: "cashflow" | "trade-proceeds"; reason: "FUTURES_PNL_UNAVAILABLE" | null }`.
- Export `reconstructPnl(rows: readonly PnlSlice[]): ReconstructionResult`; caller owns closed/completeness/event guards for non-futures.
- Fixtures export `futuresSpread(variant: "mtm-gap" | "coincidental-match"): PnlSlice[]` with synthetic IDs/accounts, FUT instrument multiplier 50, no real source identifiers.

- [ ] **Step 1: Write fixtures and failing unit assertions.** First variant quantities/prices/proceeds/net cash/commission are: (-1,196.9,9845,-72.6333,-2.633313103), (+1,194.3,-9715,-2.6377,-2.637697079), (+1,197.3,-9865,72.3667,-2.633313103), (-1,195.2,9760,-2.6377,-2.637697079); first two share contract A, last two B. Second variant proceeds are 9860,-9575,-9875,9615 and net cash -67.6333,62.3623,72.3667,-52.6377. Use corresponding contract prices 197.2,191.5,197.5,192.3. Both have broker closing values summing to 14.45798.

```ts
expect(reconstructPnl(futuresSpread("mtm-gap")).value).toBe("14.457979636");
expect(reconstructPnl(futuresSpread("coincidental-match")).value).toBe("14.457979636");
```

Add named tests: missing-proceeds and missing-commission return null/reason; null taxes equals zero while explicit -1 tax reduces total by 1; mismatched account/currency, nonzero quantity per contract, zero source quantity, and FUT expiry return null. Half each slice's quantity and net cash: expect `7.228989818`; complementary partitions sum to full result with Decimal. Non-FUT-only input returns sum of supplied cash. Mixed ordinary assets use FUT proceeds and non-FUT cash.

- [ ] **Step 2: Run** `npm test -- test/unit/futures-pnl.test.ts`; expect missing-module failure.
- [ ] **Step 3: Implement the exported types and helper.** Scale with signed quantity ratio; reject missing/malformed or inconsistent FUT evidence. Validate account/currency and per-contract balance. Do not mutate rows. No price-derived proceeds or display rounding.
- [ ] **Step 4: Run** the Task 1 command; expect all tests pass.
- [ ] **Step 5: Commit** the three Task 1 files with message `fix: reconstruct futures pnl from trade proceeds`.

### Task 2: Wire both accounting projections and preserve option warnings

**Files:**
- Modify: `src/server/strategies/accounting.ts`
- Modify: `src/server/lifecycles/accounting.ts`
- Modify: `test/unit/accounting.test.ts`
- Modify: `test/unit/lifecycle-accounting.test.ts`

**Interfaces:** Consumes Task 1 helper; existing `accountProjection` and `accountLifecycles` signatures remain unchanged. Produces corrected `reconstructedPnl` and `FUTURES_PNL_UNAVAILABLE` reasons.

- [ ] **Step 1: Add failing regressions** using both fixtures in both accounting paths. Assert reconstructed `14.457979636`, broker `14.45798`, original cashflow (`-5.542` or `14.458`), unchanged allocations, and no PNL_RECONCILIATION. Missing FUT evidence gives null plus reason. Existing incomplete/quarantined and assignment/exercise guards still yield null. Synthetic SOFI-like option rows use open cash 139.6558602, close cash -53.10225, close basis 139.65586, broker 86.53261; expect reconstructed 86.5536102 and PNL_RECONCILIATION in both paths. Remove stale FUTURES_PNL_UNAVAILABLE when recomputing complete evidence.
- [ ] **Step 2: Run** `npm test -- test/unit/accounting.test.ts test/unit/lifecycle-accounting.test.ts`; expect new futures assertions fail.
- [ ] **Step 3: Wire helper** after existing eligibility guards; map allocations/members to PnlSlice using the existing execution maps. Missing referenced executions must not be silently dropped into a complete reconstruction. Preserve broker, openingAmount and cashflow calculations. Recompute the new reason idempotently.
- [ ] **Step 4: Run** `npm test -- test/unit/futures-pnl.test.ts test/unit/accounting.test.ts test/unit/lifecycle-accounting.test.ts test/unit/broker-basis-drift.test.ts`; expect pass.
- [ ] **Step 5: Commit** Task 2 files with message `fix: apply futures reconstruction to strategies and lifecycles`.

### Task 3: Validate persisted builds and downstream results

**Files:**
- Modify: `src/server/builds/service.ts` (`ALGORITHM_VERSION`)
- Modify: `test/integration/accounting.test.ts`
- Modify: `test/integration/builds.test.ts`

**Interfaces:** Existing build persistence and analytics continue consuming `reconstructedPnl`; no schema migration.

- [ ] **Step 1: Add integration regressions** importing synthetic fixtures into a temporary store, rebuilding, reloading, and checking both projection values and reconstructed analytics. Assert source values and decision watermark are unchanged; unavailable reconstruction is excluded rather than counted as zero. Add an old-algorithm build test asserting stale status.
- [ ] **Step 2: Run** `npm test -- test/integration/accounting.test.ts test/integration/builds.test.ts`; verify the version regression fails before increment.
- [ ] **Step 3: Increment** `ALGORITHM_VERSION` from `lifecycles-v13` to `lifecycles-v14` if still v13; if the review fix has shipped independently, increment its current version instead. A combined unshipped release uses one increment.
- [ ] **Step 4: Run** `npm run check:all`, `npm test`, and `npm run build`; require successful exit codes. Do not rebuild Docker production data.
- [ ] **Step 5: Commit** Task 3 files with message `fix: invalidate builds using cash-based futures pnl`.
