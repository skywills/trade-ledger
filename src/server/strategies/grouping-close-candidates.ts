import { Decimal } from "decimal.js";
import type { Execution, Id } from "../../shared/domain.js";
import { compareExecutionTime } from "../ledger/chronology.js";
import type { GroupingContext } from "./grouping-context.js";
import { remainingCompatible, sameInstrument } from "./matching.js";
import type { StrategyDraft } from "./projection.js";

/**
 * Simultaneous, untouched single-leg lots with identical economics are
 * interchangeable for a whole-lot trade close. Break that tie by execution
 * key, never by a generated strategy ID or by assuming broker IDs encode time.
 */
export function equivalentOpeningLot(
  candidates: readonly StrategyDraft[],
  close: Execution,
  closeQuantity: string,
  executionByKey: ReadonlyMap<Id, Execution>,
): StrategyDraft | undefined {
  if (close.event !== "trade" || close.action !== "close") return undefined;
  const hasLotReference = (execution: Execution): boolean =>
    ["OrigTradeID", "RelatedTradeID", "PositionActionID"].some((key) => {
      const value = execution.brokerIds[key]?.trim();
      return value !== undefined && value !== "" && value !== "0";
    });
  if (hasLotReference(close)) return undefined;
  const lots: { draft: StrategyDraft; opening: Execution }[] = [];
  for (const draft of candidates) {
    if (draft.unresolved || draft.blocking || draft.issues.length > 0)
      return undefined;
    const leg = draft.legs[0];
    if (draft.legs.length !== 1 || leg?.role !== "open") return undefined;
    const opening = executionByKey.get(leg.executionKey);
    if (
      opening === undefined ||
      opening.event !== "trade" ||
      opening.action !== "open" ||
      opening.price === null ||
      hasLotReference(opening) ||
      !new Decimal(leg.quantity).eq(opening.quantity) ||
      !new Decimal(leg.netCash).eq(opening.netCash) ||
      !new Decimal(leg.quantity).abs().eq(new Decimal(closeQuantity).abs())
    )
      return undefined;
    lots.push({ draft, opening });
  }
  // A weak instrument can match either of two conflicting known contracts;
  // it must not make those contracts equivalent to one another.
  const knownContracts = new Set(
    lots
      .map(({ opening }) => opening.instrument.conid)
      .filter((conid) => conid !== null),
  );
  if (knownContracts.size > 1) return undefined;
  const first = lots[0]?.opening;
  if (first === undefined) return undefined;
  const sameDecimal = (left: string | null, right: string | null): boolean =>
    left === null || right === null
      ? left === right
      : new Decimal(left).eq(right);
  if (
    close.basis !== null &&
    first.basis !== null &&
    !new Decimal(close.basis).abs().eq(new Decimal(first.basis).abs())
  )
    return undefined;
  for (const { opening } of lots) {
    if (
      compareExecutionTime(first, opening) !== 0 ||
      !sameInstrument(first.instrument, opening.instrument) ||
      !sameDecimal(
        first.instrument.multiplier,
        opening.instrument.multiplier,
      ) ||
      !sameDecimal(first.quantity, opening.quantity) ||
      !sameDecimal(first.price, opening.price) ||
      !sameDecimal(first.netCash, opening.netCash) ||
      !sameDecimal(first.basis, opening.basis) ||
      !sameDecimal(first.proceeds, opening.proceeds) ||
      !sameDecimal(first.commission, opening.commission) ||
      !sameDecimal(first.taxes, opening.taxes) ||
      !sameDecimal(first.brokerPnl, opening.brokerPnl)
    )
      return undefined;
  }
  return lots.sort((left, right) =>
    left.opening.key < right.opening.key ? -1 : 1,
  )[0]?.draft;
}

