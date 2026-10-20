import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Projection } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import type {
  PreviewTotals,
  ProposalPreview,
} from "../../shared/proposal-preview.js";
import { sum } from "../analytics/performance.js";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../builds/service.js";
import { appendDecision } from "../decisions/service.js";
import { LEDGER_PARSER_VERSION } from "../ledger/normalize.js";
import { closeStore, openStore, type Store } from "../storage/database.js";
import { assertProposalState, type ProposalState } from "./proposal-state.js";
import {
  type Proposal,
  parseProposal,
  proposalDecisionInput,
  validateProposal,
  validateProposalReferences,
} from "./proposals.js";

function totals(projection: Projection): PreviewTotals {
  const counts = new Map<string, number>();
  for (const issue of projection.issues)
    counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  const currencies = [
    ...new Set(projection.strategies.map((s) => s.currency)),
  ].sort();
  return {
    strategyCount: projection.strategies.length,
    lifecycleCount: projection.lifecycles?.lifecycles.length ?? null,
    unresolvedStrategies: projection.strategies.filter(
      (s) => s.status === "unresolved",
    ).length,
    issueCounts: [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => ({ code, count })),
    pnlByCurrency: currencies.map((currency) => {
      const rows = projection.strategies.filter((s) => s.currency === currency);
      return {
        currency,
        brokerPnl: sum(rows.map((s) => s.brokerPnl)),
        reconstructedPnl: sum(rows.map((s) => s.reconstructedPnl)),
        missingBrokerPnl: rows.filter((s) => s.brokerPnl === null).length,
        missingReconstructedPnl: rows.filter((s) => s.reconstructedPnl === null)
          .length,
      };
    }),
  };
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new AppError(
      "PROPOSAL_PREVIEW_CANCELLED",
      "Proposal preview was cancelled or timed out.",
      408,
    );
}

export async function previewProposal(
  store: Store,
  proposal: Proposal,
  expected: ProposalState,
  options: { signal?: AbortSignal; now?: () => Date } = {},
): Promise<ProposalPreview> {
  checkAbort(options.signal);
  const parsed = parseProposal(proposal);
  const captured = assertProposalState(store, expected);
  const base = {
    buildId: captured.buildId,
    ledgerId: captured.ledgerId,
    watermark: captured.watermark,
    stale: false as const,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  const directory = await mkdtemp(
    join(tmpdir(), "trade-ledger-proposal-preview-"),
  );
  let clone: Store | undefined;
  try {
    checkAbort(options.signal);
    await store.db.backup(join(directory, "journal.sqlite"));
    checkAbort(options.signal);
    assertProposalState(store, expected);
    clone = openStore(directory);
    const before = assertProposalState(clone, expected);
    let result: ProposalPreview;
    try {
      const issues = [
        ...validateProposal(before.ledger, parsed),
        ...validateProposalReferences(clone, parsed),
      ].map(({ code, severity }) => ({ code, severity }));
      if (issues.some((i) => i.severity === "error"))
        result = { ...base, valid: false, issues, impact: null };
      else {
        checkAbort(options.signal);
        await appendDecision(
          clone,
          proposalDecisionInput(parsed),
          expected.watermark,
        );
        checkAbort(options.signal);
        const build = await rebuild(
          clone,
          {
            mode: "full",
            parserVersion: LEDGER_PARSER_VERSION,
            algorithmVersion: ALGORITHM_VERSION,
            signal: options.signal ?? new AbortController().signal,
          },
          options.now ? { now: options.now } : {},
        );
        checkAbort(options.signal);
        const after = activeProjection(clone).projection;
        if (build.status !== "active" || !after)
          result = {
            ...base,
            valid: false,
            issues: [
              ...issues,
              ...build.issues.map(({ code, severity }) => ({ code, severity })),
              { code: "PROPOSAL_REBUILD_FAILED", severity: "error" },
            ],
            impact: null,
          };
        else
          result = {
            ...base,
            valid: true,
            issues,
            impact: { before: totals(before.projection), after: totals(after) },
          };
      }
    } catch (error) {
      if (
        error instanceof AppError &&
        error.statusCode < 500 &&
        error.code !== "PROPOSAL_PREVIEW_CANCELLED"
      )
        result = {
          ...base,
          valid: false,
          issues: [{ code: error.code, severity: "error" }],
          impact: null,
        };
      else throw error;
    }
    checkAbort(options.signal);
    assertProposalState(store, expected);
    return result;
  } finally {
    try {
      if (clone) await closeStore(clone);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
