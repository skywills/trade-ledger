import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import {
  ResetJournalResponseSchema,
  ResetPreviewSchema,
} from "../../shared/api.js";
import { request, requestJson } from "../api.js";
import { ErrorPanel } from "../components.js";

export function ResetJournal({ onReset }: { onReset: () => void }) {
  const [scope, setScope] = useState<z.infer<typeof ResetPreviewSchema> | null>(
    null,
  );
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (scope === null && !busy && restoreFocus.current) {
      button.current?.focus();
      restoreFocus.current = false;
    }
  }, [scope, busy]);
  async function preview() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setConfirmation("");
    try {
      setScope(await request("/api/maintenance/reset", ResetPreviewSchema));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    if (confirmation !== "RESET") return;
    setBusy(true);
    setError(null);
    try {
      await requestJson(
        "/api/maintenance/reset",
        ResetJournalResponseSchema,
        "POST",
        { confirmation },
      );
      restoreFocus.current = true;
      setScope(null);
      setConfirmation("");
      setNotice(
        "Journal data reset. Model profiles and backups were kept. You can import CSV files again.",
      );
      onReset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h3>Reset journal data</h3>
      <p>
        Permanently clear imported data, trades, builds, review decisions,
        analysis runs and conversations. Model profiles, their verification and
        default selection, and existing backup archives are kept.
      </p>
      <p>
        Create a backup above first if you may need this data later. Wait for
        uploads, replies and jobs to finish before resetting.
      </p>
      {scope === null ? (
        <button
          ref={button}
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void preview()}
        >
          Reset journal data
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void reset();
          }}
        >
          <p role="alert">
            This removes {scope.imports} imports, {scope.conversations}{" "}
            conversations, {scope.decisions} decisions and {scope.builds}{" "}
            builds, plus their related journal records.
          </p>
          <p>Uploaded CSVs and transcripts will also be removed.</p>
          <p className="muted">
            Counts reflect when this confirmation was opened. Reset removes all
            journal data present when confirmed.
          </p>
          <label>
            Type RESET to confirm{" "}
            <input
              value={confirmation}
              disabled={busy}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="action-row">
            <button
              type="submit"
              className="danger"
              disabled={busy || confirmation !== "RESET"}
            >
              {busy ? "Resetting…" : "Confirm reset"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                restoreFocus.current = true;
                setScope(null);
                setConfirmation("");
                setError(null);
              }}
            >
              Keep journal data
            </button>
          </div>
        </form>
      )}
      {notice !== null ? <p role="status">{notice}</p> : null}
      {error !== null ? <ErrorPanel message={error} /> : null}
    </section>
  );
}
