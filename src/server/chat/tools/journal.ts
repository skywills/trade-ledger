import { z } from "zod";
import { validDay } from "../../../shared/analytics.js";
import type { Execution } from "../../../shared/domain.js";
import { AppError } from "../../../shared/errors.js";
import {
  normalizeStrategyDescription,
  normalizeSymbol,
  underlyingSymbol,
} from "../../../shared/symbols.js";
import {
  decisionWatermark,
  readStrategyMetadata,
} from "../../decisions/service.js";
import {
  type ChatTool,
  type ChatToolContext,
  jsonResult,
  MAX_LIST_ROWS,
  pagedResult,
  refuseInvalidInput,
  UNTRUSTED,
} from "./shared.js";

import { readToolSnapshot, snapshotMeta } from "./snapshot.js";

const ExpectedBuild = { expectedBuildId: z.string().min(1).optional() };
const dateOrder = (q: { from?: string | undefined; to?: string | undefined }) =>
  !q.from || !q.to || q.from <= q.to;

const Paging = {
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_LIST_ROWS).optional(),
};
const IsoDate = z.string().refine(validDay, "Use a valid YYYY-MM-DD date.");
const AttributionFilters = {
  underlying: z.string().min(1).optional(),
  assetClass: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
};
const ListStrategies = z
  .object({
    status: z
      .enum(["open", "partially_closed", "closed", "unresolved"])
      .optional(),
    symbol: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    ...AttributionFilters,
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    ...Paging,
    ...ExpectedBuild,
  })
  .strict()
  .refine(dateOrder, "Start date must be on or before end date.");
const GetStrategy = z
  .object({ strategyId: z.string().min(1), ...ExpectedBuild })
  .strict();
const ListTransactions = z
  .object({
    symbol: z.string().min(1).optional(),
    ...AttributionFilters,
    instrumentKey: z.string().min(1).optional(),
    executionKey: z.string().min(1).optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    ...Paging,
    ...ExpectedBuild,
  })
  .strict()
  .refine(dateOrder, "Start date must be on or before end date.");
const ListIssues = z
  .object({
    severity: z.string().optional(),
    code: z.string().optional(),
    ...Paging,
    ...ExpectedBuild,
  })
  .strict();

type EvidenceQuery = {
  underlying?: string | undefined;
  assetClass?: string | undefined;
  account?: string | undefined;
  instrumentKey?: string | undefined;
  executionKey?: string | undefined;
};
function matchesEvidence(e: Execution, q: EvidenceQuery): boolean {
  return (
    (!q.underlying ||
      underlyingSymbol(e.instrument).toUpperCase() ===
        normalizeSymbol(q.underlying.replace(/^value:/, "")).toUpperCase()) &&
    (!q.assetClass || e.instrument.assetClass === q.assetClass) &&
    (!q.account || e.account === q.account) &&
    (!q.instrumentKey || e.instrument.key === q.instrumentKey) &&
    (!q.executionKey || e.key === q.executionKey)
  );
}

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
    inputSchema: z.toJSONSchema(ListStrategies, {
      io: "input",
      target: "draft-7",
    }),
    approval: "never",
    run: (input) =>
      refuseInvalidInput(() => {
        const q = ListStrategies.parse(input ?? {});
        const active = readToolSnapshot(ctx, q.expectedBuildId);
        const executions = new Map(
          (active.ledger?.executions ?? []).map((e) => [e.key, e]),
        );
        const evidence = new Map<string, Execution[]>();
        for (const allocation of active.projection?.allocations ?? []) {
          const execution = executions.get(allocation.executionKey);
          if (execution) {
            const rows = evidence.get(allocation.strategyId) ?? [];
            rows.push(execution);
            evidence.set(allocation.strategyId, rows);
          }
        }
        const rows = (active.projection?.strategies ?? [])
          .map((s) => ({
            ...s,
            description: normalizeStrategyDescription(s.description),
          }))
          .filter(
            (s) =>
              (q.status === undefined || s.status === q.status) &&
              (q.type === undefined || s.type === q.type),
          )
          .filter(
            (s) =>
              q.symbol === undefined ||
              s.description
                .toLowerCase()
                .includes(
                  normalizeStrategyDescription(q.symbol.trim()).toLowerCase(),
                ),
          )
          .filter(
            (s) =>
              (!q.underlying && !q.assetClass && !q.account) ||
              (evidence.get(s.id) ?? []).some((e) => matchesEvidence(e, q)),
          )
          .filter((s) => within(s.openingDate, q.from, q.to))
          .sort((a, b) =>
            (b.openingDate ?? "").localeCompare(a.openingDate ?? ""),
          );
        return pagedResult(snapshotMeta(active), rows, q.offset, q.limit);
      }),
  };
}

function getStrategyTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "get_strategy",
    description: `Read one strategy with its allocations, links and notes/stop-loss metadata. ${UNTRUSTED}`,
    inputSchema: z.toJSONSchema(GetStrategy, {
      io: "input",
      target: "draft-7",
    }),
    approval: "never",
    run: (input) =>
      refuseInvalidInput(() =>
        ctx.store.db.transaction(() => {
          const { strategyId, expectedBuildId } = GetStrategy.parse(
            input ?? {},
          );
          const active = readToolSnapshot(ctx, expectedBuildId);
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
            ...snapshotMeta(active),
            watermark: decisionWatermark(ctx.store),
            strategy: {
              ...strategy,
              description: normalizeStrategyDescription(strategy.description),
            },
            allocations: (active.projection?.allocations ?? []).filter(
              (a) => a.strategyId === strategyId,
            ),
            links: (active.projection?.links ?? []).filter(
              (l) => l.from === strategyId || l.to === strategyId,
            ),
            metadata: readStrategyMetadata(ctx.store, strategyId),
          });
        })(),
      ),
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
    underlying: underlyingSymbol(e.instrument),
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
    inputSchema: z.toJSONSchema(ListTransactions, {
      io: "input",
      target: "draft-7",
    }),
    approval: "never",
    run: (input) =>
      refuseInvalidInput(() => {
        const q = ListTransactions.parse(input ?? {});
        const active = readToolSnapshot(ctx, q.expectedBuildId);
        const rows = (active.ledger?.executions ?? [])
          .filter(
            (e) =>
              q.symbol === undefined ||
              normalizeSymbol(e.instrument.symbol).toUpperCase() ===
                normalizeSymbol(q.symbol).toUpperCase(),
          )
          .filter((e) => matchesEvidence(e, q))
          .filter((e) => within(e.date, q.from, q.to))
          .sort((a, b) => b.date.localeCompare(a.date));
        return pagedResult(
          snapshotMeta(active),
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
    inputSchema: z.toJSONSchema(ListIssues, { io: "input", target: "draft-7" }),
    approval: "never",
    run: (input) =>
      refuseInvalidInput(() => {
        const q = ListIssues.parse(input ?? {});
        const active = readToolSnapshot(ctx, q.expectedBuildId);
        const rows = (active.projection?.issues ?? []).filter(
          (i) =>
            (q.severity === undefined || i.severity === q.severity) &&
            (q.code === undefined || i.code === q.code),
        );
        return pagedResult(snapshotMeta(active), rows, q.offset, q.limit);
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
