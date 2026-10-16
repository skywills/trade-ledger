import { Decimal } from "decimal.js";
import type {
  Allocation,
  Decision,
  Execution,
  Id,
  Issue,
  LedgerSnapshot,
  Projection,
  SourceRef,
  Strategy,
} from "../../shared/domain.js";
import {
  isClosingEvent,
  looksLikeBookedEvent,
  validateLifecycle,
} from "./lifecycle.js";
import {
  isDerivative,
  remainingCompatible,
  sameInstrument,
} from "./matching.js";
import {
  addLeg,
  emptyDraft,
  finalizeDraft,
  legOf,
  makeIssue,
  pushDraftIssue,
  recomputePresentation,
  type StrategyDraft,
} from "./projection.js";

export type ResolveId = (account: string, keys: string[]) => Id;

interface Link {
  from: Id;
  to: Id;
  type: string;
  sources: SourceRef[];
}

interface MergeInstruction {
  chosen: Id;
  merged: Id[];
}

interface LifecycleInstruction {
  event: string;
  source: SourceRef;
  target: SourceRef;
  sources: SourceRef[];
}

function sourceKey(source: SourceRef): string {
  return `${source.importId}:${source.rowNumber}`;
}

function roleOf(execution: Execution): "open" | "close" {
  if (execution.event === "unsupported") return "close";
  if (execution.action === "open") return "open";
  if (execution.action === "close") return "close";
  if (execution.action === "mixed") return "close";
  if (isClosingEvent(execution.event)) return "close";
  if (looksLikeBookedEvent(execution)) return "close";
  return "open";
}

function orderKeyOf(execution: Execution): string {
  return (
    execution.brokerIds.BrokerageOrderID ??
    execution.brokerIds.IBOrderID ??
    `exec:${execution.key}`
  );
}

function groupKeyOf(execution: Execution): string {
  return `${execution.account}\u0000${execution.currency}\u0000${orderKeyOf(execution)}`;
}

function sortedByKey(executions: readonly Execution[]): Execution[] {
  return [...executions].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
}

/** Compares executions only when their available provenance makes order safe. */
function compareExecutionTime(
  left: Execution,
  right: Execution,
): number | null {
  const sharesImport = left.sources.some((leftSource) =>
    right.sources.some(
      (rightSource) => rightSource.importId === leftSource.importId,
    ),
  );
  const sameKnownTimezone =
    left.timezone !== null &&
    right.timezone !== null &&
    left.timezone === right.timezone;
  const sameUnzonedReport =
    left.timezone === null && right.timezone === null && sharesImport;
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/.test(left.rawDateTime) ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/.test(right.rawDateTime)
  ) {
    return null;
  }
  if (!sameKnownTimezone && !sameUnzonedReport) {
    const leftDay = Date.parse(`${left.date}T00:00:00Z`);
    const rightDay = Date.parse(`${right.date}T00:00:00Z`);
    const dayGap = Math.abs(rightDay - leftDay) / 86_400_000;
    // Legal timezone offsets span at most 26 hours. A three-day calendar gap
    // keeps relative order certain without assigning either row a time zone.
    if (dayGap > 2) return left.date < right.date ? -1 : 1;
    return null;
  }
  if (
    (!left.rawDateTime.includes("T") || !right.rawDateTime.includes("T")) &&
    left.date === right.date
  ) {
    return null;
  }
  return left.rawDateTime < right.rawDateTime
    ? -1
    : left.rawDateTime > right.rawDateTime
      ? 1
      : 0;
}

/**
 * Simultaneous, untouched single-leg lots with identical economics are
 * interchangeable for a whole-lot trade close. Break that tie by execution
 * key, never by a generated strategy ID or by assuming broker IDs encode time.
 */
