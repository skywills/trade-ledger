# Review attribution and duplicate presentation

## Scope and evidence
The live review queue has two discrepancies, each emitted at strategy and lifecycle scope. Strategy findings have empty source references; ReviewPage identifies lifecycles through source overlap, resulting in two blank rows. This fix can ship independently of futures accounting.

## Behavior
Add optional typed reconciliation context to Issue: owner references, exact affected allocation slices, and both compared amounts/currency. Populate it at both accounting emitters, including source references. Persist context in the existing review_items.candidate_json under a versioned reconciliation property; old {} values remain valid. Preserve stable issue keys and underlying issue records for chat diagnostics.

Consolidate only the Review page's presentation, before pagination on the server. Two findings combine only when code, severity, currency, broker and reconstructed amounts, and the complete canonical multiset of allocation slices match. A slice is executionKey, role, signed quantity and allocated net cash. Do not merge on source overlap alone. Union owner references, sources and underlying issue keys. Keep unrelated codes and missing-context legacy findings separate. The canonical displayed key is the lexicographically first underlying key, so existing chat issue lookup still works.

Return grouped review entries with underlying issueKeys and explicit owners. Display lifecycle and strategy links under Affected items, with IDs as fallback labels. If no owner exists, show Unattributed issue rather than a blank cell. No source-overlap inference for new contextual findings. Legacy findings retain existing best-effort inference. Details show both amounts and their signed difference without claiming a cause. Existing chat tools continue listing/diagnosing raw stable issues; expose context without silently changing their issue-key contract. Review's Ask Agent action supplies all underlying issue keys.

A grouped review result is a read model, not a rewrite of accounting evidence. Total counts and pagination reflect grouped entries. Old builds need a rebuild to receive new context; no fabricated historical attribution. Increment the current build algorithm version (once per combined release if both fixes ship together).

## Acceptance
Four fixture issues become two actionable rows with both owners and sources. A strategy/lifecycle pair covering different allocations remains separate even with the same source rows. Existing issue keys remain diagnosable. Missing-context records remain readable. Cross-build lifecycle data cannot supply incorrect labels or links.

## Global constraints
- Preserve imported source values, decisions, signed allocation quantities, and allocated net cash.
- Use decimal.js and decimal strings; never JavaScript number arithmetic for money.
- Do not substitute broker P&L for independently reconstructed P&L.
- Do not increase reconciliation tolerance or suppress the unexplained SOFI discrepancy.
- No new dependencies. No production database writes, deployment, or rebuild during plan execution.
- Preserve existing non-futures accounting and assignment/exercise completeness guards.
