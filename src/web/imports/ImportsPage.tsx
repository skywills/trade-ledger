import { type DragEvent, useState } from "react";
import {
  BuildResponseSchema,
  CommitResponseSchema,
  type ImportPreview,
  ImportRowsEnvelope,
  ImportRowViewSchema,
  ImportsEnvelope,
  PreviewResponseSchema,
  pollJob,
  requestJson,
  requestMultipart,
  useJobSignal,
  useJson,
} from "../api.js";
import {
  ErrorPanel,
  Loading,
  PageLinks,
  pageNumber,
  TableScroll,
} from "../components.js";
import { Link, useQuery } from "../navigation.js";

function ImportRowDetail({
  importId,
  rowNumber,
}: {
  importId: string;
  rowNumber: number;
}) {
  const remote = useJson(
    `/api/imports/${encodeURIComponent(importId)}/rows/${rowNumber}`,
    ImportRowViewSchema,
  );
  if (remote.status === "loading")
    return <Loading label="Loading source row…" />;
  if (!remote.data)
    return (
      <ErrorPanel
        message={remote.error?.message ?? "Failed to load the source row."}
        onRetry={remote.reload}
      />
    );
  const row = remote.data;
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

function ImportRows({ importId, page }: { importId: string; page: number }) {
  const remote = useJson(
    `/api/imports/${encodeURIComponent(importId)}/rows?pageSize=50&page=${page}`,
    ImportRowsEnvelope,
  );
  if (remote.status === "loading")
    return <Loading label="Loading source rows…" />;
  if (!remote.data)
    return (
      <ErrorPanel
        message={remote.error?.message ?? "Failed to load source rows."}
        onRetry={remote.reload}
      />
    );
  const href = (n: number) =>
    `/imports?import=${encodeURIComponent(importId)}&page=${n}`;
  return (
    <>
      {remote.data.items.length ? (
        <TableScroll label="Source rows">
          <table className="source-rows" aria-label="Source rows">
            <thead>
              <tr>
                <th>Row</th>
                <th>Section</th>
                <th>Kind</th>
              </tr>
            </thead>
            <tbody>
              {remote.data.items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link to={`${href(page)}&row=${row.rowNumber}`}>
                      Row {row.rowNumber}
                    </Link>
                  </td>
                  <td>{row.section ?? "—"}</td>
                  <td>{row.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : (
        <p>No retained rows on this page.</p>
      )}
      <PageLinks {...remote.data} href={href} />
    </>
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
  const jobSignal = useJobSignal();
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
    const signal = jobSignal();
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
      if (!signal.aborted) {
        setPreviews(previewResponse.previews);
        setStep("committing");
      }
      const commits = [];
      for (const entry of previewResponse.previews) {
        commits.push(
          await requestJson(
            `/api/imports/${encodeURIComponent(entry.id)}/commit`,
            CommitResponseSchema,
            "POST",
          ),
        );
      }
      const duplicates = commits.filter((entry) => entry.duplicate).length;

      if (!signal.aborted) setStep("building");
      const build = await requestJson(
        "/api/builds",
        BuildResponseSchema,
        "POST",
        { mode: "full" },
      );
      const job = await pollJob(build.jobId, undefined, { signal });
      signal.throwIfAborted();
      const prefix = duplicates > 0 ? "Already imported (duplicate). " : "";
      setResult(`${prefix}Import complete. Build ${job.status}.`);
      imports.reload();
    } catch (caught) {
      if (signal.aborted) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!signal.aborted) {
        setBusy(false);
        setStep("idle");
      }
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

  if (selectedImport !== null) {
    const page = pageNumber(query.get("page"));
    const filename = imports.data?.items.find(
      (entry) => entry.id === selectedImport,
    )?.filename;
    return (
      <section>
        <p>
          <Link to="/imports">← Imports</Link>
        </p>
        <h2>{filename ?? "Import source rows"}</h2>
        {query.has("row") ? (
          <>
            <Link
              to={`/imports?import=${encodeURIComponent(selectedImport)}&page=${page}`}
            >
              Browse source rows
            </Link>
            <ImportRowDetail
              key={`${selectedImport}/${selectedRow}`}
              importId={selectedImport}
              rowNumber={selectedRow}
            />
          </>
        ) : (
          <ImportRows
            key={`${selectedImport}/${page}`}
            importId={selectedImport}
            page={page}
          />
        )}
      </section>
    );
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
                {preview.counts.cashTransactions > 0 && (
                  <span className="badge">
                    {preview.counts.cashTransactions} cash evidence rows
                  </span>
                )}{" "}
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
      ) : !imports.data?.items.length ? (
        <p className="empty-state">No files imported yet.</p>
      ) : (
        <TableScroll label="Committed imports">
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
                    <Link
                      to={`/imports?import=${encodeURIComponent(entry.id)}`}
                    >
                      View rows
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}
