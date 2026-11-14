import { afterEach, expect, it } from "vitest";
import { buildEvidenceSnapshot } from "../../src/server/ai/evidence.js";
import { buildProposalEvidenceSnapshot } from "../../src/server/ai/proposal-evidence.js";
import {
  type ProposalKind,
  parseProposal,
} from "../../src/server/ai/proposals.js";
import { activeProjection } from "../../src/server/builds/service.js";
import { appendDecision } from "../../src/server/decisions/service.js";
import { proposalFixture } from "../helpers/proposal-fixture.js";
import type { TestStore } from "../helpers/store.js";

const stores: TestStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((t) => t.dispose()));
});

const stock1 = "txn:A:trade:stock-1";
const stock2 = "txn:A:trade:stock-2";
const call = "txn:A:trade:call";
const other = "txn:B:trade:other-account";

it.each<ProposalKind>([
  "manual_allocation",
  "identity_binding",
  "group_explicit",
  "lifecycle",
  "notes",
  "stop_loss",
  "group_merge",
  "import_exclusion",
  "import_inclusion",
  "lifecycle_attachment",
  "lifecycle_membership",
  "lifecycle_attachment_rejection",
  "wheel_campaign",
  "wheel_campaign_membership",
])(
  "%s evidence includes its payload references without unrelated rows",
  async (kind) => {
    const t = await proposalFixture();
    stores.push(t);
    const source = { importId: t.importId, rowNumber: 2 };
    const cases: Record<ProposalKind, { payload: unknown; keys: string[] }> = {
      manual_allocation: {
        payload: {
          strategyId: t.mergeIds[0],
          source,
          allocations: [
            { executionKey: stock2, quantity: "100", netCash: "-10000" },
          ],
        },
        keys: [stock1, stock2],
      },
      identity_binding: {
        payload: {
          source,
          canonicalIdentity: "canonical",
          expectedQuantity: "100",
        },
        keys: [stock1],
      },
      group_explicit: {
        payload: {
          strategyId: t.mergeIds[0],
          source: { importId: t.importId, rowNumber: 3 },
        },
        keys: [stock1, stock2],
      },
      lifecycle: {
        payload: {
          event: "roll",
          sourceRef: source,
          targetRef: { importId: t.importId, rowNumber: 4 },
        },
        keys: [call, stock1],
      },
      notes: {
        payload: { strategyId: t.mergeIds[0], text: "Reviewed" },
        keys: [stock1],
      },
      stop_loss: {
        payload: { strategyId: t.mergeIds[0], price: "90" },
        keys: [stock1],
      },
      group_merge: {
        payload: {
          chosenStrategyId: t.mergeIds[0],
          mergedStrategyIds: [t.mergeIds[1]],
        },
        keys: [stock1, stock2],
      },
      import_exclusion: {
        payload: { importId: t.importId },
        keys: [call, stock1, stock2, other],
      },
      import_inclusion: {
        payload: { importId: t.importId },
        keys: [call, stock1, stock2, other],
      },
      lifecycle_attachment: {
        payload: {
          opening: t.suggestion.callOpening,
          targets: [{ lifecycleId: t.target.id, quantity: "-1" }],
        },
        keys: [call, stock1],
      },
      lifecycle_membership: {
        payload: {
          assignments: [
            {
              lifecycleId: t.target.id,
              allocation: t.suggestion.callOpening,
              quantity: "-1",
            },
          ],
        },
        keys: [call, stock1],
      },
      lifecycle_attachment_rejection: {
        payload: {
          callOpening: t.suggestion.callOpening,
          candidateLifecycleIds: [t.target.id],
          reason: "Keep separate",
        },
        keys: [call, stock1],
      },
      wheel_campaign: {
        payload: {
          campaignId: "new",
          name: "New campaign",
          account: "A",
          currency: "USD",
          underlyingKey: "value:XYZ",
        },
        keys: [],
      },
      wheel_campaign_membership: {
        payload: { lifecycleId: t.other.id, campaignId: null },
        keys: [other],
      },
    };
    const testCase = cases[kind];
    const proposal = parseProposal({ kind, payload: testCase.payload });
    const evidence = buildProposalEvidenceSnapshot(
      t.store,
      t.expected.buildId,
      proposal,
    );
    expect(evidence.rows.map((row) => row.executionKey)).toEqual(testCase.keys);
    expect(evidence.rejected).toEqual([]);
    expect(evidence).toMatchObject(t.expected);
  },
);

it("explicit sources and strategy IDs add evidence and duplicate references appear once", async () => {
  const t = await proposalFixture();
  stores.push(t);
  const evidence = buildProposalEvidenceSnapshot(
    t.store,
    t.expected.buildId,
    parseProposal({
      kind: "notes",
      sources: [
        { importId: t.importId, rowNumber: 4 },
        { importId: t.importId, rowNumber: 4 },
      ],
      strategyIds: [t.other.componentIds[0]],
      payload: { strategyId: t.mergeIds[0], text: "Reviewed" },
    }),
  );
  expect(evidence.rows.map((row) => row.executionKey)).toEqual([
    call,
    stock1,
    other,
  ]);
});

it("campaign evidence follows its existing lifecycle members", async () => {
  const t = await proposalFixture();
  stores.push(t);
  await t.campaign();
  await appendDecision(
    t.store,
    {
      kind: "wheel_campaign_membership",
      clientRequestId: "membership",
      author: "user",
      payload: { campaignId: "wheel", lifecycleId: t.target.id },
    },
    1,
  );
  await t.rebuild();
  const proposal = parseProposal({
    kind: "wheel_campaign",
    payload: {
      campaignId: "wheel",
      name: "Renamed",
      account: "A",
      currency: "USD",
      underlyingKey: "value:XYZ",
    },
  });
  const evidence = buildProposalEvidenceSnapshot(
    t.store,
    activeProjection(t.store).buildId ?? "",
    proposal,
  );
  expect(evidence.rows.map((row) => row.executionKey)).toEqual([stock1]);
});

it("explicitly empty execution evidence does not fall back to the whole ledger", async () => {
  const t = await proposalFixture();
  stores.push(t);
  const evidence = buildEvidenceSnapshot(t.store, {
    buildId: t.expected.buildId,
    executionKeys: [],
  });
  expect(evidence.rows).toEqual([]);
  expect(
    buildEvidenceSnapshot(t.store, { buildId: t.expected.buildId }).rows,
  ).toHaveLength(4);
});
