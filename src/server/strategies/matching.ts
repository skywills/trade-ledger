import { Decimal } from "decimal.js";
import type { DecimalText, Instrument } from "../../shared/domain.js";

export interface Leg {
  instrument: Instrument;
  quantity: DecimalText;
}

const DERIVATIVE_CLASSES: ReadonlySet<string> = new Set(["OPT", "WAR", "FUT"]);
const STOCK_CLASSES: ReadonlySet<string> = new Set(["STK", "STOCK"]);

/** Sign of a signed decimal quantity without converting it to a JS number. */
export function signOf(quantity: DecimalText): number {
  const value = new Decimal(quantity);
  if (value.isZero()) return 0;
  return value.isNegative() ? -1 : 1;
}

export function isDerivative(instrument: Instrument): boolean {
  return DERIVATIVE_CLASSES.has(instrument.assetClass.trim().toUpperCase());
}

export function isStock(instrument: Instrument): boolean {
  return STOCK_CLASSES.has(instrument.assetClass.trim().toUpperCase());
}

/**
 * Two instruments refer to the same contract. Canonical keys are compared
 * first; when a weak row lacks a conid the contract-defining fields decide.
 */
export function sameInstrument(left: Instrument, right: Instrument): boolean {
  if (left.key === right.key) return true;
  return (
    left.assetClass === right.assetClass &&
    left.underlying === right.underlying &&
    left.expiry === right.expiry &&
    left.strike === right.strike &&
    left.putCall === right.putCall
  );
}

/**
 * A close can only discharge a currently open position of the opposite sign
 * with at least the close's magnitude. Zero remaining is never closable.
 */
export function remainingCompatible(
  remaining: DecimalText,
  closing: DecimalText,
): boolean {
  const current = new Decimal(remaining);
  const close = new Decimal(closing);
  if (current.isZero() || close.isZero()) return false;
  if (current.isNegative() === close.isNegative()) return false;
  return current.abs().gte(close.abs());
}

/** Contract expiry year for options; null for shares and absent expiries. */
export function yearOf(expiry: string | null): number | null {
  if (expiry === null) return null;
  const year = Number.parseInt(expiry.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

/**
 * Derives the strategy classification from actual leg directions and ratios.
 * Signed units decide which strike is long: a lower long strike is bullish,
 * a higher long strike is bearish, for both puts and calls.
 */
export function classifyLegs(legs: readonly Leg[]): string {
  if (legs.length === 0) return "unresolved";
  if (legs.every((leg) => isStock(leg.instrument))) return "stock";
  if (!legs.every((leg) => isDerivative(leg.instrument))) return "custom";

  const underlying = legs[0]?.instrument.underlying ?? null;
  const expiry = legs[0]?.instrument.expiry ?? null;
  if (
    !legs.every(
      (leg) =>
        leg.instrument.underlying === underlying &&
        leg.instrument.expiry === expiry,
    )
  ) {
    return "custom";
  }

  if (legs.length === 1) {
    return signOf(legs[0]?.quantity ?? "0") >= 0
      ? "long_option"
      : "short_option";
  }

  if (legs.length === 2) {
    const first = legs[0];
    const second = legs[1];
    if (first === undefined || second === undefined) return "custom";
    const putCall = first.instrument.putCall;
    const firstSign = signOf(first.quantity);
    const secondSign = signOf(second.quantity);
    if (
      putCall !== null &&
      second.instrument.putCall === putCall &&
      firstSign !== 0 &&
      secondSign !== 0 &&
      firstSign !== secondSign
    ) {
      const long = firstSign > 0 ? first : second;
      const short = firstSign < 0 ? first : second;
      const longStrike = long.instrument.strike;
      const shortStrike = short.instrument.strike;
      if (longStrike !== null && shortStrike !== null) {
        const comparison = new Decimal(longStrike).comparedTo(
          new Decimal(shortStrike),
        );
        if (putCall === "P") {
          return comparison < 0 ? "bull_put_spread" : "bear_put_spread";
        }
        if (putCall === "C") {
          return comparison < 0 ? "bull_call_spread" : "bear_call_spread";
        }
      }
    }
  }
  return "custom";
}
