import { describe, expect, it } from "vitest";
import { strategyAnchorKey } from "../../src/server/decisions/registry.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { normalizeLedger } from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import {
  accountProjection,
  validateProjection,
} from "../../src/server/strategies/accounting.js";
import { groupStrategies } from "../../src/server/strategies/grouping.js";
import type { LedgerSnapshot } from "../../src/shared/domain.js";
import { formatMoney } from "../../src/shared/money.js";
import {
  buildExecutionTable,
  type ExecutionFields,
  executionRow,
  fixtures,
} from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  const { store, dispose } = await createTestStore();
  try {
    await run(store);
  } finally {
    await dispose();
  }
}

async function commitBytes(
  store: Store,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  const preview = await previewImport(store, {
    filename,
    bytes,
    timezone: "UTC",
  });
  const committed = await commitImport(store, preview.id);
  expect(committed.duplicate).toBe(false);
}

async function ledgerFrom(
  store: Store,
  filename: string,
  bytes: Uint8Array,
): Promise<LedgerSnapshot> {
  await commitBytes(store, filename, bytes);
  return normalizeLedger(store, {
    parserVersion: "flex-v1",
    decisionWatermark: 0,
  });
}

function resolveId(account: string, keys: string[]): string {
  return strategyAnchorKey({ account, openingKeys: keys });
}

function optionLeg(
  order: string,
  tradeId: string,
  overrides: Partial<ExecutionFields> = {},
): ExecutionFields {
  return executionRow({
    ClientAccountID: "SIM-Z",
    AssetClass: "OPT",
    Symbol: "TEST",
    UnderlyingSymbol: "TEST",
    Conid:
      overrides.Conid ??
      `9${overrides.Strike ?? "100"}${overrides["Put/Call"] ?? "C"}${(
        overrides.Expiry ?? "2026-12-18"
      ).replaceAll("-", "")}`,
    CurrencyPrimary: "USD",
    TradeDate: overrides.TradeDate ?? "2026-09-03",
    DateTime: `${overrides.TradeDate ?? "2026-09-03"} 10:00:00`,
    Quantity: overrides.Quantity ?? "+1",
    TradePrice: overrides.TradePrice ?? "2",
    NetCash: overrides.NetCash ?? "-200",
    "Notes/Codes": overrides["Notes/Codes"] ?? "O",
    IBOrderID: order,
    BrokerageOrderID: order,
    IBExecID: `EXEC-${tradeId}`,
    TradeID: tradeId,
    Expiry: overrides.Expiry ?? "2026-12-18",
    Strike: overrides.Strike ?? "100",
    "Put/Call": overrides["Put/Call"] ?? "C",
    Multiplier: overrides.Multiplier ?? "100",
    ...overrides,
  });
}

