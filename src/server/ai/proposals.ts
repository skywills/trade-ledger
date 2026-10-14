import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type {
  Execution,
  Id,
  Issue,
  LedgerSnapshot,
  SourceRef,
} from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import { minorUnit } from "../../shared/money.js";
import { activeLedgerSnapshot } from "../builds/service.js";
import {
  type DecisionInput,
  DecisionInputSchema,
  rejectionInput,
} from "../decisions/schemas.js";
import {
  appendDecision,
  type Decision,
  decisionWatermark,
} from "../decisions/service.js";
import type { Store } from "../storage/database.js";
import { makeIssue } from "../strategies/projection.js";
import { readRun, updateRun } from "./runs.js";

/**
 * A model's reconciliation proposal. It mirrors the Task 6 financial decision
 * shapes but carries no `clientRequestId`/`author`: a proposal is a suggestion,
 * not a retained decision. Accepting it re-validates against the current ledger
 * and only then appends a real decision.
 */
const DecimalText = z
  .string()
  .regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/, "must be a decimal string");

const IdSchema = z.string().min(1);
const SourceRefSchema = z.object({
  importId: IdSchema,
  rowNumber: z.number().int().positive(),
});

const CommonFields = {
  rationale: z.string().optional(),
  sources: z.array(SourceRefSchema).default([]),
  strategyIds: z.array(IdSchema).default([]),
};

const AllocationRowSchema = z.object({
  executionKey: z.string().min(1),
  quantity: DecimalText,
  netCash: DecimalText,
  brokerPnl: DecimalText.nullable().default(null),
});

export const ProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("manual_allocation"),
    ...CommonFields,
    payload: z.object({
      strategyId: IdSchema,
      source: SourceRefSchema,
      allocations: z.array(AllocationRowSchema).min(1),
    }),
  }),
  z.object({
    kind: z.literal("identity_binding"),
    ...CommonFields,
    payload: z.object({
      source: SourceRefSchema,
      canonicalIdentity: IdSchema,
      expectedQuantity: DecimalText,
    }),
  }),
  z.object({
    kind: z.literal("group_explicit"),
    ...CommonFields,
    payload: z.object({ strategyId: IdSchema, source: SourceRefSchema }),
  }),
  z.object({
    kind: z.literal("lifecycle"),
    ...CommonFields,
    payload: z.object({
      event: z.enum(["assignment", "exercise", "expiry", "roll"]),
      sourceRef: SourceRefSchema,
      targetRef: SourceRefSchema,
    }),
  }),
  z.object({
    kind: z.literal("notes"),
    ...CommonFields,
    payload: z.object({ strategyId: IdSchema, text: z.string().min(1) }),
  }),
  z.object({
    kind: z.literal("stop_loss"),
    ...CommonFields,
    payload: z.object({ strategyId: IdSchema, price: DecimalText }),
  }),
]);

export type Proposal = z.infer<typeof ProposalSchema>;
export type ProposalKind = Proposal["kind"];

export const PROPOSAL_KINDS = [
  "manual_allocation",
  "identity_binding",
  "group_explicit",
  "lifecycle",
  "notes",
  "stop_loss",
] as const satisfies readonly ProposalKind[];

/** Parse a model-supplied proposal; throws an AppError on a schema violation. */
export function parseProposal(raw: unknown): Proposal {
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      "INVALID_PROPOSAL",
      `Proposal failed validation: ${parsed.error.message}`,
      400,
    );
  }
  return parsed.data;
}

export type ParsedProposal =
  | { ok: true; proposal: Proposal }
  | { ok: false; message: string };

/** Non-throwing parse used by the `submit_proposal` tool. */
export function tryParseProposal(raw: unknown): ParsedProposal {
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.message };
  return { ok: true, proposal: parsed.data };
}

function sourceKey(source: SourceRef): string {
  return `${source.importId}#${source.rowNumber}`;
}

function executionByKey(
  ledger: LedgerSnapshot,
  key: string,
): Execution | undefined {
  return ledger.executions.find((execution) => execution.key === key);
}

function sourceExists(ledger: LedgerSnapshot, source: SourceRef): boolean {
  const key = sourceKey(source);
  return ledger.executions.some((execution) =>
    execution.sources.some((candidate) => sourceKey(candidate) === key),
  );
}

