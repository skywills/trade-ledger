import { parse } from "csv-parse/sync";
import { afterEach, expect, it, vi } from "vitest";
import { serializeAnalyticsCsv } from "../../src/server/analytics/csv.js";
import { parseExportQuery } from "../../src/server/analytics/query.js";
import { readAnalyticsSnapshot } from "../../src/server/analytics/snapshot.js";
import { ALGORITHM_VERSION, rebuild } from "../../src/server/builds/service.js";
import { createChatTools } from "../../src/server/chat/tools/index.js";
import { analyticsApp } from "../helpers/analytics-app.js";
import { callTool, toolContext, toolJson } from "../helpers/chat-tools.js";
import { createTestStore } from "../helpers/store.js";

afterEach(() => vi.useRealTimers());
it("descriptor_download_equals_full_scope_service_export and more_than_50_rows_are_exported", async () => {
  const t = await analyticsApp();
  try {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    const snapshot = readAnalyticsSnapshot(t.store);
    const input = {
      unit: "strategy",
      dataset: "strategies",
      currency: "USD",
      basis: "reconstructed",
      expectedBuildId: snapshot.buildId,
    };
    const descriptor = await toolJson(
      createChatTools(toolContext(t.store)),
      "export_analytics",
      input,
    );
    expect(descriptor.downloadUrl).toMatch(/^\/api\/analytics\/export\?/);
    expect(descriptor).not.toHaveProperty("csv");
    expect(descriptor).not.toHaveProperty("path");
    expect(descriptor.downloadUrl).not.toContain("://");
    const download = await t.app.inject(descriptor.downloadUrl);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("text/csv");
    expect(download.headers["content-disposition"]).toContain(
      descriptor.filename,
    );
    expect(download.body).toBe(
      serializeAnalyticsCsv(snapshot, parseExportQuery(input)).csv,
    );
    expect(parse(download.body, { columns: true })).toHaveLength(679);
    expect(descriptor.filters).toMatchObject({
      currency: "USD",
      basis: "reconstructed",
    });
  } finally {
    await t.close();
  }
});
it("currency_and_basis_are_pinned and query_special_characters_are_encoded", async () => {
  const t = await analyticsApp();
  try {
    const buildId = readAnalyticsSnapshot(t.store).buildId;
    const value = "A & B/#?=+ ü";
    const descriptor = await toolJson(
      createChatTools(toolContext(t.store)),
      "export_analytics",
      {
        unit: "strategy",
        dataset: "summary",
        symbol: value,
        expectedBuildId: buildId,
      },
    );
    const url = new URL(descriptor.downloadUrl, "http://journal.test");
    expect(url.pathname).toBe("/api/analytics/export");
    expect(url.hash).toBe("");
    expect(url.searchParams.get("symbol")).toBe(value);
    expect(url.searchParams.get("currency")).toBe("USD");
    expect(url.searchParams.get("basis")).toBe("broker");
    expect(url.searchParams.get("expectedBuildId")).toBe(buildId);
    expect((await t.app.inject(descriptor.downloadUrl)).statusCode).toBe(200);
  } finally {
    await t.close();
  }
});
it("download_rejects_changed_build", async () => {
  const t = await analyticsApp();
  try {
    const descriptor = await toolJson(
      createChatTools(toolContext(t.store)),
      "export_analytics",
      {
        unit: "strategy",
        dataset: "summary",
        expectedBuildId: readAnalyticsSnapshot(t.store).buildId,
      },
    );
    await rebuild(t.store, {
      mode: "full",
      parserVersion: "flex-v1",
      algorithmVersion: ALGORITHM_VERSION,
      signal: new AbortController().signal,
    });
    expect((await t.app.inject(descriptor.downloadUrl)).statusCode).toBe(409);
  } finally {
    await t.close();
  }
});
it("rejects caller URLs, paths, filenames and invalid dates on a valid build", async () => {
  const t = await analyticsApp();
  try {
    const tools = createChatTools(toolContext(t.store));
    const base = {
      unit: "strategy",
      dataset: "summary",
      expectedBuildId: readAnalyticsSnapshot(t.store).buildId,
    };
    for (const extra of [
      { url: "https://example.com" },
      { path: "/tmp/export.csv" },
      { filename: "export.csv" },
      { from: "2026-02-30" },
      { from: "2026-10-20", to: "2026-10-01" },
    ])
      expect(
        await callTool(tools, "export_analytics", { ...base, ...extra }),
      ).toMatchObject({ isError: true });
  } finally {
    await t.close();
  }
});
it("missing or empty builds do not produce a download descriptor", async () => {
  const t = await createTestStore();
  try {
    const tools = createChatTools(toolContext(t.store));
    for (const input of [
      { dataset: "summary" },
      { dataset: "summary", expectedBuildId: "missing" },
    ])
      expect(await callTool(tools, "export_analytics", input)).toMatchObject({
        isError: true,
      });
  } finally {
    await t.dispose();
  }
});
