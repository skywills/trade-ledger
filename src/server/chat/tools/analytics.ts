import { z } from "zod";
import {
  AnalyticsQuerySchema,
  DetailQuerySchema,
} from "../../../shared/analytics.js";
import { aggregateAnalytics } from "../../analytics/aggregate.js";
import { selectAnalyticsDetails } from "../../analytics/details.js";
import {
  parseAnalyticsQuery,
  parseDetailQuery,
} from "../../analytics/query.js";
import {
  type ChatTool,
  type ChatToolContext,
  defineReadTool,
  jsonResult,
  MAX_LIST_ROWS,
  PagingInput,
} from "./shared.js";
import { pageSelectedResult, readToolSnapshot } from "./snapshot.js";

const Expected = { expectedBuildId: z.string().min(1).optional() };
const Summary = z
  .object({ ...AnalyticsQuerySchema.shape, ...Expected })
  .strict();
const Details = z
  .object(DetailQuerySchema.shape)
  .omit({ page: true, pageSize: true })
  .extend(PagingInput)
  .strict();
const Breakdown = Summary.extend({
  ...PagingInput,
  section: z.enum([
    "daily",
    "monthly",
    "byStrategyType",
    "byUnderlying",
    "recent",
    "best",
    "worst",
  ]),
});

export function analyticsTools(ctx: ChatToolContext): ChatTool[] {
  return [
    defineReadTool(
      "get_analytics_summary",
      "Dashboard performance, transaction and quality summaries. Defaults to lifecycle unit and broker basis; filters report the selected currency, never combined currencies. Drawdown measures cumulative closed P&L, not account equity. Use breakdown/details tools for rows.",
      Summary,
      ({ expectedBuildId, ...raw }) => {
        const result = aggregateAnalytics(
          readToolSnapshot(ctx, expectedBuildId),
          parseAnalyticsQuery(raw),
        );
        const {
          buildId,
          ledgerId,
          stale,
          generatedAt,
          filters,
          unit,
          performance,
          transactions,
          quality,
        } = result;
        return jsonResult({
          buildId,
          ledgerId,
          stale,
          generatedAt,
          filters,
          unit,
          performance,
          transactions,
          quality,
          drawdownBasis: "closed_pnl",
        });
      },
    ),
    defineReadTool(
      "get_analytics_details",
      "Page dashboard detail rows for the same unit, basis, currency and filters as the summary. Pass its buildId as expectedBuildId. kind=strategies returns lifecycle rows by default; scope=current-open is current-build context.",
      Details,
      ({ offset, limit, ...raw }) => {
        const snapshot = readToolSnapshot(ctx, raw.expectedBuildId);
        const page = Math.floor(offset / MAX_LIST_ROWS) + 1;
        const query = parseDetailQuery({
          ...raw,
          page,
          pageSize: MAX_LIST_ROWS,
        });
        const first = selectAnalyticsDetails(snapshot, query);
        const localOffset = offset % MAX_LIST_ROWS;
        const second =
          localOffset + limit > MAX_LIST_ROWS &&
          page * MAX_LIST_ROWS < first.total
            ? selectAnalyticsDetails(snapshot, { ...query, page: page + 1 })
            : null;
        const {
          items,
          total,
          page: _page,
          pageSize: _pageSize,
          ...meta
        } = first;
        return pageSelectedResult(
          meta,
          [...items.slice(localOffset), ...(second?.items ?? [])],
          total,
          offset,
          limit,
        );
      },
    ),
    defineReadTool(
      "get_analytics_breakdown",
      "Page one dashboard series or ranking using the same resolved filters and build as the summary. best/worst/recent retain the dashboard's top-ten scope; daily drawdown is closed-P&L drawdown.",
      Breakdown,
      ({ expectedBuildId, section, offset, limit, ...raw }) => {
        const result = aggregateAnalytics(
          readToolSnapshot(ctx, expectedBuildId),
          parseAnalyticsQuery(raw),
        );
        const { buildId, ledgerId, stale, generatedAt, filters, unit } = result;
        const rows = result[section];
        return pageSelectedResult(
          { buildId, ledgerId, stale, generatedAt, filters, unit, section },
          rows.slice(offset, offset + limit),
          rows.length,
          offset,
          limit,
        );
      },
    ),
  ];
}
