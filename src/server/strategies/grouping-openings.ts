import type { Execution, Id } from "../../shared/domain.js";
import { groupKeyOf, roleOf, sortedByKey } from "./grouping-common.js";
import type { GroupingContext } from "./grouping-context.js";
import { sameInstrument } from "./matching.js";
import { addLeg, legOf, makeIssue, pushDraftIssue } from "./projection.js";

export function groupOpenings(context: GroupingContext): Map<string, Id> {
  const {
    ledger,
    resolveId,
    draftFor,
    availableOf,
    residualNetCash,
    residualBrokerPnl,
    recordConsumption,
  } = context;
  // 2. Opening groups proposed by the broker order identity. A partially
  //    allocated execution contributes only its residual units.
  const openingGroups = new Map<string, Execution[]>();
  for (const execution of sortedByKey(ledger.executions)) {
    if (execution.event === "unsupported") continue;
    if (roleOf(execution) !== "open") continue;
    if (availableOf(execution).isZero()) continue;
    const key = groupKeyOf(execution);
    const group = openingGroups.get(key) ?? [];
    group.push(execution);
    openingGroups.set(key, group);
  }
  const orderOpenings = new Map<string, Id>();
  for (const key of [...openingGroups.keys()].sort()) {
    const group = sortedByKey(openingGroups.get(key) ?? []);
    const first = group[0];
    if (first === undefined) continue;
    const id = resolveId(
      first.account,
      group.map((execution) => execution.key),
    );
    const draft = draftFor(
      id,
      first.account,
      first.currency,
      group.flatMap((execution) => execution.sources),
    );
    for (const execution of group) {
      const quantity = availableOf(execution).toFixed();
      const netCash = residualNetCash(execution);
      const brokerPnl = residualBrokerPnl(execution);
      addLeg(draft, legOf(execution, "open", { quantity, netCash, brokerPnl }));
      recordConsumption(execution, quantity, netCash, brokerPnl);
    }
    orderOpenings.set(groupKeyOf(first), id);
  }
  return orderOpenings;
}

export function markUnsupportedInventory(context: GroupingContext): void {
  const { ledger, drafts, resolveId, draftFor, recordConsumption } = context;
  // 3. Unsupported corporate actions block definitive exposure and closure.
  for (const execution of ledger.executions) {
    if (execution.event !== "unsupported") continue;
    let matched = false;
    for (const draft of drafts.values()) {
      if (draft.account !== execution.account) continue;
      if (
        !draft.legs.some((leg) =>
          sameInstrument(leg.instrument, execution.instrument),
        )
      ) {
        continue;
      }
      draft.unresolved = true;
      draft.blocking = true;
      pushDraftIssue(
        draft,
        makeIssue(
          "UNSUPPORTED_INVENTORY",
          execution.sources,
          "warning",
          execution.key,
        ),
      );
      matched = true;
    }
    if (!matched) {
      const id = resolveId(execution.account, [execution.key]);
      const draft = draftFor(
        id,
        execution.account,
        execution.currency,
        execution.sources,
      );
      addLeg(draft, legOf(execution, "close"));
      recordConsumption(
        execution,
        execution.quantity,
        execution.netCash,
        execution.brokerPnl,
      );
      draft.unresolved = true;
      draft.blocking = true;
      draft.complete = false;
      pushDraftIssue(
        draft,
        makeIssue(
          "UNSUPPORTED_INVENTORY",
          execution.sources,
          "warning",
          execution.key,
        ),
      );
    }
  }
}
