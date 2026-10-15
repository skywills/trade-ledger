import { useState } from "react";
import { ModelsResponseSchema } from "../../shared/api.js";
import {
  type AttachmentDto,
  SendMessageResponseSchema,
  ThreadEnvelopeSchema,
} from "../../shared/chat-api.js";
import { ApiError, JournalEnvelope, requestJson, useJson } from "../api.js";
import { Link, navigate } from "../navigation.js";
import { Composer } from "./Composer.js";
import { SparkleIcon } from "./icons.js";

const SUGGESTIONS = [
  "What is my realised P&L by month this year?",
  "Which positions are still open?",
  "Summarise the review issues I should fix first.",
  "Import the attached CSV and tell me what changed.",
] as const;

type Model = {
  name: string;
  modelId: string;
  mode: string;
  ready: boolean;
};

function useDefaultModel(): { model: Model | null; loading: boolean } {
  const models = useJson("/api/models", ModelsResponseSchema);
  const profile = models.data?.profiles.find(
    (p) => p.id === models.data?.defaultProfileId,
  );
  if (profile === undefined) {
    return { model: null, loading: models.status === "loading" };
  }
  const ready = profile.enabled && profile.compatibility.status === "verified";
  return {
    model: {
      name: profile.name,
      modelId: profile.modelId,
      mode: profile.mode,
      ready,
    },
    loading: false,
  };
}

function StatusLine({ model }: { model: Model }) {
  const journal = useJson("/api/journal?pageSize=1", JournalEnvelope);
  const data = journal.data;
  return (
    <p className="agent-status">
      <span className="status-dot" aria-hidden="true" />
      {model.name} <span className="muted">({model.modelId})</span>
      {data !== null ? (
        <span className="muted">
          {" "}
          · {data.total} strategies
          {data.buildId === null ? " · no build yet" : ""}
          {data.stale ? " · build is stale" : ""}
        </span>
      ) : null}
    </p>
  );
}

function NoModel() {
  return (
    <div className="agent-setup" role="status">
      <p>
        <strong>Set up a model to start.</strong> The agent needs a verified,
        enabled default model profile.
      </p>
      <Link to="/maintenance" className="button-link">
        Open Maintenance → Models
      </Link>
    </div>
  );
}

async function startConversation(
  text: string,
  attachments: AttachmentDto[],
  cloudConfirmed: boolean,
): Promise<void> {
  const { thread } = await requestJson(
    "/api/chat/threads",
    ThreadEnvelopeSchema,
    "POST",
    {
      cloudConfirmed,
    },
  );
  await requestJson(
    `/api/chat/threads/${thread.id}/messages`,
    SendMessageResponseSchema,
    "POST",
    {
      clientMessageId: crypto.randomUUID(),
      text,
      attachments,
    },
  );
  navigate(`/chat/${thread.id}`);
}

function CloudConsent({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="cloud-consent">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      Allow sending my journal data to this cloud model
    </label>
  );
}

/** The landing page: one input, a few suggested questions, and model status. */
export function AgentHome({ onStarted }: { onStarted: () => void }) {
  const { model, loading } = useDefaultModel();
  const [draft, setDraft] = useState({ text: "", nonce: 0 });
  const [cloudConfirmed, setCloudConfirmed] = useState(false);
  const cloud = model?.mode === "cloud";
  const send = async (text: string, attachments: AttachmentDto[]) => {
    try {
      await startConversation(text, attachments, cloudConfirmed);
      onStarted();
    } catch (err) {
      throw err instanceof ApiError
        ? err
        : new Error("Could not start a conversation.");
    }
  };
  return (
    <section className="agent-home" aria-labelledby="agent-home-title">
      <div className="agent-hero">
        <span className="agent-mark" aria-hidden="true">
          <SparkleIcon />
        </span>
        <h2 id="agent-home-title">Ask about your journal</h2>
        <p className="muted">
          Questions about P&amp;L, positions and review issues are answered from
          your active build. Imports, rebuilds and backups always ask for your
          approval first.
        </p>
        {model !== null ? <StatusLine model={model} /> : null}
      </div>
      {!loading && (model === null || !model.ready) ? (
        <NoModel />
      ) : (
        <>
          <Composer
            key={draft.nonce}
            disabled={loading || (cloud && !cloudConfirmed)}
            initialText={draft.text}
            onSend={send}
            autoFocus
            footer={
              cloud ? (
                <CloudConsent
                  checked={cloudConfirmed}
                  onChange={setCloudConfirmed}
                />
              ) : null
            }
          />
          <ul className="suggestions" aria-label="Suggested questions">
            {SUGGESTIONS.map((text) => (
              <li key={text}>
                <button
                  type="button"
                  className="suggestion"
                  onClick={() =>
                    setDraft((d) => ({ text, nonce: d.nonce + 1 }))
                  }
                >
                  {text}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
