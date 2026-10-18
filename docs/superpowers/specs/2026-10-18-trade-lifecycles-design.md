# Trade lifecycles and wheel campaigns

Status: reviewed for implementation on 2026-10-18; user authorized implementation on a feature branch.

## Intent and agreed behavior

The journal should answer whether an entire trading idea made money, including its transition from options into assigned stock and subsequent covered calls. Assignment is a change of exposure, not a win or loss. Preserve original strategies and executions for audit and analysis.

The user agreed to one win/loss result per completed lifecycle and an optional wheel campaign grouping multiple cycles. Examples:

- Bull put spread → assignment → stock sale: one lifecycle.
- Bull put spread → assignment → repeated covered calls → stock sale/call-away: one lifecycle, including any retained long put.
- Short put → assignment → repeated covered calls → call-away: one wheel cycle.
- Short put closed or expired without assignment: a completed cycle.
- Another put opened after a completed cycle: a new lifecycle within the same campaign.

Implementation choices below are proposed defaults, particularly quantity matching, roll behavior, valuation, and historical migration.

## Current code and constraints

- `src/shared/domain.ts` defines strategies, execution allocations, and strategy links, but no lifecycle or campaign.
- `src/server/strategies/grouping.ts` links assignment/exercise through `PositionActionID`; it does not combine option and stock P&L.
- `src/server/strategies/accounting.ts` intentionally withholds reconstructed strategy P&L for assignment/exercise/basis-transfer executions.
- `src/server/builds/service.ts:computeProjection` groups, remaps durable strategy IDs, then accounts strategies. Builds are persisted and activated atomically.
- `src/server/analytics/` measures closed strategies; analytics, drills, charts, and exports share an active-build snapshot.
- Retained, supersedable decisions already support corrections and replay.
- There is no market-price feed in the current model. Execution prices are historical fills, not current marks.

## Approaches considered

1. **Add lifecycle projection above strategies (recommended).** Preserve audit records, attach quantity slices, and switch performance to lifecycle results. More explicit data, but supports partial assignments and concurrent trades correctly.
2. Merge all related strategies into one strategy. Smaller conceptual change initially, but loses original strategy identity and makes overlapping stock/call quantities hard to separate.
3. Group by symbol at report time. Easy to display, but incorrectly combines independent trades and creates inconsistent drill-downs and win rates.

## Architecture

`ledger → strategy grouping/accounting → lifecycle membership/accounting → persisted active build → journal/analytics/export`

A campaign is a user-selected organizational parent. A lifecycle owns economic exposure and its outcome. A strategy describes an existing component. An execution allocation remains the source of truth for quantities, cash, and broker P&L.

Use new focused modules under `src/server/lifecycles/`; do not expand the large strategy grouper into a second accounting engine. Existing strategy-level P&L restrictions stay intact.

## Identity and membership

- Lifecycle identity is anchored to the originating opening execution and account; it survives new imports, rebuilds, and covered-call additions. Campaign identity comes from a retained user decision.
- Membership references `(strategyId, executionKey, allocationRole)` and a signed quantity slice. Store apportioned `netCash` and nullable `brokerPnl`, with source references and estimated flags.
- Each source allocation is partitioned exactly once across lifecycle members. Sum of member quantities and amounts must equal the source allocation; use Decimal and the existing deterministic remainder allocation conventions.
- Do not duplicate cash or P&L when splitting one stock sale across two lifecycles. Shares used for call coverage are reserved, not duplicated as new stock acquisitions.
- Never connect different accounts, currencies, or incompatible underlying instruments. Symbol text alone is insufficient evidence.
- Preserve source anchors when presentation groups are merged or corrected. Missing anchors generate a review issue rather than silently moving a decision.

## Linking and quantity rules

1. Seed one lifecycle per originating strategy; incomplete/orphan records remain visible as unresolved lifecycles.
2. Use validated assignment/exercise evidence to attach the resulting stock quantity to the originating option lifecycle. Account for contract multiplier and put/call direction.
3. Show a covered-call attachment suggestion when the same account/currency/underlying has sufficient unreserved long shares at call opening. Confirm through a retained decision before attachment; this also avoids guessing trading intent.
4. Multiple eligible stock lots/lifecycles require an explicit quantity choice. Never infer the oldest holding merely because it shares a ticker.
5. A call spanning multiple lifecycles can be split explicitly into contract quantity slices, with quantities/amounts conserved. Unsupported fractional-contract splits are rejected.
6. Track overlapping short calls chronologically. Expiry or buyback releases reserved shares. Call assignment consumes the associated stock through broker evidence, not a second manual stock-sale record.
7. Partial stock sales keep the lifecycle open while any shares or options remain. If stock is sold before its call closes, keep the call and show that it is no longer fully covered.
8. Put/call rolls are retained as separate strategies but stay in one lifecycle when an existing validated roll link establishes continuity before that lifecycle reaches flat exposure. The roll must not generate an intermediate closed result. Independent orders after flat exposure start new cycles; manual correction is available.
9. The remaining protective put is retained until sold, expired, or exercised. A lifecycle cannot close just because the short put and stock have closed.
10. Pending covered-call suggestions with plausible lifecycle continuity block final lifecycle eligibility until accepted or explicitly rejected. Rejection records that the call is independent; it is not a hidden disappearance of a review issue.

