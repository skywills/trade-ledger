# TradeLedger Dashboard Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add Overview, Analysis, and Reports dashboards with consistent full-dataset trading metrics, transaction drill-downs, print, and CSV export.

**Architecture:** A read-only snapshot service captures one active projection and its associated ledger; pure decimal aggregation and shared scope predicates feed all three APIs. React dashboard views share URL filters, validated responses, KPI/chart components, and exact-data table alternatives. Existing Agent, Journal, Transactions, backup formats, and storage schemas remain intact.

**Tech Stack:** Existing React 19, TypeScript, Fastify, better-sqlite3, decimal.js, Zod, plain CSS, Vitest, and Playwright; no new runtime dependency. Node >=22.19.0.

**Spec:** `docs/superpowers/specs/2026-10-16-dashboard-analytics-design.md` (read the reviewed metric/filter contracts before implementing).

## Global Constraints

- Product: TradeLedger (package/repository slug: trade-ledger).
- All financial arithmetic, comparisons, and aggregation use decimal.js on the server.
- Monetary API fields remain canonical decimal strings with currency; browser formatting follows the existing currency conventions.
- Never sum currencies or introduce FX conversion.
- Do not aggregate paginated browser lists or truncate at 100 records.
- Each closed strategy contributes only its selected field; no per-row fallback.
- Do not subtract fees again from either P&L series.
- Analytics must never rebuild or mutate the journal.
- No schema migration or persisted analytics tables are needed.
- No live broker data or AI model is required.
- Retain the existing system font, indigo accent, light/dark tokens, semantic success/danger/warning colors, focus rings, 4/8px spacing, and modest card radii.
- Do not add a second UI framework, web fonts, decorative gradients, or count-up animations.
- Preserve the existing, uncommitted TradeLedger rename; stage only files belonging to the current task. Never revert another change to obtain a clean tree.

## Review Focus

1. A build changes between chart display and export/detail: reject mismatched expectedBuildId with 409 and provide refresh (Tasks 1, 4, 5, 8).
2. Shared execution allocations or mixed-underlying strategies: deduplicate transaction keys and attribute strategy P&L to exactly one bucket (Tasks 2, 3).
3. A slow earlier filter response arrives after a later response: render only data belonging to the current URL scope (Task 6).
4. Very long/sparse history, all-null P&L, or extreme decimals: preserve exact data and missingness while bounding SVG work and finite coordinates (Tasks 3, 7).
5. Spreadsheet-like symbols/notes and export from page 2: protect textual cells, preserve signed money, and export the full matching scope (Task 5).

## File map and dependency order

- `src/server/analytics/snapshot.ts`: coherent storage reads and provenance; no analytics math.
- `src/shared/analytics.ts`: query/result Zod schemas and inferred DTOs; browser-safe.
- `src/server/analytics/query.ts`, `scope.ts`: validation and reusable membership/detail predicates.
- `src/server/analytics/performance.ts`, `transactions.ts`, `aggregate.ts`: decimal metrics, series, and result assembly.
- `src/server/analytics/details.ts`, `csv.ts`: ordered page selection and full-scope export serialization.
- `src/server/http/routes-analytics.ts`; modify `src/server/app.ts`: read endpoints and registration.
- `src/web/dashboard/query.ts`, `api.ts`, `DashboardPage.tsx`, `DashboardFilters.tsx`: URL state, request isolation, shared layout.
- `src/web/dashboard/KpiCards.tsx`, `Charts.tsx`, `chartModel.ts`, `BreakdownTable.tsx`, `Overview.tsx`: reusable display units and Overview.
- `src/web/dashboard/Analysis.tsx`, `DetailTable.tsx`, `Reports.tsx`, `ExportButton.tsx`, `dashboard.css`: investigation, reports, download handling, responsive/print styles.
- `test/fixtures/analytics.ts`, `test/unit/analytics-*.test.ts`, `test/integration/analytics-*.test.ts`, `e2e/dashboard.spec.ts`: deterministic, isolated validation.
- Modify `src/web/App.tsx`, `README.md`, `docs/TEST-PLAN.md`, `docs/IMPLEMENTATION_STATUS.md` only for routing and current feature documentation.

Tasks 1–5 build one shared backend; Tasks 6–9 deliver the views in order; Task 10 verifies the integrated feature. This is one subsystem and one plan, not three independently calculated dashboards. Do not start execution until the user reviews the plan and selects the execution approach.

