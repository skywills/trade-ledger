import { useState } from "react";
import {
  type ModelProfileView,
  ModelsResponseSchema,
  SaveProfileResponseSchema,
  SelectDefaultResponseSchema,
  TestProfileSchema,
  THINKING_LEVEL_VALUES,
  type ThinkingLevel,
} from "../../shared/api.js";
import { ApiError, requestJson, useJson } from "../api.js";
import { ErrorPanel, Loading } from "../components.js";

interface Draft {
  name: string;
  mode: "local" | "cloud";
  provider: string;
  protocol: string;
  endpoint: string;
  modelId: string;
  contextWindow: string;
  maxTokens: string;
  timeoutSeconds: string;
  supportsTools: boolean;
  thinkingLevels: string;
  credentialRef: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  mode: "local",
  provider: "openai",
  protocol: "openai-completions",
  endpoint: "http://127.0.0.1:11434/v1",
  modelId: "",
  contextWindow: "8192",
  maxTokens: "1024",
  timeoutSeconds: "30",
  supportsTools: true,
  thinkingLevels: "off",
  credentialRef: "",
};

function parseThinkingLevels(raw: string): ThinkingLevel[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ThinkingLevel =>
      (THINKING_LEVEL_VALUES as readonly string[]).includes(entry),
    );
}

function draftFrom(profile: ModelProfileView): Draft {
  return {
    name: profile.name,
    mode: profile.mode,
    provider: profile.provider,
    protocol: profile.protocol,
    endpoint: profile.endpoint,
    modelId: profile.modelId,
    contextWindow: String(profile.contextWindow),
    maxTokens: String(profile.maxTokens),
    timeoutSeconds: String(profile.timeoutSeconds),
    supportsTools: profile.supportsTools,
    thinkingLevels: profile.thinkingLevels.join(","),
    credentialRef: profile.credentialRef ?? "",
  };
}

function buildPayload(draft: Draft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    mode: draft.mode,
    provider: draft.provider.trim(),
    protocol: draft.protocol.trim(),
    endpoint: draft.endpoint.trim(),
    modelId: draft.modelId.trim(),
    contextWindow: Number(draft.contextWindow),
    maxTokens: Number(draft.maxTokens),
    timeoutSeconds: Number(draft.timeoutSeconds),
    supportsTools: draft.supportsTools,
    thinkingLevels: parseThinkingLevels(draft.thinkingLevels),
    credentialRef:
      draft.credentialRef.trim() === "" ? null : draft.credentialRef.trim(),
  };
}

function compatibilityLabel(profile: ModelProfileView): string {
  const { compatibility } = profile;
  if (compatibility.status === "unchecked") return "Not verified";
  if (compatibility.status === "verified") return "Verified";
  return `${compatibility.status}${compatibility.reason === null ? "" : `: ${compatibility.reason}`}`;
}

/**
 * Model profiles panel. Model discovery is intentionally omitted in the first
 * release: the operator types the model id. Credential sources show only
 * configured/missing status — never a value.
 */
