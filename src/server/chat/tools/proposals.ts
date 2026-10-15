// src/server/chat/tools/proposals.ts
import { randomUUID } from "node:crypto";
import { buildEvidenceSnapshot } from "../../ai/evidence.js";
import { tryParseProposal } from "../../ai/proposals.js";
import {
  appendRunProposal,
  insertRun,
  newProposalId,
  type SubmittedProposal,
} from "../../ai/runs.js";
import { resolveProfile } from "../../ai/session-host.js";
import { MAX_PROPOSALS_PER_RUN } from "../../ai/tools.js";
import { activeProjection } from "../../builds/service.js";
import {
  type ChatTool,
  type ChatToolContext,
  errorResult,
  jsonResult,
  refuseInvalidInput,
} from "./shared.js";

const SUBMIT_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [
        "manual_allocation",
        "identity_binding",
        "group_explicit",
        "lifecycle",
        "notes",
        "stop_loss",
      ],
    },
    rationale: { type: "string" },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          importId: { type: "string" },
          rowNumber: { type: "integer", minimum: 1 },
        },
        required: ["importId", "rowNumber"],
        additionalProperties: false,
      },
    },
    strategyIds: { type: "array", items: { type: "string" } },
    payload: { type: "object" },
  },
  required: ["kind", "payload"],
  additionalProperties: false,
};

/** Creates this turn's proposal run on first use; proposals are persisted one by one. */
async function ensureRun(ctx: ChatToolContext): Promise<string> {
  const existing = ctx.turn.current.proposalRunId;
  if (existing !== null) return existing;
  const thread = ctx.thread();
  const buildId = activeProjection(ctx.store).buildId;
  const evidence = buildEvidenceSnapshot(ctx.store, {
    buildId: buildId ?? "",
    issueKeys: thread.seed?.issueKeys ?? [],
  });
  const runId = randomUUID();
  await insertRun(
    ctx.store,
    {
      id: runId,
      profileSnapshot: resolveProfile(ctx.store, thread.profileId, {
        cloudConfirmed: thread.cloudConfirmed,
      }),
      evidence,
      sessionId: thread.sessionId,
      createdAt: ctx.now().toISOString(),
      threadId: thread.id,
    },
    "proposal_ready",
  );
  ctx.turn.current = { ...ctx.turn.current, proposalRunId: runId };
  return runId;
}

export function proposalTools(ctx: ChatToolContext): ChatTool[] {
  return [
    {
      name: "submit_proposal",
      description:
        "Record a reconciliation proposal for the user to accept or reject. This does not write a decision. Allocations must conserve each execution's signed quantity and net cash.",
      inputSchema: SUBMIT_SCHEMA,
      approval: "never",
      run: (input) =>
        refuseInvalidInput(async () => {
          if (ctx.turn.current.proposalCount >= MAX_PROPOSALS_PER_RUN) {
            return errorResult(
              `At most ${MAX_PROPOSALS_PER_RUN} proposals may be submitted per turn.`,
            );
          }
          const parsed = tryParseProposal(input);
          if (!parsed.ok)
            return errorResult(`Proposal rejected: ${parsed.message}`);
          const runId = await ensureRun(ctx);
          const submitted: SubmittedProposal = {
            id: newProposalId(),
            proposal: parsed.proposal,
            submittedAt: ctx.now().toISOString(),
            accepted: false,
          };
          await appendRunProposal(ctx.store, runId, submitted);
          ctx.turn.current = {
            ...ctx.turn.current,
            proposalCount: ctx.turn.current.proposalCount + 1,
          };
          ctx.emitProposal(runId, submitted.id);
          return jsonResult({
            recorded: true,
            proposalId: submitted.id,
            note: "The user must accept this proposal before it becomes a decision.",
          });
        }),
    },
  ];
}
