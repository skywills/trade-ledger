import { z } from "zod";
import { AnalyticsQuerySchema } from "../../../shared/analytics.js";
import { PROPOSAL_KINDS } from "../../ai/proposals.js";
import {
  MAX_PROPOSALS_PER_RUN,
  PROFILE_NONE_BUILTIN_TOOLS,
} from "../../ai/tools.js";
import { decisionWatermark } from "../../decisions/service.js";
import { MAX_CALLS_PER_TOOL, MAX_IDENTICAL_CALLS } from "./repeatGuard.js";
import {
  type ChatTool,
  type ChatToolContext,
  defineReadTool,
  jsonResult,
  MAX_LIST_ROWS,
} from "./shared.js";
import { readToolSnapshot, snapshotMeta } from "./snapshot.js";

export function capabilitiesTool(
  ctx: ChatToolContext,
  tools: readonly ChatTool[],
): ChatTool {
  const tool: ChatTool = defineReadTool(
    "get_capabilities",
    "Discover available application tools, approval modes, proposal kinds, limits and unavailable data. This does not enable additional permissions.",
    z.object({}).strict(),
    () =>
      ctx.store.db.transaction(() => {
        const snapshot = readToolSnapshot(ctx);
        return jsonResult({
          ...snapshotMeta(snapshot),
          watermark: decisionWatermark(ctx.store),
          tools: [...tools, tool]
            .map(({ name, approval }) => ({ name, approval }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          runtimeTools: PROFILE_NONE_BUILTIN_TOOLS,
          proposalKinds: PROPOSAL_KINDS,
          decisionAcceptanceRequired: true,
          limits: {
            maxListRows: MAX_LIST_ROWS,
            maxProposalsPerTurn: MAX_PROPOSALS_PER_RUN,
            maxReadCallsPerTool: MAX_CALLS_PER_TOOL,
            maxIdenticalReadCalls: MAX_IDENTICAL_CALLS,
          },
          pollingExceptions: ["get_job", "get_build_status"],
          analytics: {
            units: AnalyticsQuerySchema.shape.unit.removeDefault().options,
            bases: AnalyticsQuerySchema.shape.basis.removeDefault().options,
            defaultUnit: AnalyticsQuerySchema.parse({}).unit,
            defaultBasis: AnalyticsQuerySchema.parse({}).basis,
          },
          unsupported: [
            "live_quotes",
            "greeks",
            "fx_conversion",
            "account_equity_reconstruction",
            "multiplier_corrections",
          ],
        });
      })(),
  );
  return tool;
}
