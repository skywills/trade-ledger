import { z } from "zod";
import { AppError } from "../../../shared/errors.js";
import { listImportRows, readImportRow } from "../../imports/service.js";
import {
  type ChatTool,
  type ChatToolContext,
  defineReadTool,
  jsonResult,
  PagingInput,
} from "./shared.js";
import {
  pageSelectedResult,
  readToolSnapshot,
  snapshotMeta,
} from "./snapshot.js";

const Reference = {
  importId: z.string().min(1),
  expectedBuildId: z.string().min(1).optional(),
};
const Rows = z.object({ ...Reference, ...PagingInput }).strict();
const Field = z
  .object({
    ...Reference,
    rowNumber: z.number().int().positive(),
    field: z.string().min(1),
    valueOffset: z.number().int().min(0).default(0),
  })
  .strict();
const FIELD_CHUNK_CHARACTERS = 1_000;

export function importEvidenceTools(ctx: ChatToolContext): ChatTool[] {
  return [
    defineReadTool(
      "get_import_rows",
      "Page immutable retained source-row metadata, including quarantined rows absent from normalized executions. fieldNames inventories raw fields; use get_import_row_field for exact private values. Source evidence cannot be edited.",
      Rows,
      (q) =>
        ctx.store.db.transaction(() => {
          const snapshot = readToolSnapshot(ctx, q.expectedBuildId);
          const result = listImportRows(ctx.store, q.importId, {
            orderBy: "rowNumber",
            direction: "asc",
            offset: q.offset,
            limit: q.limit,
          });
          const rows = result.items.map((row) => ({
            rowNumber: row.rowNumber,
            section: row.section,
            kind: row.kind,
            issues: row.issues.map(({ code, severity }) => ({
              code,
              severity,
            })),
            fieldNames: Object.keys(row.fields),
          }));
          return pageSelectedResult(
            { ...snapshotMeta(snapshot), importId: q.importId },
            rows,
            result.total,
            q.offset,
            q.limit,
          );
        })(),
    ),
    defineReadTool(
      "get_import_row_field",
      "Read one raw source field in chunks of at most 1,000 Unicode characters. Continue from nextValueOffset until null; totalCharacters describes the full value. PRIVATE broker evidence; never append it to a sanitized technical report.",
      Field,
      (q) =>
        ctx.store.db.transaction(() => {
          const snapshot = readToolSnapshot(ctx, q.expectedBuildId);
          const row = readImportRow(ctx.store, q.importId, q.rowNumber);
          if (!Object.hasOwn(row.fields, q.field))
            throw new AppError(
              "IMPORT_FIELD_NOT_FOUND",
              "This field does not exist in the retained row.",
              404,
            );
          const characters = Array.from(row.fields[q.field] ?? "");
          let count = Math.max(
            0,
            Math.min(FIELD_CHUNK_CHARACTERS, characters.length - q.valueOffset),
          );
          // JSON escaping and UTF-16 surrogate pairs can exceed a model line
          // before the code-point ceiling is reached. Advance only by what fits.
          while (true) {
            const end = q.valueOffset + count;
            const result = jsonResult({
              ...snapshotMeta(snapshot),
              importId: q.importId,
              rowNumber: q.rowNumber,
              field: q.field,
              value: characters.slice(q.valueOffset, end).join(""),
              totalCharacters: characters.length,
              nextValueOffset: end < characters.length ? end : null,
            });
            if (!result.isError || count <= 1) return result;
            count = Math.max(1, Math.floor(count * 0.75));
          }
        })(),
    ),
  ];
}
