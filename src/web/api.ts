import { useEffect, useState } from "react";
import { z } from "zod";
import { listEnvelopeSchema } from "../shared/api.js";

/**
 * Browser API client. Every monetary value crosses the wire as a string; the
 * client never parses money into a JS number. All responses are validated by a
 * zod schema so a shape change fails loudly instead of rendering `NaN`.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const SourceRefSchema = z.object({
  importId: z.string(),
  rowNumber: z.number().int(),
});

export const IssueSchema = z.object({
  key: z.string(),
  code: z.string(),
  sources: z.array(SourceRefSchema),
  severity: z.enum(["warning", "error"]),
});

const InstrumentSchema = z.object({
  key: z.string(),
  assetClass: z.string(),
  symbol: z.string(),
  underlying: z.string().nullable(),
  conid: z.string().nullable(),
  expiry: z.string().nullable(),
  strike: z.string().nullable(),
  putCall: z.enum(["P", "C"]).nullable(),
  multiplier: z.string().nullable(),
});

export const ExecutionSchema = z.object({
  key: z.string(),
  account: z.string(),
  instrument: InstrumentSchema,
  date: z.string(),
  rawDateTime: z.string(),
  timezone: z.string().nullable(),
  quantity: z.string(),
  price: z.string().nullable(),
  currency: z.string(),
  netCash: z.string(),
  proceeds: z.string().nullable(),
  commission: z.string().nullable(),
  taxes: z.string().nullable(),
  basis: z.string().nullable(),
  brokerPnl: z.string().nullable(),
  action: z.enum(["open", "close", "mixed", "unknown"]),
  event: z.enum([
    "trade",
    "assignment",
    "exercise",
    "expiry",
    "cash_settlement",
    "unsupported",
  ]),
  brokerIds: z.record(z.string(), z.string()),
  codes: z.array(z.string()),
  sources: z.array(SourceRefSchema),
});

export const LotSchema = z.object({
  rowNumber: z.number().int(),
  section: z.string().nullable(),
  fields: z.record(z.string(), z.string()),
  kind: z.string(),
  issues: z.array(IssueSchema),
});

export const AllocationSchema = z.object({
  strategyId: z.string(),
  executionKey: z.string(),
  quantity: z.string(),
  netCash: z.string(),
  brokerPnl: z.string().nullable(),
  pnlEstimated: z.boolean(),
  role: z.enum(["open", "close"]),
});

export const StrategySchema = z.object({
  id: z.string(),
  type: z.string(),
  currency: z.string(),
  description: z.string(),
  openingDate: z.string().nullable(),
  closeDate: z.string().nullable(),
  expiry: z.string().nullable(),
  expiryYear: z.number().int().nullable(),
  status: z.enum(["open", "partially_closed", "closed", "unresolved"]),
  complete: z.boolean(),
  openingAmount: z.string().nullable(),
  cashflow: z.string().nullable(),
  brokerPnl: z.string().nullable(),
  reconstructedPnl: z.string().nullable(),
  positions: z.array(
    z.object({ instrumentKey: z.string(), quantity: z.string() }),
  ),
  reasons: z.array(z.string()),
});

export const StrategyLinkSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.string(),
  sources: z.array(SourceRefSchema),
});

export const ImportSummarySchema = z.object({
  id: z.string(),
  filename: z.string(),
  sha256: z.string(),
  originalFilePath: z.string(),
  importedAt: z.string(),
  status: z.string(),
});

export const ImportPreviewSchema = z.object({
  id: z.string(),
  hash: z.string(),
  capabilities: z.array(z.string()),
  counts: z.object({
    total: z.number(),
    executions: z.number(),
    lots: z.number(),
    summaries: z.number(),
    markers: z.number(),
    quarantined: z.number(),
  }),
  issues: z.array(IssueSchema),
  committable: z.boolean(),
});

export const ImportRowViewSchema = z.object({
  id: z.string(),
  rowNumber: z.number().int(),
  section: z.string().nullable(),
  fields: z.record(z.string(), z.string()),
  kind: z.string(),
  issues: z.array(IssueSchema),
});

export const JobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  progress: z.string().nullable(),
  error: z.string().nullable(),
  input: z.unknown(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export const StrategyDetailSchema = z.object({
  strategy: StrategySchema,
  allocations: z.array(AllocationSchema),
  links: z.array(StrategyLinkSchema),
  buildId: z.string().nullable(),
  stale: z.boolean(),
});

export type SourceRef = z.infer<typeof SourceRefSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type Execution = z.infer<typeof ExecutionSchema>;
export type Lot = z.infer<typeof LotSchema>;
export type Allocation = z.infer<typeof AllocationSchema>;
export type Strategy = z.infer<typeof StrategySchema>;
export type ImportSummary = z.infer<typeof ImportSummarySchema>;
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;
export type ImportRowView = z.infer<typeof ImportRowViewSchema>;
export type Job = z.infer<typeof JobSchema>;
export type StrategyDetail = z.infer<typeof StrategyDetailSchema>;

export const JournalEnvelope = listEnvelopeSchema(StrategySchema);
export const TransactionsEnvelope = listEnvelopeSchema(ExecutionSchema);
export const LotsEnvelope = listEnvelopeSchema(LotSchema);
export const ImportsEnvelope = listEnvelopeSchema(ImportSummarySchema);
export const ReviewEnvelope = listEnvelopeSchema(IssueSchema);
export const ImportRowsEnvelope = listEnvelopeSchema(ImportRowViewSchema);
export const PreviewResponseSchema = z.object({
  previews: z.array(ImportPreviewSchema),
});
export const CommitResponseSchema = z.object({
  importId: z.string(),
  duplicate: z.boolean(),
});
export const BuildResponseSchema = z.object({ jobId: z.string() });
export const JobEnvelopeSchema = z.object({ job: JobSchema });
export const RollbackResponseSchema = z.object({
  buildId: z.string().nullable(),
  stale: z.boolean(),
});
export const BackupStartResponseSchema = z.object({ jobId: z.string() });
export const RestoreInstructionsSchema = z.object({
  offline: z.boolean(),
  instructions: z.array(z.string()),
});
export const DecisionResponseSchema = z.object({
  decision: z.object({
    id: z.string(),
    sequence: z.number().int(),
    kind: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorFrom(response: Response, body: unknown): ApiError {
  const record =
    body !== null && typeof body === "object"
      ? (body as { code?: unknown; message?: unknown; issues?: unknown })
      : {};
  const code = typeof record.code === "string" ? record.code : "REQUEST_FAILED";
  const message =
    typeof record.message === "string"
      ? record.message
      : `Request failed with status ${response.status}.`;
  return new ApiError(code, message, response.status, record.issues);
}

/** Validated JSON request. Never converts strings to numbers. */
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  if (typeof options.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...options, headers });
  const body = await readBody(response);
  if (!response.ok) throw errorFrom(response, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      "INVALID_RESPONSE",
      `Unexpected response shape from ${path}.`,
      response.status,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  method: string,
  payload?: unknown,
): Promise<T> {
  return request(path, schema, {
    method,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

/** Multipart request; the browser sets the boundary, so we never set a type. */
export async function requestMultipart<T>(
  path: string,
  schema: z.ZodType<T>,
  form: FormData,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    body: form,
    headers: { accept: "application/json" },
  });
  const body = await readBody(response);
  if (!response.ok) throw errorFrom(response, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      "INVALID_RESPONSE",
      `Unexpected response shape from ${path}.`,
      response.status,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export type RemoteStatus = "loading" | "ready" | "error";

export interface RemoteState<T> {
  status: RemoteStatus;
  data: T | null;
  error: ApiError | null;
  reload: () => void;
}

/** Fetches a validated JSON resource, exposing server buildId/stale-driven states. */
export function useJson<T>(path: string, schema: z.ZodType<T>): RemoteState<T> {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{
    status: RemoteStatus;
    data: T | null;
    error: ApiError | null;
  }>({ status: "loading", data: null, error: null });

  useEffect(() => {
    const generation = nonce;
    let cancelled = false;
    setState((current) => ({
      status: "loading",
      data: current.data,
      error: null,
    }));
    request(path, schema)
      .then((data) => {
        if (!cancelled && generation === nonce)
          setState({ status: "ready", data, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== nonce) return;
        setState({
          status: "error",
          data: null,
          error:
            error instanceof ApiError
              ? error
              : new ApiError("REQUEST_FAILED", String(error), 0),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path, schema, nonce]);

  return { ...state, reload: () => setNonce((value) => value + 1) };
}

export const TERMINAL_JOB_STATUSES = [
  "complete",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export function isTerminalJob(job: Job): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status);
}

/** Polls a persisted job until it reaches a terminal state, reporting progress. */
export async function pollJob(
  jobId: string,
  onProgress?: (job: Job) => void,
): Promise<Job> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const { job } = await request(`/api/jobs/${jobId}`, JobEnvelopeSchema);
    onProgress?.(job);
    if (isTerminalJob(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new ApiError("JOB_TIMEOUT", "The job did not finish in time.", 0);
}
