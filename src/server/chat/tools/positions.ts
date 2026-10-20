import { z } from "zod";
import { selectOpenPositions } from "../../analytics/open-positions.js";
import {
  type ChatTool,
  type ChatToolContext,
  defineReadTool,
  PagingInput,
} from "./shared.js";
import {
  pageSelectedResult,
  readToolSnapshot,
  snapshotMeta,
} from "./snapshot.js";

const Query = z.strictObject({
  account: z.string().min(1).optional(),
  currency: z.string().min(1).optional(),
  underlying: z.string().min(1).optional(),
  assetClass: z.string().min(1).optional(),
  instrumentKey: z.string().min(1).optional(),
  expectedBuildId: z.string().min(1).optional(),
  section: z
    .enum(["positions", "contributors", "unresolved"])
    .default("positions"),
  ...PagingInput,
});
export function positionTools(ctx: ChatToolContext): ChatTool[] {
  return [
    defineReadTool(
      "get_open_positions_summary",
      "Current-build remaining quantities by exact account, currency and contract. Net and gross long/short amounts are quantities, not live values. Select contributors or unresolved for paged evidence; unscopedUnresolvedCount reports attribution gaps that cannot satisfy the requested filters. No date/expiry-based liquidation, live quotes, Greeks or valuation.",
      Query,
      ({ expectedBuildId, section, offset, limit, ...filters }) => {
        const snapshot = readToolSnapshot(ctx, expectedBuildId);
        const selection = selectOpenPositions(snapshot, filters);
        const rows =
          section === "positions"
            ? selection.items
            : section === "contributors"
              ? selection.contributions
              : selection.unresolved;
        return pageSelectedResult(
          {
            ...snapshotMeta(snapshot),
            scope: "current_build",
            filters,
            section,
            totalPositionGroups: selection.items.length,
            unresolvedCount: selection.unresolved.length,
            unscopedUnresolvedCount: selection.unscopedUnresolvedCount,
          },
          rows.slice(offset, offset + limit),
          rows.length,
          offset,
          limit,
        );
      },
    ),
  ];
}
