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
import { fixtures } from "../fixtures/scenarios.js";
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
