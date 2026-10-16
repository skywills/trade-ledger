import type { Instrument } from "./domain.js";

// Presentation/search aliases only. Never use these to construct contract keys
// or match allocations: broker Conids and contract attributes remain authoritative.
const SYMBOL_ALIASES = new Map([
  ["BRK A", "BRK.A"],
  ["BRK-A", "BRK.A"],
  ["BRK.A", "BRK.A"],
  ["BRK B", "BRK.B"],
  ["BRK-B", "BRK.B"],
  ["BRK.B", "BRK.B"],
]);

/** Only known whole-symbol aliases change; contract symbols stay verbatim. */
export function normalizeSymbol(symbol: string): string {
  return SYMBOL_ALIASES.get(symbol.trim().toUpperCase()) ?? symbol;
}

export function underlyingSymbol(
  instrument: Pick<Instrument, "underlying" | "symbol">,
): string {
  return normalizeSymbol(instrument.underlying ?? instrument.symbol);
}

/** Journal descriptions begin with an underlying followed by the strategy type. */
export function normalizeStrategyDescription(description: string): string {
  return description.replace(/^BRK[ .-][AB](?=\s|$)/i, normalizeSymbol);
}

export function normalizeUnderlyingKey(key: string): string {
  return key.startsWith("value:")
    ? `value:${normalizeSymbol(key.slice(6))}`
    : key;
}
