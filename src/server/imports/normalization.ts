import { Decimal } from "decimal.js";
import type {
  DecimalText,
  Execution,
  Instrument,
  Issue,
  RawRow,
  SourceRef,
} from "../../shared/domain.js";
import { splitCodes } from "./classification.js";

export function makeIssue(
  code: string,
  source: SourceRef,
  severity: Issue["severity"],
): Issue {
  return {
    key: `${source.importId}:${source.rowNumber}:${code}`,
    code,
    sources: [source],
    severity,
  };
}

export type DecimalParse =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "ok"; value: DecimalText };

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

const BROKER_ID_FIELDS = [
  "IBOrderID",
  "BrokerageOrderID",
  "IBExecID",
  "TradeID",
  "PositionActionID",
  "OrigOrderID",
  "OrigTradeID",
  "RelatedTradeID",
] as const;

const DERIVATIVE_ASSET_CLASSES: ReadonlySet<string> = new Set([
  "OPT",
  "WAR",
  "FUT",
]);

const EVENT_CODES: ReadonlyArray<readonly [string, Execution["event"]]> = [
  ["A", "assignment"],
  ["Ex", "exercise"],
  ["Exp", "expiry"],
  ["Ca", "cash_settlement"],
];

/**
 * Validates and canonicalizes a decimal without ever touching JS numbers.
 * Exponent notation and thousands separators are rejected; canonical output
 * keeps the source's fraction digits, strips a leading "+", strips leading
 * integer zeros, and collapses any signed zero to "0".
 */
export function canonicalDecimal(raw: string | undefined): DecimalParse {
  const text = raw?.trim() ?? "";
  if (text === "") return { status: "absent" };
  if (!DECIMAL_PATTERN.test(text)) return { status: "invalid" };
  let value: Decimal;
  try {
    value = new Decimal(text);
  } catch {
    return { status: "invalid" };
  }
  if (value.isZero()) return { status: "ok", value: "0" };
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  const [rawInteger = "", rawFraction = ""] = unsigned.split(".");
  const integer = rawInteger === "" ? "0" : rawInteger.replace(/^0+(?=\d)/, "");
  return {
    status: "ok",
    value: `${negative ? "-" : ""}${integer}${rawFraction === "" ? "" : `.${rawFraction}`}`,
  };
}

export type TimestampParse =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "ok"; date: string; timestamp: string };

const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/;
const TWS_DATETIME = /^(\d{4})(\d{2})(\d{2});(\d{2})(\d{2})(\d{2})?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isoDate(
  year: string,
  month: string,
  day: string,
): { date: string } | null {
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const yearNumber = Number(year);
  if (monthNumber < 1 || monthNumber > 12) return null;
  let maxDay = DAYS_IN_MONTH[monthNumber - 1] ?? 31;
  if (monthNumber === 2 && isLeapYear(yearNumber)) maxDay = 29;
  if (dayNumber < 1 || dayNumber > maxDay) return null;
  return { date: `${year}-${pad2(monthNumber)}-${pad2(dayNumber)}` };
}

function isoTime(
  hour: string,
  minute: string,
  second: string | undefined,
  fraction: string | undefined,
): string | null {
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second ?? "0");
  if (hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) return null;
  return `${hour}:${minute}:${pad2(secondNumber)}${fraction ?? ""}`;
}

/**
 * Normalizes source timestamps to ISO calendar values. The wall-clock time is
 * never shifted: source times stay exactly as recorded, so an unknown source
 * timezone can never be silently replaced by the server timezone.
 */
