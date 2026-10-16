import { useEffect, useState } from "react";
import type { z } from "zod";
import {
  AnalyticsDetailsResponseSchema,
  type AnalyticsQuery,
  AnalyticsResponseSchema,
  type DetailQuery,
} from "../../shared/analytics.js";
import { ApiError, type RemoteState } from "../api.js";
export function queryString(query: object): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  return p.toString();
}
function useResource<T>(
  path: string | null,
  schema: z.ZodType<T>,
): RemoteState<T> {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{
    key: string | null;
    status: "loading" | "ready" | "error";
    data: T | null;
    error: ApiError | null;
  }>({ key: null, status: "loading", data: null, error: null });
  const key = path === null ? null : `${path}|${nonce}`;
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState({ key, status: "loading", data: null, error: null });
    fetch(path, { signal: controller.signal })
      .then(async (response) => {
        const raw = await response.json();
        if (!response.ok)
          throw new ApiError(
            raw.code ?? "REQUEST_FAILED",
            raw.message ?? "Unable to load analytics.",
            response.status,
          );
        return schema.parse(raw);
      })
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ key, status: "ready", data, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            status: "error",
            data: null,
            error:
              error instanceof ApiError
                ? error
                : new ApiError(
                    "INVALID_RESPONSE",
                    error instanceof Error
                      ? error.message
                      : "Unable to load analytics.",
                    0,
                  ),
          });
      });
    return () => controller.abort();
  }, [path, key, schema]);
  return {
    ...(state.key === key && path
      ? state
      : { status: "loading" as const, data: null, error: null }),
    reload: () => setNonce((n) => n + 1),
  };
}
export function useAnalytics(query: AnalyticsQuery, enabled = true) {
  return useResource(
    enabled ? `/api/analytics?${queryString(query)}` : null,
    AnalyticsResponseSchema,
  );
}
export function useAnalyticsDetails(query: DetailQuery) {
  return useResource(
    `/api/analytics/details?${queryString(query)}`,
    AnalyticsDetailsResponseSchema,
  );
}