function equivalentOpeningLot(
  candidates: readonly StrategyDraft[],
  close: Execution,
  closeQuantity: string,
  executionByKey: ReadonlyMap<Id, Execution>,
): StrategyDraft | undefined {
  if (close.event !== "trade" || close.action !== "close") return undefined;
  const hasLotReference = (execution: Execution): boolean =>
    ["OrigTradeID", "RelatedTradeID", "PositionActionID"].some((key) => {
      const value = execution.brokerIds[key]?.trim();
      return value !== undefined && value !== "" && value !== "0";
    });
  if (hasLotReference(close)) return undefined;
  const lots: { draft: StrategyDraft; opening: Execution }[] = [];
  for (const draft of candidates) {
    if (draft.unresolved || draft.blocking || draft.issues.length > 0)
      return undefined;
    const leg = draft.legs[0];
    if (draft.legs.length !== 1 || leg?.role !== "open") return undefined;
    const opening = executionByKey.get(leg.executionKey);
    if (
      opening === undefined ||
      opening.event !== "trade" ||
      opening.action !== "open" ||
      opening.price === null ||
      hasLotReference(opening) ||
      !new Decimal(leg.quantity).eq(opening.quantity) ||
      !new Decimal(leg.netCash).eq(opening.netCash) ||
      !new Decimal(leg.quantity).abs().eq(new Decimal(closeQuantity).abs())
    )
      return undefined;
    lots.push({ draft, opening });
  }
  // A weak instrument can match either of two conflicting known contracts;
  // it must not make those contracts equivalent to one another.
  const knownContracts = new Set(
    lots
      .map(({ opening }) => opening.instrument.conid)
      .filter((conid) => conid !== null),
  );
  if (knownContracts.size > 1) return undefined;
  const first = lots[0]?.opening;
  if (first === undefined) return undefined;
  const sameDecimal = (left: string | null, right: string | null): boolean =>
    left === null || right === null
      ? left === right
      : new Decimal(left).eq(right);
  if (
    close.basis !== null &&
    first.basis !== null &&
    !new Decimal(close.basis).abs().eq(new Decimal(first.basis).abs())
  )
    return undefined;
  for (const { opening } of lots) {
    if (
      compareExecutionTime(first, opening) !== 0 ||
      !sameInstrument(first.instrument, opening.instrument) ||
      !sameDecimal(
        first.instrument.multiplier,
        opening.instrument.multiplier,
      ) ||
      !sameDecimal(first.quantity, opening.quantity) ||
      !sameDecimal(first.price, opening.price) ||
      !sameDecimal(first.netCash, opening.netCash) ||
      !sameDecimal(first.basis, opening.basis) ||
      !sameDecimal(first.proceeds, opening.proceeds) ||
      !sameDecimal(first.commission, opening.commission) ||
      !sameDecimal(first.taxes, opening.taxes) ||
      !sameDecimal(first.brokerPnl, opening.brokerPnl)
    )
      return undefined;
  }
  return lots.sort((left, right) =>
    left.opening.key < right.opening.key ? -1 : 1,
  )[0]?.draft;
}

/**
 * Orders known chronological constraints without treating uncertain pairs as
 * pairwise key comparisons. A stable topological ordering is transitive even
 * when some executions cannot be compared safely.
 */
function orderByKnownChronology(executions: readonly Execution[]): Execution[] {
  const indegree = new Map<string, number>();
  for (const execution of executions) {
    indegree.set(execution.key, 0);
  }

  const precedes = (left: Execution, right: Execution): boolean => {
    const chronology = compareExecutionTime(left, right);
    if (chronology === null) return false;
    return chronology === 0 ? left.key < right.key : chronology < 0;
  };

  // Count incoming constraints without retaining the pairwise graph. The
  // quadratic comparison cost is bounded by the close count, while auxiliary
  // memory stays linear instead of growing with the number of comparable pairs.
  for (let leftIndex = 0; leftIndex < executions.length; leftIndex += 1) {
    const left = executions[leftIndex];
    if (left === undefined) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < executions.length;
      rightIndex += 1
    ) {
      const right = executions[rightIndex];
      if (right === undefined) continue;
      if (precedes(left, right)) {
        indegree.set(right.key, (indegree.get(right.key) ?? 0) + 1);
      } else if (precedes(right, left)) {
        indegree.set(left.key, (indegree.get(left.key) ?? 0) + 1);
      }
    }
  }

  const byKey = new Map(
    executions.map((execution) => [execution.key, execution]),
  );
  const ready: string[] = [];
  const pushReady = (key: string): void => {
    let index = ready.length;
    ready.push(key);
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = ready[parentIndex];
      if (parent === undefined || parent <= key) break;
      ready[index] = parent;
      index = parentIndex;
    }
    ready[index] = key;
  };
  const popReady = (): string | undefined => {
    const first = ready[0];
    const last = ready.pop();
    if (first === undefined || last === undefined || ready.length === 0)
      return first;
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      if (leftIndex >= ready.length) break;
      const rightIndex = leftIndex + 1;
      const childIndex =
        rightIndex < ready.length &&
        (ready[rightIndex] ?? "") < (ready[leftIndex] ?? "")
          ? rightIndex
          : leftIndex;
      const child = ready[childIndex];
      if (child === undefined || child >= last) break;
      ready[index] = child;
      index = childIndex;
    }
    ready[index] = last;
    return first;
  };
  for (const execution of executions) {
    if (indegree.get(execution.key) === 0) pushReady(execution.key);
  }
  const pending = new Set(executions.map((execution) => execution.key));
  const ordered: Execution[] = [];
  while (ready.length > 0) {
    const key = popReady();
    if (key === undefined) continue;
    const execution = byKey.get(key);
    if (execution !== undefined) ordered.push(execution);
    pending.delete(key);
    if (execution === undefined) continue;
    for (const next of pending) {
      const nextExecution = byKey.get(next);
      if (nextExecution === undefined || !precedes(execution, nextExecution))
        continue;
      const nextIndegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) pushReady(next);
    }
  }

  // Pairwise time evidence should be acyclic. In case malformed provenance
  // ever creates a cycle, keep the entire close set deterministic and let the
  // exposure guard below prevent a consumed opening from being reused.
  return ordered.length === executions.length
    ? ordered
    : sortedByKey(executions);
}