### Task 1: Capture a consistent analytics snapshot

**Files:** Create `src/server/analytics/snapshot.ts`, `test/fixtures/analytics.ts`, `test/integration/analytics-snapshot.test.ts`. Read `src/server/builds/service.ts`, `src/server/builds/repository.ts`, `src/server/storage/ledger.ts`, `test/helpers/store.ts`.

**Interfaces:** Produce `AnalyticsSnapshot = { buildId: string | null; ledgerId: string | null; stale: boolean; generatedAt: string; projection: Projection | null; ledger: LedgerSnapshot | null }` and `readAnalyticsSnapshot(store: Store, now?: Date): AnalyticsSnapshot`. Fixtures export `strategy(patch: Partial<Strategy>): Strategy`, `execution(patch: Partial<Execution>): Execution`, `snapshot(patch: Partial<AnalyticsSnapshot>): AnalyticsSnapshot`, and `performanceFixture(): AnalyticsSnapshot`. Defaults are complete USD closed stock strategies and unique-key executions; each test supplies differing IDs. The large fixture has 481 wins of 100, 197 losses of -190, one loss of -213.76, and 19 open strategies: total 10,456.24 across 679 closed strategies.

- [x] Write integration tests `returns empty provenance before first build`, `reads the active build ledger despite newer retained ledger`, `reports stale decisions without rebuilding`, and `rejects missing associated ledger`. Assert empty build/ledger IDs are null; populated projection.ledgerId equals ledger.id; a missing associated ledger yields AppError code ANALYTICS_SNAPSHOT_INVALID.
- [x] Run `npx vitest run test/integration/analytics-snapshot.test.ts`; expect failure because the snapshot module is absent.
- [x] Implement `readAnalyticsSnapshot` in one synchronous read transaction. Use `activeProjection`, `loadLedgerSnapshot(store.db, projection.ledgerId)`, and the returned build/stale metadata; no independent newest-ledger lookup, await, mutation, or write helper. Validate the associated ledger exists. No-build results are explicit nulls. Fixtures are synthetic and contain no private broker exports.
- [x] Run `npx vitest run test/integration/analytics-snapshot.test.ts`; expect all tests pass with temporary stores disposed through existing helpers.
- [x] Commit only Task 1 files: `git commit -m "feat: read consistent analytics snapshots"` after staging the exact files above.

### Task 2: Define validated filters and reusable scopes

**Files:** Create `src/shared/analytics.ts`, `src/server/analytics/query.ts`, `src/server/analytics/scope.ts`, `test/unit/analytics-scope.test.ts`.

**Interfaces:** Shared schemas produce `AnalyticsQuery` with optional from/to/currency/symbol/underlying/strategyType/assetClass and basis=`broker|reconstructed` (default broker). `DetailQuery` extends it with kind=`strategies|transactions`, scope=`closed|current-open|unresolved|undated-closed` (default closed), optional outcome=`win|loss|breakeven|unavailable`, groupBy=`strategyType|underlying|assetClass|event`, group, date, expectedBuildId, sort/direction, page/pageSize. `ExportQuery` replaces paging/kind with dataset=`summary|strategies|transactions` and retains matching detail predicates. Export inferred types and request schemas from the shared module.

`parseAnalyticsQuery(raw: unknown): AnalyticsQuery`; `parseDetailQuery(raw: unknown): DetailQuery`; `parseExportQuery(raw: unknown): ExportQuery` throw existing-style AppErrors. `resolveScope(snapshot: AnalyticsSnapshot, query: AnalyticsQuery): AnalyticsScope` produces effective query (resolved currency), full-snapshot options, closed/currentOpen/unresolved/undatedClosed strategy arrays, scoped executions, attribution maps, and excludedUnallocated count. `strategyUnderlying(strategyId: string, snapshot: AnalyticsSnapshot): string` returns exact bucket key; display labels are separate. Reserved bucket keys `__multi__` and `__unknown__` cannot collide with actual instrument symbols; wrap real keys with `value:`. Treat duplicate query keys as invalid instead of accepting an array.

- [x] Write scope tests including these exact assertions (using Task 1 fixture helpers):

