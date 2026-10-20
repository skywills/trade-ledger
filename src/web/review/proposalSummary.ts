import type { SubmittedProposalDto } from "../../shared/api.js";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown) {
  return typeof value === "string" ? value : "unavailable";
}
function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}
function records(value: unknown) {
  return Array.isArray(value) ? value.map(object) : [];
}
function source(value: unknown) {
  const ref = object(value);
  return `${text(ref.importId)} row ${typeof ref.rowNumber === "number" ? ref.rowNumber : "unavailable"}`;
}

/** Plain strings only; the component renders broker/user content as React text. */
export function proposalSummary(
  proposal: SubmittedProposalDto["proposal"],
): string[] {
  const p = proposal.payload;
  let lines: string[];
  switch (proposal.kind) {
    case "notes":
      lines = [`Strategy ${text(p.strategyId)}: ${text(p.text)}`];
      break;
    case "stop_loss":
      lines = [
        `Set strategy ${text(p.strategyId)} stop-loss price to ${text(p.price)}.`,
      ];
      break;
    case "identity_binding":
      lines = [
        `Bind ${source(p.source)} to ${text(p.canonicalIdentity)} with expected quantity ${text(p.expectedQuantity)}.`,
      ];
      break;
    case "manual_allocation":
      lines = [
        `Allocate to strategy ${text(p.strategyId)}.`,
        ...records(p.allocations).map(
          (a) =>
            `${text(a.executionKey)}: quantity ${text(a.quantity)}, net cash ${text(a.netCash)}, broker P&L ${a.brokerPnl === null ? "unavailable" : text(a.brokerPnl)}.`,
        ),
      ];
      break;
    case "group_explicit":
      lines = [
        `Group ${source(p.source)} into strategy ${text(p.strategyId)}.`,
      ];
      break;
    case "group_merge":
      lines = [
        `Merge ${strings(p.mergedStrategyIds).join(", ")} into ${text(p.chosenStrategyId)}.`,
      ];
      break;
    case "lifecycle":
      lines = [
        `${text(p.event)}: ${source(p.sourceRef)} → ${source(p.targetRef)}.`,
      ];
      break;
    case "import_exclusion":
      lines = [`Exclude import ${text(p.importId)} from the next rebuild.`];
      break;
    case "import_inclusion":
      lines = [`Include import ${text(p.importId)} in the next rebuild.`];
      break;
    case "lifecycle_attachment":
      lines = [
        `Call opening ${text(object(p.opening).executionKey)}.`,
        ...records(p.targets).map(
          (t) =>
            `Attach ${text(t.quantity)} contracts to lifecycle ${text(t.lifecycleId)}.`,
        ),
      ];
      break;
    case "lifecycle_membership":
      lines = records(p.assignments).map(
        (a) =>
          `Assign ${text(a.quantity)} of ${text(object(a.allocation).executionKey)} to lifecycle ${text(a.lifecycleId)}.`,
      );
      break;
    case "lifecycle_attachment_rejection":
      lines = [
        `Keep call opening ${text(object(p.callOpening).executionKey)} independent of lifecycles ${strings(p.candidateLifecycleIds).join(", ")}.`,
        text(p.reason),
      ];
      break;
    case "wheel_campaign":
      lines = [
        `Campaign ${text(p.campaignId)}: ${text(p.name)} (${text(p.account)}, ${text(p.currency)}, ${text(p.underlyingKey)}).`,
      ];
      break;
    case "wheel_campaign_membership":
      lines = [
        p.campaignId === null
          ? `Remove lifecycle ${text(p.lifecycleId)} from its campaign.`
          : `Add lifecycle ${text(p.lifecycleId)} to campaign ${text(p.campaignId)}.`,
      ];
      break;
    default:
      lines = [
        "Review this legacy proposal's rationale and evidence before accepting.",
      ];
  }
  if (proposal.supersedesId)
    lines.push(`Supersedes decision ${proposal.supersedesId}.`);
  return lines;
}
