import { Decimal } from "decimal.js";
import { z } from "zod";
import type { Execution, Issue } from "../../../shared/domain.js";
import { AppError } from "../../../shared/errors.js";
import {
  ALGORITHM_VERSION,
  activeLedgerSnapshot,
  activeProjection,
} from "../../builds/service.js";
import { compareExecutionTime } from "../../ledger/chronology.js";
import { LEDGER_PARSER_VERSION } from "../../ledger/normalize.js";
import { sameInstrument } from "../../strategies/matching.js";
import { makeIssue } from "../../strategies/projection.js";
import {
  type ChatTool,
  type ChatToolContext,
  jsonResult,
  MAX_LIST_ROWS,
  PagingSchemaFields,
  pagedResult,
  refuseInvalidInput,
  UNTRUSTED,
} from "./shared.js";

const Reference = z
  .object({ issueKey: z.string().min(1), expectedBuildId: z.string().min(1) })
  .strict();
const Diagnosis = Reference.extend({
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_LIST_ROWS).optional(),
}).strict();
const ReferenceFields = {
  issueKey: { type: "string" },
  expectedBuildId: { type: "string" },
} as const;
const GUIDANCE =
  "Use source evidence and allocations to explain the finding. Opening presence alone does not prove available exposure. Use submit_proposal for supported corrections; the user must accept before any decision is written. Never invent lifecycle codes, source data, or unsupported decisions. Use create_issue_report for a suspected application defect. Do not propose changes against a stale build.";

function inspect(
  ctx: ChatToolContext,
  issueKey: string,
  expectedBuildId: string,
) {
  const active = activeProjection(ctx.store);
  const ledger = activeLedgerSnapshot(ctx.store);
  if (active.buildId === null || active.projection === null || ledger === null)
    throw new AppError(
      "NO_ACTIVE_BUILD",
      "Rebuild before diagnosing review issues.",
      409,
    );
  if (active.buildId !== expectedBuildId)
    throw new AppError(
      "STALE_BUILD",
      "The active build changed; list review issues again.",
      409,
    );
  const issue = active.projection.issues.find((item) => item.key === issueKey);
  if (!issue)
    throw new AppError(
      "ISSUE_NOT_FOUND",
      "This issue is not in the active build.",
      404,
    );
  const sourceSet = new Set(
    issue.sources.map((source) => `${source.importId}:${source.rowNumber}`),
  );
  const selected = new Set(
    ledger.executions
      .filter((execution) =>
        execution.sources.some((source) =>
          sourceSet.has(`${source.importId}:${source.rowNumber}`),
        ),
      )
      .map((execution) => execution.key),
  );
  // Strategy P&L findings have no source refs. Resolve their exact scope rather
  // than falling back to the entire ledger. Lifecycle P&L has its own scope.
  for (const strategy of active.projection.strategies) {
    if (
      issue.key !==
      makeIssue(issue.code, issue.sources, issue.severity, strategy.id).key
    )
      continue;
    for (const allocation of active.projection.allocations)
      if (allocation.strategyId === strategy.id)
        selected.add(allocation.executionKey);
  }
  const lifecycle = active.projection.lifecycles;
  for (const entry of lifecycle?.lifecycles ?? []) {
    if (issue.key !== `lifecycle:pnl:${entry.id}`) continue;
    for (const member of lifecycle?.members ?? [])
      if (member.lifecycleId === entry.id)
        selected.add(member.allocation.executionKey);
  }
  const roots = ledger.executions.filter((execution) =>
    selected.has(execution.key),
  );
  const related = ledger.executions
    .filter(
      (execution) =>
        selected.has(execution.key) ||
        roots.some(
          (root) =>
            root.account === execution.account &&
            root.currency === execution.currency &&
            sameInstrument(root.instrument, execution.instrument),
        ),
    )
    .sort((a, b) => a.key.localeCompare(b.key));
  const timeEvidence = roots
    .filter((root) => root.action === "close")
    .map((close) => {
      const candidates = related.filter(
        (opening) =>
          opening.action === "open" &&
          opening.account === close.account &&
          opening.currency === close.currency &&
          sameInstrument(opening.instrument, close.instrument) &&
          new Decimal(opening.quantity).isNegative() !==
            new Decimal(close.quantity).isNegative(),
      );
      const counts = { before: 0, tied: 0, after: 0, uncertain: 0 };
      for (const opening of candidates) {
        const order = compareExecutionTime(opening, close);
        if (order === null) counts.uncertain++;
        else if (order < 0) counts.before++;
        else if (order === 0) counts.tied++;
        else counts.after++;
      }
      return {
        executionKey: close.key,
        openingCandidates: candidates.length,
        ...counts,
        basisPresent: close.basis !== null,
      };
    });
  return { active, issue, related, selected, timeEvidence };
}

