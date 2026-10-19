import type {
  Allocation,
  Id,
  Projection,
  Strategy,
} from "../../shared/domain.js";
import type { Link, MergeInstruction } from "./grouping-common.js";
import type { GroupingContext } from "./grouping-context.js";
import {
  emptyDraft,
  finalizeDraft,
  makeIssue,
  pushDraftIssue,
  recomputePresentation,
  type StrategyDraft,
} from "./projection.js";

export function finalizeGrouping(
  context: GroupingContext,
  merges: readonly MergeInstruction[],
  links: readonly Link[],
): Projection {
  const { ledger, drafts, orderedDecisions, issues, addIssue } = context;
  // 8. User merges change presentation only: every allocation stays unique.
  const remap = new Map<Id, Id>();
  for (const { chosen, merged } of merges) {
    for (const mergedId of merged) {
      const sourceDraft = drafts.get(mergedId);
      if (sourceDraft === undefined) continue;
      const chosenDraft = drafts.get(chosen);
      if (
        chosenDraft !== undefined &&
        (chosenDraft.account !== sourceDraft.account ||
          chosenDraft.currency !== sourceDraft.currency)
      ) {
        const issue = makeIssue(
          "INCOMPATIBLE_STRATEGY_MERGE",
          [...sourceDraft.legs, ...chosenDraft.legs].flatMap(
            (leg) => leg.sources,
          ),
          "error",
          `${chosen}:${mergedId}`,
        );
        addIssue(issue);
        pushDraftIssue(chosenDraft, issue);
        pushDraftIssue(sourceDraft, issue);
        continue;
      }
      remap.set(mergedId, chosen);
    }
  }
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
  const draftsByMergeTarget = new Map<Id, StrategyDraft[]>();
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
    const issue = makeIssue(
      "INCOMPATIBLE_STRATEGY_MERGE",
      group.flatMap((draft) => draft.legs.flatMap((leg) => leg.sources)),
      "error",
      targetId,
    );
    addIssue(issue);
    for (const draft of group) {
      safeTargets.set(draft.id, draft.id);
      pushDraftIssue(draft, issue);
    }
  }
  const safeFinalId = (id: Id): Id => safeTargets.get(id) ?? finalId(id);

  const consolidated = new Map<Id, StrategyDraft>();
  for (const draft of drafts.values()) {
    const targetId = safeFinalId(draft.id);
    let container = consolidated.get(targetId);
    if (container === undefined) {
      container = emptyDraft(targetId);
      consolidated.set(targetId, container);
    }
    if (container.account === "") container.account = draft.account;
    if (container.currency === "") container.currency = draft.currency;
    container.legs.push(...draft.legs);
    container.openingLegs.push(...draft.openingLegs);
    for (const allocation of draft.allocations) {
      container.allocations.push({ ...allocation, strategyId: targetId });
    }
    for (const issue of draft.issues) pushDraftIssue(container, issue);
    container.unresolved = container.unresolved || draft.unresolved;
    container.blocking = container.blocking || draft.blocking;
    container.complete = container.complete && draft.complete;
    if (
      draft.openingDate !== null &&
      (container.openingDate === null ||
        draft.openingDate < container.openingDate)
    ) {
      container.openingDate = draft.openingDate;
    }
  }

  const finalLinks: Link[] = [];
  const finalLinkKeys = new Set<string>();
  for (const link of links) {
    const from = safeFinalId(link.from);
    const to = safeFinalId(link.to);
    if (from === to) continue;
    const key = `${from}|${to}|${link.type}`;
    if (finalLinkKeys.has(key)) continue;
    finalLinkKeys.add(key);
    finalLinks.push({ from, to, type: link.type, sources: link.sources });
  }

  const strategies: Strategy[] = [];
  for (const draft of [...consolidated.values()].sort((left, right) =>
    left.id < right.id ? -1 : 1,
  )) {
    recomputePresentation(draft);
    strategies.push(finalizeDraft(draft));
    for (const issue of draft.issues) addIssue(issue);
  }

  const allocations: Allocation[] = [...consolidated.values()]
    .flatMap((draft) => draft.allocations)
    .sort((left, right) =>
      `${left.strategyId}|${left.executionKey}` <
      `${right.strategyId}|${right.executionKey}`
        ? -1
        : 1,
    );

  const watermark = orderedDecisions.reduce(
    (max, decision) => Math.max(max, decision.sequence),
    0,
  );

  return {
    ledgerId: ledger.id,
    watermark,
    strategies,
    allocations,
    links: finalLinks,
    issues: [...issues.values()].sort((left, right) =>
      left.key < right.key ? -1 : 1,
    ),
  };
}
