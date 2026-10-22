import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import type {
  Issue,
  ParsedImport,
  RawRow,
  SourceRef,
} from "../../shared/domain.js";
import { classifyFields } from "./classification.js";
import {
  buildFieldMap,
  canonicalizeHeader,
  isCanonicalField,
  isHeaderRecord,
} from "./headers.js";
import { makeIssue } from "./normalization.js";

export const DEFAULT_FLEX_LIMIT_BYTES = 20971520;

const SECTION_MARKER_PATTERN = /^(?:BOF|BOA|BOS)\b/;

/**
 * Parses an IBKR Flex CSV export. The input must be UTF-8 (an optional BOM is
 * accepted); anything else is rejected with an explanatory issue. Headers are
 * located by field names so repeated accounts and repeated header rows parse
 * correctly, and unknown sections/checksum semantics are surfaced as
 * capability diagnostics instead of guesses. Recognized row kinds are counted
 * as parsed; no sums are inferred. Whole-file issue keys use an empty
 * importId placeholder until the store assigns the import identity.
 *
 * ParsedImport.issues collects only error-severity issues; warnings ride on
 * the RawRow they belong to.
 */
export function parseFlex(
  bytes: Uint8Array,
  limitBytes: number = DEFAULT_FLEX_LIMIT_BYTES,
): ParsedImport {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const capabilities = new Set<string>();
  const issues: Issue[] = [];
  const wholeFileSource: SourceRef = { importId: "", rowNumber: 0 };
  const finish = (rows: RawRow[]): ParsedImport => ({
    hash,
    rows,
    capabilities: [...capabilities].sort(),
    issues,
  });

  if (bytes.byteLength > limitBytes) {
    issues.push(makeIssue("input_oversize", wholeFileSource, "error"));
    return finish([]);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    capabilities.add("encoding:rejected-non-utf8");
    issues.push(makeIssue("invalid_utf8", wholeFileSource, "error"));
    return finish([]);
  }

  let records: string[][];
  try {
    records = parse(text, {
      bom: false,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  } catch {
    issues.push(makeIssue("csv_malformed", wholeFileSource, "error"));
    return finish([]);
  }

  const rows: RawRow[] = [];
  let headerNames: string[] | null = null;

  for (const [index, record] of records.entries()) {
    const rowNumber = index + 1;
    const source: SourceRef = { importId: "", rowNumber };

    if (isHeaderRecord(record)) {
      headerNames = record.map(canonicalizeHeader);
      capabilities.add("layout:header-first");
      let hasUnknownColumn = false;
      for (const name of headerNames) {
        if (name === "") continue;
        if (isCanonicalField(name)) capabilities.add(`field:${name}`);
        else hasUnknownColumn = true;
      }
      if (hasUnknownColumn) capabilities.add("unknown_columns:preserved");
      continue;
    }

    const nonEmptyCells = record.filter((cell) => cell.trim() !== "");
    if (nonEmptyCells.length <= 1) {
      // Strip a leading BOM so the first record's section marker (e.g. "BOF")
      // is recognized even when a decoder leaves it in place.
      const token = (nonEmptyCells[0] ?? "").replace(/^\uFEFF/, "").trim();
      if (token === "") {
        rows.push({
          rowNumber,
          section: null,
          fields: {},
          kind: "marker",
          issues: [],
        });
        continue;
      }
      if (SECTION_MARKER_PATTERN.test(token)) {
        capabilities.add("layout:flex-sectioned");
      } else {
        capabilities.add(`unknown_section:${token}`);
      }
      rows.push({
        rowNumber,
        section: token,
        fields: {},
        kind: "marker",
        issues: [],
      });
      continue;
    }

    if (headerNames === null) {
      const issue = makeIssue("unknown_pre_header_row", source, "error");
      issues.push(issue);
      rows.push({
        rowNumber,
        section: (record[0] ?? "").trim() || null,
        fields: {},
        kind: "quarantine",
        issues: [issue],
      });
      continue;
    }

    const fields = buildFieldMap(record, headerNames);
    const rowIssues: Issue[] = [];
    if (record.length !== headerNames.length) {
      rowIssues.push(makeIssue("column_count_mismatch", source, "warning"));
    }
    const { kind, quarantineCode } = classifyFields(fields);
    if (quarantineCode !== null) {
      const issue = makeIssue(quarantineCode, source, "error");
      rowIssues.push(issue);
      issues.push(issue);
    }
    rows.push({
      rowNumber,
      section: kind === "cash" ? "StatementOfFunds" : null,
      fields,
      kind,
      issues: rowIssues,
    });
  }

  if (headerNames === null) {
    issues.push(makeIssue("missing_header", wholeFileSource, "error"));
  }

  return finish(rows);
}
