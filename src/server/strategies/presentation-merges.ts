import type { Decision, Id } from "../../shared/domain.js";

/** Final presentation owner for every original strategy, including chained and incompatible merges. */
export function presentationMergeResolver<
  T extends { id: Id; account: string; currency: string },
>(
  drafts: ReadonlyMap<Id, T>,
  decisions: readonly Decision[],
  onIncompatible?: (group: T[], scope: string) => void,
): (id: Id) => Id {
  // 8. User merges change presentation only: every allocation stays unique.
  const remap = new Map<Id, Id>();
  for (const decision of decisions) {
    if (decision.kind !== "group_merge") continue;
    const chosen = decision.payload.chosenStrategyId;
    const merged = decision.payload.mergedStrategyIds;
    if (typeof chosen !== "string" || !Array.isArray(merged)) continue;
    for (const mergedId of merged) {
      if (typeof mergedId !== "string") continue;
      const sourceDraft = drafts.get(mergedId);
      if (sourceDraft === undefined) continue;
      const chosenDraft = drafts.get(chosen);
      if (
        chosenDraft !== undefined &&
        (chosenDraft.account !== sourceDraft.account ||
          chosenDraft.currency !== sourceDraft.currency)
      ) {
        onIncompatible?.([sourceDraft, chosenDraft], `${chosen}:${mergedId}`);
        continue;
      }
      remap.set(mergedId, chosen);
    }
  }
  if (remap.size === 0) return (id: Id) => id;
  const finalId = (id: Id): Id => {
    let current = id;
    const seen = new Set<Id>();
    while (remap.has(current) && !seen.has(current)) {
      seen.add(current);
      current = remap.get(current) ?? current;
    }
    return current;
  };

  // Validate each transitive merge target before consolidating any amounts.
  // A retained decision can name a chosen ID that has no current draft, so
  // checking only the immediate chosen/merged pair is not sufficient.
  const draftsByMergeTarget = new Map<Id, T[]>();
  for (const draft of drafts.values()) {
    const targetId = finalId(draft.id);
    const group = draftsByMergeTarget.get(targetId) ?? [];
    group.push(draft);
    draftsByMergeTarget.set(targetId, group);
  }
  const safeTargets = new Map<Id, Id>();
  for (const [targetId, group] of draftsByMergeTarget) {
    const dimensions = new Set(
      group.map((draft) => `${draft.account}\u0000${draft.currency}`),
    );
    if (dimensions.size <= 1) {
      for (const draft of group) safeTargets.set(draft.id, targetId);
      continue;
    }
    onIncompatible?.(group, targetId);
    for (const draft of group) safeTargets.set(draft.id, draft.id);
  }
  return (id: Id): Id => safeTargets.get(id) ?? finalId(id);
}
