import { Decimal } from "decimal.js";
import type {
  Allocation,
  DecimalText,
  Execution,
  Id,
  Issue,
  LedgerSnapshot,
  Projection,
  SourceRef,
  Strategy,
} from "../../shared/domain.js";
import { minorUnit, reconcilesWithin } from "../../shared/money.js";
import { splitAmount } from "./allocation.js";
import { signOf, yearOf } from "./matching.js";
import { makeIssue } from "./projection.js";

function canonical(value: Decimal): DecimalText {
  return value.isZero() ? "0" : value.toFixed();
}

interface IndexedAllocation {
  index: number;
  allocation: Allocation;
}

function indexByExecution(
  allocations: readonly Allocation[],
): Map<string, IndexedAllocation[]> {
  const byExecution = new Map<string, IndexedAllocation[]>();
  allocations.forEach((allocation, index) => {
    const entries = byExecution.get(allocation.executionKey) ?? [];
    entries.push({ index, allocation });
    byExecution.set(allocation.executionKey, entries);
  });
  return byExecution;
}

/**
 * Fills in broker P/L that was apportioned across the strategies sharing one
 * execution. When an execution carries authoritative realized P/L but none of
 * its allocations recorded an explicit amount, the P/L is distributed
 * proportionally by signed quantity and every affected allocation is marked
 * estimated rather than broker-verified.
 */
function apportionBrokerPnl(
  ledger: LedgerSnapshot,
  allocations: Allocation[],
): Allocation[] {
  const updated = allocations.map((allocation) => ({ ...allocation }));
  const executionByKey = new Map<Id, Execution>(
    ledger.executions.map((execution) => [execution.key, execution]),
  );

  for (const [executionKey, entries] of indexByExecution(allocations)) {
    if (entries.length === 0) continue;
    const execution = executionByKey.get(executionKey);
    if (execution === undefined || execution.brokerPnl === null) continue;
    if (entries.some((entry) => entry.allocation.brokerPnl !== null)) continue;

    const ordered = [...entries].sort((left, right) => {
      const leftId = left.allocation.strategyId;
      const rightId = right.allocation.strategyId;
      if (leftId !== rightId) return leftId < rightId ? -1 : 1;
      return left.index - right.index;
    });
    const shares = splitAmount(
      execution.brokerPnl,
      ordered.map((entry) => ({
        strategyId: entry.allocation.strategyId,
        quantity: entry.allocation.quantity,
      })),
    );
    ordered.forEach((entry, position) => {
      const share = shares[position];
      if (share === undefined) return;
      updated[entry.index] = {
        ...entry.allocation,
        brokerPnl: share.amount,
        pnlEstimated: true,
      };
    });
  }

  return updated;
}

function executionsOf(
  allocations: readonly Allocation[],
  executionByKey: ReadonlyMap<Id, Execution>,
): Execution[] {
  const result: Execution[] = [];
  for (const allocation of allocations) {
    const execution = executionByKey.get(allocation.executionKey);
    if (execution !== undefined) result.push(execution);
  }
  return result;
}

/** A basis transfer or unmodeled corporate action makes cashflow an estimate. */
function hasBasisTransfer(executions: readonly Execution[]): boolean {
  return executions.some(
    (execution) =>
      execution.basis !== null ||
      execution.event === "assignment" ||
      execution.event === "exercise" ||
      execution.event === "unsupported",
  );
}

/** Quarantined or conflicting evidence prevents any definitive combined total. */
function hasQuarantinedEvidence(ledger: LedgerSnapshot): boolean {
  return (
    ledger.conflicts > 0 ||
    ledger.issues.some((issue) => issue.severity === "error")
  );
}

interface StrategyAmounts {
  openingAmount: DecimalText | null;
  cashflow: DecimalText | null;
  brokerPnl: DecimalText | null;
  reconstructedPnl: DecimalText | null;
  estimated: boolean;
  reconciliation: boolean;
}

