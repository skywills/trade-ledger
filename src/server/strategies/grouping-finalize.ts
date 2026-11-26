import { Decimal } from "decimal.js";
import type {
  Allocation,
  Id,
  Projection,
  Strategy,
} from "../../shared/domain.js";
import { groupBy } from "../../shared/group-by.js";
import type { Link } from "./grouping-common.js";
import type { GroupingContext } from "./grouping-context.js";
import { presentationMergeResolver } from "./presentation-merges.js";
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
  links: readonly Link[],
): Projection {
  const { ledger, drafts, orderedDecisions, issues, addIssue } = context;
  const safeFinalId = presentationMergeResolver(
    drafts,
    orderedDecisions,
    (group, scope) => {
      const issue = makeIssue(
        "INCOMPATIBLE_STRATEGY_MERGE",
        group.flatMap((d) => d.legs.flatMap((l) => l.sources)),
        "error",
        scope,
      );
      addIssue(issue);
      for (const draft of group) pushDraftIssue(draft, issue);
    },
  );

  const consolidated = new Map<Id, StrategyDraft>();
  const combined = new Set<Id>();
  for (const draft of drafts.values()) {
    const targetId = safeFinalId(draft.id);
    let container = consolidated.get(targetId);
    if (container === undefined) {
      container = emptyDraft(targetId);
      consolidated.set(targetId, container);
    } else combined.add(targetId);
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

  // A presentation merge can bring several parts of the same execution
  // onto one strategy. Persist a single financial allocation for that key.
  const allocations: Allocation[] = [...consolidated.values()]
    .flatMap((draft) => {
      if (!combined.has(draft.id)) return draft.allocations;
      const groups = groupBy(draft.allocations, (a) =>
        JSON.stringify([a.executionKey, a.role]),
      );
      return [...groups.values()].flatMap((parts) => {
        const first = parts[0];
        if (!first || parts.length === 1) return parts;
        const sum = (field: "quantity" | "netCash" | "brokerPnl") =>
          parts
            .reduce((n, p) => n.plus(p[field] ?? 0), new Decimal(0))
            .toFixed();
        const estimated = parts.some((p) => p.pnlEstimated);
        return [
          {
            ...first,
            quantity: sum("quantity"),
            netCash: sum("netCash"),
            brokerPnl: parts.some((p) => p.brokerPnl === null)
              ? null
              : sum("brokerPnl"),
            pnlEstimated: estimated,
            pnlAttribution: estimated
              ? ("estimated" as const)
              : parts.some((p) => p.pnlAttribution === "basis-reconciled")
                ? ("basis-reconciled" as const)
                : first.pnlAttribution,
          },
        ];
      });
    })
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
