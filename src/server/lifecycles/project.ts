import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import type {
  Allocation,
  Decision,
  Execution,
  LedgerSnapshot,
  Projection,
} from "../../shared/domain.js";
import type {
  AllocationRef,
  LifecycleAnchor,
  LifecycleProjection,
  RetainedLifecycleAnchor,
} from "../../shared/lifecycles.js";
import {
  LifecycleAttachmentPayloadSchema,
  LifecycleMembershipPayloadSchema,
} from "../../shared/lifecycles.js";
import { underlyingSymbol } from "../../shared/symbols.js";
import {
  redirectLifecycleDecisions,
  resolveLifecycleAlias,
} from "./aliases.js";
import { compareLifecycleTime } from "./chronology.js";
import { applyMembershipChanges } from "./decisions.js";
import {
  indexMembersByAllocation,
  partition,
  refKey,
  sum,
} from "./membership.js";

export { validateMembership } from "./membership.js";
export const lifecycleId = (a: LifecycleAnchor) =>
  `lc-${createHash("sha256")
    .update(JSON.stringify([a.account, a.openingExecutionKey]))
    .digest("hex")
    .slice(0, 24)}`;

/** Keep exact identity and the existing unique execution/role fallback. */
function allocationResolver(allocations: readonly Allocation[]) {
  const exact = new Map<string, Allocation>();
  const byExecution = new Map<string, Allocation[]>();
  for (const a of allocations) {
    const key = refKey(a);
    if (!exact.has(key)) exact.set(key, a);
    const fallback = JSON.stringify([a.executionKey, a.role]);
    const rows = byExecution.get(fallback) ?? [];
    rows.push(a);
    byExecution.set(fallback, rows);
  }
  return (ref: AllocationRef) => {
    const match = exact.get(refKey(ref));
    if (match) return match;
    const rows = byExecution.get(JSON.stringify([ref.executionKey, ref.role]));
    return rows?.length === 1 ? rows[0] : undefined;
  };
}
export function projectLifecycles(
  ledger: LedgerSnapshot,
  projection: Projection,
  decisions: readonly Decision[],
  resolveId: (a: LifecycleAnchor) => string = lifecycleId,
  originProjection?: Projection,
  retainedAnchors: readonly RetainedLifecycleAnchor[] = [],
): LifecycleProjection {
  const retained = new Map(
    retainedAnchors.map((anchor, rank) => [
      JSON.stringify([anchor.account, anchor.openingExecutionKey]),
      { id: anchor.id, rank },
    ]),
  );
  const finalProjection = projection;
  projection = originProjection ?? projection;
  const resolveSource = allocationResolver(projection.allocations);
  const sourceRef = (
    ref: import("../../shared/lifecycles.js").AllocationRef,
  ) => {
    const a = resolveSource(ref);
    return a
      ? { strategyId: a.strategyId, executionKey: a.executionKey, role: a.role }
      : ref;
  };
  if (originProjection)
    decisions = decisions.map((d) => {
      const payload = structuredClone(d.payload);
      if (d.kind === "lifecycle_attachment" && payload.opening)
        payload.opening = sourceRef(
          payload.opening as import("../../shared/lifecycles.js").AllocationRef,
        );
      if (d.kind === "lifecycle_attachment_rejection" && payload.callOpening)
        payload.callOpening = sourceRef(
          payload.callOpening as import("../../shared/lifecycles.js").AllocationRef,
        );
      if (d.kind === "lifecycle_membership") {
        const p = LifecycleMembershipPayloadSchema.safeParse(payload);
        if (p.success)
          payload.assignments = p.data.assignments.map((a) => ({
            ...a,
            allocation: sourceRef(a.allocation),
          }));
      }
      return { ...d, payload };
    });
  const exec = new Map(ledger.executions.map((e) => [e.key, e]));
  const draft: LifecycleProjection = {
    version: 1,
    lifecycles: [],
    members: [],
    campaigns: [],
    suggestions: [],
    issues: [],
    valuations: [],
  };
  const roots = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const s of projection.strategies) {
    const rows = projection.allocations.filter((a) => a.strategyId === s.id);
    const opening = [...rows].sort((a, b) => {
      const x = exec.get(a.executionKey),
        y = exec.get(b.executionKey);
      return (
        (a.role === "open" ? 0 : 1) - (b.role === "open" ? 0 : 1) ||
        ((x
          ? retained.get(JSON.stringify([x.account, x.key]))?.rank
          : undefined) ?? Number.MAX_SAFE_INTEGER) -
          ((y
            ? retained.get(JSON.stringify([y.account, y.key]))?.rank
            : undefined) ?? Number.MAX_SAFE_INTEGER) ||
        (x && y ? (compareLifecycleTime(x, y) ?? 0) : 0) ||
        (x?.date ?? "").localeCompare(y?.date ?? "") ||
        a.executionKey.localeCompare(b.executionKey)
      );
    })[0];
    const e = opening && exec.get(opening.executionKey);
    if (!e) continue;
    const id =
      retained.get(JSON.stringify([e.account, e.key]))?.id ??
      resolveId({ account: e.account, openingExecutionKey: e.key });
    roots.set(s.id, id);
    const underlyingKeys = new Set(
      rows
        .map((a) => exec.get(a.executionKey))
        .filter((e): e is Execution => !!e)
        .map((e) => underlyingSymbol(e.instrument)),
    );
    if (!draft.lifecycles.some((l) => l.id === id))
      draft.lifecycles.push({
        ...s,
        id,
        originOpeningExecutionKey: e.key,
        account: e.account,
        underlyingKey:
          underlyingKeys.size === 1
            ? `value:${[...underlyingKeys][0]}`
            : "__multi__",
        originStrategyType: s.type,
        stage: "options",
        campaignId: null,
        coveredShares: "0",
        uncoveredShares: "0",
        componentIds: [s.id],
        positions: [],
        cashflow: null,
        brokerPnl: null,
        reconstructedPnl: null,
      });
    for (const a of rows)
      draft.members.push(
        ...partition(
          a,
          [{ lifecycleId: id, quantity: a.quantity }],
          exec.get(a.executionKey)?.sources ?? [],
        ),
      );
  }
  // Retained event links move only the evidenced opening, preserving other lots
  // in the same stock component. Later closes follow a unique compatible owner.
  const changedStockStrategies = new Set<string>();
  const ownedStockCloses = new Set<string>();
  const acquiredOptionEvents = new Set<string>();
  const explicitCloseRefs = new Set(
    decisions
      .filter((d) => d.kind === "lifecycle_membership")
      .flatMap((d) => {
        const p = LifecycleMembershipPayloadSchema.safeParse(d.payload);
        return p.success
          ? p.data.assignments.map((t) => refKey(t.allocation))
          : [];
      }),
  );
  for (const link of projection.links.filter((l) =>
    ["assignment", "exercise", "roll"].includes(l.type),
  )) {
    const from = roots.get(link.from),
      to = roots.get(link.to);
    if (!from || !to || from === to) continue;
    const source = draft.lifecycles.find((l) => l.id === from),
      target = draft.lifecycles.find((l) => l.id === to);
    if (
      !source ||
      !target ||
      source.account !== target.account ||
      source.currency !== target.currency ||
      source.underlyingKey !== target.underlyingKey
    )
      continue;
    const optionEvents = projection.allocations
      .filter((a) => a.strategyId === link.from)
      .map((a) => exec.get(a.executionKey))
      .filter(
        (e): e is Execution =>
          !!e &&
          (e.event === "assignment" ||
            e.event === "exercise" ||
            link.sources.some((s) =>
              e.sources.some(
                (t) => s.importId === t.importId && s.rowNumber === t.rowNumber,
              ),
            )),
      );
    const candidates = draft.members
      .filter(
        (m) =>
          m.allocation.strategyId === link.to && m.allocation.role === "open",
      )
      .filter((m) => {
        const e = exec.get(m.allocation.executionKey);
        if (!e) return false;
        if (link.type === "roll") return true;
        if (e.instrument.assetClass !== "STK") return false;
        if (
          link.sources.some((s) =>
            e.sources.some(
              (t) => s.importId === t.importId && s.rowNumber === t.rowNumber,
            ),
          )
        )
          return true;
        const action = e.brokerIds.PositionActionID;
        if (action)
          return optionEvents.some(
            (o) => o.brokerIds.PositionActionID === action,
          );
        return (
          (e.event === "assignment" || e.event === "exercise") &&
          optionEvents.some((o) => o.date === e.date)
        );
      });
    for (const m of candidates) m.lifecycleId = from;
    if (
      link.type !== "roll" &&
      candidates.some((m) => {
        const e = exec.get(m.allocation.executionKey);
        return e && new Decimal(m.quantity).eq(e.quantity);
      })
    ) {
      for (const option of optionEvents) {
        if (
          link.sources.some((s) =>
            option.sources.some(
              (t) => s.importId === t.importId && s.rowNumber === t.rowNumber,
            ),
          ) &&
          projection.allocations.some(
            (a) =>
              a.strategyId === link.from &&
              a.role === "close" &&
              a.executionKey === option.key &&
              new Decimal(a.quantity).eq(option.quantity),
          )
        )
          acquiredOptionEvents.add(option.key);
      }
    }
    if (candidates.length || link.type !== "roll")
      changedStockStrategies.add(link.to);
    if (link.type === "roll" && candidates.length) {
      for (const m of draft.members)
        if (m.lifecycleId === to) m.lifecycleId = from;
      aliases.set(to, from);
      for (const [k, v] of roots) if (v === to) roots.set(k, from);
    }
  }
  for (const strategyId of changedStockStrategies) {
    const rows = projection.allocations
      .filter((a) => a.strategyId === strategyId)
      .sort((a, b) => {
        const x = exec.get(a.executionKey),
          y = exec.get(b.executionKey);
        return (
          (x && y ? (compareLifecycleTime(x, y) ?? 0) : 0) ||
          (a.role === "open" ? 0 : 1) - (b.role === "open" ? 0 : 1) ||
          a.executionKey.localeCompare(b.executionKey)
        );
      });
    const inventory = new Map<string, Map<string, Decimal>>();
    for (const a of rows) {
      const e = exec.get(a.executionKey);
      if (!e) continue;
      const book =
        inventory.get(e.instrument.key) ?? new Map<string, Decimal>();
      inventory.set(e.instrument.key, book);
      let pieces = draft.members.filter(
        (m) => refKey(m.allocation) === refKey(a),
      );
      if (a.role === "close") {
        const owners = [...book].filter(
          ([, q]) =>
            !q.isZero() &&
            q.isNegative() !== new Decimal(a.quantity).isNegative() &&
            q.abs().gte(new Decimal(a.quantity).abs()),
        );
        if (owners.length === 1) {
          ownedStockCloses.add(refKey(a));
          pieces = partition(
            a,
            [{ lifecycleId: owners[0]?.[0] ?? "", quantity: a.quantity }],
            e.sources,
          );
          draft.members = draft.members.filter(
            (m) => refKey(m.allocation) !== refKey(a),
          );
          draft.members.push(...pieces);
        } else if (owners.length !== 1 && !explicitCloseRefs.has(refKey(a))) {
          draft.issues.push({
            key: `lifecycle:stock-close:${refKey(a)}`,
            code: "LIFECYCLE_STOCK_CLOSE_AMBIGUOUS",
            sources: e.sources,
            severity: "warning",
          });
          for (const id of book.keys()) {
            const l = draft.lifecycles.find((l) => l.id === id);
            if (l) l.reasons.push("LIFECYCLE_STOCK_CLOSE_AMBIGUOUS");
          }
        }
      }
      for (const m of pieces)
        book.set(
          m.lifecycleId,
          (book.get(m.lifecycleId) ?? new Decimal(0)).plus(m.quantity),
        );
    }
  }
  const pendingMerges = new Map<
    string,
    Array<{ to: string; optionKeys: string[] }>
  >();
  // An exercised option can dispose of stock already owned by another option
  // lifecycle. Join the closed option cycle to that proven stock owner; moving
  // only the stock disposal would separate it from the acquisition it closes.
  for (const link of projection.links.filter((l) =>
    ["assignment", "exercise"].includes(l.type),
  )) {
    const from = roots.get(link.from);
    if (!from) continue;
    const referenced = (e: Execution) =>
      link.sources.some((s) =>
        e.sources.some(
          (t) => s.importId === t.importId && s.rowNumber === t.rowNumber,
        ),
      );
    const stockCloses = projection.allocations.filter((a) => {
      const e = exec.get(a.executionKey);
      return (
        a.strategyId === link.to &&
        a.role === "close" &&
        e?.instrument.assetClass === "STK" &&
        referenced(e)
      );
    });
    if (stockCloses.length !== 1) continue;
    const close = stockCloses[0];
    if (!close || !ownedStockCloses.has(refKey(close))) continue;
    const owners = draft.members.filter(
      (m) => refKey(m.allocation) === refKey(close),
    );
    const ownerIds = new Set(owners.map((m) => m.lifecycleId));
    if (
      ownerIds.size !== 1 ||
      !new Decimal(sum(owners.map((m) => m.quantity))).eq(close.quantity)
    )
      continue;
    const to = owners[0]?.lifecycleId;
    if (!to || from === to) continue;
    const source = draft.lifecycles.find((l) => l.id === from);
    const target = draft.lifecycles.find((l) => l.id === to);
    if (
      !source ||
      !target ||
      source.account !== target.account ||
      source.currency !== target.currency ||
      source.underlyingKey !== target.underlyingKey
    )
      continue;
    const members = draft.members.filter((m) => m.lifecycleId === from);
    const balances = new Map<string, Decimal>();
    for (const m of members) {
      const e = exec.get(m.allocation.executionKey);
      if (e)
        balances.set(
          e.instrument.key,
          (balances.get(e.instrument.key) ?? new Decimal(0)).plus(m.quantity),
        );
    }
    if (!members.length || [...balances.values()].some((q) => !q.isZero()))
      continue;
    const optionCloses = members.filter((m) => {
      const e = exec.get(m.allocation.executionKey);
      return (
        m.allocation.strategyId === link.from &&
        m.allocation.role === "close" &&
        e?.instrument.assetClass === "OPT" &&
        referenced(e)
      );
    });
    if (
      !optionCloses.length ||
      optionCloses.some((m) => {
        const e = exec.get(m.allocation.executionKey);
        const slices = draft.members.filter(
          (s) =>
            s.allocation.executionKey === m.allocation.executionKey &&
            s.allocation.role === "close",
        );
        return (
          !e ||
          slices.some((s) => s.lifecycleId !== from) ||
          !new Decimal(sum(slices.map((s) => s.quantity))).eq(e.quantity)
        );
      })
    )
      continue;
    const merges = pendingMerges.get(from) ?? [];
    merges.push({
      to,
      optionKeys: optionCloses.map((m) => m.allocation.executionKey),
    });
    pendingMerges.set(from, merges);
  }
  // Validate all exercise destinations before moving any whole lifecycle.
  // A shared option opening may serve independent stock owners; that needs
  // explicit quantity membership instead of merging those owners together.
  const approvedMerges: Array<{ from: string; to: string }> = [];
  for (const [originalFrom, merges] of pendingMerges) {
    const from = resolveLifecycleAlias(originalFrom, aliases);
    const members = draft.members.filter((m) => m.lifecycleId === from);
    const destinations = new Set(
      merges.map((m) => resolveLifecycleAlias(m.to, aliases)),
    );
    const covered = new Set(merges.flatMap((m) => m.optionKeys));
    const missingEvent = members.some((m) => {
      const e = exec.get(m.allocation.executionKey);
      return (
        m.allocation.role === "close" &&
        e?.instrument.assetClass === "OPT" &&
        ["assignment", "exercise"].includes(e.event) &&
        !covered.has(e.key) &&
        !acquiredOptionEvents.has(e.key)
      );
    });
    const source = draft.lifecycles.find((l) => l.id === from);
    if (destinations.size !== 1 || missingEvent) {
      // Explicit source partitions are applied below; let their resulting
      // exposure validation decide eligibility when all closes are corrected.
      const corrected = members
        .filter((m) => m.allocation.role === "close")
        .every((m) => explicitCloseRefs.has(refKey(m.allocation)));
      if (!corrected && source) {
        source.reasons.push("LIFECYCLE_OPTION_CLOSE_AMBIGUOUS");
        draft.issues.push({
          key: `lifecycle:option-close:${from}`,
          code: "LIFECYCLE_OPTION_CLOSE_AMBIGUOUS",
          sources: members.flatMap((m) => m.sources),
          severity: "warning",
        });
      }
      continue;
    }
    const to = [...destinations][0];
    if (!to || from === to) continue;
    approvedMerges.push({ from, to });
  }
  // Coverage was checked against the original sources, before upstream joins
  // add their already validated events to a downstream source.
  for (const merge of approvedMerges) {
    const from = resolveLifecycleAlias(merge.from, aliases);
    const to = resolveLifecycleAlias(merge.to, aliases);
    if (from === to) continue;
    const source = draft.lifecycles.find((l) => l.id === from);
    const target = draft.lifecycles.find((l) => l.id === to);
    if (!source || !target) continue;
    for (const m of draft.members)
      if (m.lifecycleId === from) m.lifecycleId = to;
    target.reasons = [...new Set([...target.reasons, ...source.reasons])];
    aliases.set(from, to);
    for (const [key, id] of roots) if (id === from) roots.set(key, to);
  }
  const redirected = redirectLifecycleDecisions(decisions, aliases);
  decisions = redirected.decisions;
  for (const conflict of redirected.conflicts) {
    const lifecycle = draft.lifecycles.find(
      (l) => l.id === conflict.lifecycleId,
    );
    lifecycle?.reasons.push("LIFECYCLE_CAMPAIGN_CONFLICT");
    draft.issues.push({
      key: `lifecycle:campaign-conflict:${conflict.lifecycleId}`,
      code: "LIFECYCLE_CAMPAIGN_CONFLICT",
      sources: conflict.sources,
      severity: "warning",
    });
  }
  applyMembershipChanges(ledger, projection, draft, decisions);
  recomputeLifecycles(ledger, projection, draft, explicitCloseRefs);
  for (const c of draft.campaigns)
    c.lifecycleIds = draft.lifecycles
      .filter((l) => l.campaignId === c.id)
      .map((l) => l.id);
  const confirmedOpenings = new Set(
    decisions.flatMap((d) => {
      if (
        draft.issues.some((issue) => issue.key === `lifecycle:decision:${d.id}`)
      )
        return [];
      if (d.kind === "lifecycle_attachment") {
        const result = LifecycleAttachmentPayloadSchema.safeParse(d.payload);
        return result.success ? [refKey(result.data.opening)] : [];
      }
      if (d.kind === "lifecycle_membership") {
        const result = LifecycleMembershipPayloadSchema.safeParse(d.payload);
        return result.success
          ? result.data.assignments
              .filter((a) => a.allocation.role === "open")
              .map((a) => refKey(a.allocation))
          : [];
      }
      return [];
    }),
  );
  // Suggestions carry no ownership until confirmed. Existing positions at call
  // opening are measured chronologically, including reservations by attached calls.
  const membersByAllocation = indexMembersByAllocation(draft.members);
  const available = shareAvailability(ledger, draft);
  const unreserved = shareAvailability(ledger, draft, false);
  for (const a of projection.allocations) {
    const e = exec.get(a.executionKey);
    if (
      !e ||
      a.role !== "open" ||
      e.instrument.putCall !== "C" ||
      !new Decimal(a.quantity).lt(0)
    )
      continue;
    if (confirmedOpenings.has(refKey(a))) continue;
    const owners = (membersByAllocation.get(refKey(a)) ?? []).map(
      (m) => m.lifecycleId,
    );
    const rejected = decisions.some(
      (d) =>
        d.kind === "lifecycle_attachment_rejection" &&
        d.payload.callOpening !== null &&
        typeof d.payload.callOpening === "object" &&
        refKey(
          d.payload
            .callOpening as import("../../shared/lifecycles.js").AllocationRef,
        ) === refKey(a),
    );
    if (rejected) continue;
    const stockContracts = new Set(
      ledger.executions
        .filter(
          (row) =>
            row.account === e.account &&
            row.currency === e.currency &&
            row.instrument.assetClass === "STK" &&
            underlyingSymbol(row.instrument) === underlyingSymbol(e.instrument),
        )
        .map((row) => row.instrument.conid ?? row.instrument.key),
    );
    if (stockContracts.size > 1) continue;
    const capacities = new Map<string, Decimal>();
    const sharesAtOpening = (id: string) => {
      let shares = capacities.get(id);
      if (shares === undefined) {
        shares = available(id, e);
        capacities.set(id, shares);
      }
      return shares;
    };
    const matchingLifecycles = draft.lifecycles.filter(
      (l) =>
        !owners.includes(l.id) &&
        l.account === e.account &&
        l.currency === e.currency &&
        l.underlyingKey === `value:${underlyingSymbol(e.instrument)}`,
    );
    const multiplier = new Decimal(e.instrument.multiplier ?? "0");
    if (!multiplier.gt(0)) continue;
    const candidates = matchingLifecycles.filter((l) =>
      sharesAtOpening(l.id).gte(multiplier),
    );
    const insufficientCoverage =
      !candidates.length ||
      candidates
        .reduce(
          (total, l) =>
            total.plus(
              sharesAtOpening(l.id)
                .div(e.instrument.multiplier ?? "1")
                .floor(),
            ),
          new Decimal(0),
        )
        .lt(new Decimal(a.quantity).abs());
    // A confirmed call can reserve shares that previously made another call
    // reviewable. Keep that call pending until the user explicitly resolves it.
    const blockedByReservations =
      insufficientCoverage &&
      matchingLifecycles
        .reduce(
          (total, l) => total.plus(unreserved(l.id, e).div(multiplier).floor()),
          new Decimal(0),
        )
        .gte(new Decimal(a.quantity).abs());
    if (insufficientCoverage && !blockedByReservations) continue;
    draft.suggestions.push({
      id: `call:${a.strategyId}:${e.key}`,
      callOpening: {
        strategyId: a.strategyId,
        executionKey: a.executionKey,
        role: a.role,
      },
      quantity: a.quantity,
      candidateLifecycleIds: insufficientCoverage
        ? []
        : candidates.map((l) => l.id).sort(),
      sources: e.sources,
      reasons: blockedByReservations
        ? ["CONFIRM_COVERED_CALL", "SHARES_RESERVED_BY_OTHER_CALLS"]
        : ["CONFIRM_COVERED_CALL"],
    });
    draft.issues.push({
      key: `lifecycle:call:${a.strategyId}:${e.key}`,
      code: "PENDING_CALL_ATTACHMENT",
      sources: e.sources,
      severity: "warning",
    });
    for (const l of draft.lifecycles.filter(
      (l) => owners.includes(l.id) || candidates.some((c) => c.id === l.id),
    )) {
      l.reasons = [...new Set([...l.reasons, "PENDING_CALL_ATTACHMENT"])];
      l.status = "unresolved";
      l.complete = false;
      l.closeDate = null;
    }
  }
  if (originProjection) {
    const resolveFinal = allocationResolver(finalProjection.allocations);
    const finalRef = (
      ref: import("../../shared/lifecycles.js").AllocationRef,
    ) => {
      const a = resolveFinal(ref);
      if (!a)
        throw new Error(
          "Cannot resolve lifecycle source allocation after presentation grouping.",
        );
      return {
        strategyId: a.strategyId,
        executionKey: a.executionKey,
        role: a.role,
      };
    };
    draft.members = draft.members.map((m) => ({
      ...m,
      allocation: finalRef(m.allocation),
    }));
    draft.suggestions = draft.suggestions.map((s) => ({
      ...s,
      callOpening: finalRef(s.callOpening),
    }));
    // Presentation merges may combine two source slices. Repartition final
    // authoritative allocation amounts and coalesce identical owner references.
    const finalMembers = indexMembersByAllocation(draft.members);
    draft.members = finalProjection.allocations.flatMap((a) => {
      const rows = finalMembers.get(refKey(a)) ?? [];
      const owners = new Map<string, Decimal>();
      for (const m of rows)
        owners.set(
          m.lifecycleId,
          (owners.get(m.lifecycleId) ?? new Decimal(0)).plus(m.quantity),
        );
      return partition(
        a,
        [...owners].map(([lifecycleId, q]) => ({
          lifecycleId,
          quantity: q.toFixed(),
        })),
        exec.get(a.executionKey)?.sources ?? [],
      );
    });
    for (const l of draft.lifecycles)
      l.componentIds = [
        ...new Set(
          draft.members
            .filter((m) => m.lifecycleId === l.id)
            .map((m) => m.allocation.strategyId),
        ),
      ];
  }
  return draft;
}
export function availableShares(
  ledger: LedgerSnapshot,
  p: LifecycleProjection,
  id: string,
  before?: Execution,
): Decimal {
  return shareAvailability(ledger, p)(id, before);
}

