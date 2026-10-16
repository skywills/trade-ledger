import { useState } from "react";
import {
  ImportModelConfigurationResponseSchema,
  ModelConfigurationSchema,
} from "../../shared/api.js";
import { requestJson } from "../api.js";
import { ErrorPanel } from "../components.js";

export function ModelConfiguration({ onImported }: { onImported: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function importFile(file: File) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (file.size > 1024 * 1024)
        throw new Error(
          "Choose a model configuration JSON file smaller than 1 MiB.",
        );
      const parsed = ModelConfigurationSchema.safeParse(
        JSON.parse(await file.text()),
      );
      if (!parsed.success)
        throw new Error(
          "Invalid model configuration. Choose a version 1 JSON export containing model profiles.",
        );
      const result = await requestJson(
        "/api/models/configuration",
        ImportModelConfigurationResponseSchema,
        "POST",
        parsed.data,
      );
      setNotice(
        `Imported ${result.imported} model profile(s). Run Test, then Make default to use an imported profile.`,
      );
      onImported();
    } catch (caught) {
      setError(
        caught instanceof SyntaxError
          ? "Invalid JSON. Choose a model configuration export."
          : caught instanceof Error
            ? caught.message
            : String(caught),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-label="Portable model configuration">
      <p>
        Save model settings for a fresh database. Exports include credential
        references, never API keys. Imports add profiles without overwriting
        existing names; imported profiles require a new compatibility test.
      </p>
      <p>
        <a href="/api/models/configuration" download="model-configuration.json">
          Export model configuration
        </a>
      </p>
      <label>
        Import model configuration{" "}
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) void importFile(file);
          }}
        />
      </label>
      {busy ? <p role="status">Importing model configuration…</p> : null}
      {notice !== null ? <p role="status">{notice}</p> : null}
      {error !== null ? <ErrorPanel message={error} /> : null}
    </section>
  );
}
