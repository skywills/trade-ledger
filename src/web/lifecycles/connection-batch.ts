import type { z } from "zod";
import { compareExecutionTime } from "../../shared/execution-chronology.js";
import {
  type ProposalPreview,
  ProposalPreviewSchema,
} from "../../shared/proposal-preview.js";
import {
  DecisionResponseSchema,
  request,
  requestJson,
  type RequestOptions,
} from "../api.js";
import { LifecycleListSchema, rebuildLifecycles } from "./api.js";
import {
  type ConnectionGroup,
  connectionGroups,
  connectionProposal,
  connectionTimeline,
} from "./connections.js";

export type ConnectionData = z.infer<typeof LifecycleListSchema>;
type Proposal = ReturnType<typeof connectionProposal>;
type Receipt = { id: string; sequence: number };
type SaveRequest = {
  clientRequestId: string;
  expectedWatermark: number;
  author: "user";
  kind: Proposal["kind"];
  payload: Proposal["payload"];
};

function assignmentKey(
  assignment: Proposal["payload"]["assignments"][number],
): string {
  return [
    assignment.allocation.strategyId,
    assignment.allocation.executionKey,
    assignment.allocation.role,
    assignment.lifecycleId,
  ].join("\u0000");
}

export function canonicalProposalPayload(
  payload: Proposal["payload"],
): string {
  return JSON.stringify({
    requireCallCoverage: payload.requireCallCoverage,
    assignments: [...payload.assignments]
      .sort((a, b) => assignmentKey(a).localeCompare(assignmentKey(b)))
      .map((assignment) => ({
        allocation: {
          strategyId: assignment.allocation.strategyId,
          executionKey: assignment.allocation.executionKey,
          role: assignment.allocation.role,
        },
        lifecycleId: assignment.lifecycleId,
        quantity: assignment.quantity,
      })),
  });
}

export interface ConnectionSection {
  key: string;
  underlying: string;
  account: string;
  currency: string;
  groups: ConnectionGroup[];
}

export function connectionDate(
  group: ConnectionGroup,
  data: ConnectionData,
): string {
  const keys = new Set(
    group.suggestions.map((s) => s.callOpening.executionKey),
  );
  return (
    data.connectionExecutions
      .filter((e) => keys.has(e.key))
      .map((e) => e.date)
      .sort()[0] ?? "Date unavailable"
  );
}

export function connectionSections(data: ConnectionData): ConnectionSection[] {
  const projection = data.lifecycles;
  if (!projection) return [];
  const groups = connectionGroups(
    projection.suggestions,
    projection.members,
    data.connectionExecutions,
  );
  // Use the existing topological chronology helper so uncertain comparisons
  // cannot hide known same-day ordering behind the stable input order.
  const openings = groups.flatMap((g) =>
    g.members.filter((m) => m.allocation.role === "open"),
  );
  const ordered = connectionTimeline(openings, data.connectionExecutions).rows;
  const ranks = new Map(
    ordered.map((m, i) => [JSON.stringify(m.allocation), i]),
  );
  const rank = (g: ConnectionGroup) =>
    Math.min(
      ...g.members
        .filter((m) => m.allocation.role === "open")
        .map((m) => ranks.get(JSON.stringify(m.allocation)) ?? Infinity),
    );
  groups.sort((a, b) => rank(a) - rank(b));
  const executions = new Map(data.connectionExecutions.map((e) => [e.key, e]));
  const sections = new Map<string, ConnectionSection>();
  for (const group of groups) {
    const account =
      executions.get(group.suggestions[0]?.callOpening.executionKey ?? "")
        ?.account ?? "";
    const key = JSON.stringify([group.underlying, account, group.currency]);
    const section = sections.get(key) ?? {
      key,
      underlying: group.underlying,
      account,
      currency: group.currency,
      groups: [],
    };
    section.groups.push(group);
    sections.set(key, section);
  }
  return [...sections.values()];
}

export function commonConnectionTargets(groups: ConnectionGroup[]): string[] {
  return (
    groups[0]?.candidateIds.filter((id) =>
      groups.every((g) => g.candidateIds.includes(id)),
    ) ?? []
  );
}

export class ConnectionSelectionError extends Error {}

export interface BatchItem {
  group: ConnectionGroup;
  status: "pending" | "saved" | "complete";
  request?: SaveRequest;
  receipt?: Receipt;
}

export interface ConnectionBatch {
  data: ConnectionData;
  target: string;
  separate: boolean;
  items: BatchItem[];
}

