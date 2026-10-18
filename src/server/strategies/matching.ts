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
  if (left.assetClass !== right.assetClass) return false;
  if (left.conid !== null && right.conid !== null)
    return left.conid === right.conid;
  if (left.symbol !== right.symbol) return false;
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

/** Combine partial fills for classification without changing allocation records. */
export function aggregateLegs(fills: readonly Leg[]): Leg[] {
  const legs: Leg[] = [];
  for (const fill of fills) {
    const existing = legs.find(
      (leg) =>
        sameInstrument(leg.instrument, fill.instrument) &&
        leg.instrument.multiplier === fill.instrument.multiplier &&
        leg.instrument.expiry === fill.instrument.expiry &&
        leg.instrument.underlying === fill.instrument.underlying,
    );
    if (existing === undefined) legs.push({ ...fill });
    else
      existing.quantity = new Decimal(existing.quantity)
        .plus(fill.quantity)
        .toFixed();
  }
  return legs;
}

/** Derive strategy type from contract directions, strikes, and total quantities. */
export function classifyLegs(fills: readonly Leg[]): string {
  const legs = aggregateLegs(fills);
  if (legs.some((leg) => signOf(leg.quantity) === 0)) return "custom";
  if (legs.length === 0) return "unresolved";
  if (legs.every((leg) => isStock(leg.instrument))) return "stock";
  if (legs.every((leg) => leg.instrument.assetClass === "FUT")) {
    if (legs.length !== 1) return "custom";
    return signOf(legs[0]?.quantity ?? "0") >= 0
      ? "long_future"
      : "short_future";
  }
  if (!legs.every((leg) => leg.instrument.assetClass === "OPT"))
    return "custom";

  const underlying = legs[0]?.instrument.underlying ?? null;
  const expiry = legs[0]?.instrument.expiry ?? null;
  if (
    !fills.every(
      (leg) =>
        leg.instrument.underlying === underlying &&
        leg.instrument.expiry === expiry,
    )
  ) {
    return "custom";
  }

  if (legs.length === 1) {
    const leg = legs[0];
    if (leg === undefined) return "custom";
    const direction = signOf(leg.quantity) > 0 ? "long" : "short";
    const kind =
      leg.instrument.putCall === "C"
        ? "call"
        : leg.instrument.putCall === "P"
          ? "put"
          : "option";
    return `${direction}_${kind}`;
  }

  if (underlying === null || expiry === null) return "custom";
  if (
    !legs.every(
      (leg) =>
        leg.instrument.strike !== null && leg.instrument.putCall !== null,
    )
  )
    return "custom";
  const multiplier = legs[0]?.instrument.multiplier;
  if (!fills.every((leg) => leg.instrument.multiplier === multiplier))
    return "custom";

  if (legs.length === 2) {
    const [first, second] = legs;
    if (first === undefined || second === undefined) return "custom";
    const firstSign = signOf(first.quantity);
    const secondSign = signOf(second.quantity);
    const equalUnits = new Decimal(first.quantity)
      .abs()
      .eq(new Decimal(second.quantity).abs());
    if (first.instrument.putCall !== second.instrument.putCall) {
      const put = first.instrument.putCall === "P" ? first : second;
      const call = first.instrument.putCall === "C" ? first : second;
      if (firstSign !== secondSign || !equalUnits) return "custom";
      const comparison = new Decimal(put.instrument.strike ?? 0).comparedTo(
        call.instrument.strike ?? 0,
      );
      if (comparison > 0) return "custom";
      const direction = firstSign > 0 ? "long" : "short";
      return `${direction}_${comparison === 0 ? "straddle" : "strangle"}`;
    }
    if (firstSign === secondSign) return "custom";
    const long = firstSign > 0 ? first : second;
    const short = firstSign < 0 ? first : second;
    const comparison = new Decimal(long.instrument.strike ?? 0).comparedTo(
      short.instrument.strike ?? 0,
    );
    if (comparison === 0) return "custom";
    const kind = long.instrument.putCall === "P" ? "put" : "call";
    if (equalUnits) return `${comparison < 0 ? "bull" : "bear"}_${kind}_spread`;
    const longUnits = new Decimal(long.quantity).abs();
    const shortUnits = new Decimal(short.quantity).abs();
    if (longUnits.lt(shortUnits)) return `${kind}_ratio_spread`;
    // A ZEBRA-shaped back ratio has the long strike farther ITM. Entry
    // extrinsic value is unavailable, so this remains explicitly a candidate.
    const deeperLong = kind === "call" ? comparison < 0 : comparison > 0;
    if (deeperLong && longUnits.eq(shortUnits.times(2)))
      return `${kind}_zebra_candidate`;
    return `${kind}_backspread`;
  }
  const byStrike = [...legs].sort((a, b) =>
    new Decimal(a.instrument.strike ?? 0).comparedTo(b.instrument.strike ?? 0),
  );
  if (byStrike.length === 3) {
    const puts = byStrike.filter((leg) => leg.instrument.putCall === "P");
    const calls = byStrike.filter((leg) => leg.instrument.putCall === "C");
    const [put] = puts;
    const [shortCall, longCall] = calls;
    if (
      puts.length === 1 &&
      calls.length === 2 &&
      put &&
      shortCall &&
      longCall &&
      signOf(put.quantity) < 0 &&
      new Decimal(put.quantity).eq(shortCall.quantity) &&
      new Decimal(put.quantity).negated().eq(longCall.quantity) &&
      new Decimal(put.instrument.strike ?? 0).lt(
        shortCall.instrument.strike ?? 0,
      ) &&
      new Decimal(shortCall.instrument.strike ?? 0).lt(
        longCall.instrument.strike ?? 0,
      )
    ) {
      return "jade_lizard";
    }
    const [low, middle, high] = byStrike;
    if (
      low &&
      middle &&
      high &&
      byStrike.every(
        (leg) => leg.instrument.putCall === low.instrument.putCall,
      ) &&
      new Decimal(low.quantity).eq(high.quantity) &&
      new Decimal(low.quantity).times(-2).eq(middle.quantity)
    ) {
      const leftWidth = new Decimal(middle.instrument.strike ?? 0).minus(
        low.instrument.strike ?? 0,
      );
      const rightWidth = new Decimal(high.instrument.strike ?? 0).minus(
        middle.instrument.strike ?? 0,
      );
      if (leftWidth.gt(0) && rightWidth.gt(0)) {
        const reverse = signOf(low.quantity) < 0 ? "short_" : "";
        const broken = leftWidth.eq(rightWidth) ? "" : "broken_wing_";
        const kind = low.instrument.putCall === "C" ? "call" : "put";
        return `${reverse}${broken}${kind}_butterfly`;
      }
    }
  }
  if (legs.length === 4) {
    const puts = byStrike.filter((leg) => leg.instrument.putCall === "P");
    const calls = byStrike.filter((leg) => leg.instrument.putCall === "C");
    const [lowPut, highPut] = puts;
    const [lowCall, highCall] = calls;
    if (
      puts.length === 2 &&
      calls.length === 2 &&
      lowPut &&
      highPut &&
      lowCall &&
      highCall &&
      new Decimal(lowPut.instrument.strike ?? 0).lt(
        highPut.instrument.strike ?? 0,
      ) &&
      new Decimal(lowCall.instrument.strike ?? 0).lt(
        highCall.instrument.strike ?? 0,
      ) &&
      new Decimal(highPut.instrument.strike ?? 0).lte(
        lowCall.instrument.strike ?? 0,
      ) &&
      new Decimal(lowPut.quantity).eq(highCall.quantity) &&
      new Decimal(lowPut.quantity).negated().eq(highPut.quantity) &&
      new Decimal(highPut.quantity).eq(lowCall.quantity)
    ) {
      const reverse = signOf(lowPut.quantity) < 0 ? "reverse_" : "";
      const kind = new Decimal(highPut.instrument.strike ?? 0).eq(
        lowCall.instrument.strike ?? 0,
      )
        ? "iron_butterfly"
        : "iron_condor";
      return `${reverse}${kind}`;
    }
  }
  return "custom";
}