function isDecimal(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
}

/**
 * Validates a proposal against the current ledger using the same conservation
 * invariants the projection uses: a partition that exceeds an execution's
 * signed quantity is `OVER_ALLOCATION`, a sign contradiction is
 * `ALLOCATION_SIGN_MISMATCH`, an over-allocated cash partition is
 * `ALLOCATION_CASH_MISMATCH`, and a reference the ledger does not carry is
 * `UNKNOWN_SOURCE`. Decimal strings are checked app-side regardless of what the
 * model's own schema enforced.
 */
export function validateProposal(
  ledger: LedgerSnapshot,
  proposal: Proposal,
): Issue[] {
  const issues = new Map<string, Issue>();
  const add = (issue: Issue): void => {
    if (!issues.has(issue.key)) issues.set(issue.key, issue);
  };

  const checkSource = (source: SourceRef, scope: string): void => {
    if (!sourceExists(ledger, source)) {
      add(makeIssue("UNKNOWN_SOURCE", [source], "error", scope));
    }
  };

  switch (proposal.kind) {
    case "manual_allocation": {
      checkSource(proposal.payload.source, proposal.payload.strategyId);
      const byExecution = new Map<
        string,
        typeof proposal.payload.allocations
      >();
      for (const allocation of proposal.payload.allocations) {
        const entries = byExecution.get(allocation.executionKey) ?? [];
        entries.push(allocation);
        byExecution.set(allocation.executionKey, entries);
        if (!isDecimal(allocation.quantity) || !isDecimal(allocation.netCash)) {
          add(
            makeIssue(
              "INVALID_DECIMAL",
              [proposal.payload.source],
              "error",
              allocation.executionKey,
            ),
          );
        }
      }
      for (const [key, allocations] of byExecution) {
        const execution = executionByKey(ledger, key);
        if (execution === undefined) {
          add(makeIssue("UNKNOWN_EXECUTION", [], "error", key));
          continue;
        }
        let allocatedQuantity = new Decimal(0);
        let allocatedCash = new Decimal(0);
        let invalid = false;
        for (const allocation of allocations) {
          if (
            !isDecimal(allocation.quantity) ||
            !isDecimal(allocation.netCash)
          ) {
            invalid = true;
            continue;
          }
          allocatedQuantity = allocatedQuantity.plus(allocation.quantity);
          allocatedCash = allocatedCash.plus(allocation.netCash);
        }
        if (invalid) continue;
        if (allocatedQuantity.abs().gt(new Decimal(execution.quantity).abs())) {
          add(makeIssue("OVER_ALLOCATION", execution.sources, "error", key));
        }
        const allocatedSign = allocatedQuantity.comparedTo(0);
        const executionSign = new Decimal(execution.quantity).comparedTo(0);
        if (
          allocatedSign !== 0 &&
          executionSign !== 0 &&
          allocatedSign !== executionSign
        ) {
          add(
            makeIssue(
              "ALLOCATION_SIGN_MISMATCH",
              execution.sources,
              "error",
              key,
            ),
          );
        }
        const tolerance = new Decimal(minorUnit(execution.currency));
        if (
          allocatedCash
            .abs()
            .gt(new Decimal(execution.netCash).abs().plus(tolerance))
        ) {
          add(
            makeIssue(
              "ALLOCATION_CASH_MISMATCH",
              execution.sources,
              "error",
              key,
            ),
          );
        }
      }
      break;
    }
    case "identity_binding":
      checkSource(proposal.payload.source, proposal.payload.canonicalIdentity);
      if (!isDecimal(proposal.payload.expectedQuantity)) {
        add(
          makeIssue(
            "INVALID_DECIMAL",
            [proposal.payload.source],
            "error",
            proposal.payload.canonicalIdentity,
          ),
        );
      }
      break;
    case "group_explicit":
      checkSource(proposal.payload.source, proposal.payload.strategyId);
      break;
    case "lifecycle":
      checkSource(proposal.payload.sourceRef, "lifecycle");
      checkSource(proposal.payload.targetRef, "lifecycle");
      break;
    case "notes":
    case "stop_loss":
      if (proposal.kind === "stop_loss" && !isDecimal(proposal.payload.price)) {
        add(
          makeIssue(
            "INVALID_DECIMAL",
            [],
            "error",
            proposal.payload.strategyId,
          ),
        );
      }
      break;
  }

  for (const source of proposal.sources) checkSource(source, proposal.kind);

  return [...issues.values()].sort((left, right) =>
    left.key < right.key ? -1 : 1,
  );
}

