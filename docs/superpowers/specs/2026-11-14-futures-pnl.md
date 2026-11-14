# Futures reconstruction correction

## Scope and evidence
The approved planning scope is the accounting correction discussed in this conversation. Both strategy and lifecycle accounting currently equate closed-position net cash with reconstructed P&L. Live build d58dd62a, watermark 56, confirms futures net cash contains trade MTM rather than full round-trip proceeds. Two spreads each have proceeds 25 and commissions -10.542020364, yielding independent P&L 14.457979636 versus broker 14.45798. Their net cash totals are -5.542 and 14.458 respectively. The latter agreement is coincidental.

SOFI's opening/closing cash yields 86.5536102 versus broker 86.53261. Closing cash plus closing basis still differs by 0.021. Preserve that warning; no evidence proves a price-rounding cause.

## Behavior
For otherwise eligible closed groups containing ordinary FUT trades, calculate the FUT contribution from signed source proceeds plus commission plus taxes, scaled by allocated signed quantity/source signed quantity. Futures contracts must each balance to zero; account and currency must match. Missing proceeds or commission makes reconstruction unavailable. Null taxes contribute zero only for this existing import representation, where omitted Taxes is not reported; explicit taxes are included. Invalid source decimals remain governed by import quarantine. Never derive missing proceeds from rounded price or infer a multiplier.

Non-FUT contributions retain allocated net cash; existing event/completeness safeguards still apply. FUT non-trade events are unsupported for this calculation and produce unavailable reconstruction. Cashflow and openingAmount retain their existing cash semantics. A shared helper returns method and reason metadata internally; unavailable results add FUTURES_PNL_UNAVAILABLE to owning strategy/lifecycle reasons. No new stored amount or public schema is needed for this bounded fix.

Use source-proportional amounts at decimal.js precision and do not round intermediate values to display cents. Test partial partitions and conservation within the existing decimal precision policy. Reconciliation continues using current currency tolerance and existing broker-basis behavior for other assets.

## Acceptance
Both futures fixtures reconstruct 14.457979636 in strategies and lifecycles; source net cash remains unchanged. The option fixture still emits PNL_RECONCILIATION. Incomplete evidence yields null and a reason, never a plausible cash-based result. Analytics receives the corrected existing reconstructedPnl field. Increment the current build algorithm version so old builds become stale; rebuild only a temporary test store.

## Global constraints
- Preserve imported source values, decisions, signed allocation quantities, and allocated net cash.
- Use decimal.js and decimal strings; never JavaScript number arithmetic for money.
- Do not substitute broker P&L for independently reconstructed P&L.
- Do not increase reconciliation tolerance or suppress the unexplained SOFI discrepancy.
- No new dependencies. No production database writes, deployment, or rebuild during plan execution.
- Preserve existing non-futures accounting and assignment/exercise completeness guards.
