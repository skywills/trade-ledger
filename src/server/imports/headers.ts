export const CANONICAL_FIELDS = [
  "ClientAccountID",
  "AssetClass",
  "Symbol",
  "UnderlyingSymbol",
  "Conid",
  "CurrencyPrimary",
  "TradeDate",
  "DateTime",
  "Quantity",
  "TradePrice",
  "Proceeds",
  "IBCommission",
  "Taxes",
  "NetCash",
  "FifoPnlRealized",
  "CostBasis",
  "Notes/Codes",
  "IBOrderID",
  "BrokerageOrderID",
  "IBExecID",
  "TradeID",
  "Expiry",
  "Strike",
  "Put/Call",
  "Multiplier",
  "LevelOfDetail",
  "OpenDateTime",
  "PositionActionID",
  "TimeZone",
  "OrigOrderID",
  "OrigTradeID",
  "RelatedTradeID",
  "ClosePrice",
  "Open/CloseIndicator",
  "Date",
  "SettleDate",
  "ActivityCode",
  "ActivityDescription",
  "Debit",
  "Credit",
  "Amount",
  "TransactionID",
  "TradeQuantity",
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

const CANONICAL_FIELD_SET: ReadonlySet<string> = new Set(CANONICAL_FIELDS);

export const HEADER_ALIASES: Readonly<Record<string, CanonicalField>> = {
  Price: "TradePrice",
  Commission: "IBCommission",
  Code: "Notes/Codes",
  "Date/Time": "DateTime",
  OrderID: "IBOrderID",
  ExecID: "IBExecID",
  OpenCloseIndicator: "Open/CloseIndicator",
  Currency: "CurrencyPrimary",
  "Account ID": "ClientAccountID",
  "Activity Code": "ActivityCode",
  "Activity Description": "ActivityDescription",
  "Settle Date": "SettleDate",
  "Transaction ID": "TransactionID",
};

const MIN_HEADER_MATCHES = 3;

/**
 * Normalizes one header cell to its canonical field name. Unknown columns keep
 * their original name so they are preserved verbatim in row fields.
 */
export function canonicalizeHeader(raw: string): string {
  const name = raw.replace(/^\uFEFF/, "").trim();
  return HEADER_ALIASES[name] ?? name;
}

export function isCanonicalField(name: string): boolean {
  return CANONICAL_FIELD_SET.has(name);
}

/**
 * Detects header records by field names, never by fixed row offsets. A record
 * is a header when enough of its cells canonicalize to known field names.
 */
export function isHeaderRecord(record: readonly string[]): boolean {
  let matches = 0;
  for (const cell of record) {
    if (isCanonicalField(canonicalizeHeader(cell))) {
      matches += 1;
      if (matches >= MIN_HEADER_MATCHES) return true;
    }
  }
  return false;
}

export function buildFieldMap(
  record: readonly string[],
  headerNames: readonly string[],
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let index = 0; index < headerNames.length; index += 1) {
    const name = headerNames[index];
    if (name === undefined || name === "") continue;
    fields[name] = record[index] ?? "";
  }
  return fields;
}
