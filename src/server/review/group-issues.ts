import { Decimal } from "decimal.js";
import type { Issue, ReconciliationContext } from "../../shared/domain.js";

export type ReviewEntry = Issue & {
  issueKeys: string[];
  owners: ReconciliationContext["owners"];
};

function fingerprint(issue: Issue): string | undefined {
  const c = issue.reconciliation;
  if (
    issue.code !== "PNL_RECONCILIATION" ||
    !c ||
    c.version !== 1 ||
    !Array.isArray(c.owners) ||
    !Array.isArray(c.slices) ||
    typeof c.currency !== "string" ||
    !c.owners.every(
      (o) =>
        o &&
        (o.kind === "strategy" || o.kind === "lifecycle") &&
        typeof o.id === "string",
    )
  )
    return undefined;
  try {
    const decimal = (value: string) => {
      if (typeof value !== "string" || !value.trim())
        throw new Error("invalid decimal");
      const n = new Decimal(value);
      if (!n.isFinite()) throw new Error("invalid decimal");
      return n.toString();
    };
    const slices = c.slices
      .map((s) => {
        if (
          !s ||
          typeof s.executionKey !== "string" ||
          (s.role !== "open" && s.role !== "close")
        )
          throw new Error("invalid slice");
        return JSON.stringify([
          s.executionKey,
          s.role,
          decimal(s.quantity),
          decimal(s.netCash),
        ]);
      })
      .sort();
    return JSON.stringify([
      issue.code,
      issue.severity,
      c.currency,
      decimal(c.brokerPnl),
      decimal(c.reconstructedPnl),
      slices,
    ]);
  } catch {
    return undefined;
  }
}

export function groupReviewIssues(issues: readonly Issue[]): ReviewEntry[] {
  const groups = new Map<string, Issue[]>();
  const singles: Issue[][] = [];
  for (const issue of issues) {
    const key = fingerprint(issue);
    if (key === undefined) singles.push([issue]);
    else {
      const group = groups.get(key) ?? [];
      group.push(issue);
      groups.set(key, group);
    }
  }
  return [...groups.values(), ...singles]
    .map((group) => {
      const sorted = [...group].sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
      );
      const first = sorted[0];
      if (!first) throw new Error("Empty review issue group");
      const owners = new Map<string, ReconciliationContext["owners"][number]>();
      const sources = new Map<string, Issue["sources"][number]>();
      for (const issue of sorted) {
        for (const owner of fingerprint(issue) === undefined
          ? []
          : (issue.reconciliation?.owners ?? []))
          owners.set(JSON.stringify([owner.kind, owner.id]), owner);
        for (const source of issue.sources)
          sources.set(
            JSON.stringify([source.importId, source.rowNumber]),
            source,
          );
      }
      return {
        ...first,
        issueKeys: [...new Set(sorted.map((issue) => issue.key))].sort(),
        owners: [...owners.values()].sort(
          (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
        ),
        sources: [...sources.values()].sort(
          (a, b) =>
            a.importId.localeCompare(b.importId) || a.rowNumber - b.rowNumber,
        ),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
