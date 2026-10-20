import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Markdown } from "../../src/web/chat/Markdown.js";
import { parseInline } from "../../src/web/chat/markdown-parse.js";

const valid = "/api/analytics/export?dataset=summary&expectedBuildId=build-1";
it("only the exact internal build-pinned export route becomes a download", async () => {
  const { isAnalyticsDownloadHref } = await import(
    "../../src/web/chat/markdown-parse.js"
  );
  expect(isAnalyticsDownloadHref(valid)).toBe(true);
  expect(parseInline(`[Download CSV](${valid})`)).toContainEqual({
    kind: "download",
    text: "Download CSV",
    href: valid,
  });
});
it.each([
  "https://example.com/api/analytics/export?expectedBuildId=b",
  "//example.com/api/analytics/export?expectedBuildId=b",
  "javascript:alert(1)",
  "/api/maintenance/reset?expectedBuildId=b",
  "/api/analytics/../analytics/export?expectedBuildId=b",
  "/api/analytics%2fexport?expectedBuildId=b",
  "/api/analytics/export/../export?expectedBuildId=b",
  "/api/analytics/export%3f?expectedBuildId=b",
  "/api/analytics/export?expectedBuildId=b#fragment",
  "/api/analytics/export?expectedBuildId=b\\evil",
  "/api/analytics/export?expectedBuildId=b\nmalicious",
  "/api/analytics/export?expectedBuildId=b\u0000",
  "/api/analytics/export?dataset=summary",
  "/api/analytics/export?expectedBuildId=",
  "/api/analytics/export?expectedBuildId=%20",
])("rejects unsafe or unpinned destination %j", async (href) => {
  const { isAnalyticsDownloadHref } = await import(
    "../../src/web/chat/markdown-parse.js"
  );
  expect(isAnalyticsDownloadHref(href)).toBe(false);
  expect(
    parseInline(`[Download](${href})`).some((t) => t.kind === "download"),
  ).toBe(false);
});
it("renders hostile labels as React text and leaves other markdown links literal", () => {
  const label = '<img src=x onerror="alert(1)">';
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      text: `[${label}](${valid})\n\n[**external**](https://example.com/path_with_underscores)`,
    }),
  );
  expect(html).toContain("download=");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("target=");
  expect(html).toContain(
    "[**external**](https://example.com/path_with_underscores)",
  );
  expect((html.match(/<a /g) ?? []).length).toBe(1);
});
it("code literals and multiline labels never become downloads", () => {
  expect(
    parseInline(`\`[Download](${valid})\``).some((t) => t.kind === "download"),
  ).toBe(false);
  expect(
    parseInline(`[Download\nCSV](${valid})`).some((t) => t.kind === "download"),
  ).toBe(false);
});
