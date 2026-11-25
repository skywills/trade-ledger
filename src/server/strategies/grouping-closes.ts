import type { Execution } from "../../shared/domain.js";
import { groupBy } from "../../shared/group-by.js";
import { splitAmount } from "./allocation.js";
import { basisCloseAllocation } from "./grouping-basis.js";
import { basisPnlShares } from "./grouping-basis-pnl.js";
import {
  closeCandidates,
  closingExposure,
  equivalentOpeningLot,
} from "./grouping-close-candidates.js";
import { orderByKnownChronology } from "./grouping-close-order.js";
import { roleOf } from "./grouping-common.js";
import type { GroupingContext } from "./grouping-context.js";
import { draftsHolding } from "./grouping-draft-index.js";
import {
  fifoCloseAllocation,
  fifoLegAmounts,
  reportedLotAllocation,
} from "./grouping-fifo.js";
import { sameInstrument, signOf } from "./matching.js";
import { addLeg, legOf, makeIssue } from "./projection.js";

export function matchCloses(context: GroupingContext): Execution[] {
  const {
    ledger,
    executionByKey,
    resolveId,
    addIssue,
    draftFor,
    availableOf,
    residualNetCash,
    residualBrokerPnl,
    recordConsumption,
  } = context;
  // 4. Closes are matched to known openings by contract, lot evidence, and
  //    a unique compatible remaining position. Only the residual of a
  //    partially allocated execution is auto-matched; ambiguity or a missing
  //    opening becomes an unresolved review item rather than an invented match.
  const closeExecutions = ledger.executions.filter(
    (execution) =>
      execution.event !== "unsupported" &&
      roleOf(execution) === "close" &&
      !availableOf(execution).isZero(),
  );
  const lotKey = (account: string | undefined, tradeId: string | undefined) =>
    JSON.stringify([account, tradeId]);
  const lotsByTrade = groupBy(ledger.lots, (row) =>
    lotKey(row.fields.ClientAccountID?.trim(), row.fields.TradeID?.trim()),
  );
  const orderedCloseExecutions = orderByKnownChronology(closeExecutions);
  for (const close of orderedCloseExecutions) {
    const closeQuantity = availableOf(close).toFixed();
    let candidates = closeCandidates(context, close, closeQuantity);

    const tradeId = close.brokerIds.TradeID;
    const lots = tradeId
      ? (lotsByTrade.get(lotKey(close.account, tradeId)) ?? [])
      : [];
    const direction = signOf(closeQuantity);
    const exposureCandidates = draftsHolding(context, close.instrument).filter(
      (draft) => {
        const exposure = closingExposure(context, draft, close);
        return (
          !exposure.isZero() && (exposure.isNegative() ? -1 : 1) !== direction
        );
      },
    );
    const equivalent =
      lots.length === 0 && exposureCandidates.length > 1
        ? equivalentOpeningLot(
            exposureCandidates,
            close,
            closeQuantity,
            executionByKey,
          )
        : undefined;
    if (equivalent !== undefined) candidates = [equivalent];
    // A single compatible strategy with enough exposure is already a unique
    // strategy match. Do not invent a fill-level basis assignment inside it.
    // If other strategies are eligible, even only partially, basis must still
    // distinguish all supported cross-strategy allocations before matching.
    const needsBasisChoice =
      exposureCandidates.length > 1 || candidates.length !== 1;
    const basisAllocation =
      lots.length === 0 && equivalent === undefined && needsBasisChoice
        ? basisCloseAllocation(context, close, closeQuantity)
        : undefined;
    if (basisAllocation !== undefined && basisAllocation !== null) {
      const netCash = residualNetCash(close);
      const brokerPnl = residualBrokerPnl(close);
      const shares = splitAmount(
        netCash,
        basisAllocation.map((part) => ({
          strategyId: part.draft.id,
          quantity: part.quantity,
        })),
      );
      const pnlShares = basisPnlShares(
        close,
        basisAllocation,
        shares,
        executionByKey,
      );
      for (const part of basisAllocation) {
        const cash = shares.find((share) => share.strategyId === part.draft.id);
        if (cash === undefined)
          throw new Error("Missing basis allocation cash");
        addLeg(
          part.draft,
          legOf(close, "close", {
            quantity: part.quantity,
            netCash: cash.amount,
            ...(part.lots === undefined ? {} : { basisLots: part.lots }),
            // Basis-reconciled amounts are intentionally reported in the
            // separate "basis-reconciled" tier, not the estimated-P&L warning
            // tier. Distinguish basis-supported attribution from the
            // proportional fallback; both preserve the broker's execution
            // total.
            brokerPnl:
              basisAllocation.length === 1
                ? brokerPnl
                : (pnlShares?.get(part.draft.id) ?? null),
            pnlEstimated: false,
            ...(pnlShares === null
              ? {}
              : { pnlAttribution: "basis-reconciled" as const }),
          }),
        );
      }
      recordConsumption(close, closeQuantity, netCash, brokerPnl);
      continue;
    }

    // One broker fill can belong to several owners after a manual split. Its
    // slices have no FIFO order. Preserve the only owner that covers the close.
    const singleOpening =
      candidates.length === 1 &&
      exposureCandidates.length > 1 &&
      new Set(
        exposureCandidates.flatMap((draft) =>
          draft.openingLegs
            .filter((leg) => sameInstrument(leg.instrument, close.instrument))
            .map((leg) => leg.executionKey),
        ),
      ).size === 1;
    if (
      lots.length === 0 &&
      candidates.length === 1 &&
      basisAllocation !== null &&
      (equivalent !== undefined ||
        exposureCandidates.length <= 1 ||
        singleOpening)
    ) {
      const target = candidates[0];
      if (target !== undefined) {
        const netCash = residualNetCash(close);
        const brokerPnl = residualBrokerPnl(close);
        const fills = fifoCloseAllocation(context, close, closeQuantity, [
          target,
        ])?.[0]?.lots;
        addLeg(
          target,
          legOf(close, "close", {
            quantity: closeQuantity,
            ...(fills ? { basisLots: fills } : {}),
            netCash,
            brokerPnl,
          }),
        );
        recordConsumption(close, closeQuantity, netCash, brokerPnl);
        continue;
      }
    }

    // Older partial holdings participate even if a newer holding could cover
    // the entire close.
    const fifo =
      lots.length > 0
        ? reportedLotAllocation(
            context,
            close,
            closeQuantity,
            exposureCandidates,
            lots,
          )
        : fifoCloseAllocation(
            context,
            close,
            closeQuantity,
            exposureCandidates.length > 1 ? exposureCandidates : candidates,
          );
    if (fifo !== undefined) {
      const netCash = residualNetCash(close);
      const brokerPnl = residualBrokerPnl(close);
      for (const part of fifoLegAmounts(
        context,
        close,
        fifo,
        netCash,
        brokerPnl,
      )) {
        addLeg(
          part.draft,
          legOf(close, "close", {
            quantity: part.quantity,
            basisLots: part.lots,
            netCash: part.netCash,
            brokerPnl: part.brokerPnl,
            ...(part.pnlEstimated
              ? { pnlEstimated: true, pnlAttribution: "estimated" as const }
              : {}),
          }),
        );
      }
      recordConsumption(close, closeQuantity, netCash, brokerPnl);
      continue;
    }

    if (
      lots.length > 0 ||
      candidates.length > 1 ||
      (candidates.length === 1 && exposureCandidates.length > 1) ||
      basisAllocation === null
    ) {
      addIssue(
        makeIssue("AMBIGUOUS_CLOSE", close.sources, "warning", close.key),
      );
    } else {
      addIssue(
        makeIssue("MISSING_OPENING", close.sources, "warning", close.key),
      );
    }
    const id = resolveId(close.account, [close.key]);
    const draft = draftFor(id, close.account, close.currency, close.sources);
    const netCash = residualNetCash(close);
    const brokerPnl = residualBrokerPnl(close);
    addLeg(
      draft,
      legOf(close, "close", { quantity: closeQuantity, netCash, brokerPnl }),
    );
    recordConsumption(close, closeQuantity, netCash, brokerPnl);
    draft.unresolved = true;
    draft.complete = false;
  }
  return orderedCloseExecutions;
}
