import { z } from "zod";
import type { Execution } from "../../../shared/domain.js";
import { AppError } from "../../../shared/errors.js";
import {
  activeBuildMeta,
  activeLedgerSnapshot,
  activeProjection,
} from "../../builds/service.js";
import { readStrategyMetadata } from "../../decisions/service.js";
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

const Paging = {
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_LIST_ROWS).optional(),
};
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ListStrategies = z
  .object({
    status: z
      .enum(["open", "partially_closed", "closed", "unresolved"])
      .optional(),
    symbol: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    ...Paging,
  })
  .strict();
const GetStrategy = z.object({ strategyId: z.string().min(1) }).strict();
const ListTransactions = z
  .object({
    symbol: z.string().min(1).optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    ...Paging,
  })
  .strict();
const ListIssues = z
  .object({
    severity: z.string().optional(),
    code: z.string().optional(),
    ...Paging,
  })
  .strict();

function within(date: string | null, from?: string, to?: string): boolean {
  if (from === undefined && to === undefined) return true;
  if (date === null) return false;
  const day = date.slice(0, 10);
  return (from === undefined || day >= from) && (to === undefined || day <= to);
}

function listStrategiesTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "list_strategies",
    description: `List strategies (journal rows) in the active build, newest opening first. symbol matches the description case-insensitively; from/to filter openingDate. ${UNTRUSTED}`,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        symbol: { type: "string" },
        type: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        ...PagingSchemaFields,
      },
      additionalProperties: false,
    },
    approval: "never",
    run: (input) =>
      refuseInvalidInput(() => {
        const q = ListStrategies.parse(input ?? {});
        const active = activeProjection(ctx.store);
        const rows = (active.projection?.strategies ?? [])
          .filter(
            (s) =>
              (q.status === undefined || s.status === q.status) &&
              (q.type === undefined || s.type === q.type),
          )
          .filter(
            (s) =>
              q.symbol === undefined ||
              s.description.toLowerCase().includes(q.symbol.toLowerCase()),
          )
          .filter((s) => within(s.openingDate, q.from, q.to))
          .sort((a, b) =>
            (b.openingDate ?? "").localeCompare(a.openingDate ?? ""),
          );
        return pagedResult(
          { buildId: active.buildId, stale: active.stale },
          rows,
          q.offset,
          q.limit,
        );
      }),
  };
}

function getStrategyTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "get_strategy",
    description: `Read one strategy with its allocations, links and notes/stop-loss metadata. ${UNTRUSTED}`,
    inputSchema: {
      type: "object",
      properties: { strategyId: { type: "string" } },
      required: ["strategyId"],
      additionalProperties: false,
    },
    approval: "never",
    run: (input) =>
      refuseInvalidInput(() => {
        const { strategyId } = GetStrategy.parse(input ?? {});
        const active = activeProjection(ctx.store);
        const strategy = active.projection?.strategies.find(
          (s) => s.id === strategyId,
        );
        if (strategy === undefined)
          throw new AppError(
            "STRATEGY_NOT_FOUND",
            `No strategy exists for id ${strategyId} in the active build.`,
            404,
          );
        return jsonResult({
          buildId: active.buildId,
          stale: active.stale,
          strategy,
          allocations: (active.projection?.allocations ?? []).filter(
            (a) => a.strategyId === strategyId,
          ),
          links: (active.projection?.links ?? []).filter(
            (l) => l.from === strategyId || l.to === strategyId,
          ),
          metadata: readStrategyMetadata(ctx.store, strategyId),
        });
      }),
  };
}

/**
 * The model-facing view of an execution: everything needed to reason about and
 * propose allocations (key, sources, quantity, money, P&L, open/close marker),
 * without broker order ids, raw timestamps or the account, which roughly
 * halves the bytes per row.
 */
function transactionView(e: Execution) {
  return {
    key: e.key,
    date: e.date,
    symbol: e.instrument.symbol,
    underlying: e.instrument.underlying,
    assetClass: e.instrument.assetClass,
    quantity: e.quantity,
    price: e.price,
    currency: e.currency,
    netCash: e.netCash,
    proceeds: e.proceeds,
    commission: e.commission,
    basis: e.basis,
    brokerPnl: e.brokerPnl,
    action: e.action,
    event: e.event,
    sources: e.sources,
  };
}

function listTransactionsTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "list_transactions",
    description: `List ledger executions in the active build, newest first. Money is decimal strings; brokerPnl null means unknown. ${UNTRUSTED}`,
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        ...PagingSchemaFields,
      },
      additionalProperties: false,
    },
    approval: "never",
    run: (input) =>
      refuseInvalidInput(() => {
        const q = ListTransactions.parse(input ?? {});
        const rows = (activeLedgerSnapshot(ctx.store)?.executions ?? [])
          .filter(
            (e) =>
              q.symbol === undefined ||
              e.instrument.symbol.toUpperCase() === q.symbol.toUpperCase(),
          )
          .filter((e) => within(e.date, q.from, q.to))
          .sort((a, b) => b.date.localeCompare(a.date));
        return pagedResult(
          activeBuildMeta(ctx.store),
          rows.map(transactionView),
          q.offset,
          q.limit,
        );
      }),
  };
}

function listReviewIssuesTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "list_review_issues",
    description: `List review issues (things needing reconciliation) in the active build. ${UNTRUSTED}`,
    inputSchema: {
      type: "object",
      properties: {
        severity: { type: "string" },
        code: { type: "string" },
        ...PagingSchemaFields,
      },
      additionalProperties: false,
    },
    approval: "never",
    run: (input) =>
      refuseInvalidInput(() => {
        const q = ListIssues.parse(input ?? {});
        const active = activeProjection(ctx.store);
        const rows = (active.projection?.issues ?? []).filter(
          (i) =>
            (q.severity === undefined || i.severity === q.severity) &&
            (q.code === undefined || i.code === q.code),
        );
        return pagedResult(
          { buildId: active.buildId, stale: active.stale },
          rows,
          q.offset,
          q.limit,
        );
      }),
  };
}

export function journalTools(ctx: ChatToolContext): ChatTool[] {
  return [
    listStrategiesTool(ctx),
    getStrategyTool(ctx),
    listTransactionsTool(ctx),
    listReviewIssuesTool(ctx),
  ];
}
