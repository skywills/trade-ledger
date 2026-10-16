# Dashboard and transaction analytics

Date: 2026-10-16
Status: design prepared for written-spec review; implementation has not started.

## Intent and agreed scope

The user wants to understand total trading performance, completed and pending trades, wins and losses, and transaction activity. They approved the initial dashboard direction and requested all three proposed directions. Deliver three complementary views in one Dashboard area: Overview, Analysis (the denser trading-terminal direction), and Reports (the review-report direction). Use a shared calculation layer so changing presentation cannot change results.

The example values are illustrative, never seeded application data: P&L 10,456.24, 679 completed trades, 481 wins, 198 losses, 70.84% win rate, and 19 pending trades. The unlabeled -140.60 has no assigned meaning and must not appear as a metric without evidence. Interpret pending as open and partially closed strategies, with explicit labels. Execution counts are a separate concept.

Success means a user can see performance quickly, investigate its drivers, trace results to strategies and retained executions, and print or export a period review. All views must remain useful without AI configuration or live broker connectivity.

## Existing system and integration

The app uses React, TypeScript, plain CSS design tokens, Fastify, SQLite, and decimal.js. App.tsx owns routes and primary navigation. Journal and Transactions currently consume paginated APIs with pageSize=100. Strategy records expose status, completeness, dates, currency, brokerPnl, reconstructedPnl, and positions. Executions expose instrument, date, currency, proceeds, netCash, commission, taxes, and source references. Projections contain execution allocations for strategy drill-down.

Add a Dashboard navigation item and routes /dashboard, /dashboard/analysis, and /dashboard/reports. The root and Agent route retain their existing behavior. Use one shared dashboard shell and a tab navigation with visible active state. Existing Journal and Transactions destinations remain available.

Implement read-only analytics against the active projection and its associated retained ledger. Do not combine a strategy build with an unrelated newer ledger. Return build ID, ledger ID, stale state, and effective filters together. No schema migration or persisted analytics tables are needed. Do not aggregate paginated browser lists or truncate at 100 records.

## Shared controls and scope

The dashboard header contains period, currency, P&L basis, and a secondary export action. Period presets: All time (default), This month, Last month, This year, and Custom inclusive date range. Validate actual ISO calendar dates and start <= end. Dates use the existing normalized ledger date strings; never invent a timezone for unknown timestamps. Show that date convention in metric help.

Currency selection is mandatory for monetary totals. Default to the first available currency in sorted order and preserve the user's selection in the URL; offer other currencies explicitly. Never sum currencies or introduce FX conversion. Empty data leaves the control unselected and shows an import-oriented empty state.

P&L basis is Broker reported (default) or Reconstructed. Each closed strategy contributes only its selected field; no per-row fallback. Explain that broker values retain broker accounting semantics and reconstructed values follow the existing accounting completeness rules. Do not subtract fees again from either P&L series.

URL query parameters preserve period bounds, currency, basis, and Analysis filters when switching views or using browser back. Analysis adds symbol/underlying, strategy type, and asset class, with clear filter chips and Reset. Strategy membership filters use allocated executions. A multi-underlying strategy belongs to one explicit Multi-underlying bucket; missing attribution belongs to Unknown. Do not allocate its full P&L to each constituent symbol or asset class.

Closed-strategy performance is attributed in full to closeDate, even if some executions occurred outside the selected period. Transactions use execution.date independently. Explain this distinction next to transaction analytics; their cashflow is not the closed-strategy P&L for that period.

Open and partially closed counts describe the current active build, filtered by currency and relevant Analysis membership filters, and are labeled Current open trades. The date range does not turn these into historical positions. Report pages label them separately as current context; do not imply period-end exposure. Historical position reconstruction is excluded.

## Metric contract

All financial arithmetic, comparisons, and aggregation use decimal.js on the server. Monetary API fields remain canonical decimal strings with currency; browser formatting follows the existing currency conventions. Integer counts and bounded chart coordinates may be numbers. Rounded display values must not drive totals or win/loss classification.

