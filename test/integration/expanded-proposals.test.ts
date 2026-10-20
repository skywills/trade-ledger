import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildEvidenceSnapshot } from "../../src/server/ai/evidence.js";
import { previewProposal } from "../../src/server/ai/proposal-preview.js";
import {
  acceptProposal,
  parseProposal,
  proposalDecisionInput,
  tryParseProposal,
} from "../../src/server/ai/proposals.js";
import { appendRunProposal, insertRun } from "../../src/server/ai/runs.js";
import { activeProjection } from "../../src/server/builds/service.js";
import {
  appendDecision,
  decisionWatermark,
} from "../../src/server/decisions/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { buildExecutionTable, executionRow } from "../fixtures/scenarios.js";
import { localProfile } from "../helpers/chat.js";
import { proposalFixture } from "../helpers/proposal-fixture.js";
import type { TestStore } from "../helpers/store.js";

const stores: TestStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.dispose()));
});
const kinds = [
  "group_merge",
  "import_exclusion",
  "import_inclusion",
  "lifecycle_attachment",
  "lifecycle_membership",
  "lifecycle_attachment_rejection",
  "wheel_campaign",
  "wheel_campaign_membership",
] as const;

it.each(kinds)(
  "%s parses, previews without a live decision, and accepts once",
  async (kind) => {
    const t = await proposalFixture();
    stores.push(t);
    if (kind === "wheel_campaign_membership") {
      await t.campaign();
      await t.rebuild();
    }
    if (kind === "import_inclusion") {
      await appendDecision(
        t.store,
        {
          kind: "import_exclusion",
          payload: { importId: t.importId },
          clientRequestId: "exclude",
          author: "user",
        },
        0,
      );
      await t.rebuild();
    }
    const payloads = {
      group_merge: {
        chosenStrategyId: t.mergeIds[0],
        mergedStrategyIds: [t.mergeIds[1]],
      },
      import_exclusion: { importId: t.importId },
      import_inclusion: { importId: t.importId },
      lifecycle_attachment: {
        opening: t.suggestion.callOpening,
        targets: [{ lifecycleId: t.target.id, quantity: "-1" }],
      },
      lifecycle_membership: {
        assignments: [
          {
            lifecycleId: t.member.lifecycleId,
            allocation: t.member.allocation,
            quantity: t.member.quantity,
          },
        ],
      },
      lifecycle_attachment_rejection: {
        callOpening: t.suggestion.callOpening,
        candidateLifecycleIds: t.suggestion.candidateLifecycleIds,
        reason: "Independent trade",
      },
      wheel_campaign: {
        campaignId: "wheel",
        name: "XYZ wheel",
        account: "A",
        currency: "USD",
        underlyingKey: "value:XYZ",
      },
      wheel_campaign_membership: {
        lifecycleId: t.target.id,
        campaignId: "wheel",
      },
    };
    const proposal = parseProposal({ kind, payload: payloads[kind] });
    expect(proposalDecisionInput(proposal).kind).toBe(kind);
    const buildId = activeProjection(t.store).buildId;
    if (!buildId) throw new Error("No build");
    const watermark = decisionWatermark(t.store);
    const preview = await previewProposal(t.store, proposal, {
      buildId,
      watermark,
    });
    expect(preview.valid, JSON.stringify(preview.issues)).toBe(true);
    expect(decisionWatermark(t.store)).toBe(watermark);
    if (kind === "import_exclusion")
      expect(preview.impact?.after.strategyCount).toBe(0);
    if (kind === "import_inclusion") {
      expect(preview.impact?.before.strategyCount).toBe(0);
      expect(preview.impact?.after.strategyCount).toBe(4);
    }
    if (kind === "group_merge")
      expect(preview.impact?.after.strategyCount).toBe(3);
    const runId = randomUUID(),
      proposalId = randomUUID();
    await insertRun(
      t.store,
      {
        id: runId,
        profileSnapshot: await localProfile(t.store),
        evidence: buildEvidenceSnapshot(t.store, { buildId, issueKeys: [] }),
        sessionId: "expanded",
        createdAt: new Date().toISOString(),
      },
      "proposal_ready",
    );
    await appendRunProposal(t.store, runId, {
      id: proposalId,
      proposal,
      accepted: false,
      submittedAt: new Date().toISOString(),
    });
    const accepted = await acceptProposal(
      t.store,
      runId,
      proposalId,
      watermark,
      "connection-retry",
    );
    const replay = await acceptProposal(
      t.store,
      runId,
      proposalId,
      watermark,
      "connection-retry",
    );
    expect(replay.map((d) => d.id)).toEqual(accepted.map((d) => d.id));
    expect(decisionWatermark(t.store)).toBe(watermark + 1);
    await expect(
      acceptProposal(t.store, runId, proposalId, watermark + 1),
    ).rejects.toMatchObject({ code: "PROPOSAL_ALREADY_ACCEPTED" });
  },
);

