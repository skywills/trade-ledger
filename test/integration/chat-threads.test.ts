import { afterEach, describe, expect, it } from "vitest";
import { buildEvidenceSnapshot } from "../../src/server/ai/evidence.js";
import { acceptProposal } from "../../src/server/ai/proposals.js";
import {
  appendRunProposal,
  insertRun,
  listRunSummaries,
  listRunsForThread,
  newProposalId,
  readRun,
  updateRun,
} from "../../src/server/ai/runs.js";
import {
  appendMessage,
  createThread,
  deleteThread,
  findMessageByClientId,
  listMessages,
  listThreads,
  readThread,
  recoverChatThreads,
  updateMessage,
  updateThread,
} from "../../src/server/chat/threads.js";
import { localProfile, seedLedger } from "../helpers/chat.js";
import { createTestStore, type TestStore } from "../helpers/store.js";

const open: TestStore[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
});
async function store() {
  const s = await createTestStore();
  open.push(s);
  return s.store;
}
const now = new Date("2026-10-15T10:00:00Z");
const draft = {
  title: "P&L",
  sessionId: "sess-1",
  profileId: null,
  modelRef: "openrouter/m",
  cloudConfirmed: false,
  seed: null,
  now,
};

describe("chat thread repository", () => {
  it("creates threads and allocates monotonic message seqs", async () => {
    const s = await store();
    const thread = await createThread(s, draft);
    expect(thread).toMatchObject({
      status: "idle",
      cost: "0",
      nextSeq: 0,
      pending: null,
    });
    const a = await appendMessage(s, thread.id, {
      role: "user",
      content: "hi",
      attachments: [],
      status: "complete",
      clientMessageId: "c1",
      now,
    });
    const b = await appendMessage(s, thread.id, {
      role: "assistant",
      content: "",
      attachments: [],
      status: "streaming",
      clientMessageId: null,
      now,
    });
    expect([a.seq, b.seq]).toEqual([0, 1]);
    expect(readThread(s, thread.id)?.nextSeq).toBe(2);
    expect(findMessageByClientId(s, thread.id, "c1")?.id).toBe(a.id);
    expect(listMessages(s, thread.id).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("rejects a duplicate clientMessageId within a thread", async () => {
    const s = await store();
    const thread = await createThread(s, draft);
    await appendMessage(s, thread.id, {
      role: "user",
      content: "x",
      attachments: [],
      status: "complete",
      clientMessageId: "dup",
      now,
    });
    await expect(
      appendMessage(s, thread.id, {
        role: "user",
        content: "x",
        attachments: [],
        status: "complete",
        clientMessageId: "dup",
        now,
      }),
    ).rejects.toThrow();
  });

  it("updates, lists newest first and deletes with messages", async () => {
    const s = await store();
    const t1 = await createThread(s, { ...draft, sessionId: "a" });
    const t2 = await createThread(s, { ...draft, sessionId: "b" });
    await updateThread(s, t1.id, {
      title: "renamed",
      now: new Date("2026-10-16T00:00:00Z"),
    });
    expect(listThreads(s).map((t) => t.id)).toEqual([t1.id, t2.id]);
    const m = await appendMessage(s, t2.id, {
      role: "user",
      content: "x",
      attachments: [],
      status: "complete",
      clientMessageId: null,
      now,
    });
    await updateMessage(s, m.id, {
      content: "y",
      tools: [
        {
          callId: "c",
          name: "list_imports",
          status: "done",
          isError: false,
          approval: null,
        },
      ],
    });
    expect(listMessages(s, t2.id)[0]?.tools[0]?.name).toBe("list_imports");
    await deleteThread(s, t2.id);
    expect(readThread(s, t2.id)).toBeNull();
    expect(listMessages(s, t2.id)).toEqual([]);
  });

  it("recovers threads and messages interrupted by a restart", async () => {
    const s = await store();
    const thread = await createThread(s, draft);
    await updateThread(s, thread.id, {
      status: "waiting",
      pending: {
        kind: "approval",
        requestId: "r",
        tool: "rebuild",
        text: "Rebuild",
        expiresAt: "x",
      },
      now,
    });
    const m = await appendMessage(s, thread.id, {
      role: "assistant",
      content: "part",
      attachments: [],
      status: "streaming",
      clientMessageId: null,
      now,
    });
    await recoverChatThreads(s, now);
    expect(readThread(s, thread.id)).toMatchObject({
      status: "failed",
      pending: null,
    });
    expect(listMessages(s, thread.id).find((x) => x.id === m.id)).toMatchObject(
      { status: "failed", error: "INTERRUPTED", content: "part" },
    );
  });
});

describe("thread-aware proposal runs", () => {
  it("appends proposals in place and never loses an acceptance", async () => {
    const s = await store();
    const { ledger, buildId } = await seedLedger(s);
    const thread = await createThread(s, draft);
    const profile = await localProfile(s);
    const runId = "run-1";
    await insertRun(
      s,
      {
        id: runId,
        profileSnapshot: profile,
        evidence: buildEvidenceSnapshot(s, { buildId, issueKeys: [] }),
        sessionId: thread.sessionId,
        createdAt: now.toISOString(),
        threadId: thread.id,
      },
      "proposal_ready",
    );
    const execution = ledger.executions[0];
    const source = execution?.sources[0];
    if (execution === undefined || source === undefined)
      throw new Error("no execution");
    const proposal = {
      kind: "manual_allocation" as const,
      strategyIds: ["strategy-test"],
      sources: execution.sources,
      rationale: "r",
      payload: {
        strategyId: "strategy-test",
        source,
        allocations: [
          {
            executionKey: execution.key,
            quantity: execution.quantity,
            netCash: execution.netCash,
            brokerPnl: null,
          },
        ],
      },
    };
    const first = {
      id: newProposalId(),
      proposal,
      submittedAt: now.toISOString(),
      accepted: false,
    };
    await appendRunProposal(s, runId, first);
    await acceptProposal(s, runId, first.id, 0);
    await appendRunProposal(s, runId, { ...first, id: newProposalId() });
    await updateRun(s, runId, { usage: null, cost: 0 }); // turn end writes usage only
    const run = readRun(s, runId);
    expect(run?.proposals.map((p) => p.accepted)).toEqual([true, false]);
    expect(run?.threadId).toBe(thread.id);
    expect(listRunsForThread(s, thread.id).map((r) => r.id)).toEqual([runId]);
    expect(listRunSummaries(s)[0]).toMatchObject({
      id: runId,
      threadId: thread.id,
      pendingProposals: 1,
    });
  });

  it("keeps a proposal appended while an acceptance is in flight", async () => {
    const s = await store();
    const { ledger, buildId } = await seedLedger(s);
    const thread = await createThread(s, draft);
    const profile = await localProfile(s);
    await insertRun(
      s,
      {
        id: "run-2",
        profileSnapshot: profile,
        evidence: buildEvidenceSnapshot(s, { buildId, issueKeys: [] }),
        sessionId: thread.sessionId,
        createdAt: now.toISOString(),
        threadId: thread.id,
      },
      "proposal_ready",
    );
    const execution = ledger.executions[0];
    const source = execution?.sources[0];
    if (execution === undefined || source === undefined)
      throw new Error("no execution");
    const proposal = {
      kind: "manual_allocation" as const,
      strategyIds: ["strategy-test"],
      sources: execution.sources,
      rationale: "r",
      payload: {
        strategyId: "strategy-test",
        source,
        allocations: [
          {
            executionKey: execution.key,
            quantity: execution.quantity,
            netCash: execution.netCash,
            brokerPnl: null,
          },
        ],
      },
    };
    const first = {
      id: newProposalId(),
      proposal,
      submittedAt: now.toISOString(),
      accepted: false,
    };
    await appendRunProposal(s, "run-2", first);
    await Promise.all([
      acceptProposal(s, "run-2", first.id, 0),
      appendRunProposal(s, "run-2", { ...first, id: newProposalId() }),
    ]);
    const run = readRun(s, "run-2");
    expect(run?.proposals.map((p) => p.accepted)).toEqual([true, false]);
    expect(run?.acceptedDecisionIds).toHaveLength(1);
  });
});