export function normalizeTimestamp(raw: string | undefined): TimestampParse {
  const text = raw?.trim() ?? "";
  if (text === "") return { status: "absent" };

  const isoMatch = ISO_DATETIME.exec(text);
  if (isoMatch) {
    const date = isoDate(
      isoMatch[1] ?? "",
      isoMatch[2] ?? "",
      isoMatch[3] ?? "",
    );
    const time = isoTime(
      isoMatch[4] ?? "",
      isoMatch[5] ?? "",
      isoMatch[6],
      isoMatch[7],
    );
    if (date === null || time === null) return { status: "invalid" };
    return { status: "ok", date: date.date, timestamp: `${date.date}T${time}` };
  }

  const twsMatch = TWS_DATETIME.exec(text);
  if (twsMatch) {
    const date = isoDate(
      twsMatch[1] ?? "",
      twsMatch[2] ?? "",
      twsMatch[3] ?? "",
    );
    const time = isoTime(
      twsMatch[4] ?? "",
      twsMatch[5] ?? "",
      twsMatch[6],
      undefined,
    );
    if (date === null || time === null) return { status: "invalid" };
    return { status: "ok", date: date.date, timestamp: `${date.date}T${time}` };
  }

  const dateMatch = ISO_DATE.exec(text) ?? COMPACT_DATE.exec(text);
  if (dateMatch) {
    const date = isoDate(
      dateMatch[1] ?? "",
      dateMatch[2] ?? "",
      dateMatch[3] ?? "",
    );
    if (date === null) return { status: "invalid" };
    return { status: "ok", date: date.date, timestamp: date.date };
  }

  return { status: "invalid" };
}

export function normalizeDate(raw: string | undefined): string | null {
  const parsed = normalizeTimestamp(raw);
  return parsed.status === "ok" ? parsed.date : null;
}

function brokerIdValue(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value === "" || value.toUpperCase() === "N/A") return null;
  return value;
}

