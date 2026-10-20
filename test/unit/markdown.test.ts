import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../../src/web/chat/markdown-parse.js";

describe("parseBlocks", () => {
  it("parses a pipe table with header, alignment row and body", () => {
    const blocks = parseBlocks(
      "| Currency | P&L |\n|---|---:|\n| USD | **1,236.79** |",
    );
    expect(blocks).toEqual([
      {
        kind: "table",
        header: ["Currency", "P&L"],
        align: [null, "right"],
        rows: [["USD", "**1,236.79**"]],
      },
    ]);
  });

  it("parses headings, paragraphs and lists", () => {
    const blocks = parseBlocks(
      "## Summary\nFirst line\nsecond line\n\n- one\n- two\n\n1. a\n2. b",
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "Summary" },
      { kind: "paragraph", text: "First line\nsecond line" },
      { kind: "list", ordered: false, items: ["one", "two"] },
      { kind: "list", ordered: true, items: ["a", "b"] },
    ]);
  });

  it("keeps fenced code verbatim, including markdown-looking content", () => {
    const blocks = parseBlocks("```ts\n| a | b |\n**x**\n```\nafter");
    expect(blocks).toEqual([
      { kind: "code", text: "| a | b |\n**x**" },
      { kind: "paragraph", text: "after" },
    ]);
  });

  it("treats an unterminated fence as code to the end (streaming)", () => {
    expect(parseBlocks("```\npartial")).toEqual([
      { kind: "code", text: "partial" },
    ]);
  });

  it("does not treat a single pipe line without a separator as a table", () => {
    expect(parseBlocks("a | b")).toEqual([
      { kind: "paragraph", text: "a | b" },
    ]);
  });
});

describe("parseInline", () => {
  it("splits bold, italic and inline code", () => {
    expect(parseInline("a **b** _c_ `d` *e*")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", text: "b" },
      { kind: "text", text: " " },
      { kind: "em", text: "c" },
      { kind: "text", text: " " },
      { kind: "code", text: "d" },
      { kind: "text", text: " " },
      { kind: "em", text: "e" },
    ]);
  });

  it("leaves HTML-looking text as plain text", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
  });

  it("does not italicise underscores inside words or lone asterisks", () => {
    expect(parseInline("missing_multiplier 2 * 3")).toEqual([
      { kind: "text", text: "missing_multiplier 2 * 3" },
    ]);
  });
});

describe("parseBlocks performance", () => {
  it("stays linear on a long whitespace line after a pipe line", () => {
    const started = performance.now();
    parseBlocks(`a | b\n${" ".repeat(30_000)}|\n`);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
