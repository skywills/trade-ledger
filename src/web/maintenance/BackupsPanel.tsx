import { useEffect, useState } from "react";
import { z } from "zod";
import {
  BackupStartResponseSchema,
  isTerminalJob,
  JobSchema,
  requestJson,
  useJson,
} from "../api.js";
import { ErrorPanel } from "../components.js";

const path = "/api/maintenance/backups";
const History = z.object({
  latest: JobSchema.nullable(),
  archives: z.array(z.object({ id: z.string(), createdAt: z.string() })),
});

export function BackupsPanel() {
  const { data, error, status, reload } = useJson(path, History);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const latest = data?.latest;
  const running = latest != null && !isTerminalJob(latest);
  useEffect(() => {
    if (!running || status !== "ready") return;
    const timer = setTimeout(reload, 750);
    return () => clearTimeout(timer);
  }, [running, status, reload]);

  async function start() {
    setStarting(true);
    setStartError(null);
    try {
      await requestJson(path, BackupStartResponseSchema, "POST");
      reload();
    } catch (caught) {
      setStartError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  }
  return (
    <section className="card">
      <h3>Backup</h3>
      <p className="muted">
        Create a downloadable archive of the journal data.
      </p>
      <button
        type="button"
        disabled={starting || running || status === "loading"}
        onClick={() => void start()}
      >
        Create backup
      </button>
      {latest && (
        <p role="status" data-testid="backup-status">
          Backup {latest.status}
          {latest.error && ` · ${latest.error}`}
        </p>
      )}
      {data && data.archives.length > 0 && (
        <>
          <h4>Recent backups</h4>
          <ul>
            {data.archives.map((archive) => (
              <li key={archive.id}>
                <a
                  data-testid="backup-download"
                  href={`/api/maintenance/backups/${archive.id}/download`}
                >
                  Download archive ·{" "}
                  {new Date(archive.createdAt).toLocaleString()} ·{" "}
                  {archive.id.slice(0, 8)}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <ErrorPanel message={error.message} onRetry={reload} />}
      {startError && <ErrorPanel message={startError} />}
    </section>
  );
}
