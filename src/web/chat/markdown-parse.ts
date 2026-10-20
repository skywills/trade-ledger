/**
 * A deliberately small markdown subset for agent replies: headings, paragraphs,
 * bullet/numbered lists, pipe tables, fenced code and inline bold/italic/code.
 * It produces plain data only; rendering builds React text nodes, so model or
 * broker text can never become HTML.
 */
export type Align = "left" | "right" | "center" | null;

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { kind: "code"; text: string };

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "download"; text: string; href: string };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,4})\s+(.+)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const SEPARATOR_CELL = /^:?-{3,}:?$/;

/** `|---|:--:|` style row. A split-and-test check, linear in the line length. */
function isTableSeparator(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => SEPARATOR_CELL.test(cell));
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function isTableStart(lines: string[], i: number): boolean {
  const next = lines[i + 1];
  return (
    (lines[i] ?? "").includes("|") &&
    next !== undefined &&
    isTableSeparator(next)
  );
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  return (
    line.trim() === "" ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    isTableStart(lines, i)
  );
}

type Step = { block: Block; next: number };

function readCode(lines: string[], start: number): Step {
  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length && !FENCE.test(lines[i] ?? "")) {
    body.push(lines[i] ?? "");
    i += 1;
  }
  return { block: { kind: "code", text: body.join("\n") }, next: i + 1 };
}

function readTable(lines: string[], start: number): Step {
  const header = splitRow(lines[start] ?? "");
  const align = splitRow(lines[start + 1] ?? "").map(alignOf);
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && (lines[i] ?? "").includes("|")) {
    rows.push(splitRow(lines[i] ?? ""));
    i += 1;
  }
  return { block: { kind: "table", header, align, rows }, next: i };
}

function readList(lines: string[], start: number, ordered: boolean): Step {
  const pattern = ordered ? NUMBERED : BULLET;
  const items: string[] = [];
  let i = start;
  let match = pattern.exec(lines[i] ?? "");
  while (match !== null) {
    items.push(match[1] ?? "");
    i += 1;
    match = pattern.exec(lines[i] ?? "");
  }
  return { block: { kind: "list", ordered, items }, next: i };
}

function readParagraph(lines: string[], start: number): Step {
  const body = [lines[start] ?? ""];
  let i = start + 1;
  while (i < lines.length && !startsBlock(lines, i)) {
    body.push(lines[i] ?? "");
    i += 1;
  }
  const text = body.map((line) => line.trim()).join("\n");
  return { block: { kind: "paragraph", text }, next: i };
}

function readBlock(lines: string[], i: number): Step {
  const line = lines[i] ?? "";
  if (FENCE.test(line)) return readCode(lines, i);
  const heading = HEADING.exec(line);
  if (heading !== null) {
    const level = heading[1]?.length ?? 1;
    const text = (heading[2] ?? "").trim();
    return { block: { kind: "heading", level, text }, next: i + 1 };
  }
  if (isTableStart(lines, i)) return readTable(lines, i);
  if (BULLET.test(line)) return readList(lines, i, false);
  if (NUMBERED.test(line)) return readList(lines, i, true);
  return readParagraph(lines, i);
}

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] ?? "").trim() === "") {
      i += 1;
      continue;
    }
    const step = readBlock(lines, i);
    blocks.push(step.block);
    i = step.next;
  }
  return blocks;
}

/** Only the existing build-pinned same-origin CSV route is navigable. */
export function isAnalyticsDownloadHref(value: string): boolean {
  if (
    !value.startsWith("/api/analytics/export?") ||
    [...value].some(
      (char) =>
        char.charCodeAt(0) <= 32 ||
        char.charCodeAt(0) === 127 ||
        char === "\\" ||
        char === "#",
    )
  )
    return false;
  try {
    const url = new URL(value, "https://journal.invalid");
    return (
      url.pathname === "/api/analytics/export" &&
      url.hash === "" &&
      url.searchParams.getAll("expectedBuildId").length === 1 &&
      Boolean(url.searchParams.get("expectedBuildId")?.trim())
    );
  } catch {
    return false;
  }
}

const INLINE =
  /(`[^`\n]+`)|(\[[^[\]\r\n]+\]\([^\r\n]*?\))|(\*\*[^*\n]+\*\*)|(\*[^*\s\n][^*\n]*\*)|((?<![A-Za-z0-9])_[^_\s\n][^_\n]*_(?![A-Za-z0-9]))/g;

function tokenFor(raw: string): Inline {
  if (raw.startsWith("[")) {
    const split = raw.indexOf("](");
    const href = raw.slice(split + 2, -1);
    return isAnalyticsDownloadHref(href)
      ? { kind: "download", text: raw.slice(1, split), href }
      : { kind: "text", text: raw };
  }
  if (raw.startsWith("`")) return { kind: "code", text: raw.slice(1, -1) };
  if (raw.startsWith("**")) return { kind: "strong", text: raw.slice(2, -2) };
  return { kind: "em", text: raw.slice(1, -1) };
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: "text", text: text.slice(last, index) });
    out.push(tokenFor(match[0]));
    last = index + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
