import { Decimal } from "decimal.js";
import type {
  Allocation,
  Execution,
  Id,
  Instrument,
  Issue,
  SourceRef,
  Strategy,
} from "../../shared/domain.js";
import { classifyLegs, isDerivative, yearOf } from "./matching.js";

export interface LegRecord {
  executionKey: string;
  instrument: Instrument;
  quantity: string;
  date: string;
  role: "open" | "close";
  event: Execution["event"];
  multiplier: string | null;
  netCash: string;
  brokerPnl: string | null;
  sources: SourceRef[];
}

/**
 * In-memory working strategy used while grouping. Financial amounts are
 * intentionally absent: Task 8 owns accounting and Task 9 owns persistence.
 */
export interface StrategyDraft {
  id: Id;
  account: string;
  currency: string;
  description: string;
  type: string;
  openingDate: string | null;
  expiry: string | null;
  openingLegs: LegRecord[];
  legs: LegRecord[];
  allocations: Allocation[];
  unresolved: boolean;
  blocking: boolean;
  complete: boolean;
  issues: Issue[];
}

export function makeIssue(
  code: string,
  sources: SourceRef[],
  severity: Issue["severity"],
  scope = "",
): Issue {
  const refs = [...sources]
    .map((source) => `${source.importId}:${source.rowNumber}`)
    .sort()
    .join(",");
  return {
    key: `strategy:${code}:${scope}:${refs}`,
    code,
    sources,
    severity,
  };
}

export function emptyDraft(id: Id): StrategyDraft {
  return {
    id,
    account: "",
    currency: "",
    description: "",
    type: "unresolved",
    openingDate: null,
    expiry: null,
    openingLegs: [],
    legs: [],
    allocations: [],
    unresolved: false,
    blocking: false,
    complete: true,
    issues: [],
  };
}

export interface LegOverrides {
  quantity?: string;
  netCash?: string;
  brokerPnl?: string | null;
}

export function legOf(
  execution: Execution,
  role: "open" | "close",
  overrides: LegOverrides = {},
): LegRecord {
  return {
    executionKey: execution.key,
    instrument: execution.instrument,
    quantity: overrides.quantity ?? execution.quantity,
    date: execution.date,
    role,
    event: execution.event,
    multiplier: execution.instrument.multiplier,
    netCash: overrides.netCash ?? execution.netCash,
    brokerPnl:
      overrides.brokerPnl !== undefined
        ? overrides.brokerPnl
        : execution.brokerPnl,
    sources: execution.sources,
  };
}

export function addLeg(draft: StrategyDraft, leg: LegRecord): void {
  draft.legs.push(leg);
  if (leg.role === "open") draft.openingLegs.push(leg);
  if (
    leg.role === "open" &&
    (draft.openingDate === null || leg.date < draft.openingDate)
  ) {
    draft.openingDate = leg.date;
  }
  draft.allocations.push({
    strategyId: draft.id,
    executionKey: leg.executionKey,
    quantity: leg.quantity,
    netCash: leg.netCash,
    brokerPnl: leg.brokerPnl,
    pnlEstimated: false,
    role: leg.role,
  });
  if (leg.multiplier === null && isDerivative(leg.instrument)) {
    pushDraftIssue(
      draft,
      makeIssue("MISSING_MULTIPLIER", leg.sources, "warning", leg.executionKey),
    );
    draft.complete = false;
  }
}

export function pushDraftIssue(draft: StrategyDraft, issue: Issue): void {
  if (draft.issues.some((existing) => existing.key === issue.key)) return;
  draft.issues.push(issue);
}

/** Remaining signed exposure per contract, including zero legs. */
export function positionsOf(
  legs: readonly LegRecord[],
): Array<{ instrumentKey: string; quantity: string }> {
  const totals = new Map<string, Decimal>();
  for (const leg of legs) {
    const key = leg.instrument.key;
    totals.set(key, (totals.get(key) ?? new Decimal(0)).plus(leg.quantity));
  }
  return [...totals.keys()].sort().map((instrumentKey) => ({
    instrumentKey,
    quantity: (totals.get(instrumentKey) ?? new Decimal(0)).toFixed(),
  }));
}

/** Re-derives type, expiry, and description from the opening legs. */
export function recomputePresentation(draft: StrategyDraft): void {
  draft.type = classifyLegs(
    draft.openingLegs.map((leg) => ({
      instrument: leg.instrument,
      quantity: leg.quantity,
    })),
  );
  const expiries = [
    ...new Set(
      draft.openingLegs
        .map((leg) => leg.instrument.expiry)
        .filter((expiry): expiry is string => expiry !== null),
    ),
  ];
  // More than one distinct contract expiry is surfaced as the explicit
  // "Mixed" label rather than an ambiguous null; zero known expiries (shares,
  // unknown contracts) stay null, not "Mixed".
  draft.expiry = expiries.length > 1 ? "Mixed" : (expiries[0] ?? null);
  const symbol =
    draft.openingLegs[0]?.instrument.underlying ??
    draft.openingLegs[0]?.instrument.symbol ??
    "";
  draft.description =
    symbol === "" ? draft.type : `${symbol} ${draft.type.replaceAll("_", " ")}`;
}

export function finalizeDraft(draft: StrategyDraft): Strategy {
  const positions = positionsOf(draft.legs);
  const allZero =
    positions.length > 0 && positions.every((entry) => entry.quantity === "0");
  const hasClose = draft.legs.some((leg) => leg.role === "close");
  const status: Strategy["status"] = draft.unresolved
    ? "unresolved"
    : allZero
      ? "closed"
      : hasClose
        ? "partially_closed"
        : "open";
  const closeDates = draft.legs
    .filter((leg) => leg.role === "close")
    .map((leg) => leg.date)
    .sort();
  const closeDate =
    status === "closed" && closeDates.length > 0
      ? (closeDates[closeDates.length - 1] ?? null)
      : null;
  const reasons = [
    ...new Set([
      ...draft.issues.map((issue) => issue.code),
      ...(draft.blocking ? ["UNSUPPORTED_INVENTORY"] : []),
    ]),
  ].sort();
  return {
    id: draft.id,
    type: draft.type,
    currency: draft.currency,
    description: draft.description,
    openingDate: draft.openingDate,
    closeDate,
    expiry: draft.expiry,
    expiryYear: yearOf(draft.expiry),
    status,
    complete: draft.complete && !draft.unresolved && !draft.blocking,
    openingAmount: null,
    cashflow: null,
    brokerPnl: null,
    reconstructedPnl: null,
    positions,
    reasons,
  };
}
