import { Decimal } from "decimal.js";
import type { Execution, Issue } from "../../shared/domain.js";
import { isDerivative, isStock, sameInstrument } from "./matching.js";
import { makeIssue } from "./projection.js";

const CLOSING_EVENTS: ReadonlySet<Execution["event"]> = new Set([
  "assignment",
  "exercise",
  "expiry",
  "cash_settlement",
]);

export function isClosingEvent(event: Execution["event"]): boolean {
  return CLOSING_EVENTS.has(event);
}

/**
 * A booked derivative event carrying a zero price and zero cash flow but no
 * explicit lifecycle code. An action ID still needs a validated counterpart.
 * These are unresolved until linked; they must
 * never be silently classified as an ordinary trade or assigned a price.
 */
export function looksLikeBookedEvent(execution: Execution): boolean {
  if (execution.event !== "trade") return false;
  if (!isDerivative(execution.instrument)) return false;
  if (execution.action === "open") return false;
  const zeroPrice =
    execution.price === null || new Decimal(execution.price).isZero();
  const zeroCash = new Decimal(execution.netCash || "0").isZero();
  return zeroPrice && zeroCash;
}

/**
 * Validates contract, event, and share-unit consistency for a lifecycle link.
 * Returns an issue when the pair cannot be linked rather than inventing a
 * relationship; multiplier-free option reconciliation is a warning.
 */
export function validateLifecycle(
  event: string,
  source: Execution,
  target: Execution,
): Issue | null {
  const sources = [...source.sources, ...target.sources];
  const inconsistent = (severity: Issue["severity"], scope: string): Issue =>
    makeIssue("LIFECYCLE_INCONSISTENT", sources, severity, scope);

  if (source.account !== target.account) {
    return inconsistent("error", `${source.key}:account`);
  }

  if (event === "assignment" || event === "exercise") {
    const option =
      source.instrument.assetClass === "OPT"
        ? source
        : target.instrument.assetClass === "OPT"
          ? target
          : null;
    const stock = isStock(source.instrument)
      ? source
      : isStock(target.instrument)
        ? target
        : null;
    if (option === null || stock === null) {
      return inconsistent("error", `${source.key}:legs`);
    }
    const optionUnderlying = option.instrument.underlying;
    const stockUnderlying = stock.instrument.underlying;
    if (
      optionUnderlying !== null &&
      stockUnderlying !== null &&
      optionUnderlying !== stockUnderlying
    ) {
      return inconsistent("error", `${source.key}:underlying`);
    }
    // An adjusted option's premium multiplier is not its share deliverable.
    // Until deliverable metadata is available, do not certify a stock link
    // from the premium multiplier (e.g. SQQQ2 may deliver fewer than 100 shares).
    const symbol = option.instrument.symbol.trim();
    const root = /^(\S{1,6}?)\s*\d{6}[CP]\d{8}$/.exec(symbol)?.[1] ?? symbol;
    if (/\d$/.test(root) && root !== optionUnderlying) {
      return inconsistent("warning", `${source.key}:deliverable`);
    }
    const multiplier = option.instrument.multiplier;
    if (multiplier === null) {
      return inconsistent("warning", `${source.key}:multiplier`);
    }
    const expected = new Decimal(option.quantity).times(
      new Decimal(multiplier),
    );
    const actual = new Decimal(stock.quantity);
    if (!expected.abs().eq(actual.abs())) {
      return inconsistent("error", `${source.key}:quantity`);
    }
    return null;
  }

  if (event === "expiry" || event === "cash_settlement") {
    if (!sameInstrument(source.instrument, target.instrument)) {
      return inconsistent("error", `${source.key}:contract`);
    }
    return null;
  }

  if (event === "roll") {
    if (source.instrument.underlying !== target.instrument.underlying) {
      return inconsistent("error", `${source.key}:underlying`);
    }
    return null;
  }

  return inconsistent("error", `${source.key}:event`);
}
