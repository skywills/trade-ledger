import { expect, it } from "vitest";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import {
  appendDecision,
  decisionWatermark,
} from "../../src/server/decisions/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import {
  buildExecutionTable,
  executionRow,
  fixtures,
} from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

const input = {
  mode: "full" as const,
  parserVersion: "flex-v1",
  algorithmVersion: ALGORITHM_VERSION,
  signal: new AbortController().signal,
};
it("persists assignment continuity and replays wheel campaigns on rebuild", async () => {
  const t = await createTestStore();
  try {
    const preview = await previewImport(t.store, {
      filename: "assignment.csv",
      bytes: fixtures.assignment,
      timezone: "UTC",
    });
    await commitImport(t.store, preview.id);
    await rebuild(t.store, input);
    const p = activeProjection(t.store).projection;
    expect(p?.lifecycles?.version).toBe(1);
    expect(p?.lifecycles?.members.length).toBe(p?.allocations.length);
    const l = p?.lifecycles?.lifecycles[0];
    expect(l).toBeDefined();
    if (!l) throw Error("missing lifecycle");
    await appendDecision(
      t.store,
      {
        kind: "wheel_campaign",
        clientRequestId: "campaign",
        author: "user",
        payload: {
          campaignId: "wheel",
          name: "My wheel",
          account: l.account,
          currency: l.currency,
          underlyingKey: l.underlyingKey,
        },
      },
      decisionWatermark(t.store),
    );
    await rebuild(t.store, input);
    await appendDecision(
      t.store,
      {
        kind: "wheel_campaign_membership",
        clientRequestId: "attach",
        author: "user",
        payload: { campaignId: "wheel", lifecycleId: l.id },
      },
      decisionWatermark(t.store),
    );
    await rebuild(t.store, input);
    const loaded = activeProjection(t.store).projection?.lifecycles;
    expect(
      loaded?.lifecycles.some((c) => c.id === l.id && c.campaignId === "wheel"),
    ).toBe(true);
    expect(loaded?.campaigns[0]?.lifecycleIds).toContain(l.id);
  } finally {
    await t.dispose();
  }
});

it.each(["11:00:00", "10:00:00"])(
  "preserves retained lifecycle membership after an additional same-order fill at %s",
  async (laterTime) => {
    const t = await createTestStore();
    const fill = (id: string, time: string) =>
      executionRow({
        ClientAccountID: "FILL-A",
        AssetClass: "STK",
        Symbol: "XYZ",
        UnderlyingSymbol: "XYZ",
        Conid: "1",
        CurrencyPrimary: "USD",
        TradeDate: "2026-10-01",
        DateTime: `2026-10-01 ${time}`,
        Quantity: "50",
        TradePrice: "100",
        NetCash: "-5000",
        TradeID: id,
        IBExecID: id,
        IBOrderID: "same-order",
        BrokerageOrderID: "same-order",
        "Notes/Codes": "O",
        Multiplier: "1",
      });
    const commit = async (id: string, time: string) => {
      const preview = await previewImport(t.store, {
        filename: `${id}.csv`,
        bytes: buildExecutionTable([fill(id, time)]),
        timezone: "UTC",
      });
      await commitImport(t.store, preview.id);
      await rebuild(t.store, input);
    };
    try {
      await commit("z-first-fill", "10:00:00");
      const original = activeProjection(t.store).projection?.lifecycles
        ?.lifecycles[0];
      if (!original) throw Error("missing original lifecycle");
      await appendDecision(
        t.store,
        {
          kind: "wheel_campaign",
          clientRequestId: "campaign",
          author: "user",
          payload: {
            campaignId: "fills",
            name: "Fill campaign",
            account: original.account,
            currency: original.currency,
            underlyingKey: original.underlyingKey,
          },
        },
        decisionWatermark(t.store),
      );
      await appendDecision(
        t.store,
        {
          kind: "wheel_campaign_membership",
          clientRequestId: "membership",
          author: "user",
          payload: { campaignId: "fills", lifecycleId: original.id },
        },
        decisionWatermark(t.store),
      );
      await rebuild(t.store, input);
      await commit("a-later-fill", laterTime);
      const data = activeProjection(t.store).projection?.lifecycles;
      expect(data?.lifecycles).toHaveLength(1);
      expect(data?.lifecycles[0]).toMatchObject({
        id: original.id,
        campaignId: "fills",
        positions: [{ instrumentKey: "conid:1", quantity: "100" }],
      });
      expect(data?.campaigns[0]?.lifecycleIds).toEqual([original.id]);
      expect(data?.issues).toEqual([]);
    } finally {
      await t.dispose();
    }
  },
);
