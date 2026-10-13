import { describe, expect, it } from "vitest";
import { parseFlex } from "../../src/server/imports/csv.js";
import { normalizeExecution } from "../../src/server/imports/normalization.js";
import type { RawRow, SourceRef } from "../../src/shared/domain.js";
import { fixtures } from "../fixtures/scenarios.js";

const encoder = new TextEncoder();

function csvFile(lines: readonly string[], eol = "\n"): Uint8Array {
  return encoder.encode(lines.join(eol) + eol);
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvLine(cells: readonly string[]): string {
  return cells.map(csvCell).join(",");
}

const ref: SourceRef = { importId: "test-import", rowNumber: 2 };

function expectRow(rows: readonly RawRow[], index: number): RawRow {
  const row = rows[index];
  if (row === undefined) throw new Error(`Expected row at index ${index}`);
  return row;
}

function validExecutionFields(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ClientAccountID: "SIM-A",
    AssetClass: "OPT",
    Symbol: "AXON",
    UnderlyingSymbol: "AXON",
    Conid: "9000470",
    CurrencyPrimary: "USD",
    TradeDate: "2026-09-03",
    DateTime: "2026-09-03 10:00:00",
    Quantity: "+1",
    TradePrice: "14.02",
    Proceeds: "-1402",
    IBCommission: "-0.23",
    Taxes: "0",
    NetCash: "-1402.23006",
    FifoPnlRealized: "",
    "Notes/Codes": "O",
    IBOrderID: "ORDER-1",
    BrokerageOrderID: "BROKER-1",
    IBExecID: "EXEC-1",
    TradeID: "TRADE-A-1",
    Expiry: "20261016",
    Strike: "470",
    "Put/Call": "P",
    Multiplier: "100",
    ...overrides,
  };
}

function rawRow(fields: Record<string, string>): RawRow {
  return { rowNumber: 2, section: null, fields, kind: "execution", issues: [] };
}

