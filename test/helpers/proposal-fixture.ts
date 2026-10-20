import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import {
  appendDecision,
  decisionWatermark,
} from "../../src/server/decisions/service.js";
import { listImports } from "../../src/server/imports/service.js";
import { buildExecutionTable, executionRow } from "../fixtures/scenarios.js";
import { seedLedger } from "./chat.js";
import { createTestStore } from "./store.js";

export async function proposalFixture() {
  const t = await createTestStore();
  const rows = [
    { id: "stock-1", asset: "STK", account: "A", day: 1 },
    { id: "stock-2", asset: "STK", account: "A", day: 2 },
    { id: "call", asset: "OPT", account: "A", day: 3 },
    { id: "other-account", asset: "STK", account: "B", day: 1 },
  ];
  try {
    await seedLedger(
      t.store,
      buildExecutionTable(
        rows.map((r) =>
          executionRow({
            ClientAccountID: r.account,
            AssetClass: r.asset,
            Symbol: r.asset === "STK" ? "XYZ" : "XYZ CALL",
            UnderlyingSymbol: "XYZ",
            Conid: r.asset === "STK" ? "1" : "2",
            CurrencyPrimary: "USD",
            TradeDate: `2026-10-0${r.day}`,
            DateTime: `2026-10-0${r.day} 12:00:00`,
            Quantity: r.asset === "STK" ? "100" : "-1",
            TradePrice: r.asset === "STK" ? "100" : "1",
            NetCash: r.asset === "STK" ? "-10000" : "100",
            Multiplier: r.asset === "STK" ? "1" : "100",
            Expiry: r.asset === "OPT" ? "2026-11-20" : "",
            Strike: r.asset === "OPT" ? "105" : "",
            "Put/Call": r.asset === "OPT" ? "C" : "",
            "Notes/Codes": "O",
            IBExecID: r.id,
            TradeID: r.id,
            IBOrderID: r.id,
          }),
        ),
      ),
    );
    const snapshot = activeProjection(t.store);
    const data = snapshot.projection?.lifecycles;
    if (!snapshot.buildId || !snapshot.projection || !data)
      throw new Error("No lifecycle build");
    const suggestion = data.suggestions[0];
    if (!suggestion) throw new Error("No call suggestion");
    const target = data.lifecycles.find(
      (l) => l.id === suggestion.candidateLifecycleIds[0],
    );
    if (!target) throw new Error("No target");
    const other = data.lifecycles.find((l) => l.account === "B");
    if (!other) throw new Error("No other account");
    const member = data.members.find((m) => m.lifecycleId === target.id);
    if (!member) throw new Error("No member");
    const mergeIds = data.lifecycles
      .filter((l) => l.account === "A" && l.originStrategyType === "stock")
      .flatMap((l) => l.componentIds);
    return {
      ...t,
      projection: snapshot.projection,
      data,
      suggestion,
      target,
      other,
      member,
      mergeIds,
      importId: listImports(t.store)[0]?.id ?? "",
      expected: {
        buildId: snapshot.buildId,
        watermark: decisionWatermark(t.store),
      },
      rebuild: () =>
        rebuild(t.store, {
          mode: "full",
          parserVersion: "flex-v1",
          algorithmVersion: ALGORITHM_VERSION,
          signal: new AbortController().signal,
        }),
      campaign: () =>
        appendDecision(
          t.store,
          {
            kind: "wheel_campaign",
            clientRequestId: "campaign",
            author: "user",
            payload: {
              campaignId: "wheel",
              name: "XYZ wheel",
              account: "A",
              currency: "USD",
              underlyingKey: "value:XYZ",
            },
          },
          decisionWatermark(t.store),
        ),
    };
  } catch (error) {
    await t.dispose();
    throw error;
  }
}
