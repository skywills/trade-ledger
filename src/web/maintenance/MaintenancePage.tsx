import { useState } from "react";
import {
  ApiError,
  BuildResponseSchema,
  type Job,
  JobEnvelopeSchema,
  JournalEnvelope,
  pollJob,
  RollbackResponseSchema,
  requestJson,
  useJson,
} from "../api.js";
import { BuildBadge, ErrorPanel } from "../components.js";

/**
 * Maintenance owns rebuild/rollback controls. Models (Task 12) and backup
 * (Task 14) panels extend this page later; for now it never fabricates any
 * chart or risk metric.
 */
export function MaintenancePage() {
  const journal = useJson("/api/journal?pageSize=1", JournalEnvelope);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rollbackId, setRollbackId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  async function startBuild(mode: "full" | "projection") {
    setBusy(true);
    setError(null);
    setNotice(null);
    setJob(null);
    try {
      const { jobId } = await requestJson(
        "/api/builds",
        BuildResponseSchema,
        "POST",
        { mode },
      );
      const finished = await pollJob(jobId, setJob);
      setJob(finished);
      journal.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (job === null) return;
    try {
      const { job: cancelled } = await requestJson(
        `/api/jobs/${job.id}/cancel`,
        JobEnvelopeSchema,
        "POST",
      );
      setJob(cancelled);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function rollback() {
    if (rollbackId.trim() === "") return;
    setError(null);
    setNotice(null);
    try {
      const response = await requestJson(
        `/api/builds/${rollbackId.trim()}/rollback`,
        RollbackResponseSchema,
        "POST",
      );
      setNotice(
        `Restored build ${response.buildId ?? "unknown"}${response.stale ? " (stale)" : ""}.`,
      );
      journal.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    }
  }

  return (
    <section>
      <h2>Maintenance</h2>
      <BuildBadge
        buildId={journal.data?.buildId ?? null}
        stale={journal.data?.stale ?? false}
      />

      <h3>Rebuild</h3>
      <p>
        <button
          type="button"
          onClick={() => void startBuild("full")}
          disabled={busy}
        >
          Rebuild full
        </button>{" "}
        <button
          type="button"
          onClick={() => void startBuild("projection")}
          disabled={busy}
        >
          Rebuild projection
        </button>
        {job !== null &&
        !["complete", "failed", "cancelled", "interrupted"].includes(
          job.status,
        ) ? (
          <button type="button" onClick={() => void cancel()}>
            Cancel job
          </button>
        ) : null}
      </p>
      {job !== null ? (
        <p>
          <span data-testid="job-status">Job {job.status}</span>
          {job.progress !== null ? (
            <span data-testid="job-progress"> · {job.progress}</span>
          ) : null}
          {job.error !== null ? <span> · {job.error}</span> : null}
        </p>
      ) : null}

      <h3>Rollback</h3>
      <p>
        <label>
          Build id to restore{" "}
          <input
            value={rollbackId}
            onChange={(event) => setRollbackId(event.target.value)}
          />
        </label>{" "}
        <button type="button" onClick={() => void rollback()}>
          Rollback
        </button>
      </p>
      {notice !== null ? (
        <p data-testid="rollback-notice" role="status">
          {notice}
        </p>
      ) : null}

      {error !== null ? <ErrorPanel message={error} /> : null}
    </section>
  );
}