export function createConnectionBatch(
  data: ConnectionData,
  keys: string[],
  target: string,
  separate: boolean,
): ConnectionBatch {
  const sections = connectionSections(data);
  const selected = new Set(keys);
  const section = sections.find((s) =>
    s.groups.some((g) => selected.has(g.key)),
  );
  const groups = section?.groups.filter((g) => selected.has(g.key)) ?? [];
  if (
    !groups.length ||
    groups.length !== selected.size ||
    groups.some((g) => !g.canReviewWhole)
  )
    throw new Error(
      "Select reviewable connections for one underlying, account and currency.",
    );
  if (!separate && !commonConnectionTargets(groups).includes(target))
    throw new Error(
      "Choose one eligible share lifecycle for every selected connection.",
    );
  assertFresh(data);
  return {
    data,
    target,
    separate,
    items: groups.map((group) => ({ group, status: "pending" })),
  };
}

export interface BatchIO {
  load(signal?: AbortSignal): Promise<ConnectionData>;
  preview(
    proposal: Proposal,
    data: ConnectionData,
    signal?: AbortSignal,
  ): Promise<ProposalPreview>;
  save(payload: SaveRequest, signal?: AbortSignal): Promise<Receipt>;
  rebuild(signal?: AbortSignal): Promise<void>;
}

const CONNECTION_REQUEST_TIMEOUT_MS = 30_000;

const connectionRequestOptions = (signal?: AbortSignal): RequestOptions => ({
  ...(signal ? { signal } : {}),
  timeoutMs: CONNECTION_REQUEST_TIMEOUT_MS,
});

const batchIO: BatchIO = {
  load: (signal) =>
    request(
      "/api/lifecycles",
      LifecycleListSchema,
      connectionRequestOptions(signal),
    ),
  preview: (proposal, data, signal) =>
    requestJson(
      "/api/lifecycles/connection-preview",
      ProposalPreviewSchema,
      "POST",
      {
        proposal,
        expectedBuildId: data.buildId,
        expectedWatermark: data.watermark,
      },
      connectionRequestOptions(signal),
    ),
  save: async (payload, signal) =>
    (
      await requestJson(
        "/api/decisions",
        DecisionResponseSchema,
        "POST",
        {
          ...payload,
          sources: [],
          strategyIds: [],
          supersedesId: null,
        },
        connectionRequestOptions(signal),
      )
    ).decision,
  rebuild: (signal) => rebuildLifecycles(signal),
};

function assertFresh(data: ConnectionData) {
  if (data.stale || data.rebuildRequired || !data.buildId || !data.lifecycles)
    throw new Error(
      "Your journal changed. Close this review and rebuild the journal before continuing.",
    );
}

/** Whole-contract groups whose opening fills interleave must share a decision. */
function connectionBatchStep(
  batch: ConnectionBatch,
  first: BatchItem,
): BatchItem[] {
  if (first.request)
    return batch.items.filter(
      (i) => i.request?.clientRequestId === first.request?.clientRequestId,
    );
  if (batch.separate) return [first];
  const executions = new Map(
    batch.data.connectionExecutions.map((e) => [e.key, e]),
  );
  const openings = (item: BatchItem) =>
    item.group.suggestions.flatMap((s) => {
      const execution = executions.get(s.callOpening.executionKey);
      return execution ? [execution] : [];
    });
  const included = new Set([first]);
  let changed = true;
  while (changed) {
    changed = false;
    const current = [...included].flatMap(openings);
    for (const candidate of batch.items) {
      if (candidate.status === "complete" || included.has(candidate)) continue;
      if (
        openings(candidate).some((earlier) =>
          current.some((later) => compareExecutionTime(earlier, later) === -1),
        )
      ) {
        included.add(candidate);
        changed = true;
      }
    }
  }
  return batch.items.filter((item) => included.has(item));
}

function batchProposal(
  groups: ConnectionGroup[],
  target: string,
  separate: boolean,
): Proposal {
  const proposals = groups.map((group) =>
    connectionProposal(group, target, separate),
  );
  const first = proposals[0];
  if (!first) throw new Error("Select at least one connection.");
  return {
    ...first,
    payload: {
      ...first.payload,
      assignments: proposals.flatMap((p) => p.payload.assignments),
    },
  };
}

