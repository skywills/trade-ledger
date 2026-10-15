import { z } from "zod";
import { AppError } from "../../../shared/errors.js";
import { activeBuildMeta } from "../../builds/service.js";
import { listImports, readPreviewSummary } from "../../imports/service.js";
import {
  type ChatTool,
  type ChatToolContext,
  jsonResult,
  MAX_LIST_ROWS,
  PagingSchemaFields,
  pagedResult,
  refuseInvalidInput,
  UNTRUSTED,
} from "./shared.js";

const Paging = {
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_LIST_ROWS).optional(),
};
const ListImports = z.object({ ...Paging }).strict();
const PreviewId = z.object({ previewId: z.string().min(1) }).strict();
const JobId = z.object({ jobId: z.string().min(1) }).strict();

function listImportsTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "list_imports",
    description: `List committed CSV imports, newest first. ${UNTRUSTED}`,
    inputSchema: {
      type: "object",
      properties: { ...PagingSchemaFields },
      additionalProperties: false,
    },
    approval: "never",
    run: (input) =>
      refuseInvalidInput(() => {
        const q = ListImports.parse(input ?? {});
        const rows = listImports(ctx.store)
          .map(({ id, filename, importedAt, status }) => ({
            id,
            filename,
            importedAt,
            status,
          }))
          .reverse();
        return pagedResult({}, rows, q.offset, q.limit);
      }),
  };
}

function getImportPreviewTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "get_import_preview",
    description: `Read a staged (not yet committed) CSV import preview: counts, issues and whether it can be committed. Call this before commit_import and report the counts to the user. ${UNTRUSTED}`,
    inputSchema: {
      type: "object",
      properties: { previewId: { type: "string" } },
      required: ["previewId"],
      additionalProperties: false,
    },
    approval: "never",
    run: (input) =>
      refuseInvalidInput(() => {
        const { previewId } = PreviewId.parse(input ?? {});
        const summary = readPreviewSummary(ctx.store, previewId, ctx.now());
        return jsonResult({
          id: summary.id,
          filename: summary.filename,
          status: summary.status,
          expiresAt: summary.expiresAt,
          counts: summary.preview.counts,
          issues: summary.preview.issues.slice(0, MAX_LIST_ROWS),
          committable: summary.preview.committable,
        });
      }),
  };
}

function getBuildStatusTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "get_build_status",
    description:
      "The active build id and whether it is stale (inputs changed since it was built).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    approval: "never",
    run: () => refuseInvalidInput(() => jsonResult(activeBuildMeta(ctx.store))),
  };
}

function getJobTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "get_job",
    description: `Read a background job (rebuild or backup) by id: status, progress and error. ${UNTRUSTED}`,
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false,
    },
    approval: "never",
    run: (input) =>
      refuseInvalidInput(() => {
        const { jobId } = JobId.parse(input ?? {});
        const job = ctx.jobs.read(jobId);
        if (job === null)
          throw new AppError(
            "JOB_NOT_FOUND",
            `No job exists for id ${jobId}.`,
            404,
          );
        return jsonResult({ job });
      }),
  };
}

export function statusTools(ctx: ChatToolContext): ChatTool[] {
  return [
    listImportsTool(ctx),
    getImportPreviewTool(ctx),
    getBuildStatusTool(ctx),
    getJobTool(ctx),
  ];
}
