import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { buildEvidenceSnapshot } from "../../src/server/ai/evidence.js";
import { previewProposal } from "../../src/server/ai/proposal-preview.js";
import {
  acceptProposal,
  parseProposal,
  proposalDecisionInput,
} from "../../src/server/ai/proposals.js";
import { listRuns, recordValidatedProposal } from "../../src/server/ai/runs.js";
import { activeProjection } from "../../src/server/builds/service.js";
import { createThread } from "../../src/server/chat/threads.js";
import { proposalTools } from "../../src/server/chat/tools/proposals.js";
import {
  appendDecision,
  decisionWatermark,
} from "../../src/server/decisions/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { fixtures } from "../fixtures/scenarios.js";
import { verifiedProfile } from "../helpers/chat.js";
import { callTool, toolContext, toolJson } from "../helpers/chat-tools.js";
import {
  type InferenceServer,
  startInferenceServer,
} from "../helpers/inference-server.js";
import { proposalFixture } from "../helpers/proposal-fixture.js";
import type { TestStore } from "../helpers/store.js";

const stores: TestStore[] = [],
  servers: InferenceServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(stores.splice(0).map((s) => s.dispose()));
});
async function setup() {
  const t = await proposalFixture();
  stores.push(t);
  const inference = await startInferenceServer({ mode: "tool-call" });
  servers.push(inference);
  const profile = await verifiedProfile(t.store, inference);
  const thread = await createThread(t.store, {
    title: "Proposals",
    sessionId: randomUUID(),
    profileId: profile.id,
    modelRef: profile.modelId,
    cloudConfirmed: false,
    seed: null,
    now: new Date(),
  });
  const emitted: { runId: string; proposalId: string }[] = [];
  const ctx = {
    ...toolContext(t.store),
    thread: () => thread,
    emitProposal: (runId: string, proposalId: string) => {
      emitted.push({ runId, proposalId });
    },
  };
  return {
    ...t,
    ctx,
    profile,
    thread,
    emitted,
    tools: proposalTools(ctx),
    notes: {
      kind: "notes",
      payload: { strategyId: t.mergeIds[0], text: "Reviewed" },
    },
  };
}

it("invalid_submit_creates_no_run_or_card", async () => {
  const t = await setup();
  const execution = t.projection.allocations[0];
  if (!execution) throw new Error("No allocation");
  const result = await callTool(t.tools, "submit_proposal", {
    kind: "manual_allocation",
    payload: {
      strategyId: execution.strategyId,
      source: t.member.sources[0],
      allocations: [
        {
          executionKey: execution.executionKey,
          quantity: "1000000",
          netCash: "0",
        },
      ],
    },
  });
  expect(result.isError).toBe(true);
  expect(listRuns(t.store)).toEqual([]);
  expect(t.emitted).toEqual([]);
  expect(t.ctx.turn.current.proposalCount).toBe(0);
});

it("valid_submit_creates_pending_card_without_decision and acceptance revalidates current evidence", async () => {
  const t = await setup();
  const proposal = {
    kind: "lifecycle_attachment",
    payload: {
      opening: t.suggestion.callOpening,
      targets: [{ lifecycleId: t.target.id, quantity: "-1" }],
    },
  };
  expect(await toolJson(t.tools, "submit_proposal", proposal)).toMatchObject({
    recorded: true,
  });
  const run = listRuns(t.store)[0];
  expect(run?.proposals[0]?.accepted).toBe(false);
  expect(t.emitted).toHaveLength(1);
  expect(decisionWatermark(t.store)).toBe(0);
  await appendDecision(
    t.store,
    {
      kind: "import_exclusion",
      payload: { importId: t.importId },
      author: "user",
      clientRequestId: "exclude",
    },
    0,
  );
  await t.rebuild();
  if (!run?.proposals[0]) throw new Error("No proposal");
  await expect(
    acceptProposal(t.store, run.id, run.proposals[0].id, 1),
  ).rejects.toMatchObject({ code: "PROPOSAL_INVALID" });
  expect(decisionWatermark(t.store)).toBe(1);
});

it("twentieth_proposal_allowed_twenty_first_refused_without_preview", async () => {
  const t = await setup();
  const backup = vi.spyOn(t.store.db, "backup");
  for (let i = 0; i < 20; i++)
    expect((await toolJson(t.tools, "submit_proposal", t.notes)).recorded).toBe(
      true,
    );
  const copiesBefore = backup.mock.calls.length;
  expect(await callTool(t.tools, "submit_proposal", t.notes)).toMatchObject({
    isError: true,
  });
  expect(backup.mock.calls.length).toBe(copiesBefore);
  expect(copiesBefore).toBe(20);
  expect(listRuns(t.store)[0]?.proposals).toHaveLength(20);
  expect(decisionWatermark(t.store)).toBe(0);
});

it.each(["decision", "import", "activation"])(
  "live %s change before atomic record creates no empty run",
  async (change) => {
    const runs = await import("../../src/server/ai/runs.js");
    const t = await setup();
    const proposal = parseProposal(t.notes);
    expect((await previewProposal(t.store, proposal, t.expected)).valid).toBe(
      true,
    );
    const runId = randomUUID();
    const draft = {
      id: runId,
      profileSnapshot: t.profile,
      evidence: buildEvidenceSnapshot(t.store, {
        buildId: t.expected.buildId,
        issueKeys: [],
      }),
      sessionId: t.thread.sessionId,
      threadId: t.thread.id,
      createdAt: new Date().toISOString(),
    };
    if (change === "decision")
      await appendDecision(t.store, proposalDecisionInput(proposal), 0);
    if (change === "import") {
      const p = await previewImport(t.store, {
        filename: "later.csv",
        bytes: fixtures.partialFills,
        timezone: "UTC",
      });
      await commitImport(t.store, p.id);
    }
    if (change === "activation") await t.rebuild();
    expect(runs.recordValidatedProposal).toBeTypeOf("function");
    await expect(
      runs.recordValidatedProposal(t.store, {
        runId,
        draft,
        submitted: {
          id: randomUUID(),
          proposal,
          accepted: false,
          submittedAt: new Date().toISOString(),
        },
        expected: t.expected,
        maxProposals: 20,
      }),
    ).rejects.toMatchObject({
      code: change === "activation" ? "ANALYTICS_BUILD_CHANGED" : "STALE_INPUT",
    });
    expect(listRuns(t.store)).toEqual([]);
    expect(activeProjection(t.store).buildId).not.toBeNull();
  },
);

it("cancellation while waiting for the writer creates no run or card", async () => {
  const t = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = t.store.queue.enqueue(() => gate);
  const controller = new AbortController();
  const runId = randomUUID();
  const input = {
    runId,
    draft: {
      id: runId,
      profileSnapshot: t.profile,
      evidence: buildEvidenceSnapshot(t.store, {
        buildId: t.expected.buildId,
        issueKeys: [],
      }),
      sessionId: t.thread.sessionId,
      createdAt: new Date().toISOString(),
    },
    submitted: {
      id: randomUUID(),
      proposal: parseProposal(t.notes),
      accepted: false,
      submittedAt: new Date().toISOString(),
    },
    expected: t.expected,
    maxProposals: 20,
    signal: controller.signal,
  };
  const recording = recordValidatedProposal(t.store, input);
  controller.abort();
  release();
  await blocked;
  await expect(recording).rejects.toMatchObject({
    code: "PROPOSAL_SUBMISSION_CANCELLED",
  });
  expect(listRuns(t.store)).toEqual([]);
  expect(decisionWatermark(t.store)).toBe(0);
});
