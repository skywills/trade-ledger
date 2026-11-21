import { type DragEvent, useState } from "react";
import {
  BuildResponseSchema,
  CommitResponseSchema,
  type ImportPreview,
  ImportRowsEnvelope,
  ImportRowViewSchema,
  ImportSummarySchema,
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
      {row.issues.length > 0 && (
        <section aria-label="Row issues">
          <h4>Row issues</h4>
          <ul>
            {row.issues.map((issue) => (
              <li key={issue.key}>
                {issue.severity} · {issue.code.replaceAll("_", " ")}
              </li>
            ))}
          </ul>
        </section>
      )}
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

function ImportRows({
  importId,
  page,
  listPage,
}: {
  importId: string;
  page: number;
  listPage: number;
}) {
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
    `/imports?import=${encodeURIComponent(importId)}&page=${n}&listPage=${listPage}`;
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
  const query = useQuery();
  const listPage = pageNumber(query.get("listPage"));
  const selectedImport = query.get("import");
  return selectedImport ? (
    <ImportSource
      key={selectedImport}
      selectedImport={selectedImport}
      listPage={listPage}
    />
  ) : (
    <ImportForm listPage={listPage} />
  );
}

function ImportForm({ listPage }: { listPage: number }) {
  const imports = useJson(
    `/api/imports?pageSize=100&page=${listPage}`,
    ImportsEnvelope,
  );
  const jobSignal = useJobSignal();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<ImportStep>("idle");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<ImportPreview[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);

  async function onConfirm() {
    if (files.length === 0) return;
    const signal = jobSignal();
    setBusy(true);
    setError(null);
    setResult(null);
    setPreviews([]);
    setOutcomes({});
    let activeFile: string | undefined;
    let confirmed = 0;
    try {
      setStep("uploading");
      const form = new FormData();
      for (const file of files) form.append("files", file);
      const previewResponse = await requestMultipart(
        "/api/imports/preview",
        PreviewResponseSchema,
        form,
      );
      if (!signal.aborted) setPreviews(previewResponse.previews);
      if (previewResponse.previews.some((entry) => !entry.committable)) {
        throw new Error(
          "No files were committed. Correct the files with errors or select only valid files and try again.",
        );
      }
      if (!signal.aborted) setStep("committing");
      let duplicates = 0;
      for (const [index, entry] of previewResponse.previews.entries()) {
        activeFile = files[index]?.name;
        const commit = await requestJson(
          `/api/imports/${encodeURIComponent(entry.id)}/commit`,
          CommitResponseSchema,
          "POST",
        );
        confirmed++;
        if (commit.duplicate) duplicates++;
        if (!signal.aborted)
          setOutcomes((current) => ({
            ...current,
            [entry.id]: commit.duplicate ? "Already imported" : "Committed",
          }));
      }
      activeFile = undefined;
      if (!signal.aborted) setStep("building");
      const build = await requestJson(
        "/api/builds",
        BuildResponseSchema,
        "POST",
        { mode: "full" },
      );
      const job = await pollJob(build.jobId, undefined, { signal });
      signal.throwIfAborted();
      if (job.status !== "complete")
        throw new Error(job.error ?? `Build ${job.status}.`);
      const prefix = duplicates > 0 ? "Already imported (duplicate). " : "";
      setResult(`${prefix}Import complete. Build ${job.status}.`);
      imports.reload();
    } catch (caught) {
      if (signal.aborted) return;
      const reason = caught instanceof Error ? caught.message : String(caught);
      const guidance =
        confirmed > 0 ? " Retry the import to complete the rebuild." : "";
      setError(
        `${activeFile ? `Could not confirm ${activeFile}. ` : ""}${reason}${guidance}`,
      );
      imports.reload();
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
    setPreviews([]);
    setOutcomes({});
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
          {previews.map((preview, index) => (
            <div key={preview.id}>
              <h4>{files[index]?.name}</h4>
              <p>
                <span
                  className={`badge ${preview.committable ? "badge-success" : "badge-danger"}`}
                >
                  {outcomes[preview.id] ??
                    (preview.committable ? "Validated" : "Not committable")}
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
      {imports.status === "loading" ||
      (imports.data && imports.data.page !== listPage) ? (
        <Loading label="Loading imports…" />
      ) : imports.status === "error" ? (
        <ErrorPanel
          message="Failed to load imports."
          onRetry={imports.reload}
        />
      ) : !imports.data?.items.length ? (
        <p className="empty-state">
          {imports.data?.total
            ? "No files on this page."
            : "No files imported yet."}
        </p>
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
                      to={`/imports?import=${encodeURIComponent(entry.id)}&listPage=${listPage}`}
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
      {imports.status === "ready" && imports.data?.page === listPage && (
        <PageLinks {...imports.data} href={(n) => `/imports?listPage=${n}`} />
      )}
    </section>
  );
}

function ImportSource({
  selectedImport,
  listPage,
}: {
  selectedImport: string;
  listPage: number;
}) {
  const query = useQuery();
  const page = pageNumber(query.get("page"));
  const selectedRow = Number(query.get("row"));
  const summary = useJson(
    `/api/imports/${encodeURIComponent(selectedImport)}`,
    ImportSummarySchema,
  );
  return (
    <section>
      <p>
        <Link to={listPage > 1 ? `/imports?listPage=${listPage}` : "/imports"}>
          ← Imports
        </Link>
      </p>
      <h2>{summary.data?.filename ?? "Import source rows"}</h2>
      {summary.error && (
        <ErrorPanel message={summary.error.message} onRetry={summary.reload} />
      )}
      {query.has("row") ? (
        <>
          <Link
            to={`/imports?import=${encodeURIComponent(selectedImport)}&page=${page}&listPage=${listPage}`}
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
          listPage={listPage}
          page={page}
        />
      )}
    </section>
  );
}
