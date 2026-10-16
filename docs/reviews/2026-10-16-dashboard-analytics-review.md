# Dashboard analytics review and verification

Date: 2026-10-16
Branch: feat/dashboard-analytics
Reviewed range: 12f5ce5..ea96054, followed by one regression-tested fix pass.

One independent fresh-context reviewer assessed the implementation as With fixes. No Critical findings or declined-to-judge items were reported. The author accepted all six Important findings and re-graded the exact-table precision finding as Important because rounding a non-zero amount to zero obscured its outcome classification. No second review was requested; each fix was verified through a failing regression and the complete green suites.

| Finding | Correction and regression |
| --- | --- |
| Export replaced a saved detail's expected build | Preserve the URL build constraint until explicit refresh; browser test `saved detail export preserves the old build until explicit refresh`. |
| Top-level view switches retained hidden detail filters in exports | Overview/Reports clear detail-only state while preserving shared filters; unit test `clears detail-only scopes when leaving Analysis while retaining membership filters`. |
| Chart sampling could bridge a second missing bucket | Carry a break flag whenever the original interval contains missing data; unit test `retains a break for every omitted missing bucket between sampled extrema`. |
| Excluded/estimated data was not disclosed in the normal dashboard | Shared notices expose unknown-date/unresolved inspection links and estimated/unallocated counts; browser test `shared quality notices disclose and link excluded strategy scopes`. |
| Printed reports omitted membership filters | Render symbol, underlying, strategy type, and asset class in printable context; browser test `printed reports identify every active membership filter`. |
| Export 409 recovery required a browser reload | Add explicit refresh that reloads the summary and clears old detail build constraints; browser test `export build conflict has a refresh action that reloads the summary`. |
| Exact-data table rounded source precision | Display original decimal strings in the inspection table, retaining currency formatting elsewhere; browser test `chart data tables preserve non-zero amounts smaller than a currency minor unit`. |

Final verification: 405/405 unit/integration tests (39 files), 45/45 browser tests, lint/typecheck, production build/server health/migrations/shutdown smoke, and git diff whitespace checks passed. Five repository lint warnings and 25 informational diagnostics predate this feature; new analytics modules/tests are lint-clean. Light/dark responsive views and a generated multi-page PDF were inspected. No live broker or AI service was used.

No deferred minor findings remain. Implementation and fixes are committed locally; no merge, push, or publication has been performed.

## Execution decisions

- Ruling: Use the managed worktree and reuse existing node_modules by symlink — native tools own isolation; avoids dependency/network churn — cost if wrong: reinstall dependencies.
- Task 2: Ruling: Numeric sorting and group-key availability checks live with Task 4 detail selection rather than scope construction — they only apply to detail queries — cost if wrong: validation location refactor, no metric change.
- Task 10: Ruling: The real >100-record acceptance fixture uses stock roundtrips in separate synthetic accounts rather than concurrent same-symbol/different-conid positions in one account — existing grouping deliberately marks the latter ambiguous — cost if wrong: fixture realism only, aggregation assertions remain unchanged.
- Task 10: Ruling: Real-import browser acceptance uses an isolated compiled server and temporary database — full-suite execution exposed the legacy journal file's shared-server empty-state dependency — cost if wrong: test infrastructure only; no production behavior changes.
- Final: Ruling: Re-grade exact-table rounding from Minor to Important — presenting a non-zero financial result as zero in the inspection table obscures why it counts as a win — cost if wrong: a display-format choice only; headline currency formatting is unchanged.
