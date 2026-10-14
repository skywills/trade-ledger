import { Decimal } from "decimal.js";
import type { DecimalText } from "./domain.js";

/**
 * Display text for an amount that could not be established. Unknown P/L is
 * never rendered as zero.
 */
export const UNAVAILABLE = "Unavailable";

const FRACTION_DIGITS = new Map<string, number>();
const DEFAULT_FRACTION_DIGITS = 2;

/**
 * Number of minor-unit fraction digits a currency is displayed with, taken from
 * platform currency metadata (USD → 2, JPY → 0). Unknown currencies fall back
 * to two digits rather than throwing. Browser-safe: uses only Intl.
 */
export function currencyFractionDigits(currency: string): number {
  const code = currency.trim().toUpperCase();
  const cached = FRACTION_DIGITS.get(code);
  if (cached !== undefined) return cached;
  let digits = DEFAULT_FRACTION_DIGITS;
  try {
    digits =
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: code,
      }).resolvedOptions().maximumFractionDigits ?? DEFAULT_FRACTION_DIGITS;
  } catch {
    digits = DEFAULT_FRACTION_DIGITS;
  }
  FRACTION_DIGITS.set(code, digits);
  return digits;
}

/** One display minor unit for a currency, as a canonical decimal string. */
export function minorUnit(currency: string): DecimalText {
  const value = new Decimal(1).div(
    new Decimal(10).pow(currencyFractionDigits(currency)),
  );
  return value.toFixed();
}

/**
 * Formats a canonical decimal string for display using the currency's minor
 * unit, rounding half away from zero. Only the number is rendered: no symbol
 * and no thousands grouping. `null` renders as `Unavailable`.
 */
export function formatMoney(
  value: DecimalText | null,
  currency: string,
): string {
  if (value === null) return UNAVAILABLE;
  const digits = currencyFractionDigits(currency);
  return new Decimal(value)
    .toDecimalPlaces(digits, Decimal.ROUND_HALF_UP)
    .toFixed(digits);
}

/**
 * Source-precision comparison with a tolerance of one display minor unit for
 * the currency. Differences within tolerance reconcile; anything larger
 * requires review.
 */
export function reconcilesWithin(
  left: DecimalText,
  right: DecimalText,
  currency: string,
): boolean {
  const difference = new Decimal(left).minus(right).abs();
  return difference.lte(minorUnit(currency));
}