function evidenceView(
  execution: Execution,
  selected: ReadonlySet<string>,
  allocations: NonNullable<
    ReturnType<typeof activeProjection>["projection"]
  >["allocations"],
) {
  return {
    executionKey: execution.key,
    directlyReferenced: selected.has(execution.key),
    symbol: execution.instrument.symbol,
    assetClass: execution.instrument.assetClass,
    multiplier: execution.instrument.multiplier,
    rawDateTime: execution.rawDateTime,
    timezone: execution.timezone,
    action: execution.action,
    event: execution.event,
    quantity: execution.quantity,
    currency: execution.currency,
    basis: execution.basis,
    netCash: execution.netCash,
    brokerPnl: execution.brokerPnl,
    sources: execution.sources,
    allocations: allocations.filter(
      (allocation) => allocation.executionKey === execution.key,
    ),
  };
}

// These are fixed templates. No model-authored text, broker strings, hashes,
// source refs, quantities, dates or financial values enter the shareable report.
const REPORTS: Record<
  string,
  { observed: string; expected: string; reproduction: string }
> = {
  MISSING_OPENING: {
    observed:
      "The matcher could not establish sufficient opening exposure for a close. A review label alone does not prove the opening is absent.",
    expected:
      "Check explicit opening roles, timestamp comparability, remaining capacity and identity before concluding an opening is missing. CSV line order alone must not establish chronology.",
    reproduction:
      "Use synthetic share rows: an explicit opening and equal opposite close at one timestamp in the same report. Place the close first, then reverse row order. Both orders should produce the same result when exposure is uniquely supported. Also test a genuinely absent opening and already-consumed inventory.",
  },
  AMBIGUOUS_CLOSE: {
    observed: "The matcher could not choose an opening allocation for a close.",
    expected:
      "Resolve only a unique quantity-and-basis allocation across compatible remaining lots. Retain ambiguity if basis is absent, references conflict, several solutions exist or search limits are exceeded.",
    reproduction:
      "Use synthetic opening lots A (two contracts, total basis 20) and B (one contract, total basis 30), then close two contracts with absolute basis 40. The unique allocation is one contract from each lot. Test cash conservation, residual capacity, and an alternative fixture with multiple valid solutions.",
  },
  PNL_RECONCILIATION: {
    observed:
      "Broker-reported and reconstructed realized P&L differ beyond the currency tolerance.",
    expected:
      "Inspect allocation, commissions, basis transfers and completeness. Preserve both figures and estimated attribution; do not suppress a discrepancy to clear the review queue.",
    reproduction:
      "Construct synthetic opening and closing cash flows with explicit broker P&L. Cover equal totals, a discrepancy, split-close estimates and a basis-transfer event. Check both strategy and lifecycle accounting.",
  },
};
function safeReport(
  issue: Issue,
  stale: boolean,
  timeEvidence: ReturnType<typeof inspect>["timeEvidence"],
) {
  const code = Object.hasOwn(REPORTS, issue.code)
    ? issue.code
    : "OTHER_REVIEW_ISSUE";
  const template = REPORTS[code];
  const pattern = timeEvidence.some((item) => item.tied > 0)
    ? "Tied opening evidence exists; inspect remaining exposure and matching policy."
    : timeEvidence.some((item) => item.openingCandidates > 1)
      ? "Multiple opening candidates exist; inspect quantity, basis and allocations."
      : "Inspect the selected finding and its source evidence locally.";
  return [
    "# TradeLedger review issue report",
    `Issue category: ${code}`,
    `Algorithm: ${ALGORITHM_VERSION}; parser: ${LEDGER_PARSER_VERSION}`,
    `Build stale: ${stale ? "yes; rebuild before drawing conclusions" : "no"}`,
    "",
    template?.observed ?? "An application review finding needs investigation.",
    pattern,
    "",
    "Expected behavior:",
    template?.expected ??
      "Validate the relevant source evidence and preserve unresolved cases when evidence is insufficient.",
    "",
    "Suggested synthetic regression (template, not a replay of private trades):",
    template?.reproduction ??
      "Create a fabricated input for the relevant review category and assert the expected behavior without using real trading data.",
    "",
    "This report omits source identifiers and trading details. It is an investigation aid, not confirmation of an application defect. No report has been published or sent externally.",
  ].join("\n");
}

