import { Decimal } from "decimal.js";
import type { Execution } from "../../shared/domain.js";

export type PnlSlice = {
  execution: Execution;
  quantity: string;
  netCash: string;
};
export type ReconstructionResult = {
  value: string | null;
  method: "cashflow" | "trade-proceeds";
  reason: "FUTURES_PNL_UNAVAILABLE" | null;
};

export function reconstructPnl(
  rows: readonly PnlSlice[],
): ReconstructionResult {
  const hasFutures = rows.some(
    ({ execution }) => execution.instrument.assetClass === "FUT",
  );
  const method = hasFutures ? "trade-proceeds" : "cashflow";
  const unavailable: ReconstructionResult = {
    value: null,
    method,
    reason: "FUTURES_PNL_UNAVAILABLE",
  };
  const balances = new Map<string, Decimal>();
  let total = new Decimal(0);
  try {
    const first = rows[0]?.execution;
    for (const { execution, quantity, netCash } of rows) {
      if (
        hasFutures &&
        (execution.account !== first?.account ||
          execution.currency !== first.currency)
      )
        return unavailable;
      if (execution.instrument.assetClass !== "FUT") {
        const cash = new Decimal(netCash);
        if (!cash.isFinite()) return unavailable;
        total = total.plus(cash);
        continue;
      }
      if (
        execution.event !== "trade" ||
        execution.proceeds === null ||
        execution.commission === null ||
        !execution.instrument.key
      )
        return unavailable;
      const source = new Decimal(execution.quantity);
      const allocated = new Decimal(quantity);
      const proceeds = new Decimal(execution.proceeds);
      const commission = new Decimal(execution.commission);
      const taxes = new Decimal(execution.taxes ?? "0");
      if (
        ![source, allocated, proceeds, commission, taxes].every((value) =>
          value.isFinite(),
        ) ||
        source.isZero() ||
        allocated.isZero() ||
        source.isNegative() !== allocated.isNegative() ||
        allocated.abs().gt(source.abs())
      )
        return unavailable;
      const key = execution.instrument.key;
      balances.set(key, (balances.get(key) ?? new Decimal(0)).plus(allocated));
      total = total.plus(
        proceeds.plus(commission).plus(taxes).mul(allocated.div(source)),
      );
    }
    if ([...balances.values()].some((balance) => !balance.isZero()))
      return unavailable;
    return { value: total.toFixed(), method, reason: null };
  } catch {
    return unavailable;
  }
}