```ts
expect(() => parseAnalyticsQuery({ from: "2026-02-30" })).toThrow();
expect(() => parseAnalyticsQuery({ from: "2026-10-16", to: "2026-10-01" })).toThrow();
expect(() => parseAnalyticsQuery({ mystery: "USD" })).toThrow();
// scoped fixture has two allocations pointing to the same execution:
expect(scoped.executions.map(row => row.key)).toEqual(["shared"]);
expect(scoped.closed.map(row => row.id)).toEqual(["within-period"]);
expect(scoped.currentOpen.map(row => row.id)).toEqual(["old-open"]);
```

Also assert exact underlying versus symbol matching, Multi/Unknown attribution, type-filter exclusion of unallocated executions, inclusion without strategy-specific filters, immutable filter options, sorted currency default, rejection of unavailable currency, null currency only when the snapshot has no available currencies, invalid kind/scope/group pairs, and invalid sort/pagination. All-time excludes null/invalid close dates but keeps their disclosure count. For strategy filters, inspect all allocated executions before applying transaction date filters.
- [x] Run `npx vitest run test/unit/analytics-scope.test.ts`; expect missing-module failures.
- [x] Implement schemas, actual calendar validation, currency availability resolution, and scope predicates. An active but empty snapshot with no available currencies accepts omitted currency just like a no-build snapshot; a supplied unknown currency is rejected. Allowlist strategy sorts `closeDate|id|pnl`, transaction sorts `date|symbol|quantity|netCash`; compare money/quantity with Decimal, nulls last, stable ID/key tie-break. Page starts at 1; pageSize defaults to 25 and is capped by validation at 100. Grouping and selected filters use the same attribution keys; event groups apply only to transactions. `scope`/outcome apply only to strategy details, with closed as the ignored default for transactions; reject an explicitly supplied non-closed scope for transactions. Explicit group requires groupBy. Group keys must exist in full-snapshot options.
- [x] Run `npx vitest run test/unit/analytics-scope.test.ts`; expect all pass.
- [x] Stage Task 2 files and commit `feat: validate analytics filters and scopes`.

### Task 3: Aggregate performance and transaction metrics

**Files:** Create `src/server/analytics/performance.ts`, `transactions.ts`, `aggregate.ts`, `test/unit/analytics-performance.test.ts`, `test/unit/analytics-transactions.test.ts`; extend `src/shared/analytics.ts`.

**Interfaces:** Produce `aggregateAnalytics(snapshot: AnalyticsSnapshot, query: AnalyticsQuery): AnalyticsResponse`, `summarizePerformance(scope: AnalyticsScope): PerformanceSummary`, `summarizeTransactions(scope: AnalyticsScope): TransactionSummary`. Export response Zod schema and inferred DTOs. `AnalyticsResponse` has provenance fields from Task 1; `filters` (effective query), `options`, `performance`, `transactions`, `daily`, `monthly`, `byStrategyType`, `byUnderlying`, `recent`, `best`, `worst`, and `quality`. `quality` has undatedClosed, unresolved, estimatedClosed, and excludedUnallocated counts.

`PerformanceSummary`: closed, eligible, missing, wins, losses, breakeven, open, partiallyClosed (integer counts); pnl, winRatePct, averageWin, averageLoss, averagePnl, grossProfit, grossLoss, maxDrawdown (decimal strings or null); profitFactor `{ state: finite|no-losses|unavailable, value: string|null }`. `TransactionSummary`: executions, tradedSymbols, netCash, commissions/taxes `{ value: string|null, known: number, total: number }`, byAssetClass/byEvent `{ key, label, count }[]`. Group rows contain key/label/closed/eligible/missing/wins/losses/breakeven/pnl/winRatePct; daily points contain date/pnl/cumulative/drawdown/eligible/missing; monthly rows add month/executions/netCash to the performance fields. Recent/best/worst contain Strategy plus selectedPnl and attribution keys; restrict each to ten. Empty known monetary sets are null. Export consistent schemas for every nested shape.

- [x] Write performance tests with the fixture:

```ts
expect(result.performance).toMatchObject({
  closed: 679, eligible: 679, wins: 481, losses: 198,
  pnl: "10456.24", open: 19, partiallyClosed: 0,
});
expect(new Decimal(result.performance.winRatePct!).toFixed(2)).toBe("70.84");
```

