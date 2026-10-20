import type { Store } from "../storage/database.js";
import { type Decision, effectiveDecisions, readDecisions } from "./service.js";

export interface DecisionHistoryQuery {
  kind?: string | undefined;
  strategyId?: string | undefined;
  lifecycleId?: string | undefined;
  campaignId?: string | undefined;
  importId?: string | undefined;
  offset: number;
  limit: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function references(decision: Decision) {
  const strategy = new Set(decision.strategyIds),
    lifecycle = new Set<string>(),
    campaign = new Set<string>();
  const imports = new Set(decision.sources.map((s) => s.importId));
  const add = (set: Set<string>, value: unknown) => {
    if (typeof value === "string") set.add(value);
  };
  const many = (set: Set<string>, value: unknown) => {
    if (Array.isArray(value)) for (const item of value) add(set, item);
  };
  const allocation = (value: unknown) =>
    add(strategy, record(value).strategyId);
  const source = (value: unknown) => add(imports, record(value).importId);
  const p = decision.payload;
  switch (decision.kind) {
    case "notes":
    case "stop_loss":
    case "manual_allocation":
    case "group_explicit":
      add(strategy, p.strategyId);
      source(p.source);
      break;
    case "identity_binding":
      source(p.source);
      break;
    case "group_merge":
      add(strategy, p.chosenStrategyId);
      many(strategy, p.mergedStrategyIds);
      break;
    case "group_split":
      add(strategy, p.parentStrategyId);
      many(strategy, p.childStrategyIds);
      add(strategy, p.notesOwnerStrategyId);
      break;
    case "lifecycle":
      source(p.sourceRef);
      source(p.targetRef);
      break;
    case "import_exclusion":
    case "import_inclusion":
      add(imports, p.importId);
      break;
    case "lifecycle_attachment":
      allocation(p.opening);
      if (Array.isArray(p.targets))
        for (const t of p.targets) add(lifecycle, record(t).lifecycleId);
      break;
    case "lifecycle_membership":
      if (Array.isArray(p.assignments))
        for (const a of p.assignments) {
          const item = record(a);
          add(lifecycle, item.lifecycleId);
          allocation(item.allocation);
        }
      break;
    case "lifecycle_attachment_rejection":
      allocation(p.callOpening);
      many(lifecycle, p.candidateLifecycleIds);
      break;
    case "wheel_campaign":
      add(campaign, p.campaignId);
      break;
    case "wheel_campaign_membership":
      add(lifecycle, p.lifecycleId);
      add(campaign, p.campaignId);
      break;
  }
  return { strategy, lifecycle, campaign, imports };
}

export function selectDecisionHistory(
  store: Store,
  watermark: number,
  query: DecisionHistoryQuery,
) {
  const all = readDecisions(store, watermark);
  const effective = new Set(effectiveDecisions(all).map((d) => d.id));
  const superseders = new Map<string, string>();
  for (const d of all)
    if (d.supersedesId !== null) superseders.set(d.supersedesId, d.id);
  const rows = all
    .filter((d) => {
      if (query.kind && d.kind !== query.kind) return false;
      const refs = references(d);
      return (
        (!query.strategyId || refs.strategy.has(query.strategyId)) &&
        (!query.lifecycleId || refs.lifecycle.has(query.lifecycleId)) &&
        (!query.campaignId || refs.campaign.has(query.campaignId)) &&
        (!query.importId || refs.imports.has(query.importId))
      );
    })
    .reverse()
    .map((d) => ({
      ...d,
      effective: effective.has(d.id),
      supersededBy: superseders.get(d.id) ?? null,
    }));
  return {
    items: rows.slice(query.offset, query.offset + query.limit),
    total: rows.length,
  };
}
