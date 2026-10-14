import { Decimal } from "decimal.js";
import type { DecimalText, Id } from "../../shared/domain.js";

export interface SplitPart {
  strategyId: Id;
  quantity: DecimalText;
}

export interface SplitResult {
  strategyId: Id;
  amount: DecimalText;
}

export interface ProportionalShare extends SplitResult {
  estimated: boolean;
}

/** Extra fractional places retained beyond the source amount's own scale. */
const EXTRA_PRECISION = 18;

function canonical(value: Decimal): DecimalText {
  return value.isZero() ? "0" : value.toFixed();
}

function stableOrder(parts: readonly SplitPart[]): SplitPart[] {
  return parts
    .map((part, index) => ({ part, index }))
    .sort((left, right) =>
      left.part.strategyId < right.part.strategyId
        ? -1
        : left.part.strategyId > right.part.strategyId
          ? 1
          : left.index - right.index,
    )
    .map((entry) => entry.part);
}

/**
 * Partitions an amount across signed-quantity parts proportionally to each
 * part's magnitude. Precision is the source amount's scale plus 18 fractional
 * places; the final residual is assigned to the last part in stable
 * strategy-ID order so the parts sum to the amount exactly. Weighting by
 * magnitude means negative or short quantities never reverse the sign of the
 * distributed amount.
 */
export function splitAmount(
  amount: DecimalText,
  parts: readonly SplitPart[],
): SplitResult[] {
  const total = new Decimal(amount);
  const ordered = stableOrder(parts);
  if (ordered.length === 0) return [];

  const weights = ordered.map((part) => new Decimal(part.quantity).abs());
  const totalWeight = weights.reduce(
    (sum, weight) => sum.plus(weight),
    new Decimal(0),
  );
  const scale = total.decimalPlaces() + EXTRA_PRECISION;
  const lastIndex = ordered.length - 1;

  const amounts: Decimal[] = ordered.map(() => new Decimal(0));
  let assigned = new Decimal(0);
  if (!totalWeight.isZero()) {
    for (let index = 0; index < ordered.length; index += 1) {
      if (index === lastIndex) continue;
      const share = total
        .times(weights[index] ?? new Decimal(0))
        .div(totalWeight)
        .toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
      amounts[index] = share;
      assigned = assigned.plus(share);
    }
  }
  amounts[lastIndex] = total.minus(assigned);

  return ordered.map((part, index) => ({
    strategyId: part.strategyId,
    amount: canonical(amounts[index] ?? new Decimal(0)),
  }));
}

/**
 * Convenience wrapper that marks every apportioned amount as estimated, since
 * a proportional share is not broker-verified at strategy level.
 */
export function distributeProportional(
  amount: DecimalText,
  parts: readonly SplitPart[],
): ProportionalShare[] {
  return splitAmount(amount, parts).map((result) => ({
    ...result,
    estimated: true,
  }));
}
