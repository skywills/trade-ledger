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
it("replays three superseding campaign decisions and rejects writes against unbuilt imports", async () => {
  const t = await createTestStore();
  try {
    const p = await previewImport(t.store, {
      filename: "assignment.csv",
      bytes: fixtures.assignment,
      timezone: "UTC",
    });
    await commitImport(t.store, p.id);
    await rebuild(t.store, input);
    const l = activeProjection(t.store).projection?.lifecycles?.lifecycles[0];
    if (!l) throw Error("missing lifecycle");
    let supersedesId: string | null = null;
    for (const name of ["first", "second", "final"]) {
      const raw = {
        kind: "wheel_campaign",
        clientRequestId: name,
        author: "user",
        supersedesId,
        payload: {
          campaignId: "wheel",
          name,
          account: l.account,
          currency: l.currency,
          underlyingKey: l.underlyingKey,
        },
      };
      const d = await appendDecision(t.store, raw, decisionWatermark(t.store));
      const duplicate = await appendDecision(
        t.store,
        raw,
        decisionWatermark(t.store),
      );
      expect(duplicate.id).toBe(d.id);
      supersedesId = d.id;
    }
    await rebuild(t.store, input);
    expect(
      activeProjection(t.store).projection?.lifecycles?.campaigns.map(
        (c) => c.name,
      ),
    ).toEqual(["final"]);
    const next = await previewImport(t.store, {
      filename: "spread.csv",
      bytes: fixtures.spread,
      timezone: "UTC",
    });
    await commitImport(t.store, next.id);
    await expect(
      appendDecision(
        t.store,
        {
          kind: "wheel_campaign_membership",
          clientRequestId: "stale",
          author: "user",
          payload: { lifecycleId: l.id, campaignId: "wheel" },
        },
        decisionWatermark(t.store),
      ),
    ).rejects.toMatchObject({ code: "STALE_INPUT" });
  } finally {
    await t.dispose();
  }
});
it("preserves cycle membership when the campaign definition is superseded by a rename", async () => {
  const t = await createTestStore();
  try {
    const p = await previewImport(t.store, {
      filename: "assignment.csv",
      bytes: fixtures.assignment,
      timezone: "UTC",
    });
    await commitImport(t.store, p.id);
    await rebuild(t.store, input);
    const l = activeProjection(t.store).projection?.lifecycles?.lifecycles[0];
    if (!l) throw Error("missing lifecycle");
    const campaign = await appendDecision(
      t.store,
      {
        kind: "wheel_campaign",
        clientRequestId: "create",
        author: "user",
        payload: {
          campaignId: "wheel",
          name: "Old",
          account: l.account,
          currency: l.currency,
          underlyingKey: l.underlyingKey,
        },
      },
      decisionWatermark(t.store),
    );
    await appendDecision(
      t.store,
      {
        kind: "wheel_campaign_membership",
        clientRequestId: "join",
        author: "user",
        payload: { lifecycleId: l.id, campaignId: "wheel" },
      },
      decisionWatermark(t.store),
    );
    await appendDecision(
      t.store,
      {
        kind: "wheel_campaign",
        clientRequestId: "rename",
        supersedesId: campaign.id,
        author: "user",
        payload: {
          campaignId: "wheel",
          name: "New",
          account: l.account,
          currency: l.currency,
          underlyingKey: l.underlyingKey,
        },
      },
      decisionWatermark(t.store),
    );
    await rebuild(t.store, input);
    const data = activeProjection(t.store).projection?.lifecycles;
    expect(data?.campaigns[0]).toMatchObject({
      name: "New",
      lifecycleIds: [l.id],
    });
    expect(data?.lifecycles.find((c) => c.id === l.id)?.campaignId).toBe(
      "wheel",
    );
    await expect(
      appendDecision(
        t.store,
        {
          kind: "wheel_campaign",
          clientRequestId: "scope-change",
          author: "user",
          payload: {
            campaignId: "wheel",
            name: "Changed scope",
            account: l.account,
            currency: "EUR",
            underlyingKey: l.underlyingKey,
          },
        },
        decisionWatermark(t.store),
      ),
    ).rejects.toMatchObject({ code: "INVALID_LIFECYCLE_MEMBERSHIP" });
  } finally {
    await t.dispose();
  }
});