describe("parseFlex", () => {
  it("classifies the spread fixture into 4 executions and 2 supporting lots", () => {
    const parsed = parseFlex(fixtures.spread);
    expect(parsed.rows.filter((row) => row.kind === "execution")).toHaveLength(
      4,
    );
    expect(parsed.rows.filter((row) => row.kind === "lot")).toHaveLength(2);
    expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.capabilities).toContain("layout:header-first");
    expect(parsed.capabilities).toContain("field:TradeID");
    expect(parsed.capabilities).toContain("field:IBExecID");
    expect(parsed.issues).toHaveLength(0);
    expect(expectRow(parsed.rows, 0).rowNumber).toBe(2);
    expect(expectRow(parsed.rows, 5).rowNumber).toBe(7);
  });

  it("classifies an ST-coded row with a TradeID as an execution, not a lot", () => {
    const stCodedExecutionWithTradeId = csvFile([
      csvLine([
        "ClientAccountID",
        "AssetClass",
        "Symbol",
        "CurrencyPrimary",
        "TradeDate",
        "DateTime",
        "Quantity",
        "TradePrice",
        "NetCash",
        "Notes/Codes",
        "TradeID",
      ]),
      csvLine([
        "SIM-A",
        "OPT",
        "AXON",
        "USD",
        "2026-09-25",
        "2026-09-25 11:00:00",
        "-1",
        "38.20",
        "3820.8776968",
        "ST",
        "TRADE-X",
      ]),
    ]);
    const parsed = parseFlex(stCodedExecutionWithTradeId);
    expect(parsed.rows[0]?.kind).toBe("execution");
  });

  it("parses UTF-8 input with a BOM and CRLF line endings", () => {
    const bomCrlf = csvFile(
      [
        `\uFEFF${csvLine(["ClientAccountID", "AssetClass", "Symbol", "CurrencyPrimary", "DateTime", "Quantity", "NetCash", "TradeID", "LevelOfDetail"])}`,
        csvLine([
          "SIM-A",
          "OPT",
          "AXON",
          "USD",
          "2026-09-03 10:00:00",
          "+1",
          "-1402.23006",
          "TRADE-BOM",
          "EXECUTION",
        ]),
      ],
      "\r\n",
    );
    const parsed = parseFlex(bomCrlf);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.rows).toHaveLength(1);
    expect(expectRow(parsed.rows, 0).fields.ClientAccountID).toBe("SIM-A");
    expect(expectRow(parsed.rows, 0).kind).toBe("execution");
  });

  it("supports quoted commas and multiline descriptions inside one record", () => {
    const quoted = csvFile([
      csvLine([
        "ClientAccountID",
        "AssetClass",
        "Symbol",
        "CurrencyPrimary",
        "DateTime",
        "Quantity",
        "NetCash",
        "TradeID",
        "Description",
      ]),
      csvLine([
        "SIM-A",
        "OPT",
        "AXON",
        "USD",
        "2026-09-03 10:00:00",
        "+1",
        "-1402.23006",
        "TRADE-Q",
        "sell 1, then\nroll next week",
      ]),
    ]);
    const parsed = parseFlex(quoted);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.kind).toBe("execution");
    expect(expectRow(parsed.rows, 0).fields.Description).toBe(
      "sell 1, then\nroll next week",
    );
  });

  it("keeps parsing across repeated accounts and repeated header rows", () => {
    const headers = csvLine([
      "ClientAccountID",
      "AssetClass",
      "Symbol",
      "CurrencyPrimary",
      "DateTime",
      "Quantity",
      "NetCash",
      "TradeID",
    ]);
    const first = csvLine([
      "SIM-A",
      "OPT",
      "AXON",
      "USD",
      "2026-09-03 10:00:00",
      "+1",
      "-1402.23006",
      "TRADE-1",
    ]);
    const second = csvLine([
      "SIM-B",
      "OPT",
      "AXON",
      "USD",
      "2026-09-03 10:00:00",
      "-1",
      "1686.7318978",
      "TRADE-2",
    ]);
    const parsed = parseFlex(csvFile([headers, first, headers, second]));
    expect(parsed.issues).toHaveLength(0);
    const executions = parsed.rows.filter((row) => row.kind === "execution");
    expect(executions).toHaveLength(2);
    expect(parsed.rows).toHaveLength(2);
    expect(expectRow(executions, 0).fields.ClientAccountID).toBe("SIM-A");
    expect(expectRow(executions, 1).fields.ClientAccountID).toBe("SIM-B");
  });

  it("maps the exact spec header aliases to canonical fields", () => {
    const aliased = csvFile([
      csvLine([
        "ClientAccountID",
        "AssetClass",
        "Symbol",
        "CurrencyPrimary",
        "Date/Time",
        "Quantity",
        "Price",
        "Commission",
        "NetCash",
        "Code",
        "OrderID",
        "ExecID",
        "TradeID",
      ]),
      csvLine([
        "SIM-A",
        "OPT",
        "AXON",
        "USD",
        "2026-09-03 10:00:00",
        "+1",
        "14.02",
        "-0.23",
        "-1402.23006",
        "O",
        "ORDER-9",
        "EXEC-9",
        "TRADE-9",
      ]),
    ]);
    const parsed = parseFlex(aliased);
    const row = expectRow(parsed.rows, 0);
    expect(row.kind).toBe("execution");
    expect(row.fields.TradePrice).toBe("14.02");
    expect(row.fields.IBCommission).toBe("-0.23");
    expect(row.fields.DateTime).toBe("2026-09-03 10:00:00");
    expect(row.fields["Notes/Codes"]).toBe("O");

    const { execution } = normalizeExecution(row, ref, null);
    expect(execution?.price).toBe("14.02");
    expect(execution?.commission).toBe("-0.23");
    expect(execution?.rawDateTime).toBe("2026-09-03T10:00:00");
    expect(execution?.codes).toEqual(["O"]);
    expect(execution?.brokerIds.IBOrderID).toBe("ORDER-9");
    expect(execution?.brokerIds.IBExecID).toBe("EXEC-9");
  });

  it("splits semicolon-separated codes into individual code values", () => {
    const parsed = parseFlex(fixtures.assignment);
    const row = expectRow(parsed.rows, 0);
    const { execution } = normalizeExecution(row, ref, null);
    expect(execution?.codes).toEqual(["A", "C"]);
    expect(execution?.event).toBe("assignment");
    expect(execution?.action).toBe("close");
  });

  it("classifies no-ID ST rows as lots but zero-priced identified events as executions", () => {
    const headers = csvLine([
      "ClientAccountID",
      "AssetClass",
      "Symbol",
      "CurrencyPrimary",
      "TradeDate",
      "DateTime",
      "Quantity",
      "TradePrice",
      "NetCash",
      "FifoPnlRealized",
      "Notes/Codes",
      "TradeID",
    ]);
    const supportingLot = csvLine([
      "SIM-A",
      "OPT",
      "AXON",
      "USD",
      "2026-09-25",
      "2026-09-25 11:00:00",
      "+1",
      "",
      "",
      "2418.647637",
      "ST",
      "",
    ]);
    const zeroPricedEvent = csvLine([
      "SIM-A",
      "OPT",
      "AXON",
      "USD",
      "2026-09-24",
      "2026-09-24 10:00:00",
      "+1",
      "0",
      "0",
      "",
      "A;C",
      "TRADE-Z",
    ]);
    const parsed = parseFlex(
      csvFile([headers, supportingLot, zeroPricedEvent]),
    );
    expect(expectRow(parsed.rows, 0).kind).toBe("lot");
    expect(expectRow(parsed.rows, 1).kind).toBe("execution");

    const { execution } = normalizeExecution(
      rawRow(expectRow(parsed.rows, 1).fields),
      ref,
      null,
    );
    expect(execution?.price).toBe("0");
    expect(execution?.netCash).toBe("0");
    expect(execution?.brokerPnl).toBeNull();
  });

  it("keeps summary rows distinct from executions", () => {
    const headers = csvLine([
      "ClientAccountID",
      "Symbol",
      "CurrencyPrimary",
      "Quantity",
      "NetCash",
      "LevelOfDetail",
    ]);
    const summary = csvLine(["SIM-A", "AXON", "USD", "+1", "-1402", "SUMMARY"]);
    const parsed = parseFlex(csvFile([headers, summary]));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.kind).toBe("summary");
    expect(parsed.rows.filter((row) => row.kind === "execution")).toHaveLength(
      0,
    );
  });

  it("preserves the source timezone and never applies the server timezone", () => {
    const withSourceZone = normalizeExecution(
      rawRow(validExecutionFields({ TimeZone: "EST" })),
      ref,
      null,
    ).execution;
    expect(withSourceZone?.timezone).toBe("EST");
    expect(withSourceZone?.rawDateTime).toBe("2026-09-03T10:00:00");
    expect(withSourceZone?.rawDateTime.endsWith("Z")).toBe(false);
    expect(withSourceZone?.date).toBe("2026-09-03");

    const withReportZone = normalizeExecution(
      rawRow(validExecutionFields()),
      ref,
      "America/New_York",
    ).execution;
    expect(withReportZone?.timezone).toBe("America/New_York");
    expect(withReportZone?.rawDateTime).toBe("2026-09-03T10:00:00");

    const dateOnly = normalizeExecution(
      rawRow(validExecutionFields({ DateTime: "", TradeDate: "20260903" })),
      ref,
      null,
    ).execution;
    expect(dateOnly?.date).toBe("2026-09-03");
    expect(dateOnly?.rawDateTime).toBe("2026-09-03");
  });

  it("rejects bytes that are not valid UTF-8 with an explanatory issue", () => {
    const parsed = parseFlex(new Uint8Array([0xff, 0xfe, 0x41, 0x0a]));
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.code).toBe("invalid_utf8");
    expect(parsed.issues[0]?.severity).toBe("error");
    expect(parsed.capabilities).toContain("encoding:rejected-non-utf8");
    expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects input exceeding the byte limit and honors the 20 MiB default", () => {
    const overLimit = parseFlex(
      fixtures.spread,
      fixtures.spread.byteLength - 1,
    );
    expect(overLimit.rows).toHaveLength(0);
    expect(overLimit.issues.map((issue) => issue.code)).toEqual([
      "input_oversize",
    ]);

    const atLimit = parseFlex(fixtures.spread, fixtures.spread.byteLength);
    expect(atLimit.issues.map((issue) => issue.code)).not.toContain(
      "input_oversize",
    );

    const defaultLimit = parseFlex(new Uint8Array(20971521));
    expect(defaultLimit.issues.map((issue) => issue.code)).toEqual([
      "input_oversize",
    ]);
  });

  it("preserves unknown columns and reports them as a capability", () => {
    const unknownColumn = csvFile([
      csvLine([
        "ClientAccountID",
        "Symbol",
        "CurrencyPrimary",
        "DateTime",
        "Quantity",
        "NetCash",
        "TradeID",
        "UserNote",
      ]),
      csvLine([
        "SIM-A",
        "AXON",
        "USD",
        "2026-09-03 10:00:00",
        "+1",
        "-1402.23006",
        "TRADE-U",
        "keep me",
      ]),
    ]);
    const parsed = parseFlex(unknownColumn);
    expect(parsed.issues).toHaveLength(0);
    expect(expectRow(parsed.rows, 0).fields.UserNote).toBe("keep me");
    expect(parsed.capabilities).toContain("unknown_columns:preserved");
  });

  it("reports unknown sections as capability diagnostics and quarantines unknown rows", () => {
    const sectioned = csvFile([
      "BOF",
      csvLine([
        "ClientAccountID",
        "Symbol",
        "CurrencyPrimary",
        "DateTime",
        "Quantity",
        "NetCash",
        "TradeID",
        "LevelOfDetail",
      ]),
      csvLine([
        "SIM-A",
        "AXON",
        "USD",
        "2026-09-03 10:00:00",
        "+1",
        "-1402.23006",
        "TRADE-S",
        "EXECUTION",
      ]),
      "Notes",
      "xx,yy",
    ]);
    const parsed = parseFlex(sectioned);
    expect(parsed.capabilities).toContain("layout:flex-sectioned");
    expect(parsed.capabilities).toContain("unknown_section:Notes");
    expect(parsed.rows.map((row) => row.kind)).toEqual([
      "marker",
      "execution",
      "marker",
      "quarantine",
    ]);
    const quarantined = parsed.rows[3];
    expect(quarantined?.issues.map((issue) => issue.code)).toEqual([
      "column_count_mismatch",
      "unknown_row_type",
    ]);
    expect(parsed.issues.map((issue) => issue.code)).toEqual([
      "unknown_row_type",
    ]);
  });
});

