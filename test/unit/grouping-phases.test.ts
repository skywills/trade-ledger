import { describe, expect, it } from "vitest";
import { groupStrategies } from "../../src/server/strategies/grouping.js";
import type {
  Decision,
  Execution,
  LedgerSnapshot,
} from "../../src/shared/domain.js";
import { execution, stock } from "../fixtures/lifecycles.js";

const resolveId = (account: string, keys: string[]): string =>
  `${account}:${[...keys].sort().join("+")}`;

function ledger(executions: Execution[]): LedgerSnapshot {
  return {
    id: "ledger",
    inputHash: "input",
    executions,
    lots: [],
    issues: [],
    conflicts: 0,
  };
}

function decision(
  kind: string,
  payload: Record<string, unknown>,
  sequence = 1,
): Decision {
  return {
    id: `decision-${sequence}`,
    sequence,
    kind,
    payload,
    sources: [],
    strategyIds: [],
    supersedesId: null,
  };
}

const open = (key: string, quantity = "10", cash = "-100") =>
  execution(key, stock, quantity, cash, 1, "open");
const close = (key: string, quantity = "-4", cash = "60") =>
  execution(key, stock, quantity, cash, 2, "close");

function canonical(result: ReturnType<typeof groupStrategies>) {
  return {
    ...result,
    strategies: result.strategies.map((s) => ({
      ...s,
      positions: [...s.positions].sort((a, b) =>
        a.instrumentKey.localeCompare(b.instrumentKey),
      ),
    })),
  };
}

describe("grouping phase contracts", () => {
  it("preserves partial-close exposure, allocations and identity regardless of input order", () => {
    const opening = open("opening");
    const closing = close("closing");
    const input = ledger([opening, closing]);
    const before = structuredClone(input);
    const result = groupStrategies(input, [], resolveId);
    expect(result.strategies).toHaveLength(1);
    expect(result.strategies[0]).toMatchObject({
      id: "A:opening",
      status: "partially_closed",
      positions: [{ instrumentKey: "stock", quantity: "6" }],
    });
    expect(result.allocations).toEqual([
      {
        strategyId: "A:opening",
        executionKey: "closing",
        quantity: "-4",
        netCash: "60",
        brokerPnl: "0",
        pnlEstimated: false,
        role: "close",
      },
      {
        strategyId: "A:opening",
        executionKey: "opening",
        quantity: "10",
        netCash: "-100",
        brokerPnl: null,
        pnlEstimated: false,
        role: "open",
      },
    ]);
    expect(result.issues).toEqual([]);
    expect(
      canonical(groupStrategies(ledger([closing, opening]), [], resolveId)),
    ).toEqual(canonical(result));
    expect(input).toEqual(before);
  });

  it("reserves only manual units and cash before matching the residual opening", () => {
    const opening = open("opening");
    const closing = close("closing", "-6", "90");
    const decisions = [
      decision("manual_allocation", {
        strategyId: "manual",
        source: opening.sources[0],
        allocations: [
          {
            executionKey: opening.key,
            quantity: "4",
            netCash: "-40",
            brokerPnl: null,
          },
        ],
      }),
    ];
    const retained = structuredClone(decisions);
    const result = groupStrategies(
      ledger([opening, closing]),
      decisions,
      resolveId,
    );
    expect(result.allocations).toEqual([
      {
        strategyId: "A:opening",
        executionKey: "closing",
        quantity: "-6",
        netCash: "90",
        brokerPnl: "0",
        pnlEstimated: false,
        role: "close",
      },
      {
        strategyId: "A:opening",
        executionKey: "opening",
        quantity: "6",
        netCash: "-60",
        brokerPnl: null,
        pnlEstimated: false,
        role: "open",
      },
      {
        strategyId: "manual",
        executionKey: "opening",
        quantity: "4",
        netCash: "-40",
        brokerPnl: null,
        pnlEstimated: false,
        role: "open",
      },
    ]);
    expect(
      result.strategies.map((s) => ({
        id: s.id,
        status: s.status,
        positions: s.positions,
      })),
    ).toEqual([
      {
        id: "A:opening",
        status: "closed",
        positions: [{ instrumentKey: "stock", quantity: "0" }],
      },
      {
        id: "manual",
        status: "open",
        positions: [{ instrumentKey: "stock", quantity: "4" }],
      },
    ]);
    expect(result.watermark).toBe(1);
    expect(result.issues).toEqual([]);
    expect(decisions).toEqual(retained);
  });

  it("deduplicates retained allocations without reserving exposure twice", () => {
    const opening = open("opening");
    const payload = {
      strategyId: "manual",
      source: opening.sources[0],
      allocations: [
        {
          executionKey: opening.key,
          quantity: "4",
          netCash: "-40",
          brokerPnl: null,
        },
      ],
    };
    const result = groupStrategies(
      ledger([opening]),
      [
        decision("manual_allocation", payload),
        decision("manual_allocation", payload, 2),
      ],
      resolveId,
    );
    expect(
      result.allocations.map((a) => [a.strategyId, a.quantity, a.netCash]),
    ).toEqual([
      ["A:opening", "6", "-60"],
      ["manual", "4", "-40"],
    ]);
    expect(result.issues).toEqual([
      {
        key: "strategy:DUPLICATE_ALLOCATION:manual:imp:1",
        code: "DUPLICATE_ALLOCATION",
        severity: "warning",
        sources: opening.sources,
      },
    ]);
    expect(result.watermark).toBe(2);
  });

  it("consolidates merged positions and remaps allocations to the retained identity", () => {
    const decisions = [
      decision("group_merge", {
        chosenStrategyId: "A:first",
        mergedStrategyIds: ["A:second"],
      }),
    ];
    const result = groupStrategies(
      ledger([open("first", "3", "-30"), open("second", "2", "-20")]),
      decisions,
      resolveId,
    );
    expect(result.strategies).toHaveLength(1);
    expect(result.strategies[0]).toMatchObject({
      id: "A:first",
      status: "open",
      positions: [{ instrumentKey: "stock", quantity: "5" }],
    });
    expect(
      result.allocations.map((a) => [
        a.strategyId,
        a.executionKey,
        a.quantity,
        a.netCash,
      ]),
    ).toEqual([
      ["A:first", "first", "3", "-30"],
      ["A:first", "second", "2", "-20"],
    ]);
    expect(result.issues).toEqual([]);
  });
});
