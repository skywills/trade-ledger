import { Decimal } from "decimal.js";
import { z } from "zod";
import type { Strategy } from "../../../shared/domain.js";
import { activeProjection } from "../../builds/service.js";
import {
  type ChatTool,
  type ChatToolContext,
  jsonResult,
  refuseInvalidInput,
} from "./shared.js";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const PnlQuerySchema = z
  .object({
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    dateField: z.enum(["closeDate", "openingDate"]).default("closeDate"),
    groupBy: z
      .enum(["currency", "status", "type", "month"])
      .default("currency"),
    status: z
      .enum(["open", "partially_closed", "closed", "unresolved"])
      .optional(),
  })
  .strict();
export type PnlQuery = z.input<typeof PnlQuerySchema>;

export interface PnlGroup {
  readonly currency: string;
  readonly group: string;
  readonly strategies: number;
  readonly brokerPnl: string | null;
  readonly reconstructedPnl: string | null;
  readonly cashflow: string | null;
  readonly missingBrokerPnl: number;
  readonly missingReconstructedPnl: number;
  readonly missingCashflow: number;
}
export interface PnlSummary {
  readonly groups: PnlGroup[];
  readonly excludedNoDate: number;
}

interface Acc {
  strategies: number;
  broker: Decimal;
  recon: Decimal;
  cash: Decimal;
  missingBroker: number;
  missingRecon: number;
  missingCash: number;
}

function groupKey(
  strategy: Strategy,
  query: z.output<typeof PnlQuerySchema>,
): string {
  switch (query.groupBy) {
    case "status":
      return strategy.status;
    case "type":
      return strategy.type;
    case "month":
      return strategy[query.dateField]?.slice(0, 7) ?? "undated";
    default:
      return "all";
  }
}

function inRange(
  date: string,
  query: z.output<typeof PnlQuerySchema>,
): boolean {
  const day = date.slice(0, 10);
  return (
    (query.from === undefined || day >= query.from) &&
    (query.to === undefined || day <= query.to)
  );
}

function add(acc: Acc, strategy: Strategy): Acc {
  return {
    strategies: acc.strategies + 1,
    broker:
      strategy.brokerPnl === null
        ? acc.broker
        : acc.broker.plus(strategy.brokerPnl),
    recon:
      strategy.reconstructedPnl === null
        ? acc.recon
        : acc.recon.plus(strategy.reconstructedPnl),
    cash:
      strategy.cashflow === null ? acc.cash : acc.cash.plus(strategy.cashflow),
    missingBroker: acc.missingBroker + (strategy.brokerPnl === null ? 1 : 0),
    missingRecon:
      acc.missingRecon + (strategy.reconstructedPnl === null ? 1 : 0),
    missingCash: acc.missingCash + (strategy.cashflow === null ? 1 : 0),
  };
}

const ZERO: Acc = {
  strategies: 0,
  broker: new Decimal(0),
  recon: new Decimal(0),
  cash: new Decimal(0),
  missingBroker: 0,
  missingRecon: 0,
  missingCash: 0,
};

/** A total over zero known values is unknown (null), never "0". */
function totalOrNull(
  total: Decimal,
  missing: number,
  strategies: number,
): string | null {
  return missing === strategies ? null : total.toFixed();
}

/** Per-currency P&L totals; null values are counted, never summed as zero. */
export function summarizePnl(
  strategies: readonly Strategy[],
  input: PnlQuery,
): PnlSummary {
  const query = PnlQuerySchema.parse(input);
  const ranged = query.from !== undefined || query.to !== undefined;
  const filtered = strategies.filter(
    (s) => query.status === undefined || s.status === query.status,
  );
  const undated = ranged
    ? filtered.filter((s) => s[query.dateField] === null).length
    : 0;
  const selected = filtered.filter((s) => {
    const date = s[query.dateField];
    return !ranged || (date !== null && inRange(date, query));
  });
  const buckets = new Map<
    string,
    { currency: string; group: string; acc: Acc }
  >();
  for (const strategy of selected) {
    const group = groupKey(strategy, query);
    const key = `${strategy.currency}\u0000${group}`;
    const current = buckets.get(key) ?? {
      currency: strategy.currency,
      group,
      acc: ZERO,
    };
    buckets.set(key, { ...current, acc: add(current.acc, strategy) });
  }
  const groups = [...buckets.values()]
    .sort(
      (a, b) =>
        a.currency.localeCompare(b.currency) || a.group.localeCompare(b.group),
    )
    .map(({ currency, group, acc }) => ({
      currency,
      group,
      strategies: acc.strategies,
      brokerPnl: totalOrNull(acc.broker, acc.missingBroker, acc.strategies),
      reconstructedPnl: totalOrNull(
        acc.recon,
        acc.missingRecon,
        acc.strategies,
      ),
      cashflow: totalOrNull(acc.cash, acc.missingCash, acc.strategies),
      missingBrokerPnl: acc.missingBroker,
      missingReconstructedPnl: acc.missingRecon,
      missingCashflow: acc.missingCash,
    }));
  return { groups, excludedNoDate: undated };
}

export function pnlTools(ctx: ChatToolContext): ChatTool[] {
  return [
    {
      name: "get_pnl_summary",
      description:
        "Summarise strategy P&L from the active build, per currency (never summed across currencies). Dates are YYYY-MM-DD and filter on closeDate by default (realised P&L). missing* counts strategies whose value is unknown; a total is null when every strategy in the group is unknown (never 0).",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          dateField: { type: "string", enum: ["closeDate", "openingDate"] },
          groupBy: {
            type: "string",
            enum: ["currency", "status", "type", "month"],
          },
          status: {
            type: "string",
            enum: ["open", "partially_closed", "closed", "unresolved"],
          },
        },
        additionalProperties: false,
      },
      approval: "never",
      run: (input) =>
        refuseInvalidInput(() => {
          const active = activeProjection(ctx.store);
          const summary = summarizePnl(
            active.projection?.strategies ?? [],
            (input ?? {}) as PnlQuery,
          );
          return jsonResult({
            buildId: active.buildId,
            stale: active.stale,
            ...summary,
          });
        }),
    },
  ];
}