export function ModelsPanel() {
  const models = useJson("/api/models", ModelsResponseSchema);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const profiles = models.data?.profiles ?? [];
  const defaultProfileId = models.data?.defaultProfileId ?? null;

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload = buildPayload(draft);
      if (editingId === null) {
        await requestJson(
          "/api/models",
          SaveProfileResponseSchema,
          "POST",
          payload,
        );
        setNotice(`Created profile ${draft.name}.`);
      } else {
        const current = profiles.find((entry) => entry.id === editingId);
        await requestJson(
          `/api/models/${editingId}`,
          SaveProfileResponseSchema,
          "PUT",
          { ...payload, expectedRevision: current?.revision ?? 1 },
        );
        setNotice(`Updated profile ${draft.name}.`);
      }
      setDraft(EMPTY_DRAFT);
      setEditingId(null);
      models.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function runTest(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { result } = await requestJson(
        `/api/models/${id}/test`,
        TestProfileSchema,
        "POST",
      );
      setNotice(
        result.status === "verified"
          ? "Endpoint verified."
          : `Check ${result.status}${result.reason === null ? "" : `: ${result.reason}`}.`,
      );
      models.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function selectDefault(profile: ModelProfileView) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const confirmCloud = profile.mode === "cloud";
      await requestJson(
        "/api/models/default",
        SelectDefaultResponseSchema,
        "POST",
        {
          id: profile.id,
          ...(confirmCloud ? { confirmCloud: true } : {}),
        },
      );
      setNotice(`Selected ${profile.name} as the default profile.`);
      models.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(profile: ModelProfileView, enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await requestJson(
        `/api/models/${profile.id}`,
        SaveProfileResponseSchema,
        "PUT",
        {
          ...buildPayload(draftFrom(profile)),
          enabled,
          expectedRevision: profile.revision,
        },
      );
      setNotice(
        enabled
          ? `Enabled ${profile.name}.`
          : `Disabled ${profile.name} (retained for provenance).`,
      );
      models.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3>Model profiles</h3>
      <p>
        Local inference is the default; no cloud provider is selected
        automatically. Enter a model id manually and point at a local endpoint.
      </p>

      {models.status === "loading" && models.data === null ? (
        <Loading label="Loading model profiles…" />
      ) : null}
      {models.error !== null ? (
        <ErrorPanel message={models.error.message} onRetry={models.reload} />
      ) : null}

      {profiles.length === 0 ? (
        <p data-testid="models-empty">No model profiles configured yet.</p>
      ) : (
        <table data-testid="models-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Endpoint</th>
              <th>Model</th>
              <th>Credential source</th>
              <th>Compatibility</th>
              <th>Default</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile) => (
              <tr key={profile.id} data-testid={`model-row-${profile.name}`}>
                <td>
                  {profile.name}
                  {!profile.enabled ? (
                    <span data-testid={`model-disabled-${profile.name}`}>
                      {" "}
                      (disabled, revision {profile.revision} retained)
                    </span>
                  ) : null}
                </td>
                <td>{profile.endpoint}</td>
                <td>
                  {profile.modelId}
                  {profile.pricing === null ? " (unpriced)" : ""}
                </td>
                <td>
                  {profile.credential.configured ? "configured" : "missing"} ·{" "}
                  {profile.credential.kind}
                  {profile.credential.kind === "none"
                    ? ""
                    : ` (${profile.credential.label})`}
                </td>
                <td data-testid={`model-compat-${profile.name}`}>
                  {compatibilityLabel(profile)}
                </td>
                <td>
                  {profile.id === defaultProfileId ? (
                    <span data-testid={`model-default-${profile.name}`}>
                      default
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void selectDefault(profile)}
                      disabled={busy || !profile.enabled}
                    >
                      Make default
                    </button>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => void runTest(profile.id)}
                    disabled={busy}
                  >
                    Test
                  </button>{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(draftFrom(profile));
                      setEditingId(profile.id);
                    }}
                    disabled={busy}
                  >
                    Edit
                  </button>{" "}
                  <button
                    type="button"
                    onClick={() => void setEnabled(profile, !profile.enabled)}
                    disabled={busy}
                  >
                    {profile.enabled ? "Disable" : "Enable"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>{editingId === null ? "Add a profile" : "Edit profile"}</h4>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p>
          <label>
            Name{" "}
            <input
              value={draft.name}
              onChange={(event) => update("name", event.target.value)}
            />
          </label>{" "}
          <label>
            Mode{" "}
            <select
              value={draft.mode}
              onChange={(event) =>
                update("mode", event.target.value as Draft["mode"])
              }
            >
              <option value="local">local</option>
              <option value="cloud">cloud</option>
            </select>
          </label>
        </p>
        <p>
          <label>
            Endpoint{" "}
            <input
              value={draft.endpoint}
              onChange={(event) => update("endpoint", event.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            Provider{" "}
            <input
              value={draft.provider}
              onChange={(event) => update("provider", event.target.value)}
            />
          </label>{" "}
          <label>
            Protocol{" "}
            <input
              value={draft.protocol}
              onChange={(event) => update("protocol", event.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            Model id{" "}
            <input
              value={draft.modelId}
              onChange={(event) => update("modelId", event.target.value)}
            />
          </label>{" "}
          <label>
            Thinking levels{" "}
            <input
              value={draft.thinkingLevels}
              onChange={(event) => update("thinkingLevels", event.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            Context window{" "}
            <input
              value={draft.contextWindow}
              onChange={(event) => update("contextWindow", event.target.value)}
            />
          </label>{" "}
          <label>
            Max tokens{" "}
            <input
              value={draft.maxTokens}
              onChange={(event) => update("maxTokens", event.target.value)}
            />
          </label>{" "}
          <label>
            Timeout (s){" "}
            <input
              value={draft.timeoutSeconds}
              onChange={(event) => update("timeoutSeconds", event.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            Credential ref{" "}
            <input
              value={draft.credentialRef}
              placeholder="env:MY_KEY or file:/run/secrets/key"
              onChange={(event) => update("credentialRef", event.target.value)}
            />
          </label>{" "}
          <label>
            <input
              type="checkbox"
              checked={draft.supportsTools}
              onChange={(event) =>
                update("supportsTools", event.target.checked)
              }
            />{" "}
            Supports tools
          </label>
        </p>
        <p>
          <button type="submit" disabled={busy}>
            {editingId === null ? "Create profile" : "Save profile"}
          </button>
          {editingId !== null ? (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft(EMPTY_DRAFT);
              }}
            >
              Cancel
            </button>
          ) : null}
        </p>
      </form>

      {notice !== null ? (
        <p data-testid="models-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error !== null ? <ErrorPanel message={error} /> : null}
    </section>
  );
}
