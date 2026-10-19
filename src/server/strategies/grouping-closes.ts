import type { Execution } from "../../shared/domain.js";
import {
  closeCandidates,
  equivalentOpeningLot,
} from "./grouping-close-candidates.js";
import { orderByKnownChronology } from "./grouping-close-order.js";
import { roleOf } from "./grouping-common.js";
import type { GroupingContext } from "./grouping-context.js";
import { looksLikeBookedEvent } from "./lifecycle.js";
import { addLeg, legOf, makeIssue, pushDraftIssue } from "./projection.js";

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
  const orderedCloseExecutions = orderByKnownChronology(closeExecutions);
  for (const close of orderedCloseExecutions) {
    const closeQuantity = availableOf(close).toFixed();
    let candidates = closeCandidates(context, close, closeQuantity);

    const lot = ledger.lots.find(
      (row) =>
        (row.fields["TradeID"] ?? "").trim() !== "" &&
        (row.fields["TradeID"] ?? "").trim() ===
          (close.brokerIds.TradeID ?? ""),
    );
    if (lot !== undefined) {
      const opened = (lot.fields["OpenDateTime"] ?? "").trim().slice(0, 10);
      if (opened !== "") {
        const narrowed = candidates.filter((draft) =>
          draft.openingLegs.some((leg) => leg.date === opened),
        );
        if (narrowed.length > 0) candidates = narrowed;
      }
    }

    if (candidates.length > 1 && lot === undefined) {
      const equivalent = equivalentOpeningLot(
        candidates,
        close,
        closeQuantity,
        executionByKey,
      );
      if (equivalent !== undefined) candidates = [equivalent];
    }

    if (candidates.length === 1) {
      const target = candidates[0];
      if (target !== undefined) {
        const netCash = residualNetCash(close);
        const brokerPnl = residualBrokerPnl(close);
        addLeg(
          target,
          legOf(close, "close", {
            quantity: closeQuantity,
            netCash,
            brokerPnl,
          }),
        );
        recordConsumption(close, closeQuantity, netCash, brokerPnl);
        continue;
      }
    }

    if (candidates.length > 1) {
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
    if (
      candidates.length === 0 &&
      close.brokerIds.PositionActionID === undefined &&
      looksLikeBookedEvent(close)
    ) {
      pushDraftIssue(
        draft,
        makeIssue("LIFECYCLE_UNRESOLVED", close.sources, "warning", close.key),
      );
    }
  }
  return orderedCloseExecutions;
}