## State and completion

Store `status = open | closed | unresolved`, separately from the current stage and completeness.

Stages: `options`, `assigned_stock`, `covered_call`, `closed`. Preserve `originStrategyType`, such as `bull_put_spread` or `short_put`; the current stage does not replace it.

- Assignment transitions to assigned stock; adding a confirmed covered call changes the stage.
- A partial close does not create another win/loss observation.
- Closed means every member instrument quantity is zero, linked continuations are resolved, and a valid final event date is known.
- Unresolved evidence blocks eligibility even if observed quantities happen to net to zero.
- Closed but financially incomplete records are shown as closed with P&L unavailable, excluded from the eligible denominator.
- New activity after a completed flat cycle starts a new lifecycle, even inside the same campaign.

## Accounting and valuation

### Closed result

For complete, flat lifecycles with all cash legs present:

`reconstructedPnl = sum(member.netCash)`

This includes option premiums/buybacks, assignment/exercise stock cash, stock disposal proceeds, commissions, and taxes already represented in net cash. Do not subtract those fees a second time. Assignment option cash and corresponding stock cash must each be represented exactly once. Do not add a reported cost basis to cashflow.

This permission is lifecycle-specific: do not remove the existing strategy-level basis-transfer safeguard. Missing opening history, unmatched stock transfers, quarantined relevant evidence, or unresolved cash treatment makes reconstructed P&L unavailable.

`brokerPnl` sums the underlying apportioned broker amounts once, using allocation-level coverage rather than summing strategy totals. A null assignment/expiry amount can only count as non-reportable when broker/lot evidence establishes where the realized basis was booked; never blanket-convert nulls to zero. Otherwise broker P&L remains unavailable. Reconcile complete broker and reconstructed results within existing currency tolerances; surface mismatches for review.

Examples, amounts already net of fees:

- Spread credit 200 + assigned stock purchase -10,000 + stock sale 9,650 - separately booked fee 10 = -160.
- Put premium 200 + stock purchase -10,000 + covered-call premium 100 + call-away proceeds 10,500 = 800.

Outcome is positive/win, negative/loss, zero/breakeven; unavailable remains unavailable. Do not use mark-to-market values in win-rate eligibility.

### Open display

Display cashflow separately from profit. Display broker-reported realized P&L only with known coverage, preserving estimated flags; missing reported amounts are unavailable.

Provide optional manual valuation snapshots as retained decisions, not a live quote integration. Each snapshot contains account, currency, as-of timestamp, and nonnegative instrument prices. Require a mark for every remaining instrument and known option multipliers; never substitute the last fill or zero. All marks in a valuation share the same as-of timestamp, which must be at or after the latest included execution and not in the future.

For a complete lifecycle and complete marks:

`totalPnl = cumulative net cash + sum(signed remaining quantity × multiplier × mark)`

Stock multiplier is one. Option multiplier must come from instrument evidence. This is a marked estimate before future exit costs, labeled with date and source.

If broker-realized coverage is complete, display `unrealizedPnl = totalPnl - realizedBrokerPnl` as the residual to broker-realized P&L. Label the basis explicitly; do not claim an independently reconstructed tax-lot unrealized amount. When the decomposition is unavailable, total can still be available with realized/unrealized unavailable.

No mark means valuation unavailable, not zero. Manual marks do not affect closed outcomes. Importing dividends, interest, borrowing charges, FX conversions, live prices, and a tax-lot reconstruction engine are outside this enhancement; disclose that totals cover the retained execution cashflows.

## Wheel campaigns

- Explicitly create/name a campaign and attach lifecycles through retained decisions; do not infer a wheel solely from a short put or repeated ticker.
- Campaign scope is one account, currency, and underlying. Multiple overlapping cycles are allowed.
- Each lifecycle belongs to at most one campaign. A campaign has no separate win/loss vote.
- Show completed cycle count, open cycle count, eligible/missing count, completed-cycle P&L, and known open valuations separately. Do not present a partial sum as a complete campaign total.
- Campaign win rate is calculated from its eligible completed lifecycles; it is not added again to global lifecycle counts.

## Analytics and user flows