| Metric | Definition |
| --- | --- |
| Closed trades | Strategies with status closed and closeDate inside the selected range, regardless of whether selected P&L is available. |
| P&L coverage | Number of those closed strategies with non-null selected P&L, out of the closed count. Show separately any excluded closed strategies with unknown closeDate. |
| Realized P&L | Sum of available selected P&L for the period's closed strategies; label partial coverage. No eligible values means unavailable, not zero. |
| Wins / losses / breakeven | Counts of eligible closed strategies with selected P&L > 0 / < 0 / = 0 at full precision. |
| Win rate | Wins divided by wins + losses + breakeven. Missing P&L is excluded and disclosed through coverage. No eligible trades means unavailable. |
| Current open trades | Current strategies with status open or partially_closed, with both subcounts visible. Unresolved is separate. |
| Average win / loss | Sum of winning / losing selected P&L divided by its respective count. Average loss remains signed. No matching trades means unavailable. |
| Profit factor | Gross positive P&L divided by absolute gross negative P&L. Positive gains with no losses displays No losses; no gains and no losses is unavailable. |
| Average P&L per trade | Selected P&L total divided by eligible closed count, including breakeven. |
| Cumulative P&L | Running sum of eligible closed-strategy P&L by close date, starting at zero at the selected period's start. Label as realized P&L, never account equity. |
| Realized drawdown | Largest peak-to-trough decrease in the daily cumulative realized P&L series, including the initial zero peak. Currency amount only; no equity-return percentage. |
| Executions | Unique normalized execution keys in the selected transaction scope. Source duplicates and supporting lot rows never add counts. |
| Trading cashflow | Signed sum of execution netCash. No inference about deposits, withdrawals, or investment return. |
| Commissions / taxes | Signed sums of provided fields, with known/total execution coverage. A zero is known; null is unavailable. Label Charges / credits and explain signs rather than silently converting rebates into costs. |
| Traded symbols | Distinct instrument.symbol values in scoped executions. Separate from the underlying breakdown used for strategy performance. |

Broker-estimated allocation values must be disclosed when contributing to broker P&L; use allocation pnlEstimated metadata. Incomplete or unresolved evidence remains visible through coverage/warning indicators. Do not suppress available broker values solely because reconstructed values are unavailable. Do not infer unrealized P&L, account balance, capital at risk, annualized returns, or return percentages without the required evidence.

## Overview view

Desktop layout:

```text
Dashboard                         [Period] [Currency] [P&L basis]
Overview | Analysis | Reports                        [Export CSV]
Build/staleness and P&L coverage

[Realized P&L] [Win rate: W/L/BE] [Closed trades] [Current open trades]
[Average win] [Average loss] [Profit factor] [Average P&L / trade]

[Cumulative realized P&L: wide line chart] [Monthly P&L: signed bars]
[Performance by strategy type]           [Performance by underlying]
[Recent closed trades with P&L and links to strategy details]
```

Use direct signed labels, clear currency units, and restrained chart grids. Show monthly bars for the selected range, with partial months identified by the effective date range. Include the ten most recent closed strategies with deterministic date/ID tie-breaking. Unavailable values remain explicit. Overview includes a compact transaction summary linking to Analysis, rather than duplicating every transaction chart.

## Analysis view

The trading-terminal direction means denser investigation, not live quotes or order entry. Use the same tokens, compact spacing, and a responsive grid. Secondary sections: Performance and Transactions.

Performance includes the headline metrics, cumulative P&L, monthly P&L, daily realized drawdown, outcome counts, and sortable breakdowns by strategy type and underlying. Breakdowns expose trade count, available-P&L count, win rate, and selected P&L. Largest winners and losers link to strategy details. Use horizontal bars for ranked contributions; signed labels avoid reliance on red/green alone.

Transactions includes execution count, traded symbols, signed cashflow, commissions, and taxes with coverage; monthly execution counts; monthly cashflow; activity counts by asset class and event (trade, assignment, exercise, expiry, cash settlement, unsupported); and a server-paginated detail table. Table columns: date, symbol, asset class, action/event, quantity, price, currency, net cash, commission, taxes, broker P&L, and source. Read-only filters support inspection across the full dataset. Source links reuse the existing import-row destination.

Chart/bar activation applies a visible filter or opens a matching detail table. Performance drill-down shows exactly the matching closed strategies for that group/outcome/period and uses existing /strategies/:id pages for details. Transaction drill-down shows the matching executions and source links. Keep these paginated detail lists inside the dashboard so it does not depend on unsupported Journal URL filters. Every drill-down provides a visible back/reset path and preserves parent filters.

## Reports view

A report is a deterministic rendering of the same analytics result for the chosen month or custom period. Default to the current month when opening Reports without an explicit period; preserve an explicit period from another view. Include title, inclusive dates, currency, P&L basis, build/ledger IDs, generation time, and coverage/staleness notices.

Sections: performance summary; cumulative and monthly realized P&L; wins/losses/breakeven; strategy and underlying attribution; largest winners/losers; transaction activity and costs; data-quality notes; and optional local review notes. Notes stay in component state and appear in print; clearly label them unsaved and do not persist them or send them to AI.

Primary action is Print / Save as PDF using browser print, with print CSS that hides navigation and controls, expands report content, retains currency and filter context, and avoids clipped charts or table rows. Provide CSV exports of performance breakdowns and transactions for the full selected scope, not the visible page. Exports carry scope/build metadata and unrounded decimal values. Escape CSV correctly and neutralize spreadsheet formula prefixes in textual fields while retaining validated signed financial decimals. No PDF service or scheduled report delivery.

## Visual system and accessibility