Use a local Decimal constructor in tests. Additional assertions: 0.1 + 0.2 gives "0.3"; 0.001 is a win even if display rounds to zero; missing P&L differs from breakeven; selected basis never falls back; EUR never joins USD; gains 10 and losses -4 give factor 2.5; daily changes -5,+8,-7 give maximum drawdown 7; two close events on one day form one daily point. All-null groups/series stay unavailable. Unknown close dates are inspectable, not summed. Group sums equal headline totals; multi-underlying appears once. Broker-estimated counts are derived only from contributing allocations. Tied rankings are deterministic.
- [x] Write transaction tests: duplicate keys and supporting lots count once; a -1 commission and +0.25 rebate total -0.75; known zero differs from null; transaction dates scope independently of strategy close dates; monthly sums reconcile; unsupported lifecycle event is retained. Check >100 records and local Decimal precision with large canonical amounts.
- [x] Run `npx vitest run test/unit/analytics-performance.test.ts test/unit/analytics-transactions.test.ts`; expect failures for absent aggregators.
- [x] Implement the three modules using a locally cloned Decimal constructor with precision 40 or greater, exact addition and source-precision signs, 12-place rounded repeating divisions, and null-aware accumulators. Daily points are activity dates, not a dense calendar; initialize running peak at zero. Empty months between bounded data endpoints carry zero activity; missing-only months retain null P&L. Do not change existing Agent summarizePnl. Validate produced response shapes in tests.
- [x] Run the two tests plus `npx vitest run test/unit/pnl-summary.test.ts`; expect all pass and existing Agent semantics unchanged.
- [x] Stage Task 3 files and commit `feat: aggregate trading performance and activity`.

### Task 4: Serve summary and paginated drill-down APIs

**Files:** Create `src/server/analytics/details.ts`, `src/server/http/routes-analytics.ts`, `test/integration/analytics-http.test.ts`; modify `src/server/app.ts`, `src/shared/analytics.ts`.

**Interfaces:** `selectAnalyticsDetails(snapshot: AnalyticsSnapshot, query: DetailQuery): AnalyticsDetailsResponse`; `registerAnalyticsRoutes(app: FastifyInstance, store: Store): Promise<void>`. A details response has kind, items (Strategy with selectedPnl or Execution, discriminated by kind), page/pageSize/total, filters, and provenance. Produce shared discriminated Zod response schema. Expected build validation compares against the captured snapshot; mismatch throws AppError ANALYTICS_BUILD_CHANGED with status 409.

- [x] Write `app.inject` tests for all registered routes: summary returns the full fixture totals; pageSize=25 on 679 strategy records reports total=679 and 25 items; a month/group/outcome drill-down reconciles to its summary subtotal; current-open ignores dates; unresolved and undated-closed return appropriate records. Assert invalid dates/currency/sort/page/unknown parameters yield 400, empty-build returns 200 with null metrics, and stale snapshot metadata propagates. A captured old expectedBuildId against a new build returns 409. Malformed snapshot yields the structured 500 from Task 1, not zero totals. Use disposable stores and existing import/rebuild fixture patterns; do not add production test-seeding endpoints.
- [x] Run `npx vitest run test/integration/analytics-http.test.ts`; expect 404/new-interface failures.
- [x] Implement summary/details routes and register in `src/server/app.ts` alongside journal routes. Parse once, read snapshot once, reuse scope predicates, sort using Decimal, then page. Requests never trigger rebuilds. Provide a filtered-summary consistency check in tests without relying on page order. Summary-generated timestamps are injectable through snapshot service tests, not a browser clock.
- [x] Run `npx vitest run test/integration/analytics-http.test.ts test/integration/http.test.ts`; expect all pass.
- [x] Stage Task 4 files and commit `feat: expose analytics summary and drill-down APIs`.

### Task 5: Export exact full-scope CSV safely

**Files:** Create `src/server/analytics/csv.ts`, `test/unit/analytics-csv.test.ts`, `test/integration/analytics-export.test.ts`; modify `routes-analytics.ts` and `src/shared/analytics.ts` as needed for export DTOs.

**Interfaces:** `serializeAnalyticsCsv(snapshot: AnalyticsSnapshot, query: ExportQuery): { filename: string; csv: string }`. Register GET `/api/analytics/export`; dataset=summary|strategies|transactions. Derive filenames solely from allowlisted dataset/date/currency, never raw descriptions. Content-Type is `text/csv; charset=utf-8`; Content-Disposition uses safe quoted filenames.

