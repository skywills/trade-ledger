import { type Binding, roleOf } from "./grouping-common.js";
import type { GroupingContext } from "./grouping-context.js";
import { addLeg, legOf, makeIssue } from "./projection.js";

export function applyRetainedBindings(
  context: GroupingContext,
  bindings: readonly Binding[],
): void {
  const {
    addIssue,
    draftFor,
    availableOf,
    residualNetCash,
    residualBrokerPnl,
    recordConsumption,
  } = context;
  // 1. Retained manual/explicit allocations are applied before automatic
  //    matching. Each decision row contributes its own signed quantity and
  //    cash, so a partial row reserves only its share and the execution's
  //    remainder stays available for automatic matching. A second retained
  //    allocation targeting the same execution+strategy+role is a duplicate:
  //    it is deduplicated and surfaced as a review issue rather than being
  //    applied twice (which would double exposure and could hard-fail a build).
  const appliedBindingKeys = new Set<string>();
  for (const binding of bindings) {
    const { execution } = binding;
    const role = roleOf(execution);
    const bindingKey = `${binding.strategyId}\u0000${execution.key}\u0000${role}`;
    if (appliedBindingKeys.has(bindingKey)) {
      addIssue(
        makeIssue(
          "DUPLICATE_ALLOCATION",
          execution.sources,
          "warning",
          binding.strategyId,
        ),
      );
      continue;
    }
    appliedBindingKeys.add(bindingKey);
    if (binding.quantity === null) {
      const residualQuantity = availableOf(execution);
      if (residualQuantity.isZero()) continue;
      const quantity = residualQuantity.toFixed();
      const netCash = residualNetCash(execution);
      const brokerPnl = residualBrokerPnl(execution);
      const draft = draftFor(
        binding.strategyId,
        execution.account,
        execution.currency,
        execution.sources,
      );
      addLeg(draft, legOf(execution, role, { quantity, netCash, brokerPnl }));
      recordConsumption(execution, quantity, netCash, brokerPnl);
      continue;
    }
    const netCash = binding.netCash ?? execution.netCash;
    const draft = draftFor(
      binding.strategyId,
      execution.account,
      execution.currency,
      execution.sources,
    );
    addLeg(
      draft,
      legOf(execution, role, {
        quantity: binding.quantity,
        netCash,
        brokerPnl: binding.brokerPnl,
      }),
    );
    recordConsumption(execution, binding.quantity, netCash, binding.brokerPnl);
  }
}
