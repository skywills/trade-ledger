import type {
  Decision,
  LedgerSnapshot,
  Projection,
} from "../../shared/domain.js";
import { applyRetainedBindings } from "./grouping-allocations.js";
import { matchCloses } from "./grouping-closes.js";
import type { ResolveId } from "./grouping-common.js";
import { createGroupingContext } from "./grouping-context.js";
import { readRetainedDecisions } from "./grouping-decisions.js";
import { finalizeGrouping } from "./grouping-finalize.js";
import { buildGroupingLinks } from "./grouping-links.js";
import {
  groupOpenings,
  markUnsupportedInventory,
} from "./grouping-openings.js";

export type { ResolveId } from "./grouping-common.js";

/**
 * Pure, synchronous, in-memory grouping of a normalized ledger plus retained
 * effective decisions into a strategy projection. BrokerageOrderID proposes
 * opening groups; lot evidence, unique compatible exposure, and economically
 * equivalent simultaneous lots resolve closes; other ambiguities require decisions.
 * Lifecycle and roll links are recorded without merging P/L. Financial amounts and persistence belong to later tasks.
 */
export function groupStrategies(
  ledger: LedgerSnapshot,
  decisions: readonly Decision[],
  resolveId: ResolveId,
): Projection {
  const context = createGroupingContext(ledger, decisions, resolveId);
  const { bindings, merges, lifecycles } = readRetainedDecisions(context);
  applyRetainedBindings(context, bindings);
  const orderOpenings = groupOpenings(context);
  markUnsupportedInventory(context);
  const orderedCloses = matchCloses(context);
  const links = buildGroupingLinks(
    context,
    lifecycles,
    orderOpenings,
    orderedCloses,
  );
  return finalizeGrouping(context, merges, links);
}
