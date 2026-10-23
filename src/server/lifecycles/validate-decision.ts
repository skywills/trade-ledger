import type {
  Decision,
  LedgerSnapshot,
  Projection,
} from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import type { RetainedLifecycleAnchor } from "../../shared/lifecycles.js";
import {
  CampaignPayloadSchema,
  LifecycleRejectionPayloadSchema,
  ValuationSnapshotSchema,
} from "../../shared/lifecycles.js";
import {
  assertConnectionOrder,
  coveredConnectionAssignments,
} from "./connection-order.js";
import { refKey, validateMembership } from "./membership.js";
import { projectLifecycles } from "./project.js";
import { latestExecutionBound } from "./valuation.js";
export function validateLifecycleDecision(
  ledger: LedgerSnapshot,
  projection: Projection,
  decisions: readonly Decision[],
  candidate: Decision,
  origins?: Projection,
  retainedAnchors: readonly RetainedLifecycleAnchor[] = [],
): void {
  const connections = coveredConnectionAssignments(candidate);
  if (connections.length) {
    const current = projectLifecycles(
      ledger,
      projection,
      decisions,
      undefined,
      origins,
      retainedAnchors,
    );
    assertConnectionOrder(ledger, current, connections);
  }
  if (candidate.kind === "wheel_campaign") {
    const payload = CampaignPayloadSchema.parse(candidate.payload);
    const previous = projection.lifecycles?.campaigns.find(
      (c) => c.id === payload.campaignId,
    );
    if (
      previous &&
      (previous.account !== payload.account ||
        previous.currency !== payload.currency ||
        previous.underlyingKey !== payload.underlyingKey)
    )
      throw new AppError(
        "INVALID_LIFECYCLE_MEMBERSHIP",
        "Campaign scope cannot be changed by renaming it.",
        409,
      );
  }
  if (candidate.kind === "lifecycle_valuation") {
    const p = ValuationSnapshotSchema.parse(candidate.payload);
    if (Date.parse(p.asOf) > Date.now())
      throw new AppError(
        "INVALID_VALUATION",
        "Valuation cannot be in the future.",
        400,
      );
    if (new Set(p.marks.map((m) => m.instrumentKey)).size !== p.marks.length)
      throw new AppError(
        "INVALID_VALUATION",
        "Duplicate prices for an instrument.",
        400,
      );
    const relevant = ledger.executions.filter(
      (e) =>
        e.account === p.account &&
        e.currency === p.currency &&
        p.marks.some((m) => m.instrumentKey === e.instrument.key),
    );
    if (
      !relevant.length ||
      p.marks.some(
        (m) => !relevant.some((e) => e.instrument.key === m.instrumentKey),
      )
    )
      throw new AppError(
        "INVALID_VALUATION",
        "Prices must reference instruments in this account and currency.",
        400,
      );
    if (
      relevant.some((e) => {
        const timestamp = latestExecutionBound(e);
        return !Number.isFinite(timestamp) || timestamp > Date.parse(p.asOf);
      })
    )
      throw new AppError(
        "INVALID_VALUATION",
        "Valuation must follow the latest included execution.",
        400,
      );
  }
  if (candidate.kind === "lifecycle_attachment_rejection") {
    const p = LifecycleRejectionPayloadSchema.parse(candidate.payload);
    const draft = projectLifecycles(
      ledger,
      projection,
      decisions,
      undefined,
      origins,
      retainedAnchors,
    );
    const suggestion = draft.suggestions.find(
      (s) => refKey(s.callOpening) === refKey(p.callOpening),
    );
    if (
      !suggestion ||
      p.candidateLifecycleIds.some(
        (id) => !suggestion.candidateLifecycleIds.includes(id),
      )
    )
      throw new AppError(
        "INVALID_LIFECYCLE_MEMBERSHIP",
        "This attachment suggestion is no longer current.",
        409,
      );
  }
  const draft = projectLifecycles(
    ledger,
    projection,
    [...decisions, candidate],
    undefined,
    origins,
    retainedAnchors,
  );
  if (validateMembership(ledger, projection, draft.members).length)
    throw new AppError(
      "INVALID_LIFECYCLE_MEMBERSHIP",
      "Membership does not conserve source allocations.",
      409,
    );
}
