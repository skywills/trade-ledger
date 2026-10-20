import { Decimal } from "decimal.js";
import type { Decision, SourceRef } from "../../shared/domain.js";
import {
  CampaignMembershipPayloadSchema,
  LifecycleAttachmentPayloadSchema,
  LifecycleMembershipPayloadSchema,
  LifecycleRejectionPayloadSchema,
} from "../../shared/lifecycles.js";
import { refKey } from "./membership.js";

export function resolveLifecycleAlias(
  id: string,
  aliases: ReadonlyMap<string, string>,
): string {
  const seen = new Set<string>();
  while (aliases.has(id) && !seen.has(id)) {
    seen.add(id);
    id = aliases.get(id) ?? id;
  }
  return id;
}

function redirectPartitions<
  T extends { lifecycleId: string; quantity: string },
>(
  rows: readonly T[],
  resolve: (id: string) => string,
  allocationKey: (row: T) => string,
): T[] {
  const mapped = rows.map((row) => ({
    ...row,
    lifecycleId: resolve(row.lifecycleId),
  }));
  const originals = rows.map((row) =>
    JSON.stringify([allocationKey(row), row.lifecycleId]),
  );
  // Preserve invalid duplicate or opposing source slices for normal validation.
  if (new Set(originals).size !== originals.length) return mapped;
  const combined = new Map<string, T>();
  for (const row of mapped) {
    const key = JSON.stringify([allocationKey(row), row.lifecycleId]);
    const previous = combined.get(key);
    if (previous) {
      if (
        new Decimal(previous.quantity).isNegative() !==
        new Decimal(row.quantity).isNegative()
      )
        return mapped;
      previous.quantity = new Decimal(previous.quantity)
        .plus(row.quantity)
        .toFixed();
    } else combined.set(key, row);
  }
  return [...combined.values()];
}

/** Redirect build-local references without rewriting retained decisions. */
export function redirectLifecycleDecisions(
  decisions: readonly Decision[],
  aliases: ReadonlyMap<string, string>,
): {
  decisions: Decision[];
  conflicts: Array<{ lifecycleId: string; sources: SourceRef[] }>;
} {
  const resolve = (id: string) => resolveLifecycleAlias(id, aliases);
  const memberships = new Map<string, Map<string, Decision>>();
  for (const d of decisions) {
    if (d.kind !== "wheel_campaign_membership") continue;
    const p = CampaignMembershipPayloadSchema.safeParse(d.payload);
    if (!p.success) continue;
    const id = resolve(p.data.lifecycleId);
    const originals = memberships.get(id) ?? new Map<string, Decision>();
    const previous = originals.get(p.data.lifecycleId);
    if (
      !previous ||
      d.sequence > previous.sequence ||
      (d.sequence === previous.sequence && d.id > previous.id)
    )
      originals.set(p.data.lifecycleId, d);
    memberships.set(id, originals);
  }
  const conflicts = [...memberships].flatMap(([lifecycleId, originals]) => {
    const rows = [...originals.values()];
    return new Set(rows.map((d) => d.payload.campaignId)).size > 1
      ? [{ lifecycleId, sources: rows.flatMap((d) => d.sources) }]
      : [];
  });
  const conflicted = new Set(conflicts.map((c) => c.lifecycleId));
  const redirected = decisions.flatMap((d): Decision[] => {
    const payload = structuredClone(d.payload);
    if (d.kind === "wheel_campaign_membership") {
      const p = CampaignMembershipPayloadSchema.safeParse(payload);
      if (p.success) {
        const id = resolve(p.data.lifecycleId);
        if (conflicted.has(id)) return [];
        payload.lifecycleId = id;
      }
    } else if (d.kind === "lifecycle_membership") {
      const p = LifecycleMembershipPayloadSchema.safeParse(payload);
      if (p.success)
        payload.assignments = redirectPartitions(
          p.data.assignments,
          resolve,
          (a) => refKey(a.allocation),
        );
    } else if (d.kind === "lifecycle_attachment") {
      const p = LifecycleAttachmentPayloadSchema.safeParse(payload);
      if (p.success)
        payload.targets = redirectPartitions(p.data.targets, resolve, () => "");
    } else if (d.kind === "lifecycle_attachment_rejection") {
      const p = LifecycleRejectionPayloadSchema.safeParse(payload);
      if (p.success)
        payload.candidateLifecycleIds = [
          ...new Set(p.data.candidateLifecycleIds.map(resolve)),
        ];
    }
    return [{ ...d, payload }];
  });
  return { decisions: redirected, conflicts };
}
