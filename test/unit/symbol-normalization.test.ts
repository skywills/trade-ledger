import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { aggregateAnalytics } from "../../src/server/analytics/aggregate.js";
import { serializeAnalyticsCsv } from "../../src/server/analytics/csv.js";
import { selectAnalyticsDetails } from "../../src/server/analytics/details.js";
import {
  parseAnalyticsQuery,
  parseDetailQuery,
  parseExportQuery,
} from "../../src/server/analytics/query.js";
import {
  resolveScope,
  strategyUnderlying,
} from "../../src/server/analytics/scope.js";
import {
  emptyDraft,
  legOf,
  recomputePresentation,
} from "../../src/server/strategies/projection.js";
import { filterStrategies } from "../../src/web/journal/journalView.js";
import { execution, snapshot, strategy } from "../fixtures/analytics.js";

function berkshireSnapshot() {
  const s = snapshot();
  s.projection.strategies = [
    strategy({ id: "shares", description: "BRK B stock", brokerPnl: "10" }),
    strategy({ id: "option", description: "BRK-B long call", brokerPnl: "20" }),
    strategy({ id: "class-a", description: "BRK A stock", brokerPnl: "5" }),
  ];
  s.ledger.executions = ["BRK B", "BRK.B", "BRK-B"].map((symbol, i) =>
    execution({
      key: `shares-${i}`,
      instrument: {
        ...execution().instrument,
        symbol,
        underlying: null,
        key: "conid:100",
        conid: "100",
      },
    }),
  );
  s.ledger.executions.push(
    execution({
      key: "option",
      instrument: {
        ...execution().instrument,
        symbol: "BRK B  261218C00500000",
        underlying: "BRK B",
        assetClass: "OPT",
        key: "conid:200",
        conid: "200",
      },
    }),
    execution({
      key: "class-a",
      instrument: {
        ...execution().instrument,
        symbol: "BRK A",
        underlying: null,
        key: "conid:300",
        conid: "300",
      },
    }),
  );
  s.projection.allocations = s.ledger.executions.map((e) => ({
    strategyId: e.key.startsWith("shares-") ? "shares" : e.key,
    executionKey: e.key,
    quantity: "1",
    netCash: "-100",
    brokerPnl: "0",
    pnlEstimated: false,
    role: "close" as const,
  }));
  return s;
}

describe("Berkshire symbol normalization", () => {
  it("combines aliases in underlying groups without combining share classes or option symbols", () => {
    const s = berkshireSnapshot();
    const before = structuredClone(s);
    const result = aggregateAnalytics(
      s,
      parseAnalyticsQuery({ unit: "strategy", currency: "USD" }),
    );
    expect(result.byUnderlying).toEqual([
      expect.objectContaining({
        key: "value:BRK.B",
        label: "BRK.B",
        closed: 2,
        pnl: "30",
      }),
      expect.objectContaining({
        key: "value:BRK.A",
        label: "BRK.A",
        closed: 1,
        pnl: "5",
      }),
    ]);
    expect(result.options.symbols).toEqual([
      "BRK B  261218C00500000",
      "BRK.A",
      "BRK.B",
    ]);
    expect(result.transactions.tradedSymbols).toBe(3);
    expect(strategyUnderlying("shares", s)).toBe("value:BRK.B");
    expect(result.recent.find((x) => x.id === "shares")?.description).toBe(
      "BRK.B stock",
    );
    expect(s).toEqual(before);
  });

  it.each(["BRK B", "BRK.B", "BRK-B"])(
    "accepts %s in symbol and underlying filters and drill-down groups",
    (alias) => {
      const s = berkshireSnapshot();
      const exact = resolveScope(
        s,
        parseAnalyticsQuery({
          unit: "strategy",
          currency: "USD",
          symbol: alias,
        }),
      );
      expect(exact.executions.map((e) => e.key)).toEqual([
        "shares-0",
        "shares-1",
        "shares-2",
      ]);
      expect(exact.query.symbol).toBe("BRK.B");
      const underlying = resolveScope(
        s,
        parseAnalyticsQuery({
          unit: "strategy",
          currency: "USD",
          underlying: `value:${alias}`,
        }),
      );
      expect(underlying.closed.map((x) => x.id)).toEqual(["shares", "option"]);
      expect(underlying.executions).toHaveLength(4);
      expect(underlying.query.underlying).toBe("value:BRK.B");
      for (const kind of ["strategies", "transactions"]) {
        const details = selectAnalyticsDetails(
          s,
          parseDetailQuery({
            unit: "strategy",
            currency: "USD",
            kind,
            groupBy: "underlying",
            group: `value:${alias}`,
          }),
        );
        expect(details.total).toBe(kind === "strategies" ? 2 : 4);
        expect(details.filters.group).toBe("value:BRK.B");
      }
    },
  );

  it.each(["brk b", "BRK.B", "BRK-B", "BRK B stock"])(
    "finds canonical and older journal descriptions with %s",
    (query) => {
      const rows = [
        "BRK.B stock",
        "BRK B stock",
        "BRK-B stock",
        "BRK.A stock",
        "BRK BETA stock",
      ].map((description, i) => strategy({ id: String(i), description }));
      expect(
        filterStrategies(rows, { currency: "", status: "", query }).map(
          (s) => s.id,
        ),
      ).toEqual(["0", "1", "2"]);
    },
  );

  it("exports original contracts with their canonical underlying", () => {
    const rows = parse(
      serializeAnalyticsCsv(
        berkshireSnapshot(),
        parseExportQuery({
          unit: "strategy",
          currency: "USD",
          dataset: "transactions",
        }),
      ).csv,
      { columns: true },
    ) as Record<string, string>[];
    expect(rows.find((e) => e.key === "shares-0")).toMatchObject({
      symbol: "BRK B",
      underlying: "BRK.B",
    });
    expect(rows.find((e) => e.key === "option")).toMatchObject({
      symbol: "BRK B  261218C00500000",
      underlying: "BRK.B",
    });
  });

  it("uses the canonical underlying in newly projected journal descriptions", () => {
    const draft = emptyDraft("berkshire");
    draft.openingLegs = [
      legOf(
        execution({
          instrument: {
            ...execution().instrument,
            symbol: "BRK B",
            underlying: null,
          },
        }),
        "open",
      ),
    ];
    recomputePresentation(draft);
    expect(draft.description).toBe("BRK.B Stock");
  });
});
