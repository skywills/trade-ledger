import { Decimal } from "decimal.js";
import type {
  Decision,
  Execution,
  LedgerSnapshot,
  Projection,
} from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import {
  CampaignMembershipPayloadSchema,
  CampaignPayloadSchema,
  LifecycleAttachmentPayloadSchema,
  LifecycleMembershipPayloadSchema,
  type LifecycleProjection,
} from "../../shared/lifecycles.js";
import { underlyingSymbol } from "../../shared/symbols.js";
import { compareLifecycleTime } from "./chronology.js";
import { partition, refKey } from "./membership.js";
import { availableShares, shareAvailability } from "./project.js";

function invalid(message: string): never {
  throw new AppError("INVALID_LIFECYCLE_MEMBERSHIP", message, 409);
}
export function applyMembershipChanges(
  ledger: LedgerSnapshot,
  projection: Projection,
  draft: LifecycleProjection,
  decisions: readonly Decision[],
): LifecycleProjection {
  const exec = new Map(ledger.executions.map((e) => [e.key, e]));
  const validateTarget = (id: string, e: Execution) => {
    const l = draft.lifecycles.find((l) => l.id === id);
    if (
      !l ||
      l.account !== e.account ||
      l.currency !== e.currency ||
      l.underlyingKey !== `value:${underlyingSymbol(e.instrument)}`
    )
      invalid(
        "Target lifecycle is missing or has incompatible account, currency or underlying.",
      );
    if (e.instrument.assetClass === "STK") {
      const knownStocks = draft.members
        .filter((m) => m.lifecycleId === id)
        .map((m) => exec.get(m.allocation.executionKey)?.instrument)
        .filter((i) => i?.assetClass === "STK");
      if (
        knownStocks.some(
          (i) =>
            i &&
            (i.conid && e.instrument.conid
              ? i.conid !== e.instrument.conid
              : i.key !== e.instrument.key),
        )
      )
        invalid(
          "A different known stock contract cannot be combined by display symbol.",
        );
    }
    if (e.instrument.putCall === "C") {
      const contracts = new Set(
        ledger.executions
          .filter(
            (row) =>
              row.account === e.account &&
              row.currency === e.currency &&
              row.instrument.assetClass === "STK" &&
              underlyingSymbol(row.instrument) ===
                underlyingSymbol(e.instrument),
          )
          .map((row) => row.instrument.conid ?? row.instrument.key),
      );
      if (contracts.size > 1)
        invalid(
          "The underlying stock contract is ambiguous; matching display symbols are insufficient.",
        );
    }
    return l;
  };
  const replace = (
    a: Projection["allocations"][number],
    targets: { lifecycleId: string; quantity: string }[],
  ) => {
    const e = exec.get(a.executionKey);
    if (!e) invalid("Source execution no longer exists.");
    for (const t of targets) {
      validateTarget(t.lifecycleId, e);
      if (
        e.instrument.assetClass === "OPT" &&
        !new Decimal(t.quantity).isInteger()
      )
        invalid("Option contract slices must be integers.");
    }
    const pieces = partition(a, targets, e.sources);
    draft.members = draft.members.filter(
      (m) => refKey(m.allocation) !== refKey(a),
    );
    draft.members.push(...pieces);
  };
  // Recheck covered owners so decisions saved out of order cannot overbook shares.
  const validateCallCoverage = () => {
    const available = shareAvailability(ledger, draft);
    const ownerIds = new Set(
      decisions.flatMap((d) => {
        if (d.kind === "lifecycle_attachment") {
          const p = LifecycleAttachmentPayloadSchema.safeParse(d.payload);
          return p.success ? p.data.targets.map((t) => t.lifecycleId) : [];
        }
        if (d.kind === "lifecycle_membership") {
          const p = LifecycleMembershipPayloadSchema.safeParse(d.payload);
          return p.success && p.data.requireCallCoverage
            ? p.data.assignments.map((a) => a.lifecycleId)
            : [];
        }
        return [];
      }),
    );
    for (const id of ownerIds) {
      const opens = draft.members.filter(
        (m) =>
          m.lifecycleId === id &&
          m.allocation.role === "open" &&
          new Decimal(m.quantity).lt(0) &&
          exec.get(m.allocation.executionKey)?.instrument.putCall === "C",
      );
      for (const open of opens) {
        const opening = exec.get(open.allocation.executionKey);
        if (!opening) continue;
        const demand = opens
          .filter((other) => {
            const e = exec.get(other.allocation.executionKey);
            return (
              e && (other === open || compareLifecycleTime(e, opening) === 0)
            );
          })
          .reduce(
            (total, m) =>
              total.plus(
                new Decimal(m.quantity)
                  .abs()
                  .times(
                    exec.get(m.allocation.executionKey)?.instrument
                      .multiplier ?? "0",
                  ),
              ),
            new Decimal(0),
          );
        if (available(id, opening).lt(demand))
          invalid(
            "These calls overlap an existing reservation of the selected shares.",
          );
      }
    }
  };
  const explicitRefs = new Set(
    decisions
      .filter((d) => d.kind === "lifecycle_membership")
      .flatMap((d) => {
        const r = LifecycleMembershipPayloadSchema.safeParse(d.payload);
        return r.success
          ? r.data.assignments.map((a) => refKey(a.allocation))
          : [];
      }),
  );
  const orderedDecisions = [...decisions].sort(
    (a, b) =>
      Number(b.kind === "wheel_campaign") -
        Number(a.kind === "wheel_campaign") || a.sequence - b.sequence,
  );
  for (const d of orderedDecisions) {
    const before = structuredClone({
      members: draft.members,
      lifecycles: draft.lifecycles,
      campaigns: draft.campaigns,
      issues: draft.issues,
    });
    try {
      if (d.kind === "lifecycle_attachment") {
        const p = LifecycleAttachmentPayloadSchema.parse(d.payload);
        const a = projection.allocations.find(
          (a) => refKey(a) === refKey(p.opening),
        );
        const e = a && exec.get(a.executionKey);
        if (
          !a ||
          !e ||
          a.role !== "open" ||
          e.instrument.putCall !== "C" ||
          !new Decimal(a.quantity).lt(0) ||
          !new Decimal(e.instrument.multiplier ?? "0").gt(0)
        )
          invalid(
            "Attachment requires a known short-call opening and multiplier.",
          );
        const sameOpenings = projection.allocations.filter(
          (b) =>
            b.strategyId === a.strategyId &&
            b.role === "open" &&
            exec.get(b.executionKey)?.instrument.key === e.instrument.key,
        );
        if (sameOpenings.length !== 1)
          invalid(
            "Multiple openings in this component require explicit source partitions.",
          );
        partition(a, p.targets, e.sources);
        for (const t of p.targets) {
          validateTarget(t.lifecycleId, e);
          if (
            availableShares(ledger, draft, t.lifecycleId, e).lt(
              new Decimal(t.quantity)
                .abs()
                .times(e.instrument.multiplier ?? "0"),
            )
          )
            invalid(
              "The selected shares are unavailable or already reserved at call opening.",
            );
        }
        for (const b of projection.allocations.filter(
          (b) =>
            b.strategyId === a.strategyId &&
            exec.get(b.executionKey)?.instrument.key === e.instrument.key,
        )) {
          const targets = p.targets.map((t) => ({
            lifecycleId: t.lifecycleId,
            quantity: new Decimal(b.quantity)
              .times(t.quantity)
              .div(a.quantity)
              .toFixed(),
          }));
          if (
            b.role === "close" &&
            targets.some((t) => !new Decimal(t.quantity).isInteger())
          ) {
            if (!explicitRefs.has(refKey(b)))
              for (const t of p.targets) {
                const l = draft.lifecycles.find((l) => l.id === t.lifecycleId);
                l?.reasons.push("LIFECYCLE_CALL_CLOSE_AMBIGUOUS");
              }
            continue;
          }
          replace(b, targets);
        }
        validateCallCoverage();
      } else if (d.kind === "lifecycle_membership") {
        const p = LifecycleMembershipPayloadSchema.parse(d.payload);
        const keys = [
          ...new Set(p.assignments.map((t) => refKey(t.allocation))),
        ];
        for (const key of keys) {
          const a = projection.allocations.find((a) => refKey(a) === key);
          if (!a) invalid("Source allocation no longer exists.");
          replace(
            a,
            p.assignments.filter((t) => refKey(t.allocation) === key),
          );
        }
        if (p.requireCallCoverage) validateCallCoverage();
      } else if (d.kind === "wheel_campaign") {
        const p = CampaignPayloadSchema.parse(d.payload);
        const old = draft.campaigns.find((c) => c.id === p.campaignId);
        if (
          old &&
          (old.account !== p.account ||
            old.currency !== p.currency ||
            old.underlyingKey !== p.underlyingKey)
        )
          invalid("Campaign scope cannot be changed.");
        draft.campaigns = draft.campaigns.filter((c) => c.id !== p.campaignId);
        draft.campaigns.push({
          id: p.campaignId,
          name: p.name,
          account: p.account,
          currency: p.currency,
          underlyingKey: p.underlyingKey,
          lifecycleIds: [],
        });
      } else if (d.kind === "wheel_campaign_membership") {
        const p = CampaignMembershipPayloadSchema.parse(d.payload);
        const l = draft.lifecycles.find((l) => l.id === p.lifecycleId);
        if (!l) invalid("Lifecycle no longer exists.");
        const c =
          p.campaignId === null
            ? null
            : draft.campaigns.find((c) => c.id === p.campaignId);
        if (
          p.campaignId !== null &&
          (!c ||
            c.account !== l.account ||
            c.currency !== l.currency ||
            c.underlyingKey !== l.underlyingKey)
        )
          invalid("Campaign and lifecycle scopes must match.");
        l.campaignId = p.campaignId;
      }
    } catch (error) {
      draft.members = before.members;
      draft.lifecycles = before.lifecycles;
      draft.campaigns = before.campaigns;
      draft.issues = before.issues;
      if (d.id === "__validate__") throw error;
      draft.issues.push({
        key: `lifecycle:decision:${d.id}`,
        code: "LIFECYCLE_DECISION_UNRESOLVED",
        sources: d.sources,
        severity: "warning",
      });
      for (const l of draft.lifecycles)
        if (
          draft.members.some(
            (m) =>
              m.lifecycleId === l.id &&
              (d.strategyIds.includes(m.allocation.strategyId) ||
                JSON.stringify(d.payload).includes(l.id) ||
                JSON.stringify(d.payload).includes(m.allocation.strategyId) ||
                JSON.stringify(d.payload).includes(m.allocation.executionKey)),
          )
        )
          l.reasons.push("LIFECYCLE_DECISION_UNRESOLVED");
    }
  }
  for (const c of draft.campaigns)
    c.lifecycleIds = draft.lifecycles
      .filter((l) => l.campaignId === c.id)
      .map((l) => l.id);
  return draft;
}
