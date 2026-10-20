import type { EmbedderToolResult } from "@nathapp/nax-agent";
import { checkBuild } from "../../analytics/details.js";
import {
  type AnalyticsSnapshot,
  readAnalyticsSnapshot,
} from "../../analytics/snapshot.js";
import { type ChatToolContext, jsonResult } from "./shared.js";

export function readToolSnapshot(
  ctx: ChatToolContext,
  expectedBuildId?: string,
): AnalyticsSnapshot {
  const snapshot = readAnalyticsSnapshot(ctx.store, ctx.now());
  checkBuild(snapshot, expectedBuildId);
  return snapshot;
}

export function snapshotMeta(snapshot: AnalyticsSnapshot) {
  return {
    buildId: snapshot.buildId,
    ledgerId: snapshot.ledgerId,
    stale: snapshot.stale,
    generatedAt: snapshot.generatedAt,
  };
}

/** Rows are a preselected window beginning at offset, not the whole dataset. */
export function pageSelectedResult(
  meta: Record<string, unknown>,
  rows: readonly unknown[],
  total: number,
  offset: number,
  limit: number,
  itemsKey: "items" | "issues" = "items",
): EmbedderToolResult {
  const available = Math.min(limit, rows.length);
  let count = available;
  while (true) {
    const result = jsonResult({
      ...meta,
      [itemsKey]: rows.slice(0, count),
      total,
      nextOffset: count > 0 && offset + count < total ? offset + count : null,
      ...(count < available
        ? {
            shortened: true,
            note: "Page shortened to fit; continue from nextOffset.",
          }
        : {}),
    });
    if (!result.isError || count <= 1) return result;
    count = Math.max(1, Math.floor(count * 0.75));
  }
}