Retain the existing system font, indigo accent, light/dark tokens, semantic success/danger/warning colors, focus rings, 4/8px spacing, and modest card radii. Tabular figures align monetary columns. Prioritize legible numbers over ornament. Do not add a second UI framework, web fonts, decorative gradients, or count-up animations.

Desktop uses four primary KPI columns and a two-column chart grid. Tablet uses two KPI columns. At 375px, KPI cards use two columns when labels fit, charts stack, filters wrap, and dense tables use a labeled horizontal scroll region within the page. The page itself must not overflow. Essential labels must wrap rather than disappear.

Charts use scalable SVG with modest point counts and aggregation by day/month. Keep exact values in table alternatives and accessible tooltips available on focus/tap, not hover alone. Use explicit signs, labels, and line styles alongside color. Provide concise text summaries and a Show data table control. Interactive marks need keyboard access and adequately sized hit regions; long series can use a focusable chart with an accessible date/value navigator rather than hundreds of tab stops. Reduced motion must be respected. Test normal text contrast at 4.5:1 and meaningful chart/control contrast at 3:1 in both themes.

## API and implementation boundaries

Add src/server/analytics/ for pure scope/aggregation helpers and a snapshot reader. Introduce a dedicated routes-analytics.ts registered alongside existing read routes. Define shared analytics query/result types and Zod response schemas consistent with the current client. Add src/web/dashboard/ for shared filters, KPI cards, chart/table primitives, Overview, Analysis, Reports, and print styles.

Proposed read API:

- GET /api/analytics: summary, full-scope grouped series/breakdowns, filter options, provenance, coverage, and recent/best/worst strategy summaries. Validated filters: from, to, currency, basis, symbol, strategyType, assetClass. Limit top/bottom summaries to ten; grouped tables retain all categories and can expose their own view-all control.
- GET /api/analytics/details: validated kind=strategies|transactions, matching shared filters plus outcome/group/date drill-down, pagination, and allowlisted sort. Response includes scope and build/ledger provenance. Capture snapshot once per request; if a drill-down is requested for an old build, explicitly report a changed-build state and offer refresh instead of silently implying exact reconciliation.
- GET /api/analytics/export: same validated scope plus dataset=summary|strategies|transactions. Export all matching records and their scope/provenance, reusing the same aggregation and detail-filter predicates. Add an optional expected build ID; reject mismatched builds with a refresh message.

Read every dataset for a response from a single active build and its ledger association; leverage existing storage helpers after verifying that association. Analytics must never rebuild or mutate the journal. Invalid dates, currency, enum values, sorts, or pagination produce structured existing-style 400 errors. Unknown query parameters must not accidentally activate filters.

## Loading, errors, and missing data

Reserve KPI/chart space while loading and announce completion context without shifting focus. Initial no-build state explains that import/rebuild is needed and links to the existing workflow. An empty filtered scope shows a Reset filters action. Show unavailable metrics and coverage explanations, not fabricated zero results. Requests support retry on failure; stale results must not appear under newly selected filter labels. Stale build results remain inspectable with the existing build warning. Export and print controls communicate loading/disabled state where applicable.

## Acceptance and verification

1. All three routes, active tabs, deep links, preserved filters, browser back, and existing Agent/Journal/Transactions routes work.
2. Synthetic 679-closed-strategy data with 481 positive and 198 negative values produces 70.84% win rate. Nineteen open/partially closed strategies affect only the current open count; a separate missing-P&L case verifies coverage.
3. More than 100 strategies/executions contribute to totals and exports. Pagination affects only details.
4. Decimal edge cases, signed fees/credits, zero, null, no losses, no winners, breakeven, mixed currencies, estimated allocations, unknown close dates, unresolved strategies, and incomplete reconstructed evidence follow the metric contract.
5. Opening before the period and closing within it attributes full strategy P&L once to the close date. Transaction-period cashflow remains independently scoped. Repeated imports and supporting lots do not inflate counts.
6. Every strategy appears once in attribution, including multi-underlying/unknown cases; grouped P&L reconciles to the headline result for the same scope and basis.
7. Chart and metric drill-down totals reconcile to full-scope detail results, with build changes identified explicitly. Switching filters cannot display old values under new labels.
8. Reports match Overview/Analysis for identical filters. Printed reports show provenance/coverage, and full-scope CSV exports preserve exact money and protect textual cells from formula execution.
9. Verify at 375px, 768px, and desktop widths; light/dark themes; keyboard-only operation; chart table alternatives; reduced motion; loading, empty, partial, stale, and error states; and browser print preview.
10. Run the repository lint, typecheck, relevant unit/integration tests, build, and focused Playwright coverage for routes, filters, drill-down, and exports. No live broker data or AI model is required.

## Explicit limits

No live market feed, order entry, unrealized valuation, FX conversion, account-equity reconstruction, historical open-position snapshots, AI-generated claims, scheduled delivery, or provider-backed PDF generation. The dense Analysis direction remains an analytics workspace. The unlabeled -140.60 is omitted until its meaning is supplied.
