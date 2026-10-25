# Batch connection review

Approved in conversation: group pending connections by underlying and show their dates oldest first. Select multiple connections and either connect them to one shared share lifecycle or keep them separate. Earlier related connections must be resolved or included. Save decisions sequentially, refresh and validate after every save, and stop on failure with completed and remaining items visible.

## Approaches

Use the existing preview, decision and rebuild APIs sequentially (chosen): preserves chronology, coverage and concurrent-change checks. A combined server mutation would require broader changes to the decision flow and is outside this change.

## Constraints

Keep contract-level individual review available. Never combine accounts or currencies in one batch. Preserve request IDs on retries and avoid resaving acknowledged decisions after rebuild failures. Do not infer a successful decision from a disappearing suggestion. Batch preview shows the selected trades, common target and chronological order; each item receives a fresh server validation before saving. Existing decision history remains the audit trail.

Implementation ruling: selected contracts with interleaved opening fills are saved in one decision when they depend on each other. This avoids a dependency deadlock while keeping complete source partitions and closes intact. Independent later connections still use separate chronological decisions; the server validates each decision normally.
