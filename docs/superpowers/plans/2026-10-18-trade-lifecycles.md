# Trade Lifecycles and Wheel Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method must be chosen before implementation.

**Goal:** Count a spread/put, its assigned stock, and subsequent covered calls as one completed trade lifecycle, with optional wheel campaigns grouping cycles.

**Architecture:** Add a quantity-aware lifecycle projection after existing strategy accounting. Persist it with each build, replay corrections through retained decisions, and let analytics select lifecycle or strategy units without duplicating execution cashflows. Campaigns organize cycles and do not create extra performance observations.

**Tech Stack:** Existing Node.js >=22.19.0, TypeScript, Fastify, better-sqlite3, Decimal.js, Zod, React, Vitest, and Playwright; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-18-trade-lifecycles-design.md`

**Status:** Reviewed on 2026-10-18; user authorized implementation on `feature/trade-lifecycles`. See the spec’s implementation review decisions for interface refinements.

## Global Constraints

- Each source allocation is partitioned exactly once across lifecycle members.
- Never connect different accounts, currencies, or incompatible underlying instruments.
- Preserve source anchors when presentation groups are merged or corrected.
- Assignment is a change of exposure, not a win or loss.
- A partial close does not create another win/loss observation.
- Do not subtract those fees a second time.
- No silent fallback between bases.
- No mark means valuation unavailable, not zero.
- A campaign has no separate win/loss vote.
- Failed/stale rebuilds cannot publish mixed generations.
- Do not automatically commit, open a PR, or execute the plan as part of planning.

## Review Focus

1. Multiple same-ticker positions and overlapping calls must reserve the correct shares, without accidental cross-cycle links; tested in Tasks 2–3.
2. Assignment cost-basis transfers and absent broker amounts must not duplicate premiums or turn missing P&L into zero; tested in Task 4.
3. A protective put or uncovered short call remaining after stock disposal must prevent closure; tested in Task 2.
4. Historical builds, superseded corrections, and import order must not change durable identities or expose mixed generations; tested in Tasks 1, 3, and 6.
5. Filtered reports and exports must include whole lifecycles and match their summary denominator; tested in Tasks 7–9.

## Delivery sequence and file boundaries

1. Lifecycle data contracts and storage.
2. Deterministic membership/exposure projection.
3. Retained corrections and wheel campaign decisions.
4. Lifecycle cashflow/broker accounting.
5. Optional dated valuations.
6. Build pipeline, persistence, and historical upgrade.
7. Lifecycle analytics, drills, and exports.
8. Journal/review/campaign user flows.
9. Full acceptance and migration validation.

Tasks 1–6 establish the model; Task 7 changes the main dashboard counting unit only after the projection is complete. Tasks 8–9 complete the user-facing delivery. Keep intermediate work on a feature branch; do not ship a default dashboard switch before the complete path is validated.

### Task 1: Define lifecycle contracts and versioned storage

**Files:**
- Create `src/shared/lifecycles.ts`.
- Modify `src/shared/domain.ts`.
- Create `src/server/storage/migrations/006_trade_lifecycles.sql`.
- Create `src/server/lifecycles/repository.ts`.
- Test `test/integration/lifecycle-storage.test.ts`.

**Interfaces:**
- `AllocationRef = { strategyId: Id; executionKey: string; role: "open" | "close" }`.
- `LifecycleMember = { lifecycleId: Id; allocation: AllocationRef; quantity: DecimalText; netCash: DecimalText; brokerPnl: DecimalText | null; estimated: boolean; sources: SourceRef[] }`.
- `Lifecycle` has `id`, `account`, `currency`, `underlyingKey`, `originStrategyType`, `openingDate`, nullable `closeDate`, `status: "open" | "closed" | "unresolved"`, `stage: "options" | "assigned_stock" | "covered_call" | "closed"`, `complete`, nullable `campaignId`, `positions`, `cashflow`, nullable `brokerPnl`/`reconstructedPnl`, and `reasons`.
- Lifecycle `positions` have `instrumentKey`, signed `quantity`, `coveredShares`, and `uncoveredShares` (DecimalText); the last two are zero for non-stock instruments.
- `AttachmentSuggestion` has `id`, `callOpening: AllocationRef`, `candidateLifecycleIds: Id[]`, contract quantity, evidence sources, and reason codes.
- `WheelCampaign` has durable `id`, user `name`, `account`, `currency`, `underlyingKey`, and `lifecycleIds: Id[]`.
- `LifecycleProjection = { version: 1; lifecycles: Lifecycle[]; members: LifecycleMember[]; campaigns: WheelCampaign[]; suggestions: AttachmentSuggestion[]; issues: Issue[]; valuations: LifecycleValuation[] }`; Task 5 defines valuation fields.
- `Projection.lifecycles?: LifecycleProjection` is absent for historical builds. New builds always provide it.
- `persistLifecycleProjection(db: Store["db"], buildId: Id, projection: LifecycleProjection): void` and `loadLifecycleProjection(db: Store["db"], buildId: Id): LifecycleProjection | undefined` run inside the caller's transaction.

- [ ] Write storage tests: a quantity slice survives round-trip as an exact decimal; memberships cannot reference another build's source allocation; old builds return `undefined`; same stable origin anchor resolves to the same lifecycle ID after a second build.
- [ ] Run `npm test -- test/integration/lifecycle-storage.test.ts`; expect failure because contracts/migration/repository do not exist.
- [ ] Add Zod schemas and inferred types in the new shared module, migration, and repository. Use build-scoped views, durable origin identities, and compound membership keys referencing strategy allocations through revision IDs. Store suggestions/campaign views/valuations with the build, and anchor campaign identity to retained decisions. Resolve execution keys using the build's ledger, never a global newest revision.
- [ ] Run the focused test plus `npm run typecheck`; expect both to pass.
- [ ] Review the deliverable; commit during implementation only if authorized by the selected workflow.

### Task 2: Project lifecycle membership, chronology, and remaining exposure

**Files:**
- Create `src/server/lifecycles/project.ts` and `src/server/lifecycles/membership.ts`.
- Reuse `src/server/strategies/allocation.ts` and matching chronology helpers.
- Create `test/fixtures/lifecycles.ts` and `test/unit/lifecycle-projection.test.ts`.

**Interfaces:**
- Consumes Task 1 contracts and existing strategy allocations/links.
- `LifecycleAnchor = { account: string; openingExecutionKey: string }`.
- `projectLifecycles(ledger: LedgerSnapshot, projection: Projection, decisions: readonly Decision[], resolveId: (anchor: LifecycleAnchor) => Id): LifecycleProjection`.
- `validateMembership(ledger: LedgerSnapshot, projection: Projection, members: readonly LifecycleMember[]): Issue[]` conserves signed quantities, net cash, and known broker amounts per source allocation.
- `applyMembershipChanges(ledger: LedgerSnapshot, projection: Projection, draft: LifecycleProjection, decisions: readonly Decision[]): LifecycleProjection` is introduced in Task 3 and called before final exposure/state computation. Task 2 can initially use no membership corrections.

- [ ] Write fixture assertions: assigned spread with 100 shares has `status === "open"`; selling 50 leaves quantity `"50"` and no close date; selling all shares while a long put remains still has `status === "open"`; complete protective-put expiry finally closes it. A naked remaining call also prevents closure.
- [ ] Write conservation/chronology assertions: a 150-share stock sale split 100/50 across two lifecycles preserves the original cash exactly; multiplier 10 produces 10 assigned shares per contract; cross-account/currency links are rejected; a call cannot reserve shares acquired later; a validated roll does not create an intermediate closed cycle; a fresh put after flat exposure gets a different ID.
- [ ] Run `npm test -- test/unit/lifecycle-projection.test.ts`; expect missing-module/function failure.
- [ ] Implement seeded memberships and validated assignment/exercise continuity. Represent cross-lifecycle allocations as quantity slices; split using Decimal and deterministic remainder handling. Resolve stable anchors from source openings. Do not union whole strategies when only some quantities belong together.
- [ ] Generate covered-call suggestions with currently available share capacity, excluding reserved shares; leave calls separate until accepted. Keep plausible unresolved continuation candidates ineligible pending acceptance/rejection. Compute final stage, exposure, close date, and completeness after decisions; use broker lot references for stock disposal when available and surface ambiguous attribution rather than inventing FIFO across lifecycles.
- [ ] Run focused tests and `npm run typecheck`; expect pass.
- [ ] Review and make the task commit if the implementation workflow permits.

### Task 3: Retain attachment corrections and explicit wheel campaigns

**Files:**
- Modify `src/server/decisions/schemas.ts` and `src/server/decisions/service.ts`.
- Create `src/server/lifecycles/decisions.ts`.
- Modify `src/server/lifecycles/project.ts`.
- Test `test/integration/lifecycle-decisions.test.ts` and `test/unit/lifecycle-projection.test.ts`.

**Interfaces:**
- Add decision kinds `lifecycle_membership`, `lifecycle_attachment_rejection`, `wheel_campaign`, and `wheel_campaign_membership` to the existing decision API.
- `lifecycle_membership.payload = { assignments: Array<{ lifecycleId: Id; allocation: AllocationRef; quantity: DecimalText }> }` replaces the complete effective partition for every referenced source allocation; validates aggregate conservation before accepting.
- `lifecycle_attachment_rejection.payload = { callOpening: AllocationRef; candidateLifecycleIds: Id[]; reason: string }` records why the call stays independent.
- `wheel_campaign.payload = { campaignId: Id; name: string; account: string; currency: string; underlyingKey: string }` creates/renames an explicit campaign.
- `wheel_campaign_membership.payload = { lifecycleId: Id; campaignId: Id | null }` attaches/detaches a cycle.
- Produces Task 2's `applyMembershipChanges(...)` and campaign projection from effective decisions at the build watermark. Campaign IDs are generated by the client like existing idempotent requests, then retained as identity.

- [ ] Write tests: selecting 1 of 2 candidate lifecycles persists and replays; two concurrent calls cannot both reserve the same 100 shares; one two-contract call can be split into two one-contract covered slices; fractional contracts and excess quantities fail validation.
- [ ] Write tests: same `clientRequestId` is idempotent; superseding membership moves cash only once; explicit rejection releases the continuity block; cross-currency/campaign-account mismatches fail; a second completed cycle attaches to the same campaign without merging cycles. A disappeared anchor becomes a visible issue.
- [ ] Run `npm test -- test/integration/lifecycle-decisions.test.ts test/unit/lifecycle-projection.test.ts`; expect failures for new kinds and behavior.
- [ ] Implement schemas, active-snapshot validation, effective decision replay, source provenance, and membership application. Reuse supersession, serialized writes, and watermark behavior; do not add a separate mutable linkage store.
- [ ] Run focused tests plus `npm run typecheck`; expect pass.
- [ ] Review and make the task commit if authorized.

### Task 4: Calculate lifecycle results without duplicate cost basis

**Files:**
- Create `src/server/lifecycles/accounting.ts`.
- Test `test/unit/lifecycle-accounting.test.ts`.
- Extend `test/fixtures/lifecycles.ts`.

**Interfaces:**
- `accountLifecycles(ledger: LedgerSnapshot, strategies: Projection, lifecycles: LifecycleProjection): LifecycleProjection` fills cashflow/P&L/coverage/reasons without altering source strategy amounts.
- `lifecycleOutcome(lifecycle: Lifecycle, basis: "broker" | "reconstructed"): "win" | "loss" | "breakeven" | "unavailable"` returns unavailable for non-eligible lifecycles.
- `brokerRealized(ledger: LedgerSnapshot, members: readonly LifecycleMember[]): { value: DecimalText | null; estimated: boolean; reasons: string[] }` reports coverage conservatively, including basis transfer reporting evidence.

- [ ] Write tests asserting the spec examples reconstruct exactly `"-160"` and `"800"`; all-flat ordinary spread agrees with existing accounting; open assigned stock has reconstructed P&L `null`; complete zero result is breakeven.
- [ ] Assert net-cash commissions/taxes are not deducted again; cost basis is not added as cash; proportional member sums conserve broker P&L; a null assignment P&L is not silently zero; verified deferred-basis reporting can complete broker coverage; missing openings/quarantined relevant evidence yield null; mismatch creates a reconciliation issue using existing currency tolerances.
- [ ] Run `npm test -- test/unit/lifecycle-accounting.test.ts`; expect missing-module/function failure.
- [ ] Implement cashflow summation for complete flat lifecycles and conservative broker coverage. Reuse Decimal, money tolerance, and apportioned allocation amounts. Retain existing strategy-level safeguards unchanged.
- [ ] Run focused tests plus `npm test -- test/unit/accounting.test.ts test/integration/accounting.test.ts`; expect pass with existing strategy behavior preserved.
- [ ] Review and make the task commit if authorized.

### Task 5: Support dated manual valuation with explicit availability

**Files:**
- Create `src/server/lifecycles/valuation.ts`.
- Modify `src/shared/lifecycles.ts`, `src/server/decisions/schemas.ts`, and `src/server/decisions/service.ts`.
- Test `test/unit/lifecycle-valuation.test.ts` and `test/integration/lifecycle-decisions.test.ts`.

**Interfaces:**
- `ValuationSnapshot = { account: string; currency: string; asOf: string; marks: Array<{ instrumentKey: string; price: DecimalText }> }`.
- New retained decision kind `lifecycle_valuation` uses that snapshot as its payload. Validate nonnegative prices and a timestamp at/after included executions, at/before decision creation time. A superseding decision replaces its referenced snapshot.
- `LifecycleValuation = { lifecycleId: Id; asOf: string | null; source: "manual" | null; cashflow: DecimalText; realizedBrokerPnl: DecimalText | null; unrealizedPnl: DecimalText | null; totalPnl: DecimalText | null; estimated: boolean; reasons: string[] }`.
- `valueLifecycles(ledger: LedgerSnapshot, projection: LifecycleProjection, snapshots: readonly ValuationSnapshot[]): LifecycleValuation[]` chooses the latest effective applicable complete snapshot and does not mix timestamps. Invalidated old snapshots return unavailable after newer executions.

- [ ] Write tests: net cash `"-9800"` plus 100 shares marked at `"95"` gives total `"-300"`; an open short call with multiplier 100 subtracts its market liability; known broker-realized `"100"` implies residual unrealized `"-400"` when total is `"-300"`.
- [ ] Assert absent option price, unknown multiplier, stale/as-of-before-execution snapshot, future timestamp, wrong currency, and incomplete history yield unavailable; an execution fill is never used as a current mark; a closed result does not change when a valuation is superseded.
- [ ] Run `npm test -- test/unit/lifecycle-valuation.test.ts test/integration/lifecycle-decisions.test.ts`; expect failures for missing valuation behavior.
- [ ] Implement signed market values and the specified decomposition. Persist valuation provenance/reasons; require all remaining instruments to have marks from one snapshot. Use no external price service.
- [ ] Run focused tests plus `npm run typecheck`; expect pass.
- [ ] Review and make the task commit if authorized.

### Task 6: Integrate projection into rebuilds, activation, and recovery

**Files:**
- Modify `src/server/builds/service.ts`, `src/server/builds/repository.ts`, and `src/server/builds/snapshot.ts` where algorithm compatibility is checked.
- Modify `src/server/lifecycles/repository.ts` and `src/server/analytics/snapshot.ts` if needed for compatibility metadata.
- Test `test/integration/lifecycle-builds.test.ts` and `test/integration/backup.test.ts`.

**Interfaces:**
- `computeProjection(...)` invokes lifecycle projection after durable strategy remapping/accounting, then lifecycle accounting and effective valuations.
- `persistProjection(...)` persists lifecycle views in its existing atomic write; `loadProjection(...)` round-trips `Projection.lifecycles`.
- Advance the existing build algorithm version to a lifecycle-aware version; missing lifecycle data makes lifecycle reporting explicitly rebuild-required. Retained historical strategy reports continue working.

- [ ] Write tests: rebuild/restart round-trip preserves lifecycle IDs/results; overlapping imports in different order produce equal memberships; presentation merge/correction preserves source membership anchors; projection-only decisions rebuild without unnecessary re-upload.
- [ ] Assert superseded campaign/valuation decisions replay at the selected watermark; a stale or failed build leaves all active views on the previous generation; a historical pre-migration build reports rebuild-required for lifecycle metrics; backup/restore then rebuild yields identical membership and P&L.
- [ ] Run `npm test -- test/integration/lifecycle-builds.test.ts`; expect lifecycle data missing from active builds.
- [ ] Wire the lifecycle pipeline, transactional persistence, algorithm version/staleness checks, and historical compatibility state. Do not activate a projection that fails membership conservation.
- [ ] Run `npm test -- test/integration/lifecycle-builds.test.ts test/integration/builds.test.ts test/integration/analytics-snapshot.test.ts test/integration/backup.test.ts`; expect pass.
- [ ] Review and make the task commit if authorized.

### Task 7: Apply lifecycle counting consistently to analytics and CSV

**Files:**
- Modify `src/shared/analytics.ts` and `src/server/http/routes-analytics.ts`.
- Modify `src/server/analytics/{scope,aggregate,performance,details,csv,query}.ts`.
- Create `src/server/analytics/lifecycles.ts`.
- Modify `src/web/dashboard/{api,query}.ts`.
- Test `test/unit/lifecycle-analytics.test.ts`, `test/integration/analytics-http.test.ts`, and `test/integration/analytics-export.test.ts`.

**Interfaces:**
- Add shared `unit: "lifecycle" | "strategy"` defaulting to `"lifecycle"` to summary/detail/export queries; allow optional `campaignId` in lifecycle mode and reject it in strategy mode.
- Add `kind: "lifecycles"` to detail queries and `dataset: "lifecycles"` to exports. Preserve existing explicit strategy/transaction datasets. Summary response carries discriminated `unit` and matching lifecycle/strategy result rows; frontend schemas must agree.
- `resolveLifecycleScope(snapshot: AnalyticsSnapshot, query: AnalyticsQuery): LifecycleAnalyticsScope` selects whole lifecycles. Scope contains `closed`, `currentOpen`, `unresolved`, `undatedClosed`, and attribution by origin/underlying/contained asset classes.
- Introduce shared `PerformanceObservation = { id: Id; status: string; closeDate: string | null; selectedPnl: DecimalText | null }` with adapters for each unit. Existing summary math consumes these observations; transactions remain execution-based.
- `campaignSummary(projection: LifecycleProjection, campaignId: Id): CampaignSummary` returns completed/open/eligible/missing counts and separate completed P&L/open valuations with known/total coverage counts.

- [ ] Write tests: assigned spread plus stock plus 3 covered calls yields one completed observation; an ordinary unlinked trade remains one observation; an open wheel contributes zero wins/losses; missing selected P&L does not enter denominator; campaign counts do not add observations.
- [ ] Assert closing-date buckets differ from execution-date cash activity; origin strategy attribution is stable; asset-class filters include entire member cashflows; broker/reconstructed choices do not fall back; summary/drill/pagination/CSV counts and P&L match; explicit strategy mode retains previous results; old builds return rebuild-required rather than zero trades.
- [ ] Run `npm test -- test/unit/lifecycle-analytics.test.ts test/integration/analytics-http.test.ts test/integration/analytics-export.test.ts`; expect new query/schema/unit tests to fail.
- [ ] Implement unit adapters and all aggregate/detail/export paths together, including best/worst/recent/daily/monthly and URL state. Include lifecycle/campaign identifiers, stage, origin, selected basis, reasons, and valuation date in lifecycle CSV. Never sum entire strategy amounts for slice-based memberships.
- [ ] Run focused tests plus `npm test -- test/unit/analytics-performance.test.ts test/unit/analytics-scope.test.ts test/unit/analytics-url.test.ts`; expect pass.
- [ ] Review and make the task commit if authorized.

### Task 8: Expose lifecycle, review, campaign, and valuation flows

**Files:**
- Create `src/server/http/routes-lifecycles.ts` and register it in `src/server/app.ts`.
- Create `src/web/lifecycles/{LifecycleDetail,CampaignDetail,MembershipEditor,ValuationEditor}.tsx` and local styles.
- Modify `src/web/journal/{JournalPage,StrategyDetail}.tsx`, `src/web/review/DecisionEditor.tsx`, `src/web/api.ts`, and `src/web/App.tsx` (`renderRoute`).
- Modify `src/web/dashboard/{DashboardFilters,DashboardPage,KpiCards,Overview,Reports,DetailTable,DataQuality}.tsx` and dashboard styles.
- Test `test/integration/lifecycle-http.test.ts`, `e2e/lifecycles.spec.ts`, and `e2e/dashboard.spec.ts`.

**Interfaces:**
- `GET /api/lifecycles/:id?expectedBuildId=...` returns lifecycle, memberships, event timeline, suggestions, valuation, and build provenance.
- `GET /api/campaigns/:id?expectedBuildId=...` returns campaign cycles and Task 7 summary.
- Use existing `POST /api/decisions` for all writes, existing rebuild workflow for activation, and existing supersession/idempotency fields.
- Routes `/lifecycles/:id` and `/campaigns/:id` use existing routing conventions. Membership editor submits complete source partitions; valuation editor submits one dated multi-instrument snapshot.

- [ ] Write HTTP assertions for build-ID mismatch, not-found, matching source evidence, campaign completeness counts, and post-decision stale response before rebuild.
- [ ] Write browser assertions: lifecycle summary links to full timeline; assigned shares remain open; suggestion preview shows exactly which shares/calls/cash will move; accept/reject/split survives rebuild; protective put remains visible; campaign creation and cycle membership work; manual marks show timestamp and missing-price reasons.
- [ ] Assert lifecycle/strategy selector persists in URL/export; cards say completed lifecycles; charts use “Completed lifecycle P&L”; strategy mode is clearly labeled; campaign missing components do not display a misleading complete total; rebuild-required historical state offers the existing rebuild action.
- [ ] Run `npm test -- test/integration/lifecycle-http.test.ts` and `npm run test:e2e -- e2e/lifecycles.spec.ts e2e/dashboard.spec.ts`; expect failures for missing routes/flows.
- [ ] Implement the flows using existing components/formatters and accessible labeled forms. Link original notes/components to the lifecycle rather than moving notes. Ensure async rebuild completion refreshes the same expected-build context across summary and detail.
- [ ] Run the focused HTTP/browser tests plus `npm run typecheck`; expect pass.
- [ ] Review and make the task commit if authorized.

### Task 9: Pin end-to-end acceptance and validate the upgrade

**Files:**
- Extend `test/fixtures/lifecycles.ts`, `test/integration/acceptance.test.ts`, and `e2e/lifecycles.spec.ts`.
- Modify `docs/TEST-PLAN.md`.

**Interfaces:** Consumes the complete lifecycle/campaign projection and APIs from Tasks 1–8; introduces no new product API.

- [ ] Add full import → build → assignment → call → disposal acceptance scenarios covering all 14 spec cases. Assert exact conserved source cash, lifecycle counts/results, component identities, and campaign totals before and after a correction/rebuild.
- [ ] Include the no-assignment put expiry, multiple expired calls while stock remains held, call-away with a retained long put, two overlapping wheels with shared stock-close execution, and manually rejected independent call cases.
- [ ] Run `npm test -- test/integration/acceptance.test.ts`; resolve missing cross-component wiring before broader checks.
- [ ] Document historical rebuild requirements, changed counting units, unavailable broker values, execution-cashflow scope, and manual valuation semantics in `docs/TEST-PLAN.md`.
- [ ] Run `npm run check:all`, `npm test`, `npm run test:e2e`, and `npm run test:build-smoke`; all must pass. Run `npm run test:docker` only if deployment/container code changes or repository policy requires it.
- [ ] Review the final diff against the spec, verify no new dependencies or altered raw imports, and check a restored pre-enhancement database can rebuild. Record verification evidence with the implementation handoff.
- [ ] Present the completed branch for review using the execution method selected by the user; do not publish or merge without authorization.

## Plan self-review

- Spec coverage: contracts/membership (1–3), accounting (4), open valuations (5), campaigns (3,7,8), persistence/upgrade (1,6), reporting/UI (7–8), all acceptance scenarios (9).
- Review Focus cases are pinned to the tasks owning those behaviors.
- Source execution allocations remain unique; lifecycle membership is a second-level partition, not a second ledger.
- Unavailable broker values and valuations are explicit; no hidden fallback or mark assumptions.
- App registration is in `src/server/app.ts`; client route dispatch is in `src/web/App.tsx`. Existing integration paths were checked against the repository.

## Execution handoff

Review the written spec and this draft together before implementing. Suggested execution: native in-session implementation with focused verification after each task, followed by a separate whole-change review, because the tasks share accounting and quantity-conservation interfaces. Independent delegation is optional and requires the user's selected execution method.

## Review outcomes and implementation adjustments

- Preserve pre-presentation lifecycle origins and remap/coalesce exact membership slices against final source allocations. Duplicate opening anchors coalesce into one economic lifecycle.
- Retain covered-call attachment intents separately from explicit source partitions so later imports follow confirmed ownership. Indivisible partial closes require explicit quantity review.
- Validate stock identity, chronological exposure, per-contract call reservations, and already accepted future call openings. Replay each retained correction atomically.
- Resolve effective decision history before omitting a superseded target; reject lifecycle writes against unbuilt import changes.
- Reuse existing strategy-shaped performance row APIs keyed by `unit` rather than add a second detail response union. This is an interface refinement, not a change to lifecycle counting.
- Use the existing checkout on the requested feature branch. Implement the shared core directly; independent workers implemented reporting/screens and a fresh reviewer checked the core.

## Completion evidence

Implemented on `feature/trade-lifecycles`. Reviewed fixes and limitations are recorded in `docs/reviews/2026-10-18-trade-lifecycles-review.md`.

- Full Vitest suite: 585 tests passed across 53 files.
- Full Playwright suite: 64 tests passed.
- `npm run check:all`: passed with existing repository diagnostics.
- `npm run test:build-smoke`: passed production build, migration packaging, server health, and shutdown.
- Backup/restore/rebuild preserves lifecycle projection data in the existing 18-test backup suite.
