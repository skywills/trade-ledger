import { useRef, useState } from "react";
import type { z } from "zod";
import { request, useJobSignal, useJson } from "../api.js";

interface OptionPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  buildId: string | null;
}

/** Load additional choices on demand and keep earlier selections in the form. */
export function useDecisionOptions<T>(
  path: string,
  schema: z.ZodType<OptionPage<T>>,
) {
  const first = useJson(path, schema);
  const [more, setMore] = useState<{
    first: OptionPage<T>;
    items: T[];
    page: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const signalFor = useJobSignal(path);
  const extra = more?.first === first.data ? more : null;
  const items = [...(first.data?.items ?? []), ...(extra?.items ?? [])];
  async function loadMore() {
    const original = first.data;
    if (!original || inFlight.current) return;
    const signal = signalFor();
    const page = (extra?.page ?? 1) + 1;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await request(`${path}&page=${page}`, schema, { signal });
      if (signal.aborted) return;
      if (
        next.buildId !== original.buildId ||
        next.total !== original.total ||
        next.page !== page
      ) {
        first.reload();
        setError(
          "The available records changed. The choices have been refreshed.",
        );
      } else {
        setMore({
          first: original,
          items: [...(extra?.items ?? []), ...next.items],
          page,
        });
      }
    } catch (caught) {
      if (!signal.aborted)
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not load more records.",
        );
    } finally {
      inFlight.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  return { ...first, items, loadMore, busy, moreError: error };
}