export function reviewTools(ctx: ChatToolContext): ChatTool[] {
  return [
    {
      name: "diagnose_review_issue",
      description: `Inspect one active review finding and page its executions, matching-instrument history, timestamps, basis and current allocations. Call list_review_issues first for issueKey and expectedBuildId. Results are PRIVATE journal evidence, not suitable for publishing. ${UNTRUSTED}`,
      inputSchema: {
        type: "object",
        properties: { ...ReferenceFields, ...PagingSchemaFields },
        required: ["issueKey", "expectedBuildId"],
        additionalProperties: false,
      },
      approval: "never",
      run: (input) =>
        refuseInvalidInput(() => {
          const q = Diagnosis.parse(input ?? {});
          const { active, issue, related, selected, timeEvidence } = inspect(
            ctx,
            q.issueKey,
            q.expectedBuildId,
          );
          return pagedResult(
            {
              buildId: active.buildId,
              stale: active.stale,
              issue: {
                key: issue.key,
                code: issue.code,
                severity: issue.severity,
              },
              evidenceStatus:
                selected.size === 0
                  ? "source_evidence_unavailable"
                  : "available",
              guidance:
                selected.size === 0
                  ? "No normalized source evidence is available for this finding. For ledger-level conflicts or quarantined rows, inspect import diagnostics and original rows locally; use list_imports to identify affected imports. Do not infer a correction from an empty result."
                  : GUIDANCE,
            },
            related.map((execution) => ({
              ...evidenceView(
                execution,
                selected,
                active.projection?.allocations ?? [],
              ),
              openingEvidence:
                timeEvidence.find(
                  (item) => item.executionKey === execution.key,
                ) ?? null,
            })),
            q.offset,
            q.limit,
          );
        }),
    },
    {
      name: "create_issue_report",
      description:
        "Generate a shareable technical report for one active issue using fixed templates and coarse structural observations. Omits symbols, accounts, quantities, money, dates, filenames, source refs and build IDs. No free-text content, no publication or external sending. For private evidence use diagnose_review_issue; supported corrections use submit_proposal for user acceptance.",
      inputSchema: {
        type: "object",
        properties: ReferenceFields,
        required: ["issueKey", "expectedBuildId"],
        additionalProperties: false,
      },
      approval: "never",
      run: (input) =>
        refuseInvalidInput(() => {
          const q = Reference.parse(input ?? {});
          const { active, issue, timeEvidence } = inspect(
            ctx,
            q.issueKey,
            q.expectedBuildId,
          );
          return jsonResult({
            report: safeReport(issue, active.stale, timeEvidence),
            containsTradingData: false,
            published: false,
          });
        }),
    },
  ];
}
