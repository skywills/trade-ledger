import type {
  Allocation,
  Execution,
  LedgerSnapshot,
} from "../../shared/domain.js";
import { normalizeTimestamp } from "../../shared/timestamps.js";

/** Closed-lot records sometimes omit TradeID. A unique account, currency,
 * contract and closing timestamp can still identify the signed execution. */
export function selectStrategyEvidence(
  ledger: LedgerSnapshot,
  allAllocations: Allocation[],
  strategyId: string,
) {
  const allocations = allAllocations.filter(
    (row) => row.strategyId === strategyId,
  );
  const keys = new Set(allocations.map((row) => row.executionKey));
  const executions = ledger.executions.filter((row) => keys.has(row.key));
  const closeKeys = new Set(
    allocations
      .filter((row) => row.role === "close")
      .map((row) => row.executionKey),
  );
  if (!closeKeys.size)
    return { allocations, executions, lots: [], ambiguousLotCount: 0 };
  const sharedCloses = new Set(
    allAllocations
      .filter(
        (row) =>
          row.role === "close" &&
          row.strategyId !== strategyId &&
          closeKeys.has(row.executionKey),
      )
      .map((row) => row.executionKey),
  );
  let ambiguousLotCount = 0;
  const byTrade = new Map<string, Execution[]>();
  const byContractTime = new Map<string, Execution[]>();
  function index(
    map: Map<string, Execution[]>,
    key: string,
    execution: Execution,
  ) {
    const matches = map.get(key);
    if (matches) matches.push(execution);
    else map.set(key, [execution]);
  }
  for (const row of ledger.executions) {
    if (row.brokerIds.TradeID) index(byTrade, row.brokerIds.TradeID, row);
    if (
      row.instrument.conid &&
      (row.action === "close" || row.action === "mixed")
    )
      index(
        byContractTime,
        JSON.stringify([
          row.account,
          row.currency,
          row.instrument.conid,
          row.rawDateTime,
        ]),
        row,
      );
  }
  const lots = ledger.lots.filter((lot) => {
    if (!lot.source) return false;
    const fields = lot.fields;
    const account = fields.ClientAccountID?.trim();
    const currency = fields.CurrencyPrimary?.trim();
    const contract = fields.Conid?.trim();
    const tradeId = fields.TradeID?.trim();
    let matches: Execution[];
    if (tradeId) {
      matches = (byTrade.get(tradeId) ?? []).filter(
        (row) =>
          (!account || account === row.account) &&
          (!currency || currency === row.currency) &&
          (!contract || contract === row.instrument.conid),
      );
    } else {
      const time = normalizeTimestamp(fields.DateTime);
      if (!account || !currency || !contract || time.status !== "ok")
        return false;
      matches =
        byContractTime.get(
          JSON.stringify([account, currency, contract, time.timestamp]),
        ) ?? [];
    }
    if (!matches.some((row) => closeKeys.has(row.key))) return false;
    const [match] = matches;
    if (!match || matches.length > 1 || sharedCloses.has(match.key)) {
      ambiguousLotCount++;
      return false;
    }
    return true;
  });
  return { allocations, executions, lots, ambiguousLotCount };
}
