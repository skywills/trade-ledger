import { useState } from "react";
import type { ExportQuery } from "../../shared/analytics.js";
import { downloadAnalyticsCsv } from "./api.js";
export function ExportButton({
  query,
  dataset,
}: {
  query: ExportQuery;
  dataset: ExportQuery["dataset"];
}) {
  const [selected, setSelected] = useState(dataset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dashboard-export">
      <label className="dashboard-export-choice">
        Export data
        <select
          aria-label="Export data"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value as ExportQuery["dataset"]);
            setError(null);
          }}
          disabled={busy}
        >
          <option value="summary">Performance summary</option>
          <option value="strategies">Strategies</option>
          <option value="transactions">Transactions</option>
        </select>
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const detail =
              selected === query.dataset
                ? query
                : {
                    ...query,
                    scope: "closed" as const,
                    outcome: undefined,
                    groupBy: undefined,
                    group: undefined,
                    date: undefined,
                  };
            await downloadAnalyticsCsv({ ...detail, dataset: selected });
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Could not export analytics.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Exporting…" : "Export CSV"}
      </button>
      {error && (
        <p role="alert" className="dashboard-export-error">
          {error}
        </p>
      )}
    </div>
  );
}