it("cross_account_membership_is_invalid and partial contracts are rejected", async () => {
  const t = await proposalFixture();
  stores.push(t);
  for (const target of [
    { lifecycleId: t.other.id, quantity: "-1" },
    { lifecycleId: t.target.id, quantity: "-0.5" },
    { lifecycleId: t.target.id, quantity: "-2" },
  ]) {
    const proposal = parseProposal({
      kind: "lifecycle_attachment",
      payload: { opening: t.suggestion.callOpening, targets: [target] },
    });
    expect((await previewProposal(t.store, proposal, t.expected)).valid).toBe(
      false,
    );
  }
});

it("supersession_replaces_prior_effect while legacy proposal JSON keeps defaults", async () => {
  const t = await proposalFixture();
  stores.push(t);
  const previous = await t.campaign();
  await t.rebuild();
  const proposal = parseProposal({
    kind: "wheel_campaign",
    supersedesId: previous.id,
    payload: {
      campaignId: "wheel",
      name: "Renamed",
      account: "A",
      currency: "USD",
      underlyingKey: "value:XYZ",
    },
  });
  expect(proposalDecisionInput(proposal).supersedesId).toBe(previous.id);
  const buildId = activeProjection(t.store).buildId;
  if (!buildId) throw new Error("No build");
  expect(
    (await previewProposal(t.store, proposal, { buildId, watermark: 1 })).valid,
  ).toBe(true);
  const old = parseProposal({
    kind: "notes",
    payload: { strategyId: t.mergeIds[0], text: "Legacy" },
  });
  expect(old).toMatchObject({
    sources: [],
    strategyIds: [],
    supersedesId: null,
  });
  expect(
    tryParseProposal({
      kind: "group_split",
      payload: {
        parentStrategyId: "s",
        childStrategyIds: ["c"],
        notesOwnerStrategyId: null,
      },
    }).ok,
  ).toBe(false);
});

it("same-account cross-currency attachment is invalid", async () => {
  const t = await proposalFixture();
  stores.push(t);
  const imported = await previewImport(t.store, {
    filename: "eur.csv",
    timezone: "UTC",
    bytes: buildExecutionTable([
      executionRow({
        ClientAccountID: "A",
        CurrencyPrimary: "EUR",
        AssetClass: "STK",
        Symbol: "XYZ",
        UnderlyingSymbol: "XYZ",
        Conid: "1",
        Quantity: "100",
        TradeDate: "2026-10-01",
        DateTime: "2026-10-01 12:00:00",
        TradePrice: "100",
        NetCash: "-10000",
        Multiplier: "1",
        "Notes/Codes": "O",
        IBExecID: "eur",
        TradeID: "eur",
        IBOrderID: "eur",
      }),
    ]),
  });
  await commitImport(t.store, imported.id);
  await t.rebuild();
  const current = activeProjection(t.store);
  const eur = current.projection?.lifecycles?.lifecycles.find(
    (l) => l.account === "A" && l.currency === "EUR",
  );
  if (!eur || !current.buildId) throw new Error("No EUR lifecycle");
  const proposal = parseProposal({
    kind: "lifecycle_attachment",
    payload: {
      opening: t.suggestion.callOpening,
      targets: [{ lifecycleId: eur.id, quantity: "-1" }],
    },
  });
  const result = await previewProposal(t.store, proposal, {
    buildId: current.buildId,
    watermark: 0,
  });
  expect(result.valid).toBe(false);
  expect(result.impact).toBeNull();
  expect(decisionWatermark(t.store)).toBe(0);
});
