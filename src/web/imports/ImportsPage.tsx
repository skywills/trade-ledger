import { type DragEvent, useState } from "react";
import {
  BuildResponseSchema,
  CommitResponseSchema,
  type ImportPreview,
  ImportRowsEnvelope,
  ImportsEnvelope,
  PreviewResponseSchema,
  pollJob,
  requestJson,
  requestMultipart,
  useJson,
} from "../api.js";
import { ErrorPanel, Loading } from "../components.js";
import { Link, useQuery } from "../navigation.js";

function ImportRowDetail({
  importId,
  rowNumber,
}: {
  importId: string;
  rowNumber: number;
}) {
  const rows = useJson(
    `/api/imports/${importId}/rows?pageSize=100`,
    ImportRowsEnvelope,
  );
  if (rows.status === "loading") return <Loading label="Loading source row…" />;
  if (rows.status === "error")
    return <ErrorPanel message="Failed to load the source row." />;
  const row = (rows.data?.items ?? []).find(
    (entry) => entry.rowNumber === rowNumber,
  );
  if (row === undefined) return <p>Source row {rowNumber} not found.</p>;
  return (
    <div data-testid="import-row-detail" className="row-detail">
      <h3>
        Import row {row.rowNumber} · {row.kind}
      </h3>
      <dl>
        {Object.entries(row.fields)
          .filter(([, value]) => value !== "")
          .map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

type ImportStep = "idle" | "uploading" | "committing" | "building";

const STEPS: { id: Exclude<ImportStep, "idle">; label: string }[] = [
  { id: "uploading", label: "Validate" },
  { id: "committing", label: "Commit" },
  { id: "building", label: "Rebuild journal" },
];

const STEP_LABEL: Record<ImportStep, string> = {
  idle: "",
  uploading: "Uploading and validating files…",
  committing: "Committing imports…",
  building: "Rebuilding the journal…",
};

function stepClass(id: ImportStep, current: ImportStep): string {
  const order = STEPS.map((entry) => entry.id);
  const position = order.indexOf(id as Exclude<ImportStep, "idle">);
  const now = order.indexOf(current as Exclude<ImportStep, "idle">);
  if (position < now) return "step-done";
  return position === now ? "step-current" : "step-todo";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Import screen: preview, commit, auto-rebuild and raw row drilldown. */
export function ImportsPage() {
  const imports = useJson("/api/imports?pageSize=100", ImportsEnvelope);
  const query = useQuery();
  const selectedImport = query.get("import");
  const selectedRow = Number(query.get("row") ?? "");

  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<ImportStep>("idle");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<ImportPreview[]>([]);
  const [result, setResult] = useState<string | null>(null);

  async function onConfirm() {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setPreviews([]);
    try {
      setStep("uploading");
      const form = new FormData();
      for (const file of files) form.append("files", file);
      const previewResponse = await requestMultipart(
        "/api/imports/preview",
        PreviewResponseSchema,
        form,
      );
      setPreviews(previewResponse.previews);

      setStep("committing");
      const commits = [];
      for (const entry of previewResponse.previews) {
        commits.push(
          await requestJson(
            `/api/imports/${entry.id}/commit`,
            CommitResponseSchema,
            "POST",
          ),
        );
      }
      const duplicates = commits.filter((entry) => entry.duplicate).length;

      setStep("building");
      const build = await requestJson(
        "/api/builds",
        BuildResponseSchema,
        "POST",
        { mode: "full" },
      );
      const job = await pollJob(build.jobId);
      const prefix = duplicates > 0 ? "Already imported (duplicate). " : "";
      setResult(`${prefix}Import complete. Build ${job.status}.`);
      imports.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      setStep("idle");
    }
  }

  function addFiles(list: FileList | null) {
    const picked = Array.from(list ?? []).filter(
      (file) =>
        file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv",
    );
    setFiles(picked);
    setResult(null);
    setError(
      picked.length === 0 && (list?.length ?? 0) > 0
        ? "Only .csv files can be imported."
        : null,
    );
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (!busy) addFiles(event.dataTransfer.files);
  }

  return (
    <section>
      <h2>Imports</h2>
      <section
        className={`dropzone${dragging ? " dropzone-active" : ""}`}
        aria-label="Upload area"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className="dropzone-title">Drop IBKR Flex CSV files here</p>
        <p className="muted">or choose them from your computer</p>
        <input
          type="file"
          multiple
          accept=".csv,text/csv"
          aria-label="CSV files"
          disabled={busy}
          onChange={(event) => addFiles(event.target.files)}
        />
        {files.length > 0 ? (
          <ul className="file-list" aria-label="Selected files">
            {files.map((file) => (
              <li key={`${file.name}-${file.size}-${file.lastModified}`}>
                {file.name}{" "}
                <span className="muted">({formatBytes(file.size)})</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <p>
        <button
          type="button"
          className="primary"
          onClick={onConfirm}
          disabled={busy || files.length === 0}
        >
          Confirm import
        </button>
        {files.length === 0 && !busy ? (
          <span className="muted">
            {" "}
            Choose at least one CSV file to continue.
          </span>
        ) : null}
      </p>
      {busy ? (
        <ol className="steps" aria-label="Import progress">
          {STEPS.map((entry) => (
            <li
              key={entry.id}
              aria-current={entry.id === step ? "step" : undefined}
              className={stepClass(entry.id, step)}
            >
              {entry.label}
            </li>
          ))}
        </ol>
      ) : null}
      {busy ? <Loading label={STEP_LABEL[step]} /> : null}

      {error !== null ? <ErrorPanel message={error} /> : null}
      {result !== null ? (
        <div className="success-panel">
          <p data-testid="import-result" role="status">
            {result}
          </p>
          <Link to="/journal">See your strategies →</Link>
        </div>
      ) : null}

      {previews.length > 0 ? (
        <div data-testid="import-preview" className="preview">
          <h3>Import preview</h3>
          {previews.map((preview) => (
            <div key={preview.id}>
              <p>
                <span
                  className={`badge ${preview.committable ? "badge-success" : "badge-danger"}`}
                >
                  {preview.committable ? "Committable" : "Not committable"}
                </span>{" "}
                <span className="badge">
                  {preview.counts.executions} executions
                </span>{" "}
                <span className="badge">{preview.counts.lots} lots</span>{" "}
                <span
                  className={`badge ${preview.counts.quarantined > 0 ? "badge-warn" : ""}`}
                >
                  {preview.counts.quarantined} quarantined
                </span>
              </p>
              <details>
                <summary>Detected capabilities</summary>
                <p>{preview.capabilities.join(", ") || "none"}</p>
              </details>
              {preview.issues.length > 0 ? (
                <ul>
                  {preview.issues.map((issue) => (
                    <li key={issue.key}>
                      {issue.severity}: {issue.code}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <h3>Committed imports</h3>
      {imports.status === "loading" ? (
        <Loading label="Loading imports…" />
      ) : imports.status === "error" ? (
        <ErrorPanel
          message="Failed to load imports."
          onRetry={imports.reload}
        />
      ) : (
        <table aria-label="Imports">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Status</th>
              <th>Imported at</th>
              <th>Hash</th>
              <th>Rows</th>
            </tr>
          </thead>
          <tbody>
            {(imports.data?.items ?? []).map((entry) => (
              <tr key={entry.id}>
                <td>{entry.filename}</td>
                <td>{entry.status}</td>
                <td>{entry.importedAt}</td>
                <td>{entry.sha256.slice(0, 12)}</td>
                <td>
                  <a href={`/imports?import=${entry.id}`}>View rows</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedImport !== null && query.has("row") ? (
        <ImportRowDetail importId={selectedImport} rowNumber={selectedRow} />
      ) : null}
    </section>
  );
}