describe("strategy accounting over normalized ledgers", () => {
  it("computes exact scenario A accounting at source precision", () =>
    withStore(async (store) => {
      const ledger = await ledgerFrom(store, "spread.csv", fixtures.spread);
      const accounted = accountProjection(
        ledger,
        groupStrategies(ledger, [], resolveId),
      );

      const axon = accounted.strategies.find(
        (s) => s.type === "bull_put_spread",
      );
      expect(axon?.openingAmount).toBe("-284.5018378");
      expect(axon?.cashflow).toBe("-451.6607454");
      expect(axon?.brokerPnl).toBe("-451.660745");
      expect(formatMoney(axon?.brokerPnl ?? null, "USD")).toBe("-451.66");
      expect(formatMoney("-449.212451", "USD")).toBe("-449.21");
      expect(formatMoney(null, "USD")).toBe("Unavailable");
      expect(axon?.closeDate).toBe("2026-09-25");
      expect(axon?.reconstructedPnl).toBe("-451.6607454");
      expect(
        validateProjection(ledger, accounted).filter(
          (issue) => issue.severity === "error",
        ),
      ).toHaveLength(0);
    }));

  it("never sums supporting CLOSED_LOT rows into strategy totals", () =>
    withStore(async (store) => {
      const ledger = await ledgerFrom(store, "spread.csv", fixtures.spread);
      expect(ledger.lots).toHaveLength(2);

      const accounted = accountProjection(
        ledger,
        groupStrategies(ledger, [], resolveId),
      );
      const axon = accounted.strategies[0];
      // The two supporting lots repeat the execution P/L; summing them would
      // double the total to -903.32149.
      expect(axon?.brokerPnl).toBe("-451.660745");
      expect(axon?.brokerPnl).not.toBe("-903.321490");
    }));

  it("keeps available broker P/L when openings are missing but leaves reconstructed P/L null", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("CLOSE-ONLY", "T-C", {
          Quantity: "-1",
          "Notes/Codes": "C",
          NetCash: "300",
          TradePrice: "3",
          FifoPnlRealized: "250",
        }),
      ]);
      const ledger = await ledgerFrom(store, "missing-opening.csv", rows);
      const accounted = accountProjection(
        ledger,
        groupStrategies(ledger, [], resolveId),
      );

      const strategy = accounted.strategies[0];
      expect(strategy?.brokerPnl).toBe("250");
      expect(formatMoney(strategy?.brokerPnl ?? null, "USD")).toBe("250.00");
      expect(strategy?.openingAmount).toBeNull();
      expect(strategy?.reconstructedPnl).toBeNull();
    }));

  it("does not treat lifecycle cashflow as reconstructed P/L when a basis transfer is involved", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("OPEN-PUT", "T-O", {
          Quantity: "-1",
          "Put/Call": "P",
          Strike: "100",
          NetCash: "500",
          TradePrice: "5",
          "Notes/Codes": "O",
        }),
        optionLeg("ASSIGN", "T-A", {
          Quantity: "+1",
          "Put/Call": "P",
          Strike: "100",
          NetCash: "0",
          TradePrice: "0",
          "Notes/Codes": "A",
        }),
      ]);
      const ledger = await ledgerFrom(store, "assignment-basis.csv", rows);
      const accounted = accountProjection(
        ledger,
        groupStrategies(ledger, [], resolveId),
      );

      const strategy = accounted.strategies[0];
      expect(strategy?.status).toBe("closed");
      expect(strategy?.cashflow).toBe("500");
      expect(strategy?.reconstructedPnl).toBeNull();
      expect(strategy?.brokerPnl).toBeNull();
    }));

  it("keeps currencies separate without combining totals", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("USD-OPEN", "T-U", {
          Quantity: "+1",
          NetCash: "-1000",
          TradePrice: "10",
          CurrencyPrimary: "USD",
        }),
        optionLeg("EUR-OPEN", "T-E", {
          Quantity: "+1",
          NetCash: "-900",
          TradePrice: "9",
          CurrencyPrimary: "EUR",
        }),
      ]);
      const ledger = await ledgerFrom(store, "mixed-currency.csv", rows);
      const accounted = accountProjection(
        ledger,
        groupStrategies(ledger, [], resolveId),
      );

      expect(accounted.strategies).toHaveLength(2);
      expect(accounted.strategies.map((s) => s.currency).sort()).toEqual([
        "EUR",
        "USD",
      ]);
      const usd = accounted.strategies.find((s) => s.currency === "USD");
      const eur = accounted.strategies.find((s) => s.currency === "EUR");
      expect(usd?.openingAmount).toBe("1000");
      expect(eur?.openingAmount).toBe("900");
      expect(formatMoney(usd?.openingAmount ?? null, "USD")).toBe("1000.00");
      expect(formatMoney(eur?.openingAmount ?? null, "EUR")).toBe("900.00");
    }));

  it("reports the 2027 contract expiry with a 2026 opening", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("FUT-OPEN", "T-F", {
          Quantity: "+1",
          NetCash: "-1000",
          TradePrice: "10",
          Expiry: "2027-01-15",
          TradeDate: "2026-09-03",
        }),
      ]);
      const ledger = await ledgerFrom(store, "expiry-2027.csv", rows);
      const accounted = accountProjection(
        ledger,
        groupStrategies(ledger, [], resolveId),
      );

      const strategy = accounted.strategies[0];
      expect(strategy?.openingDate).toBe("2026-09-03");
      expect(strategy?.expiry).toBe("2027-01-15");
      expect(strategy?.expiryYear).toBe(2027);
    }));
});
