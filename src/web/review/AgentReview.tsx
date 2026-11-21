import { useRef, useState } from "react";
import { AnalysisEnvelopeSchema } from "../../shared/api.js";
import { ThreadEnvelopeSchema } from "../../shared/chat-api.js";
import {
  ApiError,
  RunSummariesEnvelope,
  requestJson,
  useJson,
} from "../api.js";
import { ErrorPanel, Loading, PageLinks, pageNumber } from "../components.js";
import { Link, navigate, useQuery } from "../navigation.js";
import { ProposalList } from "./ProposalList.js";

const PROFILE_CODES = new Set([
  "NO_PROFILE",
  "PROFILE_DISABLED",
  "PROFILE_NOT_VERIFIED",
]);

/**
 * The thread is already seeded with the issue keys, so the draft only needs to
 * say what to do; listing every key made a multi-kilobyte URL and message.
 */
function prefillFor(issueKeys: string[]): string {
  if (issueKeys.length === 0) {
    return "Review the open issues and propose reconciliations.";
  }
  const noun = issueKeys.length === 1 ? "issue" : "issues";
  return `Help me reconcile the ${issueKeys.length} open review ${noun} on this page and propose fixes.`;
}

/** Opens a chat thread seeded with the current review issues. */
export function AskAgent({ issueKeys }: { issueKeys: string[] }) {
  const [error, setError] = useState<{
    message: string;
    code: string | null;
  } | null>(null);

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function open() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const { thread } = await requestJson(
        "/api/chat/threads",
        ThreadEnvelopeSchema,
        "POST",
        { seed: { issueKeys } },
      );
      navigate(
        `/chat/${thread.id}?prefill=${encodeURIComponent(prefillFor(issueKeys))}`,
      );
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { message: err.message, code: err.code }
          : { message: "Could not open the agent.", code: null },
      );
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section>
      <button
        type="button"
        data-testid="ask-agent"
        disabled={busy}
        onClick={() => void open()}
      >
        Ask agent about these issues
      </button>
      {error !== null ? (
        <ErrorPanel message={error.message}>
          {error.code !== null && PROFILE_CODES.has(error.code) ? (
            <a href="/maintenance#model-profiles">
              Configure a model in Maintenance → Models
            </a>
          ) : null}
        </ErrorPanel>
      ) : null}
    </section>
  );
}

function RunDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useJson(`/api/analysis/${id}`, AnalysisEnvelopeSchema);
  if (detail.status === "loading") return <Loading label="Loading analysis…" />;
  if (!detail.data)
    return (
      <ErrorPanel
        message="Could not load the selected analysis."
        onRetry={detail.reload}
      />
    );
  return (
    <ProposalList
      run={detail.data.run}
      onChanged={() => {
        detail.reload();
        onChanged();
      }}
    />
  );
}

/** Lists previous agent analysis runs and their proposals. */
export function PastAnalyses() {
  const query = useQuery();
  const page = pageNumber(query.get("analysisPage"));
  const runs = useJson(
    `/api/analysis?pageSize=20&page=${page}`,
    RunSummariesEnvelope,
  );
  function pageHref(next: number) {
    const params = new URLSearchParams(query);
    params.set("analysisPage", String(next));
    return `/review?${params}`;
  }
  const [openId, setOpenId] = useState<string | null>(null);
  const items = runs.data?.items ?? [];
  if (runs.status === "loading")
    return <Loading label="Loading past analyses…" />;
  if (!runs.data)
    return (
      <ErrorPanel
        message="Could not load past analyses."
        onRetry={runs.reload}
      />
    );
  if (runs.data.total === 0 && page === 1) return null;
  return (
    <section data-testid="past-analyses">
      <h3>Past analyses</h3>
      <ul>
        {items.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className="link"
              aria-expanded={openId === r.id}
              onClick={() => setOpenId(openId === r.id ? null : r.id)}
            >
              {new Date(r.createdAt).toLocaleString()} · {r.status} ·{" "}
              {r.pendingProposals} pending
            </button>
            {r.threadId !== null ? (
              <>
                {" · "}
                <Link to={`/chat/${r.threadId}`}>conversation</Link>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      <PageLinks {...runs.data} href={pageHref} />
      {openId !== null && items.some((run) => run.id === openId) ? (
        <RunDetail id={openId} onChanged={runs.reload} />
      ) : null}
    </section>
  );
}
