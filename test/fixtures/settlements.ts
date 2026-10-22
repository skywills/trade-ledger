import { buildExecutionTable, executionRow } from "./scenarios.js";

export const settlementHeaders = [
  "ClientAccountID",
  "Date",
  "SettleDate",
  "ActivityCode",
  "ActivityDescription",
  "TradeID",
  "RelatedTradeID",
  "OrderID",
  "Debit",
  "Credit",
  "CurrencyPrimary",
  "TransactionID",
  "Amount",
];

export function cashRow(
  patch: Record<string, string> = {},
): Record<string, string> {
  return {
    ClientAccountID: "SIM",
    Date: "20261016",
    SettleDate: "20261019",
    ActivityCode: "ADJ",
    ActivityDescription:
      "Option Cash Settlement for: Assignment ( SYN 16OCT26 100 C )",
    Debit: "-300",
    CurrencyPrimary: "USD",
    ...patch,
  };
}

export function fundsCsv(
  rows = [cashRow()],
  headers = settlementHeaders,
): string {
  const cell = (s: string) => `"${s.replaceAll('"', '""')}"`;
  return [
    headers.map(cell).join(","),
    ...rows.map((row) => headers.map((h) => cell(row[h] ?? "")).join(",")),
  ].join("\n");
}

export function settlementTrades(): string {
  return new TextDecoder().decode(
    buildExecutionTable(
      (
        [
          [
            "short-open",
            "SYN   261016C00100000",
            "20260901",
            "-1",
            "100",
            "-100",
            "0",
            "O",
          ],
          [
            "short-close",
            "SYN   261016C00100000",
            "20261016",
            "1",
            "0",
            "100",
            "-200",
            "C;A",
          ],
          [
            "long-open",
            "SYN   261016C00105000",
            "20260901",
            "1",
            "-20",
            "20",
            "0",
            "O",
          ],
          [
            "long-close",
            "SYN   261016C00105000",
            "20261016",
            "-1",
            "0",
            "-20",
            "80",
            "C;Ex",
          ],
        ] as const
      ).map(([id, symbol, date, quantity, cash, basis, pnl, codes]) =>
        executionRow({
          ClientAccountID: "SIM",
          AssetClass: "OPT",
          Symbol: symbol,
          UnderlyingSymbol: "SYN",
          CurrencyPrimary: "USD",
          TradeDate: date,
          DateTime: `${date};162000`,
          Quantity: quantity,
          TradePrice: "0",
          NetCash: cash,
          CostBasis: basis,
          FifoPnlRealized: pnl,
          "Notes/Codes": codes,
          IBExecID: id,
          TradeID: id,
          IBOrderID: id,
          Multiplier: "100",
        }),
      ),
    ),
  );
}

export function bothSettlements() {
  return [
    cashRow(),
    cashRow({
      ActivityDescription:
        "Option Cash Settlement for: Exercise ( SYN 16OCT26 105 C )",
      Debit: "",
      Credit: "100",
    }),
  ];
}
