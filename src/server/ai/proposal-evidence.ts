import type { SourceRef } from "../../shared/domain.js";
import { activeLedgerSnapshot, activeProjection } from "../builds/service.js";
import type { Store } from "../storage/database.js";
import { buildEvidenceSnapshot, type EvidenceSnapshot } from "./evidence.js";
import type { Proposal } from "./proposals.js";

/**
 * Active execution evidence follows the correction, independently of chat seed
 * issues. References without active executions (e.g. an excluded import) remain
 * in the proposal; full preview and acceptance validate their retained data.
 */
export function buildProposalEvidenceSnapshot(
  store: Store,
  buildId: string,
  proposal: Proposal,
): EvidenceSnapshot {
  const sources: SourceRef[] = [...proposal.sources];
  const strategyIds = new Set(proposal.strategyIds);
  const executionKeys = new Set<string>();
  const lifecycleIds = new Set<string>();
  const importIds = new Set<string>();
  const campaignIds = new Set<string>();

  switch (proposal.kind) {
    case "manual_allocation":
      sources.push(proposal.payload.source);
      strategyIds.add(proposal.payload.strategyId);
      for (const row of proposal.payload.allocations)
        executionKeys.add(row.executionKey);
      break;
    case "identity_binding":
      sources.push(proposal.payload.source);
      break;
    case "group_explicit":
      sources.push(proposal.payload.source);
      strategyIds.add(proposal.payload.strategyId);
      break;
    case "lifecycle":
      sources.push(proposal.payload.sourceRef, proposal.payload.targetRef);
      break;
    case "notes":
    case "stop_loss":
      strategyIds.add(proposal.payload.strategyId);
      break;
    case "group_merge":
      strategyIds.add(proposal.payload.chosenStrategyId);
      for (const id of proposal.payload.mergedStrategyIds) strategyIds.add(id);
      break;
    case "import_exclusion":
    case "import_inclusion":
      importIds.add(proposal.payload.importId);
      break;
    case "lifecycle_attachment":
      strategyIds.add(proposal.payload.opening.strategyId);
      executionKeys.add(proposal.payload.opening.executionKey);
      for (const target of proposal.payload.targets)
        lifecycleIds.add(target.lifecycleId);
      break;
    case "lifecycle_membership":
      for (const assignment of proposal.payload.assignments) {
        strategyIds.add(assignment.allocation.strategyId);
        executionKeys.add(assignment.allocation.executionKey);
        lifecycleIds.add(assignment.lifecycleId);
      }
      break;
    case "lifecycle_attachment_rejection":
      strategyIds.add(proposal.payload.callOpening.strategyId);
      executionKeys.add(proposal.payload.callOpening.executionKey);
      for (const id of proposal.payload.candidateLifecycleIds)
        lifecycleIds.add(id);
      break;
    case "wheel_campaign":
      campaignIds.add(proposal.payload.campaignId);
      break;
    case "wheel_campaign_membership":
      lifecycleIds.add(proposal.payload.lifecycleId);
      if (proposal.payload.campaignId !== null)
        campaignIds.add(proposal.payload.campaignId);
      break;
    default: {
      const unsupported: never = proposal;
      throw new Error(`Unsupported proposal: ${unsupported}`);
    }
  }

  const projection = activeProjection(store).projection;
  for (const campaign of projection?.lifecycles?.campaigns ?? [])
    if (campaignIds.has(campaign.id))
      for (const id of campaign.lifecycleIds) lifecycleIds.add(id);
  for (const member of projection?.lifecycles?.members ?? [])
    if (lifecycleIds.has(member.lifecycleId))
      executionKeys.add(member.allocation.executionKey);
  for (const allocation of projection?.allocations ?? [])
    if (strategyIds.has(allocation.strategyId))
      executionKeys.add(allocation.executionKey);

  const sourceKeys = new Set(
    sources.map((source) => `${source.importId}#${source.rowNumber}`),
  );
  for (const execution of activeLedgerSnapshot(store)?.executions ?? [])
    if (
      execution.sources.some(
        (source) =>
          importIds.has(source.importId) ||
          sourceKeys.has(`${source.importId}#${source.rowNumber}`),
      )
    )
      executionKeys.add(execution.key);

  return buildEvidenceSnapshot(store, {
    buildId,
    executionKeys: [...executionKeys],
  });
}