- [x] Test CSV parsing round trips for commas, quotes, CRLF, embedded newlines, and formula-prefixed textual symbols (including leading whitespace before =,+,-,@). Assert numeric -140.60 remains a numeric decimal field, while a textual =HYPERLINK(...) is apostrophe-prefixed. Assert summary column order equals the spec's 13-column rectangular schema. Assert exact decimals are not display-rounded and all data rows carry matching provenance and coverage. Test empty-scope headers and summary null fields.
- [x] Test export from a page-2 drill-down returns every matching record (e.g. 150, not 25), retains outcome/group/date/current-open scopes, includes all breakdown rows, and returns 409 for a changed expectedBuildId. Parse generated CSV with the existing csv-parse dependency and assert every record has the same column count.
- [x] Run `npx vitest run test/unit/analytics-csv.test.ts test/integration/analytics-export.test.ts`; expect missing-export failures.
- [x] Implement text-cell hardening separately from validated decimal serialization. Select full matching details before paging; reuse Task 2/4 scope logic, not a second implementation. Generate CSV after snapshot capture finishes. Capture summary generatedAt once for all rows. Add a rectangular `coverageKnown`/`coverageTotal` pair per relevant summary metric; use empty values for inapplicable metrics.
- [x] Run the two new tests and `npx vitest run test/integration/analytics-http.test.ts`; expect all pass.
- [x] Stage Task 5 files and commit `feat: export full-scope analytics CSV`.

### Task 6: Build URL-driven dashboard navigation and request state

**Files:** Create `src/web/dashboard/query.ts`, `api.ts`, `DashboardPage.tsx`, `DashboardFilters.tsx`, `dashboard.css`, `test/unit/analytics-url.test.ts`, `e2e/dashboard.spec.ts`; modify `src/web/App.tsx`.

**Interfaces:** `readDashboardQuery(search: string, view: DashboardView, today: string): DashboardQueryState`; `dashboardHref(view: DashboardView, state: DashboardQueryState): string`; view=`overview|analysis|reports`. DashboardQueryState contains AnalyticsQuery plus preset and detail query state; encode all active filters in URL. `useAnalytics(query: AnalyticsQuery): RemoteState<AnalyticsResponse>` validates with Task 3 schema. `DashboardPage({ view }: { view: DashboardView })` owns fetching and shared controls. Existing `navigate`, `Link`, `useLocation`, `BuildBadge`, `Loading`, and `ErrorPanel` are reused.

- [x] Write URL unit tests for month/year boundaries, leap years, local-calendar presets, explicit All time versus absent report preset, preservation across tabs/back, Reset, and invalid date inputs retained with visible errors instead of sent. Reports defaults to This month only when no explicit period is present. Query changes reset page and incompatible drill-down filters. Currency defaults resolved by server are written into the URL using replaceState plus popstate (no extra browser-history step).
- [x] Write browser tests for the three direct routes, Dashboard nav active state, preserved existing root/Agent route, currency/basis controls, custom-range errors, loading/retry, and no-build import link. Use Playwright route fixtures for loading/error/race cases. Delay response A, complete B, then A; assert A never appears under B's filter labels, including the first render after a URL change. Test no page overflow at 375px.
- [x] Run `npx vitest run test/unit/analytics-url.test.ts` and `npx playwright test e2e/dashboard.spec.ts`; expect absent-route/control failures.
- [x] Implement shell, filter controls, route switch, and request hook. Keep module-level schemas stable. A dashboard-local hook tracks the request key in state, immediately exposes loading when key differs, discards late results, and cleans up requests; do not alter generic useJson behavior across unrelated screens. Shared header shows effective scope, provenance, coverage, and staleness. Preserve TradeLedger heading. Unknown dashboard subroutes render the existing NotFound behavior.
- [x] Run the two targeted commands; expect all current assertions pass.
- [x] Stage only Task 6 files/hunks (App.tsx already contains approved branding) and commit `feat: add dashboard routes and shared filters`.

### Task 7: Deliver Overview with accessible charts

**Files:** Create `KpiCards.tsx`, `Charts.tsx`, `chartModel.ts`, `BreakdownTable.tsx`, `Overview.tsx` under `src/web/dashboard/`; extend `dashboard.css`, `DashboardPage.tsx`, `e2e/dashboard.spec.ts`; create `test/unit/analytics-chart.test.ts`.