/** Mutable attempt state retains acknowledged receipts and exact uncertain requests. */
export async function runConnectionBatch(
  batch: ConnectionBatch,
  io: BatchIO = batchIO,
  onProgress: (message: string) => void = () => {},
  signal?: AbortSignal,
): Promise<void> {
  for (const [index, item] of batch.items.entries()) {
    signal?.throwIfAborted();
    if (item.status === "complete") continue;
    const step = connectionBatchStep(batch, item);
    const label = `${step.length > 1 ? `${index + 1}–${index + step.length}` : index + 1} of ${batch.items.length}`;
    if (!item.request) {
      onProgress(`Checking connection ${label}…`);
      const fresh = await io.load(signal);
      assertFresh(fresh);
      if (
        fresh.buildId !== batch.data.buildId ||
        fresh.watermark !== batch.data.watermark ||
        fresh.ledgerId !== batch.data.ledgerId
      )
        throw new Error(
          "Your journal changed. Close this review and review the latest connections.",
        );
      const currentGroups = new Map(
        connectionSections(fresh)
          .flatMap((s) => s.groups)
          .map((g) => [g.key, g]),
      );
      const groups = step.map((i) => {
        const group = currentGroups.get(i.group.key);
        if (
          !group?.canReviewWhole ||
          (!batch.separate && !group.candidateIds.includes(batch.target))
        )
          throw new Error(
            "This connection changed or the share lifecycle is no longer eligible. Close this review and select the latest connections.",
          );
        return group;
      });
      const proposal = batchProposal(groups, batch.target, batch.separate);
      const original = batchProposal(
        step.map((i) => i.group),
        batch.target,
        batch.separate,
      );
      if (
        canonicalProposalPayload(proposal.payload) !==
        canonicalProposalPayload(original.payload)
      )
        throw new Error(
          "The selected trades changed. Close this review and review the latest connections.",
        );
      // Check combined coverage before any fresh save: individual suggestions
      // can compete for the same shares even when each is eligible on its own.
      // Repeat this for all non-complete items on every fresh-preview attempt
      // so a retry cannot save one remaining item before a later one fails.
      const remaining = batch.items.filter((i) => i.status !== "complete");
      const firstFresh = remaining.find((i) => !i.request);
      if (
        !batch.separate &&
        remaining.length > 1 &&
        item === firstFresh
      ) {
        onProgress("Checking available shares for all selected connections…");
        const selection = await io.preview(
          batchProposal(
            remaining.map((i) => i.group),
            batch.target,
            false,
          ),
          fresh,
          signal,
        );
        if (
          selection.buildId !== fresh.buildId ||
          selection.watermark !== fresh.watermark
        )
          throw new Error(
            "Your journal changed. Close this review and review the latest connections.",
          );
        if (!selection.valid)
          throw new ConnectionSelectionError(
            selection.blockingConnection
              ? `Resolve the earlier connection dated ${selection.blockingConnection.date} first. No decisions were saved. Close this review and include it in your selection.`
              : "The selected calls cannot all be connected with the available shares. No decisions were saved. Close this review and select fewer connections, or review them individually.",
          );
      }
      const preview = await io.preview(proposal, fresh, signal);
      if (!preview.valid)
        throw new Error(
          preview.blockingConnection
            ? `Resolve the earlier connection dated ${preview.blockingConnection.date} first. Close this review and include it in your selection.`
            : "These trades cannot be resolved as selected. Check the available shares and quantities, or use individual review.",
        );
      if (
        preview.buildId !== fresh.buildId ||
        preview.watermark !== fresh.watermark
      )
        throw new Error(
          "Your journal changed. Close this review and review the latest connections.",
        );
      signal?.throwIfAborted();
      item.request = {
        clientRequestId: crypto.randomUUID(),
        expectedWatermark: preview.watermark,
        author: "user",
        kind: proposal.kind,
        payload: proposal.payload,
      };
      for (const member of step) member.request = item.request;
    }
    if (!item.receipt) {
      signal?.throwIfAborted();
      onProgress(`Saving connection ${label}…`);
      item.receipt = await io.save(item.request, signal);
      for (const member of step) {
        member.receipt = item.receipt;
        member.status = "saved";
      }
    }
    // A saved decision must be rebuilt even if the user navigates away.
    onProgress(`Updating journal for connection ${label}…`);
    await io.rebuild(signal);
    const fresh = await io.load(signal);
    assertFresh(fresh);
    if (
      fresh.ledgerId !== batch.data.ledgerId ||
      fresh.watermark !== item.receipt.sequence
    )
      throw new Error(
        "Your decision was saved, but the journal changed during the update. Close this review and review the remaining connections.",
      );
    batch.data = fresh;
    for (const member of step) member.status = "complete";
    onProgress(`Resolved ${label} connections.`);
  }
}
