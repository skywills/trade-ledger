import { useRef, useState } from "react";
import { AnalysisEnvelopeSchema } from "../../shared/api.js";
import { ThreadEnvelopeSchema } from "../../shared/chat-api.js";
import {
  ApiError,
  RunSummariesEnvelope,
  requestJson,
  useJson,
} from "../api.js";
import { ErrorPanel } from "../components.js";
import { Link, navigate } from "../navigation.js";
import { ProposalList } from "./ProposalList.js";

const PROFILE_CODES = new Set([
  "NO_PROFILE",
  "PROFILE_DISABLED",
  "PROFILE_NOT_VERIFIED",
]);

function prefillFor(issueKeys: string[]): string {
  return issueKeys.length === 0
    ? "Review the open issues and propose reconciliations."
    : `Help me reconcile these review issues: ${issueKeys.join(", ")}.`;
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
            <Link to="/maintenance">
              Configure a model in Maintenance → Models
            </Link>
          ) : null}
        </ErrorPanel>
      ) : null}
    </section>
  );
}

function RunDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useJson(`/api/analysis/${id}`, AnalysisEnvelopeSchema);
  if (detail.data === null) return null;
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
  const runs = useJson("/api/analysis?pageSize=20", RunSummariesEnvelope);
  const [openId, setOpenId] = useState<string | null>(null);
  const items = runs.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section data-testid="past-analyses">
      <h3>Past analyses</h3>
      <ul>
        {items.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className="link"
              onClick={() => setOpenId(r.id)}
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
      {openId !== null ? (
        <RunDetail id={openId} onChanged={runs.reload} />
      ) : null}
    </section>
  );
}
