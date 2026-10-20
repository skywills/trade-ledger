// src/server/chat/tools/proposals.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildEvidenceSnapshot } from "../../ai/evidence.js";
import { previewProposal } from "../../ai/proposal-preview.js";
import {
  PROPOSAL_KINDS,
  ProposalSchema,
  tryParseProposal,
} from "../../ai/proposals.js";
import {
  newProposalId,
  type RunDraft,
  readRun,
  recordValidatedProposal,
  type SubmittedProposal,
} from "../../ai/runs.js";
import { resolveProfile } from "../../ai/session-host.js";
import { MAX_PROPOSALS_PER_RUN } from "../../ai/tools.js";
import { activeProjection } from "../../builds/service.js";
import { decisionWatermark } from "../../decisions/service.js";
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
      enum: [...PROPOSAL_KINDS],
    },
    rationale: { type: "string" },
    supersedesId: { anyOf: [{ type: "string" }, { type: "null" }] },
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
    payload: {
      type: "object",
      description:
        "Use the payload variant matching kind. All quantities and money are decimal strings.",
      anyOf: ProposalSchema.options.map((option) => ({
        ...z.toJSONSchema(option.shape.payload, {
          io: "input",
          target: "draft-7",
        }),
        description: `Payload for kind ${option.shape.kind.value}`,
      })),
    },
  },
  required: ["kind", "payload"],
  additionalProperties: false,
};

/** Prepare evidence without persisting an empty run across asynchronous validation. */
async function prepareRun(
  ctx: ChatToolContext,
): Promise<{ runId: string; draft: RunDraft | null }> {
  const buildId = activeProjection(ctx.store).buildId;
  const watermark = decisionWatermark(ctx.store);
  const existingId = ctx.turn.current.proposalRunId;
  const existing = existingId === null ? null : readRun(ctx.store, existingId);
  if (
    existing &&
    existing.evidence.buildId === buildId &&
    existing.evidence.watermark === watermark
  )
    return { runId: existing.id, draft: null };
  const thread = ctx.thread();
  const evidence = buildEvidenceSnapshot(ctx.store, {
    buildId: buildId ?? "",
    issueKeys: thread.seed?.issueKeys ?? [],
  });
  const runId = randomUUID();
  return {
    runId,
    draft: {
      id: runId,
      profileSnapshot: resolveProfile(ctx.store, thread.profileId, {
        cloudConfirmed: thread.cloudConfirmed,
      }),
      evidence,
      sessionId: thread.sessionId,
      createdAt: ctx.now().toISOString(),
      threadId: thread.id,
    },
  };
}

export function proposalTools(ctx: ChatToolContext): ChatTool[] {
  return [
    {
      name: "submit_proposal",
      description:
        "Validate a reconciliation proposal in an isolated full rebuild, then record a pending card for the user to accept or reject. A stale build requires rebuilding first. This does not write a decision. Match payload to kind using the schema; never probe with empty payloads. identity_binding binds a source row to a canonical identity and expected quantity. group_split is unsupported because retained splits lack allocation mappings. No supported kind changes contract multipliers or fixes MISSING_MULTIPLIER; explain that limitation instead of submitting a proposal. Allocations must conserve each execution's signed quantity and net cash.",
      inputSchema: SUBMIT_SCHEMA,
      approval: "never",
      run: (input, runCtx) =>
        refuseInvalidInput(async () => {
          if (ctx.turn.current.proposalCount >= MAX_PROPOSALS_PER_RUN) {
            return errorResult(
              `At most ${MAX_PROPOSALS_PER_RUN} proposals may be submitted per turn.`,
            );
          }
          const parsed = tryParseProposal(input);
          if (!parsed.ok)
            return errorResult(`Proposal rejected: ${parsed.message}`);
          const buildId = activeProjection(ctx.store).buildId;
          if (!buildId)
            return errorResult(
              "NO_ACTIVE_BUILD: Rebuild before proposing a correction.",
            );
          const expected = { buildId, watermark: decisionWatermark(ctx.store) };
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30_000);
          timer.unref();
          let preview: Awaited<ReturnType<typeof previewProposal>>;
          try {
            preview = await previewProposal(
              ctx.store,
              parsed.proposal,
              expected,
              {
                signal: AbortSignal.any([controller.signal, runCtx.signal]),
                now: () => ctx.now(),
              },
            );
          } finally {
            clearTimeout(timer);
          }
          if (!preview.valid)
            return errorResult(
              `Proposal rejected: ${preview.issues.map((issue) => issue.code).join(", ")}`,
            );
          if (runCtx.signal.aborted)
            return errorResult("Proposal submission cancelled.");
          if (ctx.turn.current.proposalCount >= MAX_PROPOSALS_PER_RUN)
            return errorResult(
              `At most ${MAX_PROPOSALS_PER_RUN} proposals may be submitted per turn.`,
            );
          const { runId, draft } = await prepareRun(ctx);
          const submitted: SubmittedProposal = {
            id: newProposalId(),
            proposal: parsed.proposal,
            submittedAt: ctx.now().toISOString(),
            accepted: false,
          };
          if (runCtx.signal.aborted)
            return errorResult("Proposal submission cancelled.");
          await recordValidatedProposal(ctx.store, {
            runId,
            draft,
            submitted,
            expected,
            maxProposals: MAX_PROPOSALS_PER_RUN,
            signal: runCtx.signal,
          });
          ctx.turn.current = {
            ...ctx.turn.current,
            proposalCount: ctx.turn.current.proposalCount + 1,
            proposalRunId: runId,
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