export function normalizeExecution(
  row: RawRow,
  source: SourceRef,
  reportTimezone: string | null,
): { execution: Execution | null; issues: Issue[] } {
  const fields = row.fields;
  const issues: Issue[] = [];
  const fail = (code: string): void => {
    issues.push(makeIssue(code, source, "error"));
  };
  const requireText = (name: string): string | null => {
    const value = (fields[name] ?? "").trim();
    if (value === "") {
      fail(`missing_field.${name}`);
      return null;
    }
    return value;
  };
  const decimalFrom = (
    name: string,
    parsed: DecimalParse,
  ): DecimalText | null => {
    if (parsed.status === "invalid") {
      fail(`invalid_decimal.${name}`);
      return null;
    }
    return parsed.status === "ok" ? parsed.value : null;
  };
  const optionalDecimal = (name: string): DecimalText | null =>
    decimalFrom(name, canonicalDecimal(fields[name]));

  const account = requireText("ClientAccountID");
  const assetClass = requireText("AssetClass");
  const symbol = requireText("Symbol");
  const currency = requireText("CurrencyPrimary");

  let quantity: DecimalText | null = null;
  const parsedQuantity = canonicalDecimal(fields["Quantity"]);
  if (parsedQuantity.status === "absent") fail("missing_field.Quantity");
  else if (parsedQuantity.status === "invalid")
    fail("invalid_decimal.Quantity");
  else quantity = parsedQuantity.value;

  let timestamp = normalizeTimestamp(fields["DateTime"]);
  if (timestamp.status === "absent") {
    timestamp = normalizeTimestamp(fields["TradeDate"]);
  }
  let date: string | null = null;
  let rawDateTime: string | null = null;
  if (timestamp.status === "absent") fail("missing_field.DateTime");
  else if (timestamp.status === "invalid") fail("invalid_datetime.DateTime");
  else {
    date = timestamp.date;
    rawDateTime = timestamp.timestamp;
  }

  // Proceeds/IBCommission/Taxes are parsed exactly once; the conversion below
  // is the only place their invalid_decimal issues are raised, and the NetCash
  // derivation reuses the same parse results so keys stay unique.
  const proceedsParse = canonicalDecimal(fields["Proceeds"]);
  const proceeds = decimalFrom("Proceeds", proceedsParse);
  const commissionParse = canonicalDecimal(fields["IBCommission"]);
  const commission = decimalFrom("IBCommission", commissionParse);
  const taxesParse = canonicalDecimal(fields["Taxes"]);
  const taxes = decimalFrom("Taxes", taxesParse);
  const price = optionalDecimal("TradePrice");
  const basis = optionalDecimal("CostBasis");
  const brokerPnl = optionalDecimal("FifoPnlRealized");

  let netCash: DecimalText | null = null;
  const parsedNetCash = canonicalDecimal(fields["NetCash"]);
  if (parsedNetCash.status === "ok") netCash = parsedNetCash.value;
  else if (parsedNetCash.status === "invalid") fail("invalid_decimal.NetCash");
  else {
    let complete = true;
    let sawInvalidOperand = false;
    let sum = new Decimal(0);
    for (const parsed of [proceedsParse, commissionParse, taxesParse]) {
      if (parsed.status === "ok") sum = sum.plus(parsed.value);
      else if (parsed.status === "invalid") sawInvalidOperand = true;
      else complete = false;
    }
    if (complete) netCash = sum.toString();
    else if (!sawInvalidOperand) fail("missing_net_cash");
  }

  let expiry: string | null = null;
  const rawExpiry = (fields["Expiry"] ?? "").trim();
  if (rawExpiry !== "") {
    const parsedExpiry = normalizeDate(rawExpiry);
    if (parsedExpiry === null) fail("invalid_date.Expiry");
    else expiry = parsedExpiry;
  }
  const strike = optionalDecimal("Strike");
  const multiplier = optionalDecimal("Multiplier");
  if (
    multiplier === null &&
    DERIVATIVE_ASSET_CLASSES.has((assetClass ?? "").toUpperCase())
  ) {
    issues.push(makeIssue("missing_multiplier", source, "warning"));
  }
  const rawPutCall = (fields["Put/Call"] ?? "").trim().toUpperCase();
  let putCall: Instrument["putCall"] = null;
  if (rawPutCall === "P" || rawPutCall === "C") putCall = rawPutCall;
  else if (rawPutCall !== "") {
    issues.push(makeIssue("unexpected_put_call", source, "warning"));
  }
  const conid = (fields["Conid"] ?? "").trim();
  const underlying = (fields["UnderlyingSymbol"] ?? "").trim();
  const instrument: Instrument = {
    key: conid !== "" ? `conid:${conid}` : `symbol:${symbol ?? ""}`,
    assetClass: assetClass ?? "",
    symbol: symbol ?? "",
    underlying: underlying === "" ? null : underlying,
    conid: conid === "" ? null : conid,
    expiry,
    strike,
    putCall,
    multiplier,
  };

  const brokerIds: Record<string, string> = {};
  for (const name of BROKER_ID_FIELDS) {
    const value = brokerIdValue(fields[name]);
    if (value === null) continue;
    if (name === "OrigOrderID" && value === "0") continue;
    brokerIds[name] = value;
  }

  const codes = splitCodes(fields["Notes/Codes"]);
  const isOpen = codes.includes("O");
  const isClose = codes.includes("C");
  const action: Execution["action"] =
    isOpen && isClose
      ? "mixed"
      : isOpen
        ? "open"
        : isClose
          ? "close"
          : "unknown";
  let event: Execution["event"] = "trade";
  for (const [code, mapped] of EVENT_CODES) {
    if (codes.includes(code)) {
      event = mapped;
      break;
    }
  }

  const sourceTimezone = (fields["TimeZone"] ?? "").trim();
  const configuredTimezone = reportTimezone?.trim() ?? "";
  const timezone =
    sourceTimezone !== ""
      ? sourceTimezone
      : configuredTimezone !== ""
        ? configuredTimezone
        : null;

  if (
    issues.some((issue) => issue.severity === "error") ||
    account === null ||
    assetClass === null ||
    symbol === null ||
    currency === null ||
    quantity === null ||
    netCash === null ||
    date === null ||
    rawDateTime === null
  ) {
    return { execution: null, issues };
  }

  return {
    execution: {
      key: `exec:${source.importId}:${row.rowNumber}`,
      account,
      instrument,
      date,
      rawDateTime,
      timezone,
      quantity,
      price,
      currency,
      netCash,
      proceeds,
      commission,
      taxes,
      basis,
      brokerPnl,
      action,
      event,
      brokerIds,
      codes,
      sources: [source],
    },
    issues,
  };
}
