import { useState } from "react";
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
import { useQuery } from "../navigation.js";

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

/** Import screen: preview, commit, auto-rebuild and raw row drilldown. */
export function ImportsPage() {
  const imports = useJson("/api/imports?pageSize=100", ImportsEnvelope);
  const query = useQuery();
  const selectedImport = query.get("import");
  const selectedRow = Number(query.get("row") ?? "");

  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
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
      const form = new FormData();
      for (const file of files) form.append("files", file);
      const previewResponse = await requestMultipart(
        "/api/imports/preview",
        PreviewResponseSchema,
        form,
      );
      setPreviews(previewResponse.previews);

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
    }
  }

  return (
    <section>
      <h2>Imports</h2>
      <p>
        <label>
          CSV files{" "}
          <input
            type="file"
            multiple
            accept=".csv,text/csv"
            aria-label="CSV files"
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
        </label>
      </p>
      <p>
        <button type="button" onClick={onConfirm} disabled={busy}>
          Confirm import
        </button>
        {busy ? <Loading label=" Importing…" /> : null}
      </p>

      {error !== null ? <ErrorPanel message={error} /> : null}
      {result !== null ? (
        <p data-testid="import-result" role="status">
          {result}
        </p>
      ) : null}

      {previews.length > 0 ? (
        <div data-testid="import-preview" className="preview">
          <h3>Import preview</h3>
          {previews.map((preview) => (
            <div key={preview.id}>
              <p>
                {preview.committable ? "Committable" : "Not committable"} ·{" "}
                {preview.counts.executions} executions · {preview.counts.lots}{" "}
                lots · {preview.counts.quarantined} quarantined
              </p>
              <p>Capabilities: {preview.capabilities.join(", ") || "none"}</p>
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
