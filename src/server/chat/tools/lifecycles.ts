import { z } from "zod";
import type { Lifecycle, WheelCampaign } from "../../../shared/lifecycles.js";
import { normalizeUnderlyingKey } from "../../../shared/symbols.js";
import { decisionWatermark } from "../../decisions/service.js";
import {
  lifecycleProjection,
  selectCampaignDetail,
  selectLifecycleDetail,
} from "../../lifecycles/queries.js";
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

const Reference = {
  expectedBuildId: z.string().min(1).optional(),
  ...PagingInput,
};
const Filters = {
  account: z.string().min(1).optional(),
  currency: z.string().min(1).optional(),
  underlying: z.string().min(1).optional(),
};
const List = z.object({ ...Reference, ...Filters }).strict();
const ListCycles = List.extend({
  status: z
    .enum(["open", "partially_closed", "closed", "unresolved"])
    .optional(),
});
const Cycle = z
  .object({
    ...Reference,
    lifecycleId: z.string().min(1),
    section: z
      .enum(["members", "executions", "suggestions"])
      .default("members"),
  })
  .strict();
const Campaign = z
  .object({ ...Reference, campaignId: z.string().min(1) })
  .strict();

function cycleSummary(cycle: Lifecycle) {
  const { positions, reasons, componentIds, ...summary } = cycle;
  return {
    ...summary,
    positionCount: positions.length,
    reasonCount: reasons.length,
    componentCount: componentIds.length,
  };
}
function campaignView(campaign: WheelCampaign) {
  const { lifecycleIds, ...summary } = campaign;
  return { ...summary, lifecycleCount: lifecycleIds.length };
}
function matches(
  row: { account: string; currency: string; underlyingKey: string },
  q: z.infer<typeof List>,
) {
  return (
    (!q.account || row.account === q.account) &&
    (!q.currency || row.currency === q.currency) &&
    (!q.underlying ||
      row.underlyingKey ===
        normalizeUnderlyingKey(
          q.underlying.startsWith("value:") || q.underlying.startsWith("__")
            ? q.underlying
            : `value:${q.underlying}`,
        ))
  );
}

export function lifecycleTools(ctx: ChatToolContext): ChatTool[] {
  function capture(expectedBuildId?: string) {
    return ctx.store.db.transaction(() => {
      const snapshot = readToolSnapshot(ctx, expectedBuildId);
      return {
        snapshot,
        meta: {
          ...snapshotMeta(snapshot),
          watermark: decisionWatermark(ctx.store),
        },
      };
    })();
  }
  return [
    defineReadTool(
      "list_lifecycles",
      "Page lifecycle summaries by account, currency, underlying and status. Use returned IDs and buildId with get_lifecycle for evidence.",
      ListCycles,
      (q) => {
        const { snapshot, meta } = capture(q.expectedBuildId);
        const rows = (lifecycleProjection(snapshot)?.lifecycles ?? [])
          .filter((l) => matches(l, q) && (!q.status || l.status === q.status))
          .sort(
            (a, b) =>
              (b.openingDate ?? "").localeCompare(a.openingDate ?? "") ||
              a.id.localeCompare(b.id),
          )
          .map(cycleSummary);
        return pageSelectedResult(
          meta,
          rows.slice(q.offset, q.offset + q.limit),
          rows.length,
          q.offset,
          q.limit,
        );
      },
    ),
    defineReadTool(
      "get_lifecycle",
      "Read a lifecycle summary, valuation and one page of members, executions or suggestions. Pass expectedBuildId from list_lifecycles. Counts describe omitted summary collections; use the selected section for evidence.",
      Cycle,
      (q) => {
        const { snapshot, meta } = capture(q.expectedBuildId);
        const detail = selectLifecycleDetail(snapshot, q.lifecycleId);
        const rows = detail[q.section];
        return pageSelectedResult(
          {
            ...meta,
            lifecycle: cycleSummary(detail.lifecycle),
            valuation: detail.valuation,
            campaignIds: detail.lifecycle.campaignId
              ? [detail.lifecycle.campaignId]
              : [],
            section: q.section,
          },
          rows.slice(q.offset, q.offset + q.limit),
          rows.length,
          q.offset,
          q.limit,
        );
      },
    ),
    defineReadTool(
      "list_campaigns",
      "Page explicitly retained wheel campaigns by account, currency and underlying. Campaigns group lifecycle observations; they are not additional trades.",
      List,
      (q) => {
        const { snapshot, meta } = capture(q.expectedBuildId);
        const rows = (lifecycleProjection(snapshot)?.campaigns ?? [])
          .filter((c) => matches(c, q))
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(campaignView);
        return pageSelectedResult(
          meta,
          rows.slice(q.offset, q.offset + q.limit),
          rows.length,
          q.offset,
          q.limit,
        );
      },
    ),
    defineReadTool(
      "get_campaign",
      "Read campaign totals with coverage and a page of its lifecycle summaries. Known open valuations are separate from completed P&L; unavailable totals remain null.",
      Campaign,
      (q) => {
        const { snapshot, meta } = capture(q.expectedBuildId);
        const detail = selectCampaignDetail(snapshot, q.campaignId);
        const rows = detail.cycles.map(cycleSummary);
        return pageSelectedResult(
          {
            ...meta,
            campaign: campaignView(detail.campaign),
            summary: detail.summary,
          },
          rows.slice(q.offset, q.offset + q.limit),
          rows.length,
          q.offset,
          q.limit,
        );
      },
    ),
  ];
}