function lifecycleEventFor(group: readonly Execution[]): string {
  for (const event of ["assignment", "exercise", "expiry", "cash_settlement"]) {
    if (group.some((execution) => execution.event === event)) return event;
  }
  return "assignment";
}

/**
 * Pure, synchronous, in-memory grouping of a normalized ledger plus retained
 * effective decisions into a strategy projection. BrokerageOrderID proposes
 * opening groups; lot evidence, unique compatible exposure, and economically
 * equivalent simultaneous lots resolve closes; other ambiguities require decisions.
 * Lifecycle and roll links are recorded without merging P/L. Financial amounts and persistence belong to later tasks.
 */
export function groupStrategies(
  ledger: LedgerSnapshot,
  decisions: readonly Decision[],
  resolveId: ResolveId,
): Projection {
  const orderedDecisions = [...decisions].sort((left, right) =>
    left.sequence !== right.sequence
      ? left.sequence - right.sequence
      : left.id < right.id
        ? -1
        : 1,
  );

  const executionByKey = new Map<Id, Execution>();
  const executionBySource = new Map<string, Execution>();
  for (const execution of ledger.executions) {
    executionByKey.set(execution.key, execution);
    for (const source of execution.sources) {
      executionBySource.set(sourceKey(source), execution);
    }
  }

  const issues = new Map<string, Issue>();
  const addIssue = (issue: Issue): void => {
    if (!issues.has(issue.key)) issues.set(issue.key, issue);
  };

  const drafts = new Map<Id, StrategyDraft>();
  const draftFor = (
    id: Id,
    account: string,
    currency: string,
    sources: SourceRef[] = [],
  ): StrategyDraft => {
    const existing = drafts.get(id);
    if (existing !== undefined) {
      if (existing.account !== account || existing.currency !== currency) {
        const splitId = `${id}\u0000incompatible\u0000${account}\u0000${currency}`;
        const split = drafts.get(splitId);
        if (split !== undefined) return split;
        const incompatible = emptyDraft(splitId);
        incompatible.account = account;
        incompatible.currency = currency;
        incompatible.unresolved = true;
        incompatible.blocking = true;
        incompatible.complete = false;
        const issue = makeIssue(
          "INCOMPATIBLE_STRATEGY_MEMBERSHIP",
          sources,
          "error",
          `${id}:${account}:${currency}`,
        );
        pushDraftIssue(incompatible, issue);
        addIssue(issue);
        drafts.set(splitId, incompatible);
        return incompatible;
      }
      if (existing.account === "") existing.account = account;
      if (existing.currency === "") existing.currency = currency;
      return existing;
    }
    const draft = emptyDraft(id);
    draft.account = account;
    draft.currency = currency;
    drafts.set(id, draft);
    return draft;
  };

  interface Consumption {
    quantity: Decimal;
    netCash: Decimal;
    brokerPnl: Decimal;
  }
  const consumed = new Map<Id, Consumption>();
  const consumptionOf = (key: Id): Consumption =>
    consumed.get(key) ?? {
      quantity: new Decimal(0),
      netCash: new Decimal(0),
      brokerPnl: new Decimal(0),
    };
  const recordConsumption = (
    execution: Execution,
    quantity: string,
    netCash: string,
    brokerPnl: string | null,
  ): void => {
    const current = consumptionOf(execution.key);
    consumed.set(execution.key, {
      quantity: current.quantity.plus(quantity),
      netCash: current.netCash.plus(netCash),
      brokerPnl: current.brokerPnl.plus(brokerPnl ?? 0),
    });
  };
  /** Signed units of an execution still available for automatic matching. */
  const availableOf = (execution: Execution): Decimal => {
    const total = new Decimal(execution.quantity);
    const residual = total.minus(consumptionOf(execution.key).quantity);
    if (total.isZero() || residual.isZero()) return new Decimal(0);
    if (residual.isNegative() !== total.isNegative()) return new Decimal(0);
    return residual;
  };
  const residualNetCash = (execution: Execution): string =>
    new Decimal(execution.netCash)
      .minus(consumptionOf(execution.key).netCash)
      .toFixed();
  const residualBrokerPnl = (execution: Execution): string | null => {
    if (execution.brokerPnl === null) return null;
    return new Decimal(execution.brokerPnl)
      .minus(consumptionOf(execution.key).brokerPnl)
      .toFixed();
  };

  interface Binding {
    strategyId: Id;
    execution: Execution;
    /** Null quantity means bind the execution's whole remaining units. */
    quantity: string | null;
    netCash: string | null;
    brokerPnl: string | null;
  }
  const bindings: Binding[] = [];
  const merges: MergeInstruction[] = [];
  const lifecycles: LifecycleInstruction[] = [];
  for (const decision of orderedDecisions) {
    const payload = decision.payload;
    switch (decision.kind) {
      case "manual_allocation": {
        const strategyId =
          typeof payload.strategyId === "string"
            ? payload.strategyId
            : undefined;
        if (strategyId === undefined) continue;
        const source = payload.source as SourceRef | undefined;
        const entries = Array.isArray(payload.allocations)
          ? (payload.allocations as Array<Record<string, unknown>>)
          : [];
        for (const entry of entries) {
          const executionKey =
            typeof entry.executionKey === "string"
              ? entry.executionKey
              : undefined;
          const execution =
            (executionKey !== undefined
              ? executionByKey.get(executionKey)
              : undefined) ??
            (source !== undefined
              ? executionBySource.get(sourceKey(source))
              : undefined);
          if (execution === undefined) continue;
          bindings.push({
            strategyId,
            execution,
            quantity:
              typeof entry.quantity === "string"
                ? entry.quantity
                : execution.quantity,
            netCash:
              typeof entry.netCash === "string"
                ? entry.netCash
                : execution.netCash,
            brokerPnl:
              entry.brokerPnl === null
                ? null
                : typeof entry.brokerPnl === "string"
                  ? entry.brokerPnl
                  : execution.brokerPnl,
          });
        }
        break;
      }
      case "group_explicit": {
        const strategyId =
          typeof payload.strategyId === "string"
            ? payload.strategyId
            : undefined;
        const source = payload.source as SourceRef | undefined;
        if (strategyId === undefined || source === undefined) continue;
        const execution = executionBySource.get(sourceKey(source));
        if (execution === undefined) continue;
        bindings.push({
          strategyId,
          execution,
          quantity: null,
          netCash: null,
          brokerPnl: null,
        });
        break;
      }
      case "group_merge": {
        const chosen =
          typeof payload.chosenStrategyId === "string"
            ? payload.chosenStrategyId
            : undefined;
        const merged = Array.isArray(payload.mergedStrategyIds)
          ? payload.mergedStrategyIds.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        if (chosen !== undefined && merged.length > 0) {
          merges.push({ chosen, merged });
        }
        break;
      }
      case "group_split": {
        // A retained split is never applied to the projection yet: the payload
        // carries parent/child identities but no parent-to-child allocation
        // mapping, so a deterministic split is impossible. Surface it as a
        // review item rather than silently ignoring the decision.
        const parent =
          typeof payload.parentStrategyId === "string"
            ? payload.parentStrategyId
            : undefined;
        if (parent === undefined) continue;
        addIssue(makeIssue("SPLIT_NOT_APPLIED", [], "warning", parent));
        break;
      }
      case "lifecycle": {
        const event =
          typeof payload.event === "string" ? payload.event : undefined;
        const sourceRef = payload.sourceRef as SourceRef | undefined;
        const targetRef = payload.targetRef as SourceRef | undefined;
        if (
          event !== undefined &&
          sourceRef !== undefined &&
          targetRef !== undefined
        ) {
          lifecycles.push({
            event,
            source: sourceRef,
            target: targetRef,
            sources: decision.sources,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // 1. Retained manual/explicit allocations are applied before automatic
  //    matching. Each decision row contributes its own signed quantity and
  //    cash, so a partial row reserves only its share and the execution's
  //    remainder stays available for automatic matching. A second retained
  //    allocation targeting the same execution+strategy+role is a duplicate:
  //    it is deduplicated and surfaced as a review issue rather than being
  //    applied twice (which would double exposure and could hard-fail a build).
  const appliedBindingKeys = new Set<string>();
  for (const binding of bindings) {
    const { execution } = binding;
    const role = roleOf(execution);
    const bindingKey = `${binding.strategyId}\u0000${execution.key}\u0000${role}`;
    if (appliedBindingKeys.has(bindingKey)) {
      addIssue(
        makeIssue(
          "DUPLICATE_ALLOCATION",
          execution.sources,
          "warning",
          binding.strategyId,
        ),
      );
      continue;
    }
    appliedBindingKeys.add(bindingKey);
    if (binding.quantity === null) {
      const residualQuantity = availableOf(execution);
      if (residualQuantity.isZero()) continue;
      const quantity = residualQuantity.toFixed();
      const netCash = residualNetCash(execution);
      const brokerPnl = residualBrokerPnl(execution);
      const draft = draftFor(
        binding.strategyId,
        execution.account,
        execution.currency,
        execution.sources,
      );
      addLeg(draft, legOf(execution, role, { quantity, netCash, brokerPnl }));
      recordConsumption(execution, quantity, netCash, brokerPnl);
      continue;
    }
    const netCash = binding.netCash ?? execution.netCash;
    const draft = draftFor(
      binding.strategyId,
      execution.account,
      execution.currency,
      execution.sources,
    );
    addLeg(
      draft,
      legOf(execution, role, {
        quantity: binding.quantity,
        netCash,
        brokerPnl: binding.brokerPnl,
      }),
    );
    recordConsumption(execution, binding.quantity, netCash, binding.brokerPnl);
  }

  // 2. Opening groups proposed by the broker order identity. A partially
  //    allocated execution contributes only its residual units.
  const openingGroups = new Map<string, Execution[]>();
  for (const execution of sortedByKey(ledger.executions)) {
    if (execution.event === "unsupported") continue;
    if (roleOf(execution) !== "open") continue;
    if (availableOf(execution).isZero()) continue;
    const key = groupKeyOf(execution);
    const group = openingGroups.get(key) ?? [];
    group.push(execution);
    openingGroups.set(key, group);
  }
  const orderOpenings = new Map<string, Id>();
  for (const key of [...openingGroups.keys()].sort()) {
    const group = sortedByKey(openingGroups.get(key) ?? []);
    const first = group[0];
    if (first === undefined) continue;
    const id = resolveId(
      first.account,
      group.map((execution) => execution.key),
    );
    const draft = draftFor(
      id,
      first.account,
      first.currency,
      group.flatMap((execution) => execution.sources),
    );
    for (const execution of group) {
      const quantity = availableOf(execution).toFixed();
      const netCash = residualNetCash(execution);
      const brokerPnl = residualBrokerPnl(execution);
      addLeg(draft, legOf(execution, "open", { quantity, netCash, brokerPnl }));
      recordConsumption(execution, quantity, netCash, brokerPnl);
    }
    orderOpenings.set(groupKeyOf(first), id);
  }

  // 3. Unsupported corporate actions block definitive exposure and closure.
  for (const execution of ledger.executions) {
    if (execution.event !== "unsupported") continue;
    let matched = false;
    for (const draft of drafts.values()) {
      if (draft.account !== execution.account) continue;
      if (
        !draft.legs.some((leg) =>
          sameInstrument(leg.instrument, execution.instrument),
        )
      ) {
        continue;
      }
      draft.unresolved = true;
      draft.blocking = true;
      pushDraftIssue(
        draft,
        makeIssue(
          "UNSUPPORTED_INVENTORY",
          execution.sources,
          "warning",
          execution.key,
        ),
      );
      matched = true;
    }
    if (!matched) {
      const id = resolveId(execution.account, [execution.key]);
      const draft = draftFor(
        id,
        execution.account,
        execution.currency,
        execution.sources,
      );
      addLeg(draft, legOf(execution, "close"));
      recordConsumption(
        execution,
        execution.quantity,
        execution.netCash,
        execution.brokerPnl,
      );
      draft.unresolved = true;
      draft.blocking = true;
      draft.complete = false;
      pushDraftIssue(
        draft,
        makeIssue(
          "UNSUPPORTED_INVENTORY",
          execution.sources,
          "warning",
          execution.key,
        ),
      );
    }
  }

  // 4. Closes are matched to known openings by contract, lot evidence, and
  //    a unique compatible remaining position. Only the residual of a
  //    partially allocated execution is auto-matched; ambiguity or a missing
  //    opening becomes an unresolved review item rather than an invented match.
  const closeExecutions = ledger.executions.filter(
    (execution) =>
      execution.event !== "unsupported" &&
      roleOf(execution) === "close" &&
      !availableOf(execution).isZero(),
  );
  const orderedCloseExecutions = orderByKnownChronology(closeExecutions);
  for (const close of orderedCloseExecutions) {
    const closeQuantity = availableOf(close).toFixed();
    let candidates = [...drafts.values()].filter((draft) => {
      if (
        draft.account !== close.account ||
        draft.currency !== close.currency
      ) {
        return false;
      }
      let exposure = new Decimal(0);
      const futureOpenings: { execution: Execution; quantity: Decimal }[] = [];
      const futureCloses: { execution: Execution; quantity: Decimal }[] = [];
      const uncertainFutureCloses: Decimal[] = [];
      let sawOpening = false;
      for (const leg of draft.legs) {
        if (!sameInstrument(leg.instrument, close.instrument)) continue;
        const related = executionByKey.get(leg.executionKey);
        if (related === undefined) return false;
        if (leg.role === "close") {
          const chronological = compareExecutionTime(related, close);
          const tiedEarlierClose =
            chronological === 0 && related.key <= close.key;
          if (
            chronological !== null &&
            (chronological < 0 || tiedEarlierClose)
          ) {
            exposure = exposure.plus(leg.quantity);
          } else if (
            chronological !== null &&
            (chronological > 0 || related.key > close.key)
          ) {
            futureCloses.push({
              execution: related,
              quantity: new Decimal(leg.quantity),
            });
          } else {
            // A later or uncertain assigned/matched close reserves capacity,
            // but cannot create historical exposure with the opposite sign.
            uncertainFutureCloses.push(new Decimal(leg.quantity));
          }
          continue;
        }
        const chronological = compareExecutionTime(related, close);
        // Different time zones or date-only values on the same day leave
        // ordering uncertain. A shared unzoned report provides a common
        // wall-clock basis without claiming an absolute instant.
        if (chronological === null) return false;
        const tiedLifecycleEvent =
          chronological === 0 && leg.role === "open" && close.event !== "trade";
        if (chronological > 0 || (chronological === 0 && !tiedLifecycleEvent)) {
          if (chronological > 0) {
            futureOpenings.push({
              execution: related,
              quantity: new Decimal(leg.quantity),
            });
          }
          continue;
        }
        exposure = exposure.plus(leg.quantity);
        if (leg.role === "open") sawOpening = true;
      }
      if (
        !sawOpening ||
        !remainingCompatible(exposure.toFixed(), closeQuantity)
      )
        return false;
      const reservesCurrentExposure = (quantity: Decimal): boolean =>
        quantity.isNegative() !== exposure.isNegative();
      const uncertainReservation = uncertainFutureCloses.reduce(
        (sum, quantity) => {
          return quantity.isNegative() !== exposure.isNegative()
            ? sum.plus(quantity.abs())
            : sum;
        },
        new Decimal(0),
      );
      let knownReservation = new Decimal(0);

      for (const target of futureCloses) {
        if (!reservesCurrentExposure(target.quantity)) continue;
        let cumulativeFutureDemand = new Decimal(0);
        for (const candidate of futureCloses) {
          if (!reservesCurrentExposure(candidate.quantity)) continue;
          const chronology = compareExecutionTime(
            candidate.execution,
            target.execution,
          );
          const precedesOrUnknown =
            candidate.execution.key === target.execution.key ||
            chronology === null ||
            chronology < 0 ||
            (chronology === 0 &&
              candidate.execution.key < target.execution.key);
          if (precedesOrUnknown) {
            cumulativeFutureDemand = cumulativeFutureDemand.plus(
              candidate.quantity.abs(),
            );
          }
        }
        const replenishmentBeforeTarget = futureOpenings.reduce(
          (sum, opening) => {
            if (opening.quantity.isNegative() !== exposure.isNegative()) {
              return sum;
            }
            return compareExecutionTime(opening.execution, target.execution) ===
              -1
              ? sum.plus(opening.quantity.abs())
              : sum;
          },
          new Decimal(0),
        );
        const deficit = cumulativeFutureDemand.minus(replenishmentBeforeTarget);
        if (deficit.gt(knownReservation)) knownReservation = deficit;
      }
      return exposure
        .abs()
        .minus(uncertainReservation.plus(knownReservation))
        .gte(new Decimal(closeQuantity).abs());
    });

    const lot = ledger.lots.find(
      (row) =>
        (row.fields["TradeID"] ?? "").trim() !== "" &&
        (row.fields["TradeID"] ?? "").trim() ===
          (close.brokerIds.TradeID ?? ""),
    );
    if (lot !== undefined) {
      const opened = (lot.fields["OpenDateTime"] ?? "").trim().slice(0, 10);
      if (opened !== "") {
        const narrowed = candidates.filter((draft) =>
          draft.openingLegs.some((leg) => leg.date === opened),
        );
        if (narrowed.length > 0) candidates = narrowed;
      }
    }

    if (candidates.length > 1 && lot === undefined) {
      const equivalent = equivalentOpeningLot(
        candidates,
        close,
        closeQuantity,
        executionByKey,
      );
      if (equivalent !== undefined) candidates = [equivalent];
    }

    if (candidates.length === 1) {
      const target = candidates[0];
      if (target !== undefined) {
        const netCash = residualNetCash(close);
        const brokerPnl = residualBrokerPnl(close);
        addLeg(
          target,
          legOf(close, "close", {
            quantity: closeQuantity,
            netCash,
            brokerPnl,
          }),
        );
        recordConsumption(close, closeQuantity, netCash, brokerPnl);
        continue;
      }
    }

    if (candidates.length > 1) {
      addIssue(
        makeIssue("AMBIGUOUS_CLOSE", close.sources, "warning", close.key),
      );
    } else {
      addIssue(
        makeIssue("MISSING_OPENING", close.sources, "warning", close.key),
      );
    }
    const id = resolveId(close.account, [close.key]);
    const draft = draftFor(id, close.account, close.currency, close.sources);
    const netCash = residualNetCash(close);
    const brokerPnl = residualBrokerPnl(close);
    addLeg(
      draft,
      legOf(close, "close", { quantity: closeQuantity, netCash, brokerPnl }),
    );
    recordConsumption(close, closeQuantity, netCash, brokerPnl);
    draft.unresolved = true;
    draft.complete = false;
    if (
      candidates.length === 0 &&
      close.brokerIds.PositionActionID === undefined &&
      looksLikeBookedEvent(close)
    ) {
      pushDraftIssue(
        draft,
        makeIssue("LIFECYCLE_UNRESOLVED", close.sources, "warning", close.key),
      );
    }
  }

  const strategyOfExecution = new Map<Id, Id>();
  for (const draft of drafts.values()) {
    for (const allocation of draft.allocations) {
      strategyOfExecution.set(allocation.executionKey, draft.id);
    }
  }

  const links: Link[] = [];
  const linkKeys = new Set<string>();
  const addLink = (
    from: Id,
    to: Id,
    type: string,
    sources: SourceRef[],
  ): void => {
    if (from === to) return;
    const key = `${from}|${to}|${type}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push({ from, to, type, sources });
  };

  // 5. Assignment/exercise links from the retained PositionActionID.
  const byAction = new Map<string, Execution[]>();
  for (const execution of ledger.executions) {
    const actionId = execution.brokerIds.PositionActionID;
    if (actionId === undefined) continue;
    const group = byAction.get(actionId) ?? [];
    group.push(execution);
    byAction.set(actionId, group);
  }
  for (const actionId of [...byAction.keys()].sort()) {
    const group = sortedByKey(byAction.get(actionId) ?? []);
    const option = group.find((execution) =>
      isDerivative(execution.instrument),
    );
    const stock = group.find(
      (execution) => !isDerivative(execution.instrument),
    );
    if (option === undefined || stock === undefined) continue;
    const event = lifecycleEventFor(group);
    const issue = validateLifecycle(event, option, stock);
    if (issue !== null) {
      addIssue(issue);
      continue;
    }
    const from = strategyOfExecution.get(option.key);
    const to = strategyOfExecution.get(stock.key);
    if (from === undefined || to === undefined) continue;
    addLink(from, to, event, [...option.sources, ...stock.sources]);
  }

  // 6. User lifecycle corrections, validated before linking.
  for (const instruction of lifecycles) {
    const source = executionBySource.get(sourceKey(instruction.source));
    const target = executionBySource.get(sourceKey(instruction.target));
    if (source === undefined || target === undefined) {
      addIssue(
        makeIssue(
          "LIFECYCLE_INCONSISTENT",
          instruction.sources,
          "error",
          `${sourceKey(instruction.source)}:missing`,
        ),
      );
      continue;
    }
    const issue = validateLifecycle(instruction.event, source, target);
    if (issue !== null) {
      addIssue(issue);
      continue;
    }
    const from =
      strategyOfExecution.get(source.key) ??
      resolveId(source.account, [source.key]);
    const to =
      strategyOfExecution.get(target.key) ??
      resolveId(target.account, [target.key]);
    addLink(from, to, instruction.event, [
      ...source.sources,
      ...target.sources,
    ]);
  }

  // 7. Rolls: an order holding both a close and an open leg links the two
  //    episodes without merging their allocations or P/L.
  const orderCloses = new Map<string, Id>();
  for (const close of orderedCloseExecutions) {
    const key = groupKeyOf(close);
    if (!orderOpenings.has(key)) continue;
    const closeDraftId = strategyOfExecution.get(close.key);
    if (closeDraftId !== undefined) orderCloses.set(key, closeDraftId);
  }
  for (const key of [...orderCloses.keys()].sort()) {
    const openDraftId = orderOpenings.get(key);
    const closeDraftId = orderCloses.get(key);
    if (openDraftId === undefined || closeDraftId === undefined) continue;
    const sources = ledger.executions
      .filter((execution) => groupKeyOf(execution) === key)
      .flatMap((execution) => execution.sources);
    addLink(closeDraftId, openDraftId, "roll", sources);
  }

  // 8. User merges change presentation only: every allocation stays unique.
  const remap = new Map<Id, Id>();
  for (const { chosen, merged } of merges) {
    for (const mergedId of merged) {
      const sourceDraft = drafts.get(mergedId);
      if (sourceDraft === undefined) continue;
      const chosenDraft = drafts.get(chosen);
      if (
        chosenDraft !== undefined &&
        (chosenDraft.account !== sourceDraft.account ||
          chosenDraft.currency !== sourceDraft.currency)
      ) {
        const issue = makeIssue(
          "INCOMPATIBLE_STRATEGY_MERGE",
          [...sourceDraft.legs, ...chosenDraft.legs].flatMap(
            (leg) => leg.sources,
          ),
          "error",
          `${chosen}:${mergedId}`,
        );
        addIssue(issue);
        pushDraftIssue(chosenDraft, issue);
        pushDraftIssue(sourceDraft, issue);
        continue;
      }
      remap.set(mergedId, chosen);
    }
  }
  const finalId = (id: Id): Id => {
    let current = id;
    const seen = new Set<Id>();
    while (remap.has(current) && !seen.has(current)) {
      seen.add(current);
      current = remap.get(current) ?? current;
    }
    return current;
  };

  // Validate each transitive merge target before consolidating any amounts.
  // A retained decision can name a chosen ID that has no current draft, so
  // checking only the immediate chosen/merged pair is not sufficient.
  const draftsByMergeTarget = new Map<Id, StrategyDraft[]>();
  for (const draft of drafts.values()) {
    const targetId = finalId(draft.id);
    const group = draftsByMergeTarget.get(targetId) ?? [];
    group.push(draft);
    draftsByMergeTarget.set(targetId, group);
  }
  const safeTargets = new Map<Id, Id>();
  for (const [targetId, group] of draftsByMergeTarget) {
    const dimensions = new Set(
      group.map((draft) => `${draft.account}\u0000${draft.currency}`),
    );
    if (dimensions.size <= 1) {
      for (const draft of group) safeTargets.set(draft.id, targetId);
      continue;
    }
    const issue = makeIssue(
      "INCOMPATIBLE_STRATEGY_MERGE",
      group.flatMap((draft) => draft.legs.flatMap((leg) => leg.sources)),
      "error",
      targetId,
    );
    addIssue(issue);
    for (const draft of group) {
      safeTargets.set(draft.id, draft.id);
      pushDraftIssue(draft, issue);
    }
  }
  const safeFinalId = (id: Id): Id => safeTargets.get(id) ?? finalId(id);

  const consolidated = new Map<Id, StrategyDraft>();
  for (const draft of drafts.values()) {
    const targetId = safeFinalId(draft.id);
    let container = consolidated.get(targetId);
    if (container === undefined) {
      container = emptyDraft(targetId);
      consolidated.set(targetId, container);
    }
    if (container.account === "") container.account = draft.account;
    if (container.currency === "") container.currency = draft.currency;
    container.legs.push(...draft.legs);
    container.openingLegs.push(...draft.openingLegs);
    for (const allocation of draft.allocations) {
      container.allocations.push({ ...allocation, strategyId: targetId });
    }
    for (const issue of draft.issues) pushDraftIssue(container, issue);
    container.unresolved = container.unresolved || draft.unresolved;
    container.blocking = container.blocking || draft.blocking;
    container.complete = container.complete && draft.complete;
    if (
      draft.openingDate !== null &&
      (container.openingDate === null ||
        draft.openingDate < container.openingDate)
    ) {
      container.openingDate = draft.openingDate;
    }
  }

  const finalLinks: Link[] = [];
  const finalLinkKeys = new Set<string>();
  for (const link of links) {
    const from = safeFinalId(link.from);
    const to = safeFinalId(link.to);
    if (from === to) continue;
    const key = `${from}|${to}|${link.type}`;
    if (finalLinkKeys.has(key)) continue;
    finalLinkKeys.add(key);
    finalLinks.push({ from, to, type: link.type, sources: link.sources });
  }

  const strategies: Strategy[] = [];
  for (const draft of [...consolidated.values()].sort((left, right) =>
    left.id < right.id ? -1 : 1,
  )) {
    recomputePresentation(draft);
    strategies.push(finalizeDraft(draft));
    for (const issue of draft.issues) addIssue(issue);
  }

  const allocations: Allocation[] = [...consolidated.values()]
    .flatMap((draft) => draft.allocations)
    .sort((left, right) =>
      `${left.strategyId}|${left.executionKey}` <
      `${right.strategyId}|${right.executionKey}`
        ? -1
        : 1,
    );

  const watermark = orderedDecisions.reduce(
    (max, decision) => Math.max(max, decision.sequence),
    0,
  );

  return {
    ledgerId: ledger.id,
    watermark,
    strategies,
    allocations,
    links: finalLinks,
    issues: [...issues.values()].sort((left, right) =>
      left.key < right.key ? -1 : 1,
    ),
  };
}
