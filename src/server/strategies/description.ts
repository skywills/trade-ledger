import { Decimal } from "decimal.js";
import { underlyingSymbol } from "../../shared/symbols.js";
import { aggregateLegs, type Leg } from "./matching.js";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function expiryLabel(expiry: string | null): string {
  if (expiry === null) return "Unknown Expiry";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (match === null) return expiry;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return expiry;
  return `${month}${Number(match[3])}'${match[1]?.slice(-2)}`;
}

/** Long-to-short units reduced to their smallest whole-number ratio. */
function ratioLabel(legs: readonly Leg[]): string {
  let long = new Decimal(0);
  let short = new Decimal(0);
  for (const leg of legs) {
    const quantity = new Decimal(leg.quantity);
    if (quantity.gt(0)) long = long.plus(quantity);
    else short = short.plus(quantity.abs());
  }
  if (long.isZero() || short.isZero()) return "";
  let divisor = long;
  let remainder = short;
  while (!remainder.isZero()) {
    const next = divisor.mod(remainder);
    divisor = remainder;
    remainder = next;
  }
  return `${long.div(divisor).toFixed()}×${short.div(divisor).toFixed()}`;
}

/** Stable opening-contract description shared by journal, details, and chat. */
export function describeLegs(type: string, fills: readonly Leg[]): string {
  const legs = aggregateLegs(fills);
  const symbols = [
    ...new Set(legs.map((leg) => underlyingSymbol(leg.instrument))),
  ]
    .sort()
    .join("/");
  const name = type
    .split("_")
    .map((word) =>
      word === "zebra" ? "ZEBRA" : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
  const optionLegs = legs.filter((leg) => leg.instrument.assetClass === "OPT");
  const mixedTypes =
    new Set(
      optionLegs
        .map((leg) => leg.instrument.putCall)
        .filter((kind) => kind !== null),
    ).size > 1;
  const expiries = [
    ...new Set(
      legs
        .filter(
          (leg) =>
            leg.instrument.expiry !== null ||
            leg.instrument.assetClass === "OPT",
        )
        .map((leg) => leg.instrument.expiry),
    ),
  ].sort((a, b) => (a ?? "").localeCompare(b ?? ""));
  const contracts = expiries
    .map((expiry) => {
      const strikes = optionLegs
        .filter(
          (leg) =>
            leg.instrument.expiry === expiry && leg.instrument.strike !== null,
        )
        .map((leg) => ({
          strike: new Decimal(leg.instrument.strike ?? 0),
          kind: mixedTypes ? (leg.instrument.putCall ?? "") : "",
        }))
        .sort(
          (a, b) =>
            a.strike.comparedTo(b.strike) || a.kind.localeCompare(b.kind),
        );
      const tokens = [
        ...new Set(
          strikes.map(({ strike, kind }) => `${strike.toFixed()}${kind}`),
        ),
      ];
      return [expiryLabel(expiry), tokens.join("/")].filter(Boolean).join(" ");
    })
    .join(" / ");
  const ratio = /(?:ratio_spread|backspread|zebra_candidate)$/.test(type)
    ? ratioLabel(legs)
    : "";
  return [symbols, contracts, ratio, name].filter(Boolean).join(" ");
}
