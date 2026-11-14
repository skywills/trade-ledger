import type { PnlSlice } from "../../src/server/strategies/reconstructed-pnl.js";
import { execution } from "./analytics.js";

export function futuresSpread(
  variant: "mtm-gap" | "coincidental-match",
): PnlSlice[] {
  const quantities = ["-1", "1", "1", "-1"];
  const prices =
    variant === "mtm-gap"
      ? ["196.9", "194.3", "197.3", "195.2"]
      : ["197.2", "191.5", "197.5", "192.3"];
  const proceeds =
    variant === "mtm-gap"
      ? ["9845", "-9715", "-9865", "9760"]
      : ["9860", "-9575", "-9875", "9615"];
  const cash =
    variant === "mtm-gap"
      ? ["-72.6333", "-2.6377", "72.3667", "-2.6377"]
      : ["-67.6333", "62.3623", "72.3667", "-52.6377"];
  const commissions = [
    "-2.633313103",
    "-2.637697079",
    "-2.633313103",
    "-2.637697079",
  ];
  return quantities.map((quantity, i) => {
    const contract = i < 2 ? "A" : "B";
    const row = execution({
      key: `synthetic-${i}`,
      account: "SIM-FUT",
      quantity,
      price: prices[i] ?? "",
      proceeds: proceeds[i] ?? "",
      netCash: cash[i] ?? "",
      commission: commissions[i] ?? "",
      brokerPnl: i === 1 ? "7.22899" : i === 3 ? "7.22899" : null,
      action: i % 2 ? "close" : "open",
      instrument: {
        key: `future-${contract}`,
        assetClass: "FUT",
        symbol: contract,
        underlying: null,
        conid: `synthetic-${contract}`,
        expiry: "2027-03-19",
        strike: null,
        putCall: null,
        multiplier: "50",
      },
    });
    return { execution: row, quantity, netCash: cash[i] ?? "" };
  });
}