- Introduce `unit=lifecycle|strategy`; lifecycle is the new default. Keep an explicitly labeled strategy/component view for compatibility and investigation.
- Preserve the existing P&L `basis=broker|reconstructed` choice and broker default. No silent fallback between bases. A reconstructed lifecycle result may be available while broker result is missing.
- Standalone trades appear as one-member lifecycles, so all trades still participate.
- Lifecycle performance uses final lifecycle close date; cash activity remains attributed to execution date. Label charts “Completed lifecycle P&L” to avoid implying every premium was earned on the final date.
- Attribute lifecycle strategy breakdown to its origin strategy type. Component filters must not clip lifecycle membership or cash; underlying/account/currency identify whole lifecycles. Asset-class filtering matches any member and includes the complete result, with “contains asset class” copy.
- Summary, breakdowns, best/worst/recent, daily/monthly charts, detail counts, pagination, URL state, and CSV must use the same unit, basis, filters, and build ID.
- Lifecycle detail shows origin, current stage, event timeline, holdings, covered/uncovered share quantities, components, source rows, P&L availability/reasons, and valuation source/date.
- Review supports accepting/rejecting/splitting attachment suggestions and correcting membership through superseding decisions. Show effects before saving.
- Campaign detail lists its cycles and totals. Journal strategy detail links to related lifecycles without overwriting existing strategy notes.

## Persistence and rollout

- Add migration `006_trade_lifecycles.sql` with lifecycle/campaign identities and build-scoped lifecycle, membership, suggestion, and campaign views. Store exact decimals as TEXT; foreign keys tie memberships to the same build's source allocation.
- Persist/read lifecycle data in the same build transaction and snapshot as strategies. Failed/stale rebuilds cannot publish mixed generations.
- Advance projection algorithm version and treat pre-lifecycle active builds as needing rebuild. Historical builds remain readable; do not synthesize misleading new metrics from absent rows.
- Replay retained linking, campaign, and valuation decisions. Preserve supersession and idempotency behavior. New decisions must participate in current watermark/staleness checks.
- Existing imports do not need re-uploading. Rebuild generates lifecycles; suggest uncertain covered-call attachments for review. Dashboard states that historical win rates change because the counting unit changed.
- Backup/restore includes new tables via the existing database backup mechanism; verify restore and rebuild behavior.

## Acceptance scenarios

1. Complete ordinary spread: same P&L, one closed lifecycle.
2. Assigned spread with shares held: open, no win/loss.
3. Assigned spread then stock sold: one result, not spread plus stock.
4. Stock sold while long put remains: open until the put closes/expires.
5. Assigned stock with several calls expiring/bought back: open, premiums retained in the same lifecycle.
6. Call-away with all legs flat: one completed lifecycle with every cash leg once.
7. Unassigned put expiry/buyback: one completed wheel cycle.
8. Second put after completion: separate cycle, same explicit campaign.
9. Partial assignment/sales and shared executions: conserved quantities, no duplicate cash/P&L.
10. Concurrent same-stock lifecycles/unrelated holdings: explicit call attribution and no excess share coverage.
11. Missing history/basis reporting/marks: unavailable with reasons; no invented zero or outcome.
12. Reimports, superseded links, presentation merges, rebuilt projections, restart, and restore preserve identities and correct results.
13. Every dashboard drill/export matches the selected unit and basis; campaign totals do not double count cycles.
14. Complete marks produce total P&L; missing option marks or multipliers do not. Expired options are zero exposure only after a retained closing/expiry event.

## Delivery boundary

The accompanying implementation plan is a review draft requested by the user. Review these proposed defaults before product implementation. Do not automatically commit, open a PR, or execute the plan as part of planning.

## Implementation review decisions

- Lifecycle origins are computed before presentation-only strategy merges. Source quantity slices are then mapped to the final build's allocation references, preserving lifecycle identities and original assignment/roll links.
- Covered-call attachment is a retained opening-slice intent. Later closes follow it when whole contracts can be attributed. A partial close that would create fractional contracts across cycles remains unresolved until an explicit closing quantity partition is recorded.
- Known conflicting stock contracts cannot be combined by display symbol. Same-symbol multiple stock contracts suppress automatic covered-call suggestions rather than certify compatibility.
- Keep the existing performance-row `kind=strategies` / `dataset=strategies` API with explicit `unit=lifecycle|strategy` semantics throughout responses, drills, links, and exports.
- Ledger errors/conflicts conservatively withhold reconstructed lifecycle results and open marked totals when relevant completeness cannot be established. Broker-reported values retain their own coverage flags.
- There is no heuristic for interpreting missing broker assignment P&L as zero. Reconstructed cashflow results remain separately selectable; additional broker-specific lot evidence can be supported later.
