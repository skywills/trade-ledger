import type { FastifyInstance } from "fastify";
import {
  pageSlice,
  parsePageParams,
  parseSortSpec,
  sortWithAllowlist,
  toEnvelope,
} from "../../shared/api.js";
import { AppError } from "../../shared/errors.js";
import { activeBuildMeta } from "../builds/service.js";
import {
  commitImport,
  discardImportPreviews,
  listImportRows,
  listImports,
  previewImport,
} from "../imports/service.js";
import type { Store } from "../storage/database.js";

const MAX_FILES = 20;

function isFileTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT";
}

function readTimezone(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

/**
 * Import routes. Files stream through the multipart parser under the configured
 * byte limit; filenames are treated strictly as inert metadata because storage
 * paths come only from content hashes.
 */
export async function registerImportRoutes(
  app: FastifyInstance,
  store: Store,
  uploadLimitBytes: number,
): Promise<void> {
  app.post("/api/imports/preview", async (request, reply) => {
    const timezone = readTimezone(
      (request.query as Record<string, unknown> | undefined)?.timezone,
    );
    const previews = [];
    let fileCount = 0;
    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        fileCount += 1;
        if (fileCount > MAX_FILES) {
          throw new AppError(
            "TOO_MANY_FILES",
            `At most ${MAX_FILES} files may be previewed at once.`,
            400,
          );
        }
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await part.toBuffer());
        } catch (error) {
          if (isFileTooLarge(error)) {
            throw new AppError(
              "IMPORT_TOO_LARGE",
              "The uploaded file exceeds the configured upload limit.",
              413,
            );
          }
          throw error;
        }
        previews.push(
          await previewImport(
            store,
            {
              filename: part.filename,
              bytes,
              timezone,
            },
            { limitBytes: uploadLimitBytes },
          ),
        );
      }
    } catch (error) {
      await discardImportPreviews(
        store,
        previews.map((preview) => preview.id),
      );
      throw error;
    }
    if (previews.length === 0) {
      throw new AppError(
        "INVALID_INPUT",
        "At least one file upload is required.",
        400,
      );
    }
    reply.code(201);
    return { previews };
  });

  app.post("/api/imports/:previewId/commit", async (request) => {
    const { previewId } = request.params as { previewId: string };
    return commitImport(store, previewId);
  });

  app.get("/api/imports", async (request) => {
    const params = parsePageParams(request.query);
    const sort = parseSortSpec(
      request.query,
      ["importedAt", "filename", "status"],
      "importedAt",
    );
    const meta = activeBuildMeta(store);
    const all = sortWithAllowlist(listImports(store), sort, {
      importedAt: (entry) => entry.importedAt,
      filename: (entry) => entry.filename,
      status: (entry) => entry.status,
    });
    return toEnvelope(
      pageSlice(all, params),
      params,
      all.length,
      meta.buildId,
      meta.stale,
    );
  });

  app.get("/api/imports/:id/rows", async (request) => {
    const params = parsePageParams(request.query);
    const sort = parseSortSpec(
      request.query,
      ["rowNumber", "section", "kind"],
      "rowNumber",
    );
    const { id } = request.params as { id: string };
    const meta = activeBuildMeta(store);
    const { items, total } = listImportRows(store, id, {
      orderBy: sort.key as "rowNumber" | "section" | "kind",
      direction: sort.direction,
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
    });
    return toEnvelope(items, params, total, meta.buildId, meta.stale);
  });
}
