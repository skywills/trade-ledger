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
import {
  activeLedgerSnapshot,
  activeProjection,
} from "../../src/server/builds/service.js";
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
import {
  buildExecutionTable,
  executionRow,
  fixtures,
} from "../fixtures/scenarios.js";
import { seedLedger, verifiedProfile } from "../helpers/chat.js";
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

async function setupLargeJournal() {
  const t = await setup();
  await seedLedger(
    t.store,
    buildExecutionTable(
      Array.from({ length: 1997 }, (_, i) =>
        executionRow({
          ClientAccountID: "PADDING",
          AssetClass: "STK",
          Symbol: "OTHER",
          UnderlyingSymbol: "OTHER",
          Conid: "90001",
          CurrencyPrimary: "USD",
          TradeDate: "2026-10-01",
          DateTime: "2026-10-01 12:00:00",
          Quantity: "1",
          TradePrice: "1",
          NetCash: "-1",
          Multiplier: "1",
          "Notes/Codes": "O",
          IBExecID: `padding-${i}`,
          TradeID: `padding-${i}`,
          IBOrderID: `padding-${i}`,
        }),
      ),
    ),
  );
  expect(activeLedgerSnapshot(t.store)?.executions).toHaveLength(2001);
  return t;
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

it.each(["attachment", "attachment with sources", "membership", "notes"])(
  "%s submission scopes evidence in a journal above 2,000 executions",
  async (kind) => {
    const t = await setupLargeJournal();
    const proposal = parseProposal(
      kind === "notes"
        ? t.notes
        : kind === "membership"
          ? {
              kind: "lifecycle_membership",
              payload: {
                requireCallCoverage: true,
                assignments: [
                  {
                    lifecycleId: t.target.id,
                    allocation: t.suggestion.callOpening,
                    quantity: "-1",
                  },
                ],
              },
            }
          : {
              kind: "lifecycle_attachment",
              sources:
                kind === "attachment with sources" ? t.member.sources : [],
              payload: {
                opening: t.suggestion.callOpening,
                targets: [{ lifecycleId: t.target.id, quantity: "-1" }],
              },
            },
    );
    const expected = {
      buildId: activeProjection(t.store).buildId ?? "",
      watermark: 0,
    };
    expect((await previewProposal(t.store, proposal, expected)).valid).toBe(
      true,
    );
    expect(await toolJson(t.tools, "submit_proposal", proposal)).toMatchObject({
      recorded: true,
    });
    const run = listRuns(t.store)[0];
    expect(run?.evidence).toMatchObject(expected);
    expect(run?.evidence.rows.length).toBeGreaterThan(0);
    expect(run?.evidence.rows.every((row) => row.account !== "PADDING")).toBe(
      true,
    );
    expect(run?.evidence.rows.length).toBeLessThanOrEqual(3);
    if (kind !== "notes") {
      expect(run?.evidence.rows.map((row) => row.executionKey)).toContain(
        t.suggestion.callOpening.executionKey,
      );
      expect(run?.evidence.rows.map((row) => row.executionKey)).toContain(
        t.member.allocation.executionKey,
      );
    }
    expect(t.emitted).toHaveLength(1);
    expect(decisionWatermark(t.store)).toBe(0);
  },
  30_000,
);

it("a genuinely oversized proposal is refused even after a smaller proposal in the same turn", async () => {
  const t = await setupLargeJournal();
  await toolJson(t.tools, "submit_proposal", t.notes);
  const ledger = activeLedgerSnapshot(t.store);
  const padding = ledger?.executions.find((e) => e.account === "PADDING");
  if (!padding?.sources[0]) throw new Error("No padding import");
  const result = await callTool(t.tools, "submit_proposal", {
    kind: "import_exclusion",
    sources: [2, 3, 4, 5].map((rowNumber) => ({
      importId: t.importId,
      rowNumber,
    })),
    payload: { importId: padding.sources[0].importId },
  });
  expect(result).toMatchObject({ isError: true });
  expect(result.content).toContain("EVIDENCE_TOO_LARGE");
  expect(result.content).toContain("split the correction");
  expect(listRuns(t.store)).toHaveLength(1);
  expect(listRuns(t.store)[0]?.proposals).toHaveLength(1);
  expect(t.emitted).toHaveLength(1);
  expect(t.ctx.turn.current.proposalCount).toBe(1);
  expect(decisionWatermark(t.store)).toBe(0);
}, 30_000);

it("a new campaign can retain an empty trade snapshot in a large journal", async () => {
  const t = await setupLargeJournal();
  expect(
    await toolJson(t.tools, "submit_proposal", {
      kind: "wheel_campaign",
      payload: {
        campaignId: "new",
        name: "New wheel",
        account: "A",
        currency: "USD",
        underlyingKey: "value:XYZ",
      },
    }),
  ).toMatchObject({ recorded: true });
  expect(listRuns(t.store)[0]?.evidence.rows).toEqual([]);
  expect(t.emitted).toHaveLength(1);
  expect(decisionWatermark(t.store)).toBe(0);
}, 30_000);

it("an unrelated seeded issue cannot replace the proposal's own evidence", async () => {
  const t = await setup();
  const issue = t.projection.issues.find(
    (i) => i.sources.length > 0 && i.sources.every((s) => s.rowNumber !== 5),
  );
  if (!issue) throw new Error("No seeded issue");
  const ctx = {
    ...t.ctx,
    thread: () => ({ ...t.thread, seed: { issueKeys: [issue.key] } }),
  };
  await toolJson(proposalTools(ctx), "submit_proposal", {
    kind: "notes",
    payload: { strategyId: t.other.componentIds[0], text: "Reviewed" },
  });
  expect(listRuns(t.store)[0]?.evidence.rows.map((row) => row.account)).toEqual(
    ["B"],
  );
});

it("an excluded import can be proposed and accepted using its retained reference", async () => {
  const t = await setup();
  await appendDecision(
    t.store,
    {
      kind: "import_exclusion",
      payload: { importId: t.importId },
      author: "user",
      clientRequestId: "exclude-before-inclusion",
    },
    0,
  );
  await t.rebuild();
  expect(activeLedgerSnapshot(t.store)?.executions).toEqual([]);
  const result = await toolJson(t.tools, "submit_proposal", {
    kind: "import_inclusion",
    payload: { importId: t.importId },
  });
  expect(result.recorded).toBe(true);
  const run = listRuns(t.store)[0];
  if (!run) throw new Error("No proposal run");
  expect(run.evidence.rows).toEqual([]);
  expect(run.evidence.watermark).toBe(1);
  expect(decisionWatermark(t.store)).toBe(1);
  await acceptProposal(t.store, run.id, result.proposalId, 1);
  await t.rebuild();
  expect(activeLedgerSnapshot(t.store)?.executions).toHaveLength(4);
  expect(decisionWatermark(t.store)).toBe(2);
});

it("later proposals retain evidence for their own strategy in the same turn", async () => {
  const t = await setup();
  await toolJson(t.tools, "submit_proposal", t.notes);
  const otherStrategy = t.other.componentIds[0];
  if (!otherStrategy) throw new Error("No other strategy");
  const submitted = await toolJson(t.tools, "submit_proposal", {
    kind: "notes",
    payload: { strategyId: otherStrategy, text: "Review the other account" },
  });
  const run = listRuns(t.store).find((run) =>
    run.proposals.some((p) => p.id === submitted.proposalId),
  );
  expect(run?.evidence.rows.map((row) => row.account)).toEqual(["B"]);
  expect(listRuns(t.store)).toHaveLength(2);
  expect(t.ctx.turn.current.proposalCount).toBe(2);
  expect(decisionWatermark(t.store)).toBe(0);
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