describe("normalizeExecution", () => {
  it("returns null with issues for an invalid decimal quantity", () => {
    const badDecimalRow = rawRow(validExecutionFields({ Quantity: "12.3.4" }));
    const result = normalizeExecution(badDecimalRow, ref, null);
    expect(result.execution).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "invalid_decimal.Quantity",
    ]);
    expect(result.issues[0]?.severity).toBe("error");
    expect(result.issues[0]?.sources).toEqual([ref]);
  });

  it("distinguishes missing broker P/L from an explicit zero", () => {
    const missing = normalizeExecution(
      rawRow(validExecutionFields()),
      ref,
      null,
    ).execution;
    expect(missing?.brokerPnl).toBeNull();

    const explicitZero = normalizeExecution(
      rawRow(validExecutionFields({ FifoPnlRealized: "0" })),
      ref,
      null,
    ).execution;
    expect(explicitZero?.brokerPnl).toBe("0");
  });

  it("derives NetCash only from complete accounting operands", () => {
    const derived = normalizeExecution(
      rawRow(
        validExecutionFields({
          NetCash: "",
          Proceeds: "100",
          IBCommission: "-1",
          Taxes: "0",
        }),
      ),
      ref,
      null,
    ).execution;
    expect(derived?.netCash).toBe("99");

    const incomplete = normalizeExecution(
      rawRow(
        validExecutionFields({
          NetCash: "",
          Proceeds: "100",
          IBCommission: "-1",
          Taxes: "",
        }),
      ),
      ref,
      null,
    );
    expect(incomplete.execution).toBeNull();
    expect(incomplete.issues.map((issue) => issue.code)).toEqual([
      "missing_net_cash",
    ]);
  });

  it("quarantines rows missing minimum required fields", () => {
    const missingSymbol = normalizeExecution(
      rawRow(validExecutionFields({ Symbol: "" })),
      ref,
      null,
    );
    expect(missingSymbol.execution).toBeNull();
    expect(missingSymbol.issues.map((issue) => issue.code)).toEqual([
      "missing_field.Symbol",
    ]);
  });

  it("canonicalizes decimals without server-side float arithmetic", () => {
    const canonical = normalizeExecution(
      rawRow(
        validExecutionFields({
          Quantity: "+1",
          NetCash: "-1402.23006",
          Strike: "007.50",
        }),
      ),
      ref,
      null,
    ).execution;
    expect(canonical?.quantity).toBe("1");
    expect(canonical?.netCash).toBe("-1402.23006");
    expect(canonical?.instrument.strike).toBe("7.50");
  });

  it("maps open/close codes to actions and lifecycle codes to events", () => {
    const open = normalizeExecution(
      rawRow(validExecutionFields()),
      ref,
      null,
    ).execution;
    expect(open?.action).toBe("open");
    expect(open?.event).toBe("trade");

    const both = normalizeExecution(
      rawRow(validExecutionFields({ "Notes/Codes": "O;C" })),
      ref,
      null,
    ).execution;
    expect(both?.action).toBe("mixed");

    const exercise = normalizeExecution(
      rawRow(validExecutionFields({ "Notes/Codes": "C;Ex" })),
      ref,
      null,
    ).execution;
    expect(exercise?.event).toBe("exercise");
    expect(exercise?.action).toBe("close");
  });

  it("normalizes instrument fields and warns on missing multipliers", () => {
    const result = normalizeExecution(
      rawRow(validExecutionFields({ Multiplier: "" })),
      ref,
      null,
    );
    expect(result.execution).not.toBeNull();
    expect(result.execution?.instrument).toMatchObject({
      key: "conid:9000470",
      assetClass: "OPT",
      symbol: "AXON",
      underlying: "AXON",
      conid: "9000470",
      expiry: "2026-10-16",
      putCall: "P",
      multiplier: null,
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "missing_multiplier",
    ]);
    expect(result.issues[0]?.severity).toBe("warning");
  });
});