**Interfaces:** `Overview({ data }: { data: AnalyticsResponse })`; `KpiCards({ data }: { data: AnalyticsResponse })`; `BreakdownTable({ rows, currency, onSelect })` uses Task 3 group DTOs. `buildChartModel(points: readonly ChartPoint[], maxPoints?: number): ChartModel` uses ChartPoint `{ key: string; label: string; value: string|null }`; ChartModel has bounded coordinates, selected original indices, and gap markers. `AnalyticsChart({ title, currency, points, variant, onSelect })` supports variant=line|bar, keyboard/tap value inspection, exact original data table, and text summary. All callback keys are stable data keys, not display labels.

- [x] Test empty/single/all-null data, constant/all-zero series, very large amounts, negative-only values, sparse gaps, and >1,000 points. Assert finite coordinates, selected first/last/extreme points, no lines crossing null gaps, bounded mark count, and unchanged full-resolution source values. Coordinate normalization may use Decimal in browser solely for safe scaling; no financial totals are calculated there.
- [x] Add browser assertions for 10,456.24 P&L, 70.84% win rate, 679 closed, and 19 current-open fixture values; label currency and basis. Test unavailable versus zero cards, coverage, ten recent rows, strategy links, transaction-summary link, visible legends, table toggles, and keyboard/tap tooltips. Verify sign labels alongside color.
- [x] Run `npx vitest run test/unit/analytics-chart.test.ts` and `npx playwright test e2e/dashboard.spec.ts`; expect missing component behavior failures.
- [x] Implement four primary/eight total KPI cards, cumulative and monthly charts, strategy/underlying breakdowns, recent list, and compact transaction summary. Reuse `formatMoney` with explicit adjacent currency labels. SVG charts preserve missingness and use bounded points; exact table rows remain available through a paginated table without deleting source data. Long-chart keyboard navigation uses one focusable chart plus previous/next data point controls. Implement 375/768/desktop grids, visible focus, semantic headings, and reduced-motion styles.
- [x] Run both commands; expect all pass. Verify light/dark chart and text contrast for actual token pairs (4.5:1 text, 3:1 chart/control).
- [x] Stage Task 7 files and commit `feat: add performance overview and accessible charts`.

### Task 8: Deliver dense Analysis and matching drill-downs

**Files:** Create `src/web/dashboard/Analysis.tsx`, `DetailTable.tsx`; extend `DashboardPage.tsx`, `query.ts`, `api.ts`, `dashboard.css`, `e2e/dashboard.spec.ts`.

**Interfaces:** `Analysis({ data, section }: { data: AnalyticsResponse; section: "performance"|"transactions" })`; section is URL `section`. `DetailTable({ query }: { query: DetailQuery })` consumes Task 4 response schemas. `useAnalyticsDetails(query: DetailQuery)` follows Task 6 request-key isolation. Drill-down links carry expectedBuildId from the displayed summary, with current-open/undated scopes explicitly encoded.

- [x] Add browser tests for Performance/Transactions sections; symbol/underlying/type/asset-class filters and chips; sort with aria-sort; drawdown/outcome display; largest winners/losers; commission/tax coverage; monthly activity/cashflow and asset/event charts; all transaction columns and source links; >100-row pagination; resetting page after scope changes. Assert a bar-selected group matches detail totals and the headline subtotal. Open count drill-down ignores the chosen historical period and is visibly Current open trades. A 409 shows Refresh analytics and removes the old expectedBuildId only on refresh.
- [x] Run `npx playwright test e2e/dashboard.spec.ts`; expect new Analysis assertions fail.
- [x] Implement Analysis using shared charts/KPIs/tables. Add date/outcome/group/event drill-down state, Back to analysis/Reset controls, and summary-build consistency. Server queries own sorting/paging; browser never recomputes financial totals. Generic symbol/underlying filters remain distinct from exclusive attribution bucket links. Detail table uses a labeled scroll region; controls remain operable on mobile.
- [x] Run `npx playwright test e2e/dashboard.spec.ts`; expect all pass, including restored filters after browser back and changed-build refresh.
- [x] Stage Task 8 files and commit `feat: add trade and transaction analysis drill-downs`.

### Task 9: Deliver review Reports, print, and CSV download UI

**Files:** Create `src/web/dashboard/Reports.tsx`, `ExportButton.tsx`; modify `DashboardPage.tsx`, `api.ts`, `dashboard.css`, `e2e/dashboard.spec.ts`.

**Interfaces:** `Reports({ data }: { data: AnalyticsResponse })`; `ExportButton({ query, dataset }: { query: ExportQuery; dataset: "summary"|"strategies"|"transactions" })`. Export helper `downloadAnalyticsCsv(query: ExportQuery): Promise<void>` validates HTTP errors using existing ApiError conventions and revokes object URLs after download. Report notes are unsaved component-local text, never request parameters.