export function closingExposure(
  context: GroupingContext,
  draft: StrategyDraft,
  close: Execution,
): Decimal {
  const { executionByKey } = context;
  if (draft.account !== close.account || draft.currency !== close.currency) {
    return new Decimal(0);
  }
  let exposure = new Decimal(0);
  const futureOpenings: { execution: Execution; quantity: Decimal }[] = [];
  const futureCloses: { execution: Execution; quantity: Decimal }[] = [];
  const uncertainFutureCloses: Decimal[] = [];
  let sawOpening = false;
  for (const leg of draft.legs) {
    if (!sameInstrument(leg.instrument, close.instrument)) continue;
    const related = executionByKey.get(leg.executionKey);
    if (related === undefined) return new Decimal(0);
    if (leg.role === "close") {
      const chronological = compareExecutionTime(related, close);
      const tiedEarlierClose = chronological === 0 && related.key <= close.key;
      if (chronological !== null && (chronological < 0 || tiedEarlierClose)) {
        exposure = exposure.plus(leg.quantity);
      } else if (
        chronological !== null &&
        (chronological > 0 || related.key > close.key)
      ) {
        futureCloses.push({
          execution: related,
          quantity: new Decimal(leg.quantity),
        });
      } else {
        // A later or uncertain assigned/matched close reserves capacity,
        // but cannot create historical exposure with the opposite sign.
        uncertainFutureCloses.push(new Decimal(leg.quantity));
      }
      continue;
    }
    const chronological = compareExecutionTime(related, close);
    // Different time zones or date-only values on the same day leave
    // ordering uncertain. A shared unzoned report provides a common
    // wall-clock basis without claiming an absolute instant.
    if (chronological === null) return new Decimal(0);
    // Explicit broker roles establish exposure at a tied timestamp; CSV
    // line order is not chronology. Unzoned rows still need a shared clock.
    const tiedExplicitRoles =
      chronological === 0 &&
      leg.role === "open" &&
      related.action === "open" &&
      close.action === "close";
    const tiedLifecycleEvent =
      chronological === 0 && leg.role === "open" && close.event !== "trade";
    if (
      chronological > 0 ||
      (chronological === 0 && !(tiedLifecycleEvent || tiedExplicitRoles))
    ) {
      if (chronological > 0) {
        futureOpenings.push({
          execution: related,
          quantity: new Decimal(leg.quantity),
        });
      }
      continue;
    }
    exposure = exposure.plus(leg.quantity);
    if (leg.role === "open") sawOpening = true;
  }
  if (!sawOpening || exposure.isZero()) return new Decimal(0);
  const reservesCurrentExposure = (quantity: Decimal): boolean =>
    quantity.isNegative() !== exposure.isNegative();
  const uncertainReservation = uncertainFutureCloses.reduce((sum, quantity) => {
    return quantity.isNegative() !== exposure.isNegative()
      ? sum.plus(quantity.abs())
      : sum;
  }, new Decimal(0));
  let knownReservation = new Decimal(0);

  for (const target of futureCloses) {
    if (!reservesCurrentExposure(target.quantity)) continue;
    let cumulativeFutureDemand = new Decimal(0);
    for (const candidate of futureCloses) {
      if (!reservesCurrentExposure(candidate.quantity)) continue;
      const chronology = compareExecutionTime(
        candidate.execution,
        target.execution,
      );
      const precedesOrUnknown =
        candidate.execution.key === target.execution.key ||
        chronology === null ||
        chronology < 0 ||
        (chronology === 0 && candidate.execution.key < target.execution.key);
      if (precedesOrUnknown) {
        cumulativeFutureDemand = cumulativeFutureDemand.plus(
          candidate.quantity.abs(),
        );
      }
    }
    const replenishmentBeforeTarget = futureOpenings.reduce((sum, opening) => {
      if (opening.quantity.isNegative() !== exposure.isNegative()) {
        return sum;
      }
      return compareExecutionTime(opening.execution, target.execution) === -1
        ? sum.plus(opening.quantity.abs())
        : sum;
    }, new Decimal(0));
    const deficit = cumulativeFutureDemand.minus(replenishmentBeforeTarget);
    if (deficit.gt(knownReservation)) knownReservation = deficit;
  }
  return Decimal.max(
    0,
    exposure.abs().minus(uncertainReservation.plus(knownReservation)),
  ).times(exposure.isNegative() ? -1 : 1);
}

export function closeCandidates(
  context: GroupingContext,
  close: Execution,
  closeQuantity: string,
): StrategyDraft[] {
  return [...context.drafts.values()].filter((draft) => {
    const exposure = closingExposure(context, draft, close);
    return (
      !exposure.isZero() &&
      remainingCompatible(exposure.toFixed(), closeQuantity)
    );
  });
}
