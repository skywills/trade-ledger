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

function remainingFor(
  draft: StrategyDraft,
  instrument: Execution["instrument"],
): string {
  let total = new Decimal(0);
  for (const leg of draft.legs) {
    if (sameInstrument(leg.instrument, instrument)) {
      total = total.plus(leg.quantity);
    }
  }
  return total.toFixed();
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
 * opening groups; lot evidence and unique compatible exposure resolve closes;
 * ambiguous matches require decisions; lifecycle and roll links are recorded
 * without merging P/L. Financial amounts and persistence belong to later tasks.
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
  ): StrategyDraft => {
    const existing = drafts.get(id);
    if (existing !== undefined) {
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
    const draft = draftFor(id, first.account, first.currency);
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
      const draft = draftFor(id, execution.account, execution.currency);
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
  const closeExecutions = sortedByKey(
    ledger.executions.filter(
      (execution) =>
        execution.event !== "unsupported" &&
        roleOf(execution) === "close" &&
        !availableOf(execution).isZero(),
    ),
  );
  for (const close of closeExecutions) {
    const closeQuantity = availableOf(close).toFixed();
    let candidates = [...drafts.values()].filter(
      (draft) =>
        draft.account === close.account &&
        draft.currency === close.currency &&
        draft.legs.some(
          (leg) =>
            sameInstrument(leg.instrument, close.instrument) &&
            remainingCompatible(
              remainingFor(draft, close.instrument),
              closeQuantity,
            ),
        ),
    );

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
    const draft = draftFor(id, close.account, close.currency);
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
  for (const close of closeExecutions) {
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
      if (drafts.has(mergedId)) remap.set(mergedId, chosen);
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

  const consolidated = new Map<Id, StrategyDraft>();
  for (const draft of drafts.values()) {
    const targetId = finalId(draft.id);
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
    const from = finalId(link.from);
    const to = finalId(link.to);
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
