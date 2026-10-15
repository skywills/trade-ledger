import { z } from "zod";
import { ALGORITHM_VERSION } from "../../builds/service.js";
import { commitImport, readPreviewSummary } from "../../imports/service.js";
import { LEDGER_PARSER_VERSION } from "../../ledger/normalize.js";
import { startBackupJob } from "../../maintenance/backup-job.js";
import {
  type ChatTool,
  type ChatToolContext,
  jsonResult,
  refuseInvalidInput,
} from "./shared.js";

const CommitInput = z.object({ previewId: z.string().min(1) }).strict();
const RebuildInput = z
  .object({ mode: z.enum(["full", "projection"]) })
  .strict();

function submitRebuild(
  ctx: ChatToolContext,
  mode: "full" | "projection",
): Promise<string> {
  return ctx.scheduler.submit({
    mode,
    parserVersion: LEDGER_PARSER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    signal: new AbortController().signal,
  });
}

function describeCommit(ctx: ChatToolContext, input: unknown): string {
  const parsed = CommitInput.safeParse(input);
  if (!parsed.success) return "Commit an import (invalid input)";
  try {
    const summary = readPreviewSummary(
      ctx.store,
      parsed.data.previewId,
      ctx.now(),
    );
    return `Commit import "${summary.filename}" (${summary.preview.counts.executions} executions, ${summary.preview.counts.quarantined} quarantined) and rebuild`;
  } catch {
    return `Commit import ${parsed.data.previewId} and rebuild`;
  }
}

function commitImportTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "commit_import",
    description:
      "Commit a staged CSV import preview and start a full rebuild, as the Imports page does. Call get_import_preview first and tell the user its counts. The user must Allow this.",
    inputSchema: {
      type: "object",
      properties: { previewId: { type: "string" } },
      required: ["previewId"],
      additionalProperties: false,
    },
    approval: "always",
    describe: (input) => describeCommit(ctx, input),
    run: (input) =>
      refuseInvalidInput(async () => {
        const { previewId } = CommitInput.parse(input ?? {});
        const committed = await commitImport(ctx.store, previewId);
        const jobId = await submitRebuild(ctx, "full");
        return jsonResult({
          ...committed,
          jobId,
          note: "Rebuild started; poll get_job for completion.",
        });
      }),
  };
}

function rebuildTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "rebuild",
    description:
      'Rebuild the ledger ("full") or only the strategy projection ("projection"). The user must Allow this.',
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["full", "projection"] } },
      required: ["mode"],
      additionalProperties: false,
    },
    approval: "always",
    describe: (input) =>
      `Rebuild ledger (${RebuildInput.safeParse(input).data?.mode ?? "?"})`,
    run: (input) =>
      refuseInvalidInput(async () => {
        const { mode } = RebuildInput.parse(input ?? {});
        return jsonResult({ jobId: await submitRebuild(ctx, mode) });
      }),
  };
}

function createBackupTool(ctx: ChatToolContext): ChatTool {
  return {
    name: "create_backup",
    description:
      "Create a backup of the journal data as a background job. The user must Allow this.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    approval: "always",
    describe: () => "Create a backup",
    run: () =>
      refuseInvalidInput(async () =>
        jsonResult({ jobId: await startBackupJob(ctx.store, ctx.jobs) }),
      ),
  };
}

/** Data-changing tools. nax-agent asks the person before every run. */
export function writeTools(ctx: ChatToolContext): ChatTool[] {
  return [commitImportTool(ctx), rebuildTool(ctx), createBackupTool(ctx)];
}
