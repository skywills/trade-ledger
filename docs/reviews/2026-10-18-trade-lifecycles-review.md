# Trade lifecycles implementation review

Implemented on `feature/trade-lifecycles` from `main`, following the reviewed design and nine-task plan. Independent workers implemented reporting and screens; an independent reviewer inspected the core and then the complete change. This report records the disposition after the implementation's fix pass; it does not claim that a second independent approval was obtained after those fixes.

## Review findings and fixes

| Finding | Resolution and regression evidence |
| --- | --- |
| Presentation merges collapsed lifecycle identities | Group origins before presentation merges, retain original assignment/roll links, and remap/coalesce exact slices to final allocations. Real CSV wheel acceptance preserves identity and USD 800 result after merging. |
| Duplicate opening anchors could fail persistence | Coalesce lifecycle identities and final owner/reference slices; preserve the true originating opening key in identity storage. |
| Invalid retained corrections could partially move members | Replay each correction atomically; restore its entire previous state before recording a review issue. Unit rollback regression covers a valid first replacement followed by invalid target. |
| Chained supersession revived obsolete decisions | Resolve effective history before omitting the superseded target; idempotency and supersession integration tests pass. |
| Long calls offset unrelated short-call reservations | Reserve negative remaining quantities per contract, then sum required shares. |
| Reverse acceptance order or uncertain call times could overbook shares | Revalidate accepted future opening demand; uncertain negative exposure reserves capacity until a release is proven. Known-order and date-only overlap regressions pass. |
| Actual ledger errors were missed by history guards | Conflicts and error severities withhold reconstructed and marked totals; preserve covered broker amounts separately. Tests include real lowercase missing-cash errors. |
| Missing broker reports became zero | Require at least one authoritative amount plus complete closing coverage. All-null reporting remains unavailable. |
| New unrelated marks invalidated another instrument's valuation | Choose an applicable snapshot, without mixing timestamps or substituting historical fills. Timezone uncertainty uses a conservative bound. |
| Manually corrected raw assignment events were ignored | Follow validated source references and use validated links for current-stage presentation. |
| Display symbols hid contradictory stock contracts | Reject known stock identity contradictions, suppress ambiguous suggestions, and reject explicit covered-call attachment when conflicting known stock contracts leave the underlying ambiguous. |
| Real shared stock-sale corrections remained unresolved | An explicit conserved close partition with valid chronological exposure resolves the original orphan matching classification. Real CSV acceptance produces two eligible cycles and USD 1,000 total. Unsupported/conflicting evidence remains blocking. |
| Campaign renames lost existing memberships | Materialize effective campaign definitions before memberships; reject scope changes. Create → attach → superseding rename retains cycle membership. |
| Known open realized P&L was hidden | Render covered broker-realized values from valuation data while open; keep closed broker P&L on its own basis. Open-only valuation rows are hidden after closure. Browser regression verifies known, missing, and differing closed amounts. |
| Partial closing contracts were split fractionally across cycles | Leave indivisible closes for explicit whole-contract quantity review; preview excludes their cash from the amount moving now. Browser coverage verifies the difference. |

## Implementation decisions

- Use the requested feature branch in the existing checkout. This keeps the implementation directly reviewable; no merge or publication is included.
- Verify storage through real build fixtures rather than artificial duplicate persistence setup; storage validation was performed with build integration.
- Preserve missing broker assignment/basis-transfer values as unavailable. No heuristic converts null to zero; reconstructed lifecycle cashflow is independently selectable. This can require selecting reconstructed basis even when a combined cash result is known.
- Keep existing strategy-shaped performance-row endpoints and distinguish them by explicit counting unit throughout filters, results, links and CSV. Clients must use the selected unit for navigation.
- Compute lifecycle origins before presentation merges and remap source slices afterward. This protects economic identity while retaining strategy notes and presentation grouping.
- Retain opening attachment intent so future imports follow ownership. Ambiguous partial closes require explicit quantities; this adds review work rather than inventing fractional contracts.
- Treat ledger errors/conflicts conservatively when their relevance cannot be proven. Some otherwise unaffected results may remain unavailable until evidence is repaired.
- For unzoned/non-UTC source timestamps, require manual valuations to follow the latest possible execution instant. Latest-day marks may remain unavailable without clearer time evidence.

## Verification and limits

The complete Vitest suite passes **585 tests across 53 files**, including real CSV import/build/report acceptance, source correction, campaign replay, and backup/restore/rebuild preservation. The full browser suite passes **64 tests**. Production build/server smoke passes, including SQLite migration packaging, startup health, and SIGTERM shutdown. Lint and typecheck pass; existing repository informational diagnostics and warnings remain.

Broker-specific lot interpretations of missing assignment P&L remain conservative. The retained instrument model has no authoritative option-underlying Conid or adjusted deliverable field; the implementation rejects known contradictions and requires confirmation for compatible covered-call suggestions. It does not certify absent contractual metadata.

Browser tests exercise the compiled UI with controlled API responses; separate real importer/build/API tests cover server behavior. Backup/restore is checked explicitly, but no test claims to enumerate every possible broker report or import-order permutation. Execution-cashflow totals exclude unimported dividends, interest, borrowing charges, and transfers. Manual prices are optional dated estimates before future exit costs, not a live quote feed or tax-lot engine.
