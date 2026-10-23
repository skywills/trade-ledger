import { Decimal } from "decimal.js";
import type { LedgerSnapshot, Projection } from "../../shared/domain.js";
import type {
  Lifecycle,
  LifecycleMember,
  LifecycleProjection,
} from "../../shared/lifecycles.js";
import { reconcilesWithin } from "../../shared/money.js";
import { unresolvedEventCash } from "./event-cash.js";
import { sum } from "./membership.js";
export function brokerRealized(
  _ledger: LedgerSnapshot,
  members: readonly LifecycleMember[],
): { value: string | null; estimated: boolean; reasons: string[] } {
  const closing = members.filter((m) => m.allocation.role === "close");
  const complete =
    members.some((m) => m.brokerPnl !== null) &&
    closing.every((m) => m.brokerPnl !== null);
  return {
    value: complete ? sum(members.map((m) => m.brokerPnl ?? "0")) : null,
    estimated: members.some((m) => m.estimated),
    reasons: complete ? [] : ["BROKER_PNL_INCOMPLETE"],
  };
}
export function accountLifecycles(
  ledger: LedgerSnapshot,
  strategies: Projection,
  p: LifecycleProjection,
): LifecycleProjection {
  for (const l of p.lifecycles) {
    const members = p.members.filter((m) => m.lifecycleId === l.id);
    const cash = sum(members.map((m) => m.netCash));
    const broker = brokerRealized(ledger, members);
    const unresolvedEvents = unresolvedEventCash(ledger, strategies, members);
    const quarantined =
      ledger.conflicts > 0 || ledger.issues.some((i) => i.severity === "error");
    if (quarantined) l.complete = false;
    l.cashflow = cash;
    l.brokerPnl = l.status === "closed" ? broker.value : null;
    l.reconstructedPnl =
      l.status === "closed" &&
      l.complete &&
      !quarantined &&
      unresolvedEvents.length === 0
        ? cash
        : null;
    l.reasons = [
      ...new Set([
        ...l.reasons.filter(
          (reason) =>
            reason !== "ESTIMATED_PNL" && reason !== "BASIS_RECONCILED_PNL",
        ),
        ...broker.reasons,
        ...(members.some((m) => m.estimated) ? ["ESTIMATED_PNL"] : []),
        ...(members.some((m) => m.pnlAttribution === "basis-reconciled")
          ? ["BASIS_RECONCILED_PNL"]
          : []),
        ...(quarantined ? ["QUARANTINED_EVIDENCE"] : []),
        ...(unresolvedEvents.length ? ["EVENT_CASH_UNRESOLVED"] : []),
      ]),
    ];
    if (unresolvedEvents.length) {
      p.issues.push({
        key: `lifecycle:event-cash:${l.id}`,
        code: "EVENT_CASH_UNRESOLVED",
        sources: unresolvedEvents.flatMap((m) => m.sources),
        severity: "warning",
      });
    }
    if (
      l.brokerPnl !== null &&
      l.reconstructedPnl !== null &&
      !reconcilesWithin(l.brokerPnl, l.reconstructedPnl, l.currency)
    ) {
      l.reasons.push("PNL_RECONCILIATION");
      p.issues.push({
        key: `lifecycle:pnl:${l.id}`,
        code: "PNL_RECONCILIATION",
        sources: members.flatMap((m) => m.sources),
        severity: "warning",
      });
    }
  }
  return p;
}
export function lifecycleOutcome(
  l: Lifecycle,
  basis: "broker" | "reconstructed",
): "win" | "loss" | "breakeven" | "unavailable" {
  const pnl = basis === "broker" ? l.brokerPnl : l.reconstructedPnl;
  if (l.status !== "closed" || !l.complete || pnl === null)
    return "unavailable";
  const sign = new Decimal(pnl).cmp(0);
  return sign > 0 ? "win" : sign < 0 ? "loss" : "breakeven";
}
