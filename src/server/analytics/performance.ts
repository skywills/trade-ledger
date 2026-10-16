import { Decimal } from "decimal.js";
import type { DailyPoint, PerformanceSummary } from "../../shared/analytics.js";
import type { AnalyticsScope } from "./scope.js";
import { selectedPnl } from "./scope.js";
export const Money = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -100000,
  toExpPos: 100000,
});
export function sum(values: readonly (string | null)[]): string | null {
  const known = values.filter((v): v is string => v !== null);
  return known.length
    ? known.reduce((a, v) => a.plus(v), new Money(0)).toFixed()
    : null;
}
export function divide(
  value: string | null,
  count: number | string,
): string | null {
  return value !== null && !new Money(count).isZero()
    ? new Money(value).div(count).toDecimalPlaces(12).toFixed()
    : null;
}
export function dailySeries(scope: AnalyticsScope): DailyPoint[] {
  const dates = [...new Set(scope.closed.map((s) => s.closeDate!))].sort();
  let running = new Money(0),
    peak = new Money(0);
  let seen = false;
  return dates.map((date) => {
    const rows = scope.closed.filter((s) => s.closeDate === date);
    const values = rows.map((s) => selectedPnl(s, scope.query));
    const pnl = sum(values);
    const eligible = values.filter((v) => v !== null).length;
    if (pnl !== null) {
      seen = true;
      running = running.plus(pnl);
      peak = Money.max(peak, running);
    }
    return {
      date,
      pnl,
      cumulative: seen ? running.toFixed() : null,
      drawdown: seen ? peak.minus(running).toFixed() : null,
      eligible,
      missing: rows.length - eligible,
    };
  });
}
export function summarizePerformance(
  scope: AnalyticsScope,
): PerformanceSummary {
  const values = scope.closed.map((s) => selectedPnl(s, scope.query));
  const eligible = values.filter((v): v is string => v !== null);
  const wins = eligible.filter((v) => new Money(v).gt(0)),
    losses = eligible.filter((v) => new Money(v).lt(0));
  const pnl = sum(eligible),
    grossProfit = sum(wins),
    grossLoss = sum(losses);
  return {
    closed: values.length,
    eligible: eligible.length,
    missing: values.length - eligible.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: eligible.length - wins.length - losses.length,
    open: scope.currentOpen.filter((s) => s.status === "open").length,
    partiallyClosed: scope.currentOpen.filter(
      (s) => s.status === "partially_closed",
    ).length,
    pnl,
    winRatePct: divide(String(wins.length * 100), eligible.length),
    averageWin: divide(grossProfit, wins.length),
    averageLoss: divide(grossLoss, losses.length),
    averagePnl: divide(pnl, eligible.length),
    grossProfit,
    grossLoss,
    maxDrawdown: eligible.length
      ? dailySeries(scope).reduce(
          (max, p) => Money.max(max, p.drawdown ?? 0).toFixed(),
          "0",
        )
      : null,
    profitFactor: losses.length
      ? {
          state: "finite",
          value: divide(
            grossProfit ?? "0",
            new Money(grossLoss!).abs().toFixed(),
          ),
        }
      : wins.length
        ? { state: "no-losses", value: null }
        : { state: "unavailable", value: null },
  };
}