function amountsFor(
  ledger: LedgerSnapshot,
  strategy: Strategy,
  allocations: readonly Allocation[],
  executionByKey: ReadonlyMap<Id, Execution>,
): StrategyAmounts {
  const openAllocs = allocations.filter(
    (allocation) => allocation.role === "open",
  );
  const closeAllocs = allocations.filter(
    (allocation) => allocation.role === "close",
  );

  const openingAmount =
    openAllocs.length > 0
      ? canonical(
          openAllocs.reduce(
            (total, allocation) => total.minus(allocation.netCash),
            new Decimal(0),
          ),
        )
      : null;

  const cashflow =
    allocations.length > 0
      ? canonical(
          allocations.reduce(
            (total, allocation) => total.plus(allocation.netCash),
            new Decimal(0),
          ),
        )
      : null;

  const withPnl = allocations.filter(
    (allocation) => allocation.brokerPnl !== null,
  );
  const closingComplete =
    closeAllocs.length === 0 ||
    closeAllocs.every((allocation) => allocation.brokerPnl !== null);
  const brokerPnl =
    withPnl.length > 0 && closingComplete
      ? canonical(
          withPnl.reduce(
            (total, allocation) => total.plus(allocation.brokerPnl ?? 0),
            new Decimal(0),
          ),
        )
      : null;

  const executions = executionsOf(allocations, executionByKey);
  const definitive =
    strategy.complete &&
    strategy.status === "closed" &&
    !hasBasisTransfer(executions) &&
    !hasQuarantinedEvidence(ledger);
  const reconstructedPnl = definitive && cashflow !== null ? cashflow : null;

  const reconciliation =
    reconstructedPnl !== null &&
    brokerPnl !== null &&
    !reconcilesWithin(reconstructedPnl, brokerPnl, strategy.currency);

  return {
    openingAmount,
    cashflow,
    brokerPnl,
    reconstructedPnl,
    estimated: allocations.some((allocation) => allocation.pnlEstimated),
    reconciliation,
  };
}

/**
 * Populates every strategy's decimal amounts from its allocations. Pure,
 * synchronous and store-free: it never opens the database and never converts a
 * money value to a JS number. Broker realized P/L stays separate from net cash
 * and from independently reconstructed lifecycle P/L; an apportioned amount is
 * labeled estimated, and differences beyond one display minor unit raise a
 * review issue.
 */
export function accountProjection(
  ledger: LedgerSnapshot,
  projection: Projection,
): Projection {
  const allocations = apportionBrokerPnl(ledger, projection.allocations);
  const executionByKey = new Map<Id, Execution>(
    ledger.executions.map((execution) => [execution.key, execution]),
  );

  const issues: Issue[] = [...projection.issues];
  const seeIssue = new Set(projection.issues.map((issue) => issue.key));
  const dimensionsByStrategy = new Map<Id, Set<string>>();
  const sourcesByStrategy = new Map<Id, SourceRef[]>();
  for (const allocation of allocations) {
    const execution = executionByKey.get(allocation.executionKey);
    if (execution === undefined) continue;
    const dimensions =
      dimensionsByStrategy.get(allocation.strategyId) ?? new Set<string>();
    dimensions.add(`${execution.account}\u0000${execution.currency}`);
    dimensionsByStrategy.set(allocation.strategyId, dimensions);
    const sources = sourcesByStrategy.get(allocation.strategyId) ?? [];
    sources.push(...execution.sources);
    sourcesByStrategy.set(allocation.strategyId, sources);
  }
  const incompatibleStrategies = new Set(
    [...dimensionsByStrategy]
      .filter(([, dimensions]) => dimensions.size > 1)
      .map(([strategyId]) => strategyId),
  );

  const strategies = projection.strategies.map((strategy) => {
    if (incompatibleStrategies.has(strategy.id)) {
      const issue = makeIssue(
        "INCOMPATIBLE_STRATEGY_MEMBERSHIP",
        sourcesByStrategy.get(strategy.id) ?? [],
        "error",
        strategy.id,
      );
      if (!seeIssue.has(issue.key)) {
        seeIssue.add(issue.key);
        issues.push(issue);
      }
      return {
        ...strategy,
        status: "unresolved" as const,
        complete: false,
        closeDate: null,
        openingAmount: null,
        cashflow: null,
        brokerPnl: null,
        reconstructedPnl: null,
        positions: [],
        reasons: [
          ...new Set([...strategy.reasons, "INCOMPATIBLE_STRATEGY_MEMBERSHIP"]),
        ].sort(),
      };
    }
    const strategyAllocations = allocations.filter(
      (allocation) => allocation.strategyId === strategy.id,
    );
    const amounts = amountsFor(
      ledger,
      strategy,
      strategyAllocations,
      executionByKey,
    );

    if (amounts.reconciliation) {
      const issue = makeIssue("PNL_RECONCILIATION", [], "warning", strategy.id);
      if (!seeIssue.has(issue.key)) {
        seeIssue.add(issue.key);
        issues.push(issue);
      }
    }

    const reasons = new Set(strategy.reasons);
    if (amounts.estimated) reasons.add("ESTIMATED_PNL");

    return {
      ...strategy,
      expiryYear: strategy.expiryYear ?? yearOf(strategy.expiry),
      openingAmount: amounts.openingAmount,
      cashflow: amounts.cashflow,
      brokerPnl: amounts.brokerPnl,
      reconstructedPnl: amounts.reconstructedPnl,
      reasons: [...reasons].sort(),
    };
  });

  return {
    ...projection,
    strategies,
    allocations,
    issues,
  };
}

