import { Decimal } from "decimal.js";
import { lazy, type ReactNode, Suspense, useState } from "react";
import type { AnalysisRunDto, SubmittedProposalDto } from "../../shared/api.js";
import { AcceptAnalysisResponseSchema } from "../../shared/api.js";
import {
  LifecycleAttachmentPayloadSchema,
  LifecycleMembershipPayloadSchema,
} from "../../shared/lifecycles.js";
import { requestJson, useJson } from "../api.js";
import { ErrorPanel, Loading } from "../components.js";
import { LifecycleListSchema } from "../lifecycles/api.js";
import { BuildAction } from "../lifecycles/BuildAction.js";
import type { ConnectionDraft } from "../lifecycles/ConnectionDialog.js";

const ConnectionDialog = lazy(() =>
  import("../lifecycles/ConnectionDialog.js").then((module) => ({
    default: module.ConnectionDialog,
  })),
);

import { connectionGroups, lifecycleLabel } from "../lifecycles/connections.js";

/** Only use the guided view when its displayed source quantities exactly match the Agent proposal. */
function GuidedAgentConnectionProposal({
  run,
  entry,
  onChanged,
  onRecoveryNeeded,
  children,
}: {
  run: AnalysisRunDto;
  entry: SubmittedProposalDto;
  onChanged: () => void;
  onRecoveryNeeded?: () => void;
  children: ReactNode;
}) {
  const remote = useJson("/api/lifecycles", LifecycleListSchema);
  const [open, setOpen] = useState(false);
  const data = remote.data;
  const projection = data?.lifecycles;
  if (remote.status === "loading")
    return <Loading label="Loading connection details…" />;
  if (remote.status === "error")
    return (
      <ErrorPanel
        message="Connection details could not be loaded. Retry before accepting this proposal."
        onRetry={remote.reload}
      />
    );
  if (!data?.buildId || !projection || data.stale || data.rebuildRequired)
    return (
      <div>
        <p>Update the journal before reviewing this connection proposal.</p>
        <BuildAction onBuilt={remote.reload} />
      </div>
    );
  if (entry.accepted) return children;
  const proposal = entry.proposal;
  const attachment =
    proposal.kind === "lifecycle_attachment"
      ? LifecycleAttachmentPayloadSchema.safeParse(proposal.payload)
      : null;
  const membership =
    proposal.kind === "lifecycle_membership"
      ? LifecycleMembershipPayloadSchema.safeParse(proposal.payload)
      : null;
  const refs = attachment?.success
    ? [attachment.data.opening]
    : membership?.success && membership.data.requireCallCoverage
      ? membership.data.assignments.map((a) => a.allocation)
      : [];
  const group = connectionGroups(
    projection.suggestions,
    projection.members,
    data.connectionExecutions,
  ).find(
    (g) =>
      refs.length > 0 &&
      refs.every((ref) =>
        g.members.some(
          (m) =>
            m.allocation.strategyId === ref.strategyId &&
            m.allocation.executionKey === ref.executionKey &&
            m.allocation.role === ref.role,
        ),
      ),
  );
  if (!group) return children;
  if (membership?.success) {
    const quantity = (
      rows: {
        allocation: { strategyId: string; executionKey: string; role: string };
        quantity: string;
      }[],
    ) => {
      const totals = new Map<string, Decimal>();
      for (const row of rows) {
        const key = JSON.stringify([
          row.allocation.strategyId,
          row.allocation.executionKey,
          row.allocation.role,
        ]);
        totals.set(key, (totals.get(key) ?? new Decimal(0)).plus(row.quantity));
      }
      return totals;
    };
    const expected = quantity(group.members),
      actual = quantity(membership.data.assignments);
    if (
      expected.size !== actual.size ||
      [...expected].some(([key, value]) => !value.eq(actual.get(key) ?? "NaN"))
    )
      return children;
  } else if (
    new Set(
      group.members
        .filter((m) => m.allocation.role === "open")
        .map((m) => m.allocation.executionKey),
    ).size !== 1
  )
    return children;
  const targetIds = attachment?.success
    ? attachment.data.targets.map((t) => t.lifecycleId)
    : membership?.success
      ? membership.data.assignments.map((a) => a.lifecycleId)
      : [];
  if (new Set(targetIds).size !== 1) return children;
  const context = {
    group: { ...group, candidateIds: [...new Set(targetIds)] },
    lifecycles: projection.lifecycles,
    members: projection.members,
    executions: data.connectionExecutions,
    buildId: data.buildId,
    watermark: data.watermark,
  };
  return (
    <div className="connection-card">
      <span className="connection-eyebrow">AGENT PROPOSED CONNECTION</span>
      <h3>Review {group.underlying} covered-call connection</h3>
      <p>
        {group.contracts} short calls · {group.shares ?? "Unknown"} shares
        required
      </p>
      {proposal.rationale && <p>{proposal.rationale}</p>}
      <ul>
        {context.group.candidateIds.map((id) => (
          <li key={id}>
            {lifecycleLabel(projection.lifecycles.find((l) => l.id === id))}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="primary"
        disabled={data.stale || data.rebuildRequired}
        onClick={() => setOpen(true)}
      >
        Review connection
      </button>
      {open && (
        <Suspense fallback={<p role="status">Loading connection review…</p>}>
          <ConnectionDialog
            context={context}
            draft={proposal as ConnectionDraft}
            accept={async (watermark, clientRequestId) => {
              const response = await requestJson(
                `/api/analysis/${encodeURIComponent(run.id)}/accept`,
                AcceptAnalysisResponseSchema,
                "POST",
                {
                  proposalId: entry.id,
                  expectedWatermark: watermark,
                  clientRequestId,
                },
              );
              const decision = response.decisions[0];
              if (!decision)
                throw new Error(
                  "No connection decision was returned. Refresh before retrying.",
                );
              return decision;
            }}
            onDismiss={(_destination, changed, needsUpdate) => {
              setOpen(false);
              if (needsUpdate) onRecoveryNeeded?.();
              if (changed) onChanged();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

export function AgentConnectionProposal(props: {
  run: AnalysisRunDto;
  entry: SubmittedProposalDto;
  onChanged: () => void;
  onRecoveryNeeded?: () => void;
  children: ReactNode;
}) {
  const proposal = props.entry.proposal;
  if (
    props.entry.accepted ||
    (proposal.kind !== "lifecycle_attachment" &&
      !(
        proposal.kind === "lifecycle_membership" &&
        proposal.payload.requireCallCoverage === true
      ))
  )
    return props.children;
  return <GuidedAgentConnectionProposal {...props} />;
}