/** Converts an accepted proposal into a Task 6 decision input. */
export function proposalDecisionInput(
  proposal: Proposal,
  clientRequestId: string = randomUUID(),
): DecisionInput {
  const parsed = DecisionInputSchema.safeParse({
    kind: proposal.kind,
    sources: proposal.sources,
    strategyIds: proposal.strategyIds,
    payload: proposal.payload,
    supersedesId: null,
    clientRequestId,
    author: "ai-accepted",
  });
  if (!parsed.success) {
    throw new AppError(
      "INVALID_PROPOSAL",
      `Proposal cannot become a decision: ${parsed.error.message}`,
      400,
    );
  }
  return parsed.data;
}

/**
 * Accepts a proposal: re-reads the current ledger, re-validates the proposal
 * (a proposal that no longer conserves quantity is refused), then appends a
 * retained decision through the Task 6 path. The `expectedWatermark` guards the
 * read-modify-write; a moved watermark is a 409 the caller must refresh.
 */
export async function acceptProposal(
  store: Store,
  runId: Id,
  proposalId: Id,
  expectedWatermark: number,
): Promise<Decision[]> {
  const run = readRun(store, runId);
  if (run === null) {
    throw new AppError(
      "RUN_NOT_FOUND",
      `No analysis run exists for id ${runId}.`,
      404,
    );
  }
  const submitted = run.proposals.find((entry) => entry.id === proposalId);
  if (submitted === undefined) {
    throw new AppError(
      "PROPOSAL_NOT_FOUND",
      `No proposal exists for id ${proposalId}.`,
      404,
    );
  }
  if (submitted.accepted) {
    throw new AppError(
      "PROPOSAL_ALREADY_ACCEPTED",
      "This proposal has already been accepted.",
      409,
    );
  }
  const ledger = activeLedgerSnapshot(store);
  if (ledger === null) {
    throw new AppError(
      "NO_ACTIVE_BUILD",
      "No active ledger is available to accept a proposal against.",
      409,
    );
  }
  const errors = validateProposal(ledger, submitted.proposal).filter(
    (issue) => issue.severity === "error",
  );
  if (errors.length > 0) {
    throw new AppError(
      "PROPOSAL_INVALID",
      `Proposal failed re-validation: ${errors.map((issue) => issue.code).join(", ")}.`,
      409,
    );
  }

  const decision = await appendDecision(
    store,
    proposalDecisionInput(submitted.proposal),
    expectedWatermark,
  );
  const proposals = run.proposals.map((entry) =>
    entry.id === proposalId ? { ...entry, accepted: true } : entry,
  );
  const allAccepted = proposals.every((entry) => entry.accepted);
  await updateRun(store, runId, {
    proposals,
    acceptedDecisionIds: [...run.acceptedDecisionIds, decision.id],
    status: allAccepted ? "accepted" : run.status,
  });
  return [decision];
}

/**
 * Rejects a proposal by appending a retained `rejection` decision carrying the
 * exact evidence hash the run was made against. The watermark guard is the same
 * compare-and-append the accept path uses.
 */
export async function rejectProposal(
  store: Store,
  runId: Id,
  reason: string | undefined,
  expectedWatermark: number,
): Promise<Decision> {
  const run = readRun(store, runId);
  if (run === null) {
    throw new AppError(
      "RUN_NOT_FOUND",
      `No analysis run exists for id ${runId}.`,
      404,
    );
  }
  const decision = await appendDecision(
    store,
    rejectionInput({
      evidenceHash: run.evidence.contentHash,
      ...(reason === undefined ? {} : { reason }),
    }),
    expectedWatermark,
  );
  await updateRun(store, runId, {
    acceptedDecisionIds: [...run.acceptedDecisionIds, decision.id],
  });
  return decision;
}

export { decisionWatermark };
