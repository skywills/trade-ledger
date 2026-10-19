import { useState } from "react";
import {
  ApiError,
  BackupStartResponseSchema,
  BuildResponseSchema,
  type Job,
  JobEnvelopeSchema,
  JournalEnvelope,
  pollJob,
  RestoreInstructionsSchema,
  RollbackResponseSchema,
  requestJson,
  useJobSignal,
  useJson,
} from "../api.js";
import { BuildBadge, ErrorPanel } from "../components.js";
import { ModelsPanel } from "./ModelsPanel.js";
import { ResetJournal } from "./ResetJournal.js";

/**
 * Maintenance owns rebuild/rollback, backup, and offline restore controls, plus
 * the model profiles panel. It never fabricates any chart or risk metric.
 */
export function MaintenancePage() {
  const jobSignal = useJobSignal();
  const journal = useJson("/api/journal?pageSize=1", JournalEnvelope);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rollbackId, setRollbackId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [backupJob, setBackupJob] = useState<Job | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const restore = useJson(
    "/api/maintenance/restore",
    RestoreInstructionsSchema,
  );

  async function startBuild(mode: "full" | "projection") {
    const signal = jobSignal();
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
      const finished = await pollJob(jobId, setJob, { signal });
      signal.throwIfAborted();
      setJob(finished);
      journal.reload();
    } catch (caught) {
      if (!signal.aborted)
        setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!signal.aborted) setBusy(false);
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

  async function startBackup() {
    const signal = jobSignal();
    setBackupBusy(true);
    setError(null);
    setBackupJob(null);
    try {
      const { jobId } = await requestJson(
        "/api/maintenance/backups",
        BackupStartResponseSchema,
        "POST",
      );
      const finished = await pollJob(jobId, setBackupJob, { signal });
      signal.throwIfAborted();
      setBackupJob(finished);
    } catch (caught) {
      if (!signal.aborted)
        setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!signal.aborted) setBackupBusy(false);
    }
  }

  async function rollback() {
    setConfirmingRollback(false);
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

      <section className="card">
        <h3>Rebuild</h3>
        <p className="muted">
          Recompute strategies from the imported ledger. Use a projection
          rebuild for a quick refresh.
        </p>
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
            <button
              type="button"
              className="danger"
              onClick={() => void cancel()}
            >
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
      </section>
      <section className="card">
        <h3>Rollback</h3>
        <p className="muted">
          Restore a previously retained build. This replaces the active build.
        </p>
        <p>
          <label>
            Build id to restore{" "}
            <input
              value={rollbackId}
              onChange={(event) => setRollbackId(event.target.value)}
            />
          </label>{" "}
          {confirmingRollback ? (
            <>
              <button
                type="button"
                className="danger"
                onClick={() => void rollback()}
              >
                Confirm rollback
              </button>{" "}
              <button
                type="button"
                onClick={() => setConfirmingRollback(false)}
              >
                Keep current build
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (rollbackId.trim() === "") {
                  setError("Enter the id of the build to restore.");
                  return;
                }
                setError(null);
                setConfirmingRollback(true);
              }}
            >
              Rollback
            </button>
          )}
        </p>
        {confirmingRollback ? (
          <p role="alert" className="muted">
            Restore build {rollbackId.trim()}? The active build will be
            replaced.
          </p>
        ) : null}
        {notice !== null ? (
          <p data-testid="rollback-notice" role="status">
            {notice}
          </p>
        ) : null}
      </section>
      <section className="card">
        <h3>Backup</h3>
        <p className="muted">
          Create a downloadable archive of the journal data.
        </p>
        <p>
          <button
            type="button"
            onClick={() => void startBackup()}
            disabled={backupBusy}
          >
            Create backup
          </button>
        </p>
        {backupJob !== null ? (
          <p>
            <span data-testid="backup-status">Backup {backupJob.status}</span>
            {backupJob.status === "complete" ? (
              <>
                {" "}
                <a
                  data-testid="backup-download"
                  href={`/api/maintenance/backups/${backupJob.id}/download`}
                >
                  Download archive
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </section>
      <section className="card">
        <h3>Restore</h3>

        <p>
          Restore is an offline operation; this page never performs one. Follow
          these steps on the host:
        </p>
        <ol data-testid="restore-instructions">
          {(restore.data?.instructions ?? []).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      {error !== null ? <ErrorPanel message={error} /> : null}

      <ResetJournal
        onReset={() => {
          journal.reload();
          setJob(null);
          setBackupJob(null);
          setRollbackId("");
          setNotice(null);
          setError(null);
        }}
      />
      <ModelsPanel />
    </section>
  );
}