- [x] Add browser tests that report totals equal Overview for identical bounds/currency/basis; current-month default preserves explicit incoming periods; provenance and missing/estimated data notes render; current-open is labeled current context; review notes appear in print without being sent to the network and reset on unmount. Assert Print calls window.print only when ready. Emulate print media and verify navigation/controls hidden, notes and report context visible, charts/tables fit the printable width. Verify exported file contains all scoped rows, exact decimals, expectedBuildId, and safe filename. Test download failure, retry, and changed-build response.
- [x] Run `npx playwright test e2e/dashboard.spec.ts`; expect new Reports/export assertions fail.
- [x] Implement Reports with summary, shared charts, outcome/attribution, best/worst trades, costs/activity, data quality, and clearly labeled Unsaved review notes. Add print CSS with white surfaces and dark text, visible chart strokes, repeatable table headings, wrapped long tokens, and break-inside avoidance for cards/rows. Print current data, not live filter controls. Export actions select summary/strategies/transactions and honor active detail scope without pagination. Prevent double downloads and disable print/export while scope is loading.
- [x] Run `npx playwright test e2e/dashboard.spec.ts`; expect all pass. Inspect an actual generated print PDF once to confirm readable pagination rather than relying only on computed styles; save temporary inspection artifacts outside version control.
- [x] Stage Task 9 files and commit `feat: add printable trading reports and CSV downloads`.

### Task 10: Verify integrated behavior and document shipped scope

**Files:** Extend `e2e/dashboard.spec.ts`, `test/integration/analytics-http.test.ts` only where integration coverage is missing; modify `README.md`, `docs/TEST-PLAN.md`, `docs/IMPLEMENTATION_STATUS.md`.

**Interfaces:** No new product API. Existing routes, import/rebuild behavior, backup identifiers, and Agent P&L tool contracts must remain compatible.

- [x] Add any missing integrated assertions: import synthetic spread through the real UI and confirm closed P&L, verify re-import does not double execution counts, and navigate directly between all dashboard/legacy routes. Separate API-mocked presentation tests from these real-backend checks. Use unique synthetic symbols and no assumptions about other Playwright files' data or run order. Freeze the browser calendar for preset tests.
- [x] Run `npx playwright test e2e/dashboard.spec.ts`; expect all pass. If new assertions expose a defect, first confirm that failure, fix only the owning feature code, and rerun the relevant unit/integration and browser test.
- [x] Update docs with routes, metric definitions, period-versus-current semantics, currency/basis controls, coverage, drill-downs, report notes, print, and full-scope exports. Describe realized drawdown correctly; do not claim equity or unrealized valuation. Preserve historical design filenames, existing backup compatibility, and the TradeLedger rename.
- [x] Run `npm run check:all`, `npm test`, `npm run test:build-smoke`, and `npm run test:e2e`. Expected: zero errors/failing tests and successful built-server smoke. Existing lint warnings must be identified as baseline; no new warnings in changed files. Browser verification includes 375px, 768px, 1440px, light/dark, reduced motion, keyboard, loading/empty/partial/stale/error, and print.
- [x] Run `git diff --check` and review the complete feature diff against all ten acceptance items in the spec. Confirm every API response reconciles within the same build and no money aggregation uses JS floating point. Inspect `git status --short` before staging to exclude unrelated work. Stage Task 10 files and commit `docs: document dashboard analytics and verification`.

## Self-review and handoff

Reviewed against every spec section: snapshot/API (Tasks 1–5), metric contracts (2–3), Overview (6–7), dense Analysis (8), Reports/CSV (5, 9), accessible responsive charts (7–9), empty/error/stale/race states (1, 4, 6, 8–9), and acceptance/regression gates (10). Review Focus inputs each have explicit owning tests. All money stays string-valued across DTOs; browser coordinates never become source financial values. Execution completed task-by-task; test evidence is recorded in the execution ledger and Git history.

Execution choice remains the user's: Native implements the tasks sequentially in this session with a final independent review; Subagent-driven uses separate implementer/reviewer contexts per task. Native is recommended here because all three views share tightly coupled filter/DTO/chart contracts and the plan defines deterministic accounting tests. Follow the chosen execution skill and establish isolation at execution time; preserve the current branding changes.
