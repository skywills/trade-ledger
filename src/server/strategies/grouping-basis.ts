import { Decimal } from "decimal.js";
import type { Execution } from "../../shared/domain.js";
import { minorUnit } from "../../shared/money.js";
import { compareExecutionTime } from "../ledger/chronology.js";
import { closingExposure } from "./grouping-close-candidates.js";
import type { GroupingContext } from "./grouping-context.js";
import { sameInstrument } from "./matching.js";
import type { StrategyDraft } from "./projection.js";

export interface BasisAllocation {
  draft: StrategyDraft;
  quantity: string;
  /** Absent when strategy attribution is unique but fill provenance is not. */
  lots: Array<{ executionKey: string; quantity: string }> | undefined;
}

const MAX_LOTS = 12;
const MAX_UNITS = 10_000;
const MAX_SEARCH_NODES = 20_000;
const hasLotReference = (execution: Execution) =>
  ["OrigTradeID", "RelatedTradeID", "PositionActionID"].some((key) => {
    const value = execution.brokerIds[key]?.trim();
    return value !== undefined && value !== "" && value !== "0";
  });

/**
 * Find a unique whole-contract allocation supported by the close's cost basis.
 * Opening-fill lots only; never override broker linkage, manual partial
 * allocations, conflicting known contracts, or an exhausted search budget.
 */
