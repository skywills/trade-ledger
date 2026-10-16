import { useState } from "react";
import type { ExportQuery } from "../../shared/analytics.js";
import { ApiError } from "../api.js";
import { downloadAnalyticsCsv } from "./api.js";
export function ExportButton({
  query,
  dataset,
  onRefresh,
}: {
  query: ExportQuery;
  dataset: ExportQuery["dataset"];
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState(dataset);
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
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
            setNeedsRefresh(
              e instanceof ApiError && e.code === "ANALYTICS_BUILD_CHANGED",
            );
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
      {needsRefresh && (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setNeedsRefresh(false);
            onRefresh();
          }}
        >
          Refresh analytics
        </button>
      )}
      {error && (
        <p role="alert" className="dashboard-export-error">
          {error}
        </p>
      )}
    </div>
  );
}