/** Reuse only while memberships are unchanged; each call site owns its snapshot. */
export function shareAvailability(
  ledger: LedgerSnapshot,
  p: LifecycleProjection,
  reserveCalls = true,
) {
  const exec = new Map(ledger.executions.map((e) => [e.key, e]));
  const members = new Map<string, LifecycleProjection["members"]>();
  for (const m of p.members) {
    const rows = members.get(m.lifecycleId) ?? [];
    rows.push(m);
    members.set(m.lifecycleId, rows);
  }
  return (id: string, before?: Execution): Decimal => {
    let shares = new Decimal(0);
    const calls = new Map<string, { quantity: Decimal; multiplier: string }>();
    for (const m of members.get(id) ?? []) {
      const e = exec.get(m.allocation.executionKey);
      if (!e || (before && e.key === before.key)) continue;
      if (before) {
        const order = compareLifecycleTime(e, before);
        if (
          order === 0 ||
          order === 1 ||
          (order === null && !new Decimal(m.quantity).lt(0))
        )
          continue;
      }
      if (e.instrument.assetClass === "STK") shares = shares.plus(m.quantity);
      else if (reserveCalls && e.instrument.putCall === "C") {
        const old = calls.get(e.instrument.key);
        calls.set(e.instrument.key, {
          quantity: (old?.quantity ?? new Decimal(0)).plus(m.quantity),
          multiplier: e.instrument.multiplier ?? "0",
        });
      }
    }
    const reserved = [...calls.values()].reduce(
      (s, c) =>
        s.plus(Decimal.max(0, c.quantity.negated()).times(c.multiplier)),
      new Decimal(0),
    );
    return Decimal.max(0, shares.minus(reserved));
  };
}
export function recomputeLifecycles(
  ledger: LedgerSnapshot,
  projection: Projection,
  p: LifecycleProjection,
  correctedRefs: ReadonlySet<string> = new Set(),
): void {
  const exec = new Map(ledger.executions.map((e) => [e.key, e]));
  for (const l of p.lifecycles) {
    const members = p.members.filter((m) => m.lifecycleId === l.id);
    if (!members.length) continue;
    l.componentIds = [
      ...new Set(members.map((m) => m.allocation.strategyId)),
    ].sort();
    const positions = new Map<string, Decimal>();
    let shares = new Decimal(0),
      calls = new Decimal(0);
    for (const close of members.filter((m) => m.allocation.role === "close")) {
      const event = exec.get(close.allocation.executionKey);
      if (!event) continue;
      const prior = members.filter((m) => {
        const other = exec.get(m.allocation.executionKey);
        if (
          !other ||
          other.instrument.key !== event.instrument.key ||
          m === close
        )
          return false;
        const order = compareLifecycleTime(other, event);
        return (
          order === -1 ||
          (order === 0 &&
            ((m.allocation.role === "open" &&
              (event.event !== "trade" ||
                (other.action === "open" && event.action === "close"))) ||
              // Tied closes consume capacity in the same stable order as grouping.
              (m.allocation.role === "close" &&
                (other.key < event.key ||
                  (other.key === event.key &&
                    refKey(m.allocation) < refKey(close.allocation))))))
        );
      });
      const exposure = new Decimal(sum(prior.map((m) => m.quantity)));
      if (
        exposure.isZero() ||
        exposure.isNegative() === new Decimal(close.quantity).isNegative() ||
        exposure.abs().lt(new Decimal(close.quantity).abs())
      ) {
        l.reasons.push("LIFECYCLE_EXPOSURE_UNRESOLVED");
        p.issues.push({
          key: `lifecycle:exposure:${l.id}:${refKey(close.allocation)}`,
          code: "LIFECYCLE_EXPOSURE_UNRESOLVED",
          sources: close.sources,
          severity: "warning",
        });
      }
    }
    let assigned = projection.links.some(
      (link) =>
        ["assignment", "exercise"].includes(link.type) &&
        l.componentIds.includes(link.from) &&
        l.componentIds.includes(link.to),
    );
    for (const m of members) {
      const e = exec.get(m.allocation.executionKey);
      if (!e) continue;
      positions.set(
        e.instrument.key,
        (positions.get(e.instrument.key) ?? new Decimal(0)).plus(m.quantity),
      );
      if (e.event === "assignment" || e.event === "exercise") assigned = true;
    }
    l.positions = [...positions]
      .filter(([, q]) => !q.isZero())
      .map(([instrumentKey, q]) => ({ instrumentKey, quantity: q.toFixed() }));
    for (const pos of l.positions) {
      const e = ledger.executions.find(
        (e) => e.instrument.key === pos.instrumentKey,
      );
      if (e?.instrument.assetClass === "STK")
        shares = shares.plus(pos.quantity);
      else if (e?.instrument.putCall === "C" && new Decimal(pos.quantity).lt(0))
        calls = calls.plus(
          new Decimal(pos.quantity).abs().times(e.instrument.multiplier ?? "0"),
        );
    }
    l.coveredShares = Decimal.min(Decimal.max(0, shares), calls).toFixed();
    l.uncoveredShares = Decimal.max(
      0,
      calls.minus(Decimal.max(0, shares)),
    ).toFixed();
    const components = projection.strategies.filter((s) =>
      l.componentIds.includes(s.id),
    );
    const dates = members
      .map((m) => exec.get(m.allocation.executionKey)?.date ?? "")
      .sort();
    const correctedOrphan = (s: Projection["strategies"][number]) => {
      const rows = projection.allocations.filter((a) => a.strategyId === s.id);
      return (
        rows.length > 0 &&
        rows.every(
          (a) =>
            a.role === "close" &&
            correctedRefs.has(refKey(a)) &&
            exec.get(a.executionKey)?.event !== "unsupported",
        ) &&
        s.reasons.every((r) =>
          [
            "MISSING_OPENING",
            "AMBIGUOUS_CLOSE",
            "LIFECYCLE_UNRESOLVED",
          ].includes(r),
        )
      );
    };
    const unresolved =
      components.some(
        (s) => s.status === "unresolved" && !correctedOrphan(s),
      ) ||
      l.reasons.some((r) => r.startsWith("LIFECYCLE_")) ||
      l.positions.some((pos) => {
        const es = members.filter(
          (m) =>
            exec.get(m.allocation.executionKey)?.instrument.key ===
            pos.instrumentKey,
        );
        return !es.some((m) => m.allocation.role === "open");
      });
    l.complete =
      components.every((s) => s.complete || correctedOrphan(s)) && !unresolved;
    l.status = unresolved
      ? "unresolved"
      : l.positions.length
        ? "open"
        : "closed";
    l.openingDate = dates[0] ?? null;
    l.closeDate = l.status === "closed" ? (dates.at(-1) ?? null) : null;
    l.stage =
      l.status === "closed"
        ? "closed"
        : calls.gt(0) &&
            (assigned ||
              members.some(
                (m) =>
                  exec.get(m.allocation.executionKey)?.instrument.assetClass ===
                  "STK",
              ))
          ? "covered_call"
          : assigned && shares.gt(0)
            ? "assigned_stock"
            : "options";
    l.cashflow = sum(members.map((m) => m.netCash));
  }
  p.lifecycles = p.lifecycles
    .filter((l) => p.members.some((m) => m.lifecycleId === l.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