export function basisCloseAllocation(
  context: GroupingContext,
  close: Execution,
  closeQuantity: string,
): BasisAllocation[] | null | undefined {
  const quantity = new Decimal(closeQuantity);
  if (
    close.event !== "trade" ||
    close.action !== "close" ||
    close.instrument.assetClass !== "OPT" ||
    close.basis === null ||
    new Decimal(close.basis).isZero() ||
    hasLotReference(close) ||
    !quantity.isInteger() ||
    quantity.abs().gt(MAX_UNITS) ||
    !quantity.eq(close.quantity)
  )
    return undefined;

  const lots: {
    draft: StrategyDraft;
    opening: Execution;
    capacity: number;
    unitBasis: Decimal;
    parts: Array<{ executionKey: string; capacity: number }>;
  }[] = [];
  const draftCapacity = new Map<StrategyDraft, number>();
  for (const draft of context.drafts.values()) {
    const exposure = closingExposure(context, draft, close);
    if (exposure.isZero() || exposure.isNegative() === quantity.isNegative())
      continue;
    if (
      draft.unresolved ||
      draft.blocking ||
      draft.issues.length > 0 ||
      draft.legs.some(
        (part) => !sameInstrument(part.instrument, close.instrument),
      )
    )
      return undefined;
    const capacity = Decimal.min(exposure.abs(), quantity.abs()).toNumber();
    draftCapacity.set(draft, capacity);
    const consumed = new Map<string, Decimal>();
    for (const part of draft.legs.filter((part) => part.role === "close")) {
      // A preassigned/manual close spanning several opening fills does not
      // establish which basis lots remain. Do not guess that distribution.
      if (draft.openingLegs.length > 1 && part.basisLots === undefined)
        return undefined;
      for (const lot of part.basisLots ?? [])
        consumed.set(
          lot.executionKey,
          (consumed.get(lot.executionKey) ?? new Decimal(0)).plus(
            new Decimal(lot.quantity).abs(),
          ),
        );
    }
    for (const leg of draft.openingLegs) {
      const opening = context.executionByKey.get(leg.executionKey);
      if (
        opening === undefined ||
        opening.action !== "open" ||
        opening.event !== "trade" ||
        opening.basis === null ||
        new Decimal(opening.basis).isZero() ||
        hasLotReference(opening) ||
        !new Decimal(leg.quantity).eq(opening.quantity) ||
        !new Decimal(leg.netCash).eq(opening.netCash) ||
        !sameInstrument(opening.instrument, close.instrument) ||
        opening.instrument.multiplier !== close.instrument.multiplier ||
        !new Decimal(opening.quantity).isInteger() ||
        !exposure.isInteger()
      )
        return undefined;
      const chronology = compareExecutionTime(opening, close);
      if (chronology === null) return undefined;
      if (chronology > 0) continue;
      const remaining = new Decimal(opening.quantity)
        .abs()
        .minus(consumed.get(opening.key) ?? 0);
      const available = Decimal.min(remaining, capacity, quantity.abs());
      if (available.lte(0)) continue;
      lots.push({
        draft,
        opening,
        capacity: available.toNumber(),
        parts: [{ executionKey: opening.key, capacity: available.toNumber() }],
        unitBasis: new Decimal(opening.basis)
          .abs()
          .div(new Decimal(opening.quantity).abs()),
      });
    }
  }
  if (lots.length === 0) return undefined;
  if (
    new Set(
      lots
        .map((lot) => lot.opening.instrument.conid)
        .filter((id) => id !== null),
    ).size > 1
  )
    return undefined;
  lots.sort((a, b) => a.opening.key.localeCompare(b.opening.key));
  // Equal-basis fills in the same strategy are interchangeable. Searching
  // them separately creates false ambiguity at fill level and can hide the
  // unique strategy allocation. Keep their provenance in stable key order.
  for (let index = 0; index < lots.length; index++) {
    const lot = lots[index];
    if (lot === undefined) continue;
    for (let otherIndex = index + 1; otherIndex < lots.length; otherIndex++) {
      const other = lots[otherIndex];
      if (
        other === undefined ||
        other.draft !== lot.draft ||
        !other.unitBasis.eq(lot.unitBasis)
      )
        continue;
      lot.parts.push(...other.parts);
      lot.capacity = Math.min(
        lot.capacity + other.capacity,
        draftCapacity.get(lot.draft) ?? 0,
      );
      lots.splice(otherIndex--, 1);
    }
  }
  if (lots.length > MAX_LOTS) return null;
  const expectedBasis = new Decimal(close.basis).abs();
  const tolerance = new Decimal(minorUnit(close.currency));
  const solutions: number[][] = [];
  let strategySignature: string | undefined;
  const uncertainProvenance = new Set<StrategyDraft>();
  const allocation = lots.map(() => 0);
  const usedByDraft = new Map<StrategyDraft, number>();
  let nodes = 0;
  let exhausted = false;
  const search = (index: number, remaining: number, basis: Decimal): void => {
    if (++nodes > MAX_SEARCH_NODES) {
      exhausted = true;
      return;
    }
    if (
      solutions.length > 1 ||
      exhausted ||
      basis.gt(expectedBasis.plus(tolerance))
    )
      return;
    if (index === lots.length) {
      if (remaining !== 0 || basis.minus(expectedBasis).abs().gt(tolerance))
        return;
      const totals = new Map<string, number>();
      lots.forEach((lot, position) => {
        totals.set(
          lot.draft.id,
          (totals.get(lot.draft.id) ?? 0) + (allocation[position] ?? 0),
        );
      });
      const signature = JSON.stringify(
        [...totals].sort(([a], [b]) => a.localeCompare(b)),
      );
      const first = solutions[0];
      if (first === undefined) {
        strategySignature = signature;
        solutions.push([...allocation]);
      } else if (signature !== strategySignature) {
        solutions.push([...allocation]);
      } else {
        // Several fill vectors can prove the same strategy-level allocation.
        // Keep searching to rule out other strategy allocations, but do not
        // claim any particular fill provenance for the affected strategy.
        lots.forEach((lot, position) => {
          if (allocation[position] !== first[position])
            uncertainProvenance.add(lot.draft);
        });
      }
      return;
    }
    const lot = lots[index];
    if (lot === undefined) return;
    const remainingCapacity = lots
      .slice(index + 1)
      .reduce((sum, item) => sum + item.capacity, 0);
    const minimum = Math.max(0, remaining - remainingCapacity);
    const used = usedByDraft.get(lot.draft) ?? 0;
    const availableForDraft = (draftCapacity.get(lot.draft) ?? 0) - used;
    for (
      let units = minimum;
      units <= Math.min(remaining, lot.capacity, availableForDraft);
      units++
    ) {
      usedByDraft.set(lot.draft, used + units);
      allocation[index] = units;
      search(
        index + 1,
        remaining - units,
        basis.plus(lot.unitBasis.times(units)),
      );
      usedByDraft.set(lot.draft, used);
      if (solutions.length > 1 || exhausted) return;
    }
  };
  search(0, quantity.abs().toNumber(), new Decimal(0));
  const solution = solutions[0];
  // null means basis evidence is ambiguous or the proof hit its budget.
  // The caller must not bypass it with an ordinary whole-close fallback.
  if (exhausted || solutions.length > 1) return null;
  if (solution === undefined) return undefined;
  const byDraft = new Map<StrategyDraft, BasisAllocation>();
  lots.forEach((lot, index) => {
    const units = solution[index] ?? 0;
    if (units === 0) return;
    const signed = new Decimal(units).times(quantity.isNegative() ? -1 : 1);
    const entry = byDraft.get(lot.draft) ?? {
      draft: lot.draft,
      quantity: "0",
      lots: [],
    };
    entry.quantity = new Decimal(entry.quantity).plus(signed).toFixed();
    let remaining = units;
    for (const part of lot.parts) {
      const take = Math.min(remaining, part.capacity);
      if (take > 0)
        entry.lots?.push({
          executionKey: part.executionKey,
          quantity: new Decimal(take)
            .times(quantity.isNegative() ? -1 : 1)
            .toFixed(),
        });
      remaining -= take;
      if (remaining === 0) break;
    }
    byDraft.set(lot.draft, entry);
  });
  for (const entry of byDraft.values()) {
    if (uncertainProvenance.has(entry.draft)) entry.lots = undefined;
  }
  return [...byDraft.values()];
}
