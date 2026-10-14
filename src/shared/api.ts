import { z } from "zod";
import type { Id } from "./domain.js";
import { AppError } from "./errors.js";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface PageParams {
  page: number;
  pageSize: number;
}

export type SortDirection = "asc" | "desc";

export interface SortSpec {
  key: string;
  direction: SortDirection;
}

/**
 * The exact envelope every paginated list endpoint returns. `buildId` and
 * `stale` are always present so the browser never has to guess which build a
 * page was served from; both are `null`/`false` when no generation is active.
 */
export interface ListEnvelope<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  buildId: Id | null;
  stale: boolean;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  issues?: unknown;
}

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.unknown()).optional(),
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

export type JobDto = z.infer<typeof JobSchema>;

export function listEnvelopeSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
    total: z.number().int().min(0),
    buildId: z.string().nullable(),
    stale: z.boolean(),
  });
}

function invalid(message: string): AppError {
  return new AppError("INVALID_INPUT", message, 400);
}

function readBoundedInt(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw invalid(`${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw invalid(`${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

/** Parses and bounds the shared page/pageSize query parameters. */
export function parsePageParams(query: unknown): PageParams {
  const record = (query ?? {}) as Record<string, unknown>;
  return {
    page: readBoundedInt(record.page, "page", 1, Number.MAX_SAFE_INTEGER, 1),
    pageSize: readBoundedInt(
      record.pageSize,
      "pageSize",
      1,
      MAX_PAGE_SIZE,
      DEFAULT_PAGE_SIZE,
    ),
  };
}

/**
 * Parses a sort request against a fixed allowlist. The returned key always
 * comes from `allowed`, so downstream SQL never interpolates user input.
 */
export function parseSortSpec(
  query: unknown,
  allowed: readonly string[],
  fallbackKey: string,
): SortSpec {
  const record = (query ?? {}) as Record<string, unknown>;
  const rawKey = record.sort;
  let key = fallbackKey;
  if (rawKey !== undefined) {
    if (typeof rawKey !== "string" || !allowed.includes(rawKey)) {
      throw invalid(`Unknown sort key: ${String(rawKey)}.`);
    }
    key = rawKey;
  }
  const rawOrder = record.order;
  let direction: SortDirection = "asc";
  if (rawOrder !== undefined) {
    if (rawOrder !== "asc" && rawOrder !== "desc") {
      throw invalid("order must be asc or desc.");
    }
    direction = rawOrder;
  }
  return { key, direction };
}

function compareValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number")
    return left - right;
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable in-memory sort driven by a fixed accessor allowlist. */
export function sortWithAllowlist<T>(
  items: readonly T[],
  spec: SortSpec,
  accessors: Record<string, (item: T) => string | number>,
): T[] {
  const accessor = accessors[spec.key];
  if (accessor === undefined) return [...items];
  const factor = spec.direction === "desc" ? -1 : 1;
  return [...items].sort(
    (left, right) => factor * compareValues(accessor(left), accessor(right)),
  );
}

export function pageSlice<T>(items: readonly T[], params: PageParams): T[] {
  const start = (params.page - 1) * params.pageSize;
  return items.slice(start, start + params.pageSize);
}

export function toEnvelope<T>(
  items: readonly T[],
  params: PageParams,
  total: number,
  buildId: Id | null,
  stale: boolean,
): ListEnvelope<T> {
  return {
    items: [...items],
    page: params.page,
    pageSize: params.pageSize,
    total,
    buildId,
    stale,
  };
}
