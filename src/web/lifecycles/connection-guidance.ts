import { Decimal } from "decimal.js";
import type { AllocationRef, ConnectionPlan } from "../../shared/lifecycles.js";
import type { Execution } from "../api.js";
import type { ConnectionData, ConnectionSection } from "./connection-batch.js";
import type { ConnectionGroup } from "./connections.js";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Jun20'25 145C". */
export function contractLabel(i: Execution["instrument"]): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(i.expiry ?? "");
  const expiry = match
    ? `${MONTHS[Number(match[2]) - 1] ?? match[2]}${Number(match[3])}'${(match[1] ?? "").slice(2)}`
    : "";
  const strike = i.strike ? new Decimal(i.strike).toString() : "";
  return `${expiry} ${strike}${i.putCall ?? ""}`.trim();
}

/** "1 short call" / "2 short calls". */
export function shortCallsLabel(contracts: number | string): string {
  return `${contracts} short ${Number(contracts) === 1 ? "call" : "calls"}`;
}

export function groupPlan(g: ConnectionGroup): ConnectionPlan | null {
  return g.suggestions[0]?.plan ?? null;
}

export interface PositionGroup {
  /** null = "Needs your choice". */
  lifecycleId: string | null;
  title: string;
  groups: ConnectionGroup[];
  applicable: { connect: ConnectionGroup[]; separate: ConnectionGroup[] };
  /** Older manual row disabling Apply. */
  blockedBy: ConnectionGroup | null;
}

function positionTitle(id: string, data: ConnectionData): string {
  const lifecycle = data.lifecycles?.lifecycles.find((l) => l.id === id);
  const label = lifecycle?.description || "an earlier trade";
  const executions = new Map(data.connectionExecutions.map((e) => [e.key, e]));
  const assignment = data.lifecycles?.members
    .filter((m) => m.lifecycleId === id)
    .map((m) => ({
      member: m,
      execution: executions.get(m.allocation.executionKey),
    }))
    .find(
      (x) =>
        x.execution?.instrument.assetClass === "STK" &&
        x.execution.event === "assignment",
    );
  const date = assignment?.execution?.date;
  const shares = assignment
    ? new Decimal(assignment.member.quantity).abs().toString()
    : null;
  const head = shares ? `${shares} shares from` : "Shares from";
  return `${head} ${label}${date ? ` (assigned ${date})` : ""}`;
}

export function positionGroups(
  section: ConnectionSection,
  data: ConnectionData,
): PositionGroup[] {
  const byPosition = new Map<string | null, ConnectionGroup[]>();
  for (const group of section.groups) {
    const id = groupPlan(group)?.lifecycleId ?? null;
    byPosition.set(id, [...(byPosition.get(id) ?? []), group]);
  }
  const ids = [...byPosition.keys()].filter((id) => id !== null);
  const ordered = byPosition.has(null) ? [...ids, null] : ids;
  return ordered.map((lifecycleId): PositionGroup => {
    const groups = byPosition.get(lifecycleId) ?? [];
    const action = (g: ConnectionGroup) => groupPlan(g)?.action;
    const connect =
      lifecycleId === null ? [] : groups.filter((g) => action(g) === "connect");
    const separate =
      lifecycleId === null
        ? []
        : groups.filter((g) => action(g) === "separate");
    const applicableRows = new Set([...connect, ...separate]);
    const blockedBy =
      groups.find(
        (g, i) =>
          action(g) === "manual" &&
          groups.slice(i + 1).some((later) => applicableRows.has(later)),
      ) ?? null;
    return {
      lifecycleId,
      title:
        lifecycleId === null
          ? "Needs your choice"
          : positionTitle(lifecycleId, data),
      groups,
      applicable: { connect, separate },
      blockedBy,
    };
  });
}

function time(e: Execution | undefined): string | null {
  const m = /[T ;](\d{2}):(\d{2})/.exec(e?.rawDateTime ?? "");
  return m ? `${m[1]}:${m[2]}` : null;
}

/** The row's own opening: group when given, else the suggestion carrying this plan. */
function openingExecution(
  plan: ConnectionPlan,
  data: ConnectionData,
  group: ConnectionGroup | undefined,
): Execution | undefined {
  const key =
    group?.suggestions[0]?.callOpening.executionKey ??
    data.lifecycles?.suggestions.find((s) => s.plan === plan)?.callOpening
      .executionKey ??
    data.lifecycles?.suggestions.find(
      (s) => JSON.stringify(s.plan) === JSON.stringify(plan),
    )?.callOpening.executionKey;
  return data.connectionExecutions.find((e) => e.key === key);
}

/** Plain-language reason a row was classified the way it was. */
export function explainPlan(
  plan: ConnectionPlan,
  data: ConnectionData,
  group?: ConnectionGroup,
): string {
  const executions = new Map(data.connectionExecutions.map((e) => [e.key, e]));
  const label = (r: AllocationRef | undefined) => {
    const e = r && executions.get(r.executionKey);
    return e ? contractLabel(e.instrument) : "earlier call";
  };
  const opening = openingExecution(plan, data, group);
  const soldAt = opening
    ? `${opening.date}${time(opening) ? ` ${time(opening)}` : ""}`
    : "an unknown time";
  // heldBy: HELD_BY_EARLIER_CALL, SHARES_SOLD, ROLL_RELEASE; dependsOn[0]: COVERED_AFTER_EARLIER.
  const earlier =
    plan.reason === "COVERED_AFTER_EARLIER" ? plan.dependsOn?.[0] : plan.heldBy;
  let text: string;
  switch (plan.reason) {
    case "COVERED": {
      const n = plan.sharesAtOpening ?? group?.shares ?? "Enough";
      text = `${n} shares were free when this call was sold.`;
      break;
    }
    case "COVERED_AFTER_EARLIER":
      text = `Rolled from the ${label(earlier)}; covered once that call is connected.`;
      break;
    case "ROLL_RELEASE":
      text = `Sold before the ${label(earlier)} closed later that day; the shares passed to this call.`;
      break;
    case "HELD_BY_EARLIER_CALL":
      text = `When this call was sold (${soldAt}), the ${label(plan.heldBy)} still held the shares.`;
      break;
    case "SHARES_SOLD": {
      const sale =
        plan.sharesSold && executions.get(plan.sharesSold.executionKey);
      const sameDay = !sale || !opening || sale.date === opening.date;
      const when = sameDay
        ? `${time(sale) ? ` at ${time(sale)}` : ""} the same day`
        : ` on ${sale?.date}${time(sale) ? ` at ${time(sale)}` : ""}`;
      text = `When this call was sold (${soldAt}), the ${label(plan.heldBy)} still held the shares. The shares were sold${when}, so they never covered this call.`;
      break;
    }
    case "MULTIPLE_POSITIONS":
      text = "More than one share position could cover this call. Choose one.";
      break;
    case "PARTIAL":
      text =
        "Only some of these contracts can be covered. Review this call individually.";
      break;
    case "ORDER_UNKNOWN":
      text =
        "Trade times can't show what happened first. Review this call individually.";
      break;
  }
  if (plan.pairedWith)
    text += ` Sold together with a long ${label(plan.pairedWith)} — likely a call spread.`;
  return text;
}