/**
 * Validates allocation conservation against the source ledger. Any allocation
 * partition that exceeds an execution's signed quantity, contradicts its sign,
 * or over-allocates its cash is a hard error; conflicting or quarantined
 * evidence flags that a definitive combined total is not available. Issue codes
 * are stable machine strings.
 */
export function validateProjection(
  ledger: LedgerSnapshot,
  projection: Projection,
): Issue[] {
  const issues = new Map<string, Issue>();
  const add = (issue: Issue): void => {
    if (!issues.has(issue.key)) issues.set(issue.key, issue);
  };
  for (const issue of projection.issues) {
    if (
      issue.severity === "error" &&
      (issue.code === "INCOMPATIBLE_STRATEGY_MERGE" ||
        issue.code === "INCOMPATIBLE_STRATEGY_MEMBERSHIP")
    ) {
      add(issue);
    }
  }
  const byExecution = indexByExecution(projection.allocations);
  const dimensionsByStrategy = new Map<Id, Set<string>>();
  const sourcesByStrategy = new Map<Id, SourceRef[]>();
  for (const allocation of projection.allocations) {
    const execution = ledger.executions.find(
      (candidate) => candidate.key === allocation.executionKey,
    );
    if (execution === undefined) continue;
    const dimensions =
      dimensionsByStrategy.get(allocation.strategyId) ?? new Set<string>();
    dimensions.add(`${execution.account}\u0000${execution.currency}`);
    dimensionsByStrategy.set(allocation.strategyId, dimensions);
    const sources = sourcesByStrategy.get(allocation.strategyId) ?? [];
    sources.push(...execution.sources);
    sourcesByStrategy.set(allocation.strategyId, sources);
  }
  for (const [strategyId, dimensions] of dimensionsByStrategy) {
    if (dimensions.size <= 1) continue;
    add(
      makeIssue(
        "INCOMPATIBLE_STRATEGY_MEMBERSHIP",
        sourcesByStrategy.get(strategyId) ?? [],
        "error",
        strategyId,
      ),
    );
  }

  for (const execution of ledger.executions) {
    const entries = byExecution.get(execution.key) ?? [];
    if (entries.length === 0) continue;

    let allocatedQuantity = new Decimal(0);
    let allocatedCash = new Decimal(0);
    for (const { allocation } of entries) {
      allocatedQuantity = allocatedQuantity.plus(allocation.quantity);
      allocatedCash = allocatedCash.plus(allocation.netCash);
      const allocationSign = signOf(allocation.quantity);
      const executionSign = signOf(execution.quantity);
      if (
        allocationSign !== 0 &&
        executionSign !== 0 &&
        allocationSign !== executionSign
      ) {
        add(
          makeIssue(
            "ALLOCATION_SIGN_MISMATCH",
            execution.sources,
            "error",
            `${execution.key}:${allocation.strategyId}`,
          ),
        );
      }
    }

    if (allocatedQuantity.abs().gt(new Decimal(execution.quantity).abs())) {
      add(
        makeIssue(
          "ALLOCATION_OVERFLOW",
          execution.sources,
          "error",
          execution.key,
        ),
      );
    }

    const allocatedSign = signOf(canonical(allocatedQuantity));
    const executionSign = signOf(execution.quantity);
    if (
      allocatedSign !== 0 &&
      executionSign !== 0 &&
      allocatedSign !== executionSign
    ) {
      add(
        makeIssue(
          "ALLOCATION_SIGN_MISMATCH",
          execution.sources,
          "error",
          execution.key,
        ),
      );
    }

    const executionCash = new Decimal(execution.netCash);
    const cashTolerance = new Decimal(minorUnit(execution.currency));
    const cashSign = signOf(canonical(allocatedCash));
    const expectedCashSign = signOf(execution.netCash);
    if (allocatedCash.abs().gt(executionCash.abs().plus(cashTolerance))) {
      add(
        makeIssue(
          "ALLOCATION_CASH_MISMATCH",
          execution.sources,
          "error",
          execution.key,
        ),
      );
    } else if (
      cashSign !== 0 &&
      expectedCashSign !== 0 &&
      cashSign !== expectedCashSign
    ) {
      add(
        makeIssue(
          "ALLOCATION_CASH_MISMATCH",
          execution.sources,
          "error",
          execution.key,
        ),
      );
    }
  }

  if (ledger.conflicts > 0) {
    add(makeIssue("CONFLICTING_EVIDENCE", [], "error", ledger.id));
  }
  if (ledger.issues.some((issue) => issue.severity === "error")) {
    add(makeIssue("QUARANTINED_EVIDENCE", [], "warning", ledger.id));
  }

  return [...issues.values()].sort((left, right) =>
    left.key < right.key ? -1 : 1,
  );
}
