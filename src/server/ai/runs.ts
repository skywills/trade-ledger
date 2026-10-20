import { randomUUID } from "node:crypto";
import type { Id } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import { type Store, write } from "../storage/database.js";
import type { EvidenceSnapshot } from "./evidence.js";
import type { LlmProfileSnapshot } from "./profiles.js";
import { assertProposalState, type ProposalState } from "./proposal-state.js";
import type { Proposal } from "./proposals.js";

/**
 * Durable analysis-run rows (`ai_runs`). A run keeps the immutable profile and
 * evidence snapshots it was made against, the proposals the model produced, the
 * usage/cost the session reported, and the ids of any decisions a person later
 * accepted. Nothing here writes a decision: the run only records proposals.
 */
export const ANALYSIS_PROMPT_VERSION = "reconcile-v1";
export const PROPOSAL_SCHEMA_VERSION = "proposal-v2";

export type AnalysisStatus =
  | "running"
  | "proposal_ready"
  | "failed"
  | "cancelled"
  | "accepted";

export interface SubmittedProposal {
  readonly id: Id;
  readonly proposal: Proposal;
  readonly submittedAt: string;
  readonly accepted: boolean;
}

export interface RunUsage {
  readonly rounds: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly generatedTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface PersistedRun {
  readonly id: Id;
  readonly status: AnalysisStatus;
  readonly profileSnapshot: LlmProfileSnapshot;
  readonly evidence: EvidenceSnapshot;
  readonly proposals: SubmittedProposal[];
  readonly acceptedDecisionIds: Id[];
  readonly usage: RunUsage | null;
  readonly cost: number | null;
  readonly costSource: string | null;
  readonly error: string | null;
  readonly sessionId: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly threadId: Id | null;
}

export interface RunDraft {
  readonly id: Id;
  readonly profileSnapshot: LlmProfileSnapshot;
  readonly evidence: EvidenceSnapshot;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly threadId?: Id | null;
}

interface RunRow {
  id: string;
  profile_snapshot_json: string;
  input_references_json: string;
  proposal_json: string;
  validation_json: string;
  decision_references_json: string;
  usage_json: string | null;
  cost: string | null;
  cost_source: string | null;
  status: string;
  created_at: string;
  thread_id: string | null;
}

interface ValidationMeta {
  error?: string | null;
  finishedAt?: string | null;
  sessionId?: string | null;
}

export function newProposalId(): Id {
  return randomUUID();
}

function insertRow(
  store: Store,
  draft: RunDraft,
  status: AnalysisStatus,
): void {
  store.db
    .prepare(
      `INSERT INTO ai_runs (
         id, input_references_json, input_hash, profile_id,
         profile_snapshot_json, requested_model, returned_model, prompt_version,
         schema_version, proposal_json, validation_json, decision_references_json,
         usage_json, cost, cost_source, status, created_at, thread_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      draft.id,
      JSON.stringify(draft.evidence),
      draft.evidence.contentHash,
      draft.profileSnapshot.id,
      JSON.stringify(draft.profileSnapshot),
      draft.profileSnapshot.modelId,
      null,
      ANALYSIS_PROMPT_VERSION,
      PROPOSAL_SCHEMA_VERSION,
      JSON.stringify({ proposals: [] }),
      JSON.stringify({
        issues: [],
        error: null,
        finishedAt: null,
        sessionId: draft.sessionId,
      }),
      JSON.stringify([]),
      null,
      null,
      null,
      status,
      draft.createdAt,
      draft.threadId ?? null,
    );
}

export function insertRun(
  store: Store,
  draft: RunDraft,
  status: AnalysisStatus = "running",
): Promise<void> {
  return write(store, () => insertRow(store, draft, status));
}

function toRun(row: RunRow): PersistedRun {
  const profile = JSON.parse(row.profile_snapshot_json) as LlmProfileSnapshot;
  const evidence = JSON.parse(row.input_references_json) as EvidenceSnapshot;
  const proposals =
    (JSON.parse(row.proposal_json) as { proposals?: SubmittedProposal[] })
      .proposals ?? [];
  const meta = JSON.parse(row.validation_json) as ValidationMeta;
  const usage =
    row.usage_json === null ? null : (JSON.parse(row.usage_json) as RunUsage);
  return {
    id: row.id,
    status: row.status as AnalysisStatus,
    profileSnapshot: profile,
    evidence,
    proposals: [...proposals],
    acceptedDecisionIds: JSON.parse(row.decision_references_json) as Id[],
    usage,
    cost: row.cost === null ? null : Number(row.cost),
    costSource: row.cost_source,
    error: meta.error ?? null,
    sessionId: meta.sessionId ?? null,
    createdAt: row.created_at,
    finishedAt: meta.finishedAt ?? null,
    threadId: row.thread_id ?? null,
  };
}

export function readRun(store: Store, id: Id): PersistedRun | null {
  const row = store.db
    .prepare(
      `SELECT id, profile_snapshot_json, input_references_json, proposal_json,
              validation_json, decision_references_json, usage_json, cost,
              cost_source, status, created_at, thread_id
       FROM ai_runs WHERE id = ?`,
    )
    .get(id) as RunRow | undefined;
  return row === undefined ? null : toRun(row);
}

export function listRuns(store: Store): PersistedRun[] {
  const rows = store.db
    .prepare(
      `SELECT id, profile_snapshot_json, input_references_json, proposal_json,
              validation_json, decision_references_json, usage_json, cost,
              cost_source, status, created_at, thread_id
       FROM ai_runs ORDER BY created_at DESC, rowid DESC`,
    )
    .all() as RunRow[];
  return rows.map(toRun);
}

export interface RunUpdate {
  readonly status?: AnalysisStatus;
  readonly proposals?: readonly SubmittedProposal[];
  readonly acceptedDecisionIds?: readonly Id[];
  readonly usage?: RunUsage | null;
  readonly cost?: number | null;
  readonly costSource?: string | null;
  readonly error?: string | null;
  readonly finishedAt?: string | null;
  readonly returnedModel?: string | null;
}

function readMeta(store: Store, id: Id): ValidationMeta {
  const row = store.db
    .prepare("SELECT validation_json FROM ai_runs WHERE id = ?")
    .get(id) as { validation_json: string } | undefined;
  if (row === undefined) {
    throw new AppError(
      "RUN_NOT_FOUND",
      `No analysis run exists for id ${id}.`,
      404,
    );
  }
  return JSON.parse(row.validation_json) as ValidationMeta;
}

export function updateRun(
  store: Store,
  id: Id,
  patch: RunUpdate,
): Promise<void> {
  return write(store, () => {
    const current = readRun(store, id);
    if (current === null) {
      throw new AppError(
        "RUN_NOT_FOUND",
        `No analysis run exists for id ${id}.`,
        404,
      );
    }
    const meta = readMeta(store, id);
    const nextMeta: ValidationMeta = {
      error: patch.error !== undefined ? patch.error : (meta.error ?? null),
      finishedAt:
        patch.finishedAt !== undefined
          ? patch.finishedAt
          : (meta.finishedAt ?? null),
      sessionId: meta.sessionId ?? null,
    };
    const proposals = patch.proposals ?? current.proposals;
    const accepted = patch.acceptedDecisionIds ?? current.acceptedDecisionIds;
    const usage = patch.usage !== undefined ? patch.usage : current.usage;
    const cost = patch.cost !== undefined ? patch.cost : current.cost;
    const costSource =
      patch.costSource !== undefined ? patch.costSource : current.costSource;
    store.db
      .prepare(
        `UPDATE ai_runs SET
           proposal_json = ?, validation_json = ?, decision_references_json = ?,
           usage_json = ?, cost = ?, cost_source = ?, status = ?,
           returned_model = COALESCE(?, returned_model)
         WHERE id = ?`,
      )
      .run(
        JSON.stringify({ proposals }),
        JSON.stringify(nextMeta),
        JSON.stringify(accepted),
        usage === null ? null : JSON.stringify(usage),
        cost === null ? null : String(cost),
        costSource,
        patch.status ?? current.status,
        patch.returnedModel ?? null,
        id,
      );
  });
}

/** Read-modify-write of one proposal, so concurrent acceptances are never overwritten. */
export function appendRunProposal(
  store: Store,
  runId: Id,
  proposal: SubmittedProposal,
): Promise<void> {
  return write(store, () => {
    const current = readRun(store, runId);
    if (current === null) {
      throw new AppError(
        "RUN_NOT_FOUND",
        `No analysis run exists for id ${runId}.`,
        404,
      );
    }
    store.db
      .prepare("UPDATE ai_runs SET proposal_json = ? WHERE id = ?")
      .run(
        JSON.stringify({ proposals: [...current.proposals, proposal] }),
        runId,
      );
  });
}

/** Validate the live generation and create/append the card in one writer turn. */
export function recordValidatedProposal(
  store: Store,
  input: {
    runId: string;
    draft: RunDraft | null;
    submitted: SubmittedProposal;
    expected: ProposalState;
    maxProposals: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  return write(store, () => {
    if (input.signal?.aborted)
      throw new AppError(
        "PROPOSAL_SUBMISSION_CANCELLED",
        "Proposal submission was cancelled.",
        408,
      );
    assertProposalState(store, input.expected);
    if (input.draft) {
      if (
        input.draft.id !== input.runId ||
        input.draft.evidence.buildId !== input.expected.buildId ||
        input.draft.evidence.watermark !== input.expected.watermark
      )
        throw new AppError(
          "STALE_INPUT",
          "Proposal evidence no longer matches the validated journal.",
          409,
        );
      insertRow(store, input.draft, "proposal_ready");
    }
    const current = readRun(store, input.runId);
    if (!current)
      throw new AppError(
        "RUN_NOT_FOUND",
        "The proposal run is unavailable.",
        404,
      );
    if (
      current.evidence.buildId !== input.expected.buildId ||
      current.evidence.watermark !== input.expected.watermark
    )
      throw new AppError(
        "STALE_INPUT",
        "Refresh proposal evidence before recording another correction.",
        409,
      );
    if (current.proposals.length >= input.maxProposals)
      throw new AppError(
        "PROPOSAL_LIMIT",
        "This proposal run has reached its proposal limit.",
        409,
      );
    store.db
      .prepare(
        "UPDATE ai_runs SET proposal_json = ?, status = 'proposal_ready' WHERE id = ?",
      )
      .run(
        JSON.stringify({ proposals: [...current.proposals, input.submitted] }),
        input.runId,
      );
  });
}

/**
 * Marks one proposal accepted and records its decision, re-reading the row
 * inside the writer queue so a concurrently appended proposal is never lost.
 */
export function markProposalAccepted(
  store: Store,
  runId: Id,
  proposalId: Id,
  decisionId: Id,
): Promise<void> {
  return write(store, () => {
    const current = readRun(store, runId);
    if (current === null) {
      throw new AppError(
        "RUN_NOT_FOUND",
        `No analysis run exists for id ${runId}.`,
        404,
      );
    }
    if (current.proposals.find((entry) => entry.id === proposalId)?.accepted)
      return;
    const proposals = current.proposals.map((entry) =>
      entry.id === proposalId ? { ...entry, accepted: true } : entry,
    );
    const status = proposals.every((entry) => entry.accepted)
      ? "accepted"
      : current.status;
    store.db
      .prepare(
        "UPDATE ai_runs SET proposal_json = ?, decision_references_json = ?, status = ? WHERE id = ?",
      )
      .run(
        JSON.stringify({ proposals }),
        JSON.stringify([...current.acceptedDecisionIds, decisionId]),
        status,
        runId,
      );
  });
}

export function listRunsForThread(store: Store, threadId: Id): PersistedRun[] {
  const rows = store.db
    .prepare("SELECT id FROM ai_runs WHERE thread_id = ? ORDER BY created_at")
    .all(threadId) as { id: string }[];
  return rows
    .map((row) => readRun(store, row.id))
    .filter((run): run is PersistedRun => run !== null);
}

export interface RunSummary {
  readonly id: Id;
  readonly status: AnalysisStatus;
  readonly createdAt: string;
  readonly threadId: Id | null;
  readonly pendingProposals: number;
}

export function listRunSummaries(store: Store): RunSummary[] {
  const rows = store.db
    .prepare("SELECT id FROM ai_runs ORDER BY created_at DESC")
    .all() as { id: string }[];
  return rows
    .map((row) => readRun(store, row.id))
    .filter((run): run is PersistedRun => run !== null)
    .map((run) => ({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      threadId: run.threadId,
      pendingProposals: run.proposals.filter((p) => !p.accepted).length,
    }));
}
