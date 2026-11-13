import type { Instrument } from "../../shared/domain.js";
import type { GroupingContext } from "./grouping-context.js";
import { legWriteCount, type StrategyDraft } from "./projection.js";

interface DraftIndex {
  byKey: Map<string, Set<StrategyDraft>>;
  indexedLegs: Map<StrategyDraft, number>;
  /** Position of each draft in the context's draft order. */
  order: Map<StrategyDraft, number>;
  /** `legWriteCount()` and draft count when the index last caught up. */
  writes: number;
  size: number;
}

const indexes = new WeakMap<GroupingContext, DraftIndex>();

/**
 * `sameInstrument` matches by conid when both sides carry one, otherwise by
 * symbol (plus terms). Any draft that can hold exposure to an instrument
 * therefore has a leg with the same conid or the same symbol, so these keys
 * give an exact superset of the candidates.
 */
function keysOf(instrument: Instrument): string[] {
  const keys = [`s:${instrument.assetClass}:${instrument.symbol}`];
  if (instrument.conid !== null)
    keys.push(`c:${instrument.assetClass}:${instrument.conid}`);
  return keys;
}

function catchUp(context: GroupingContext, index: DraftIndex): void {
  const writes = legWriteCount();
  if (writes === index.writes && context.drafts.size === index.size) return;
  let position = 0;
  for (const draft of context.drafts.values()) {
    index.order.set(draft, position);
    position += 1;
    const seen = index.indexedLegs.get(draft) ?? 0;
    if (seen === draft.legs.length) continue;
    // A shrunken leg list is re-indexed from the start; stale keys only
    // over-include, which is safe.
    const from = seen > draft.legs.length ? 0 : seen;
    for (const leg of draft.legs.slice(from))
      for (const key of keysOf(leg.instrument)) {
        const drafts = index.byKey.get(key) ?? new Set<StrategyDraft>();
        drafts.add(draft);
        index.byKey.set(key, drafts);
      }
    index.indexedLegs.set(draft, draft.legs.length);
  }
  index.writes = writes;
  index.size = context.drafts.size;
}

/**
 * Drafts that may hold the given instrument, in the context's draft order.
 * Close matching otherwise evaluates every draft for every close, which grows
 * quadratically with the journal. The index catches up incrementally with
 * drafts and legs added since the last call (legs are only added through
 * `addLeg`); it only ever over-includes, and callers still evaluate exposure
 * exactly, so results are unchanged.
 */
export function draftsHolding(
  context: GroupingContext,
  instrument: Instrument,
): StrategyDraft[] {
  let index = indexes.get(context);
  if (!index) {
    index = {
      byKey: new Map(),
      indexedLegs: new Map(),
      order: new Map(),
      writes: -1,
      size: -1,
    };
    indexes.set(context, index);
  }
  catchUp(context, index);
  const holding = new Set<StrategyDraft>();
  for (const key of keysOf(instrument))
    for (const draft of index.byKey.get(key) ?? []) holding.add(draft);
  const order = index.order;
  // Drafts replaced in the context map are no longer candidates.
  return [...holding]
    .filter(
      (draft) => order.has(draft) && context.drafts.get(draft.id) === draft,
    )
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}
