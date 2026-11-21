import { useEffect, useRef, useState } from "react";
import type { Lifecycle } from "../../shared/lifecycles.js";
import { ValuationSnapshotSchema } from "../../shared/lifecycles.js";
import type { Execution } from "../api.js";
import type { SaveDecision } from "./api.js";
import { contractLabel } from "./connection-guidance.js";
export function ValuationEditor({
  lifecycle,
  openOnArrival,
  executions,
  save,
  disabled,
}: {
  lifecycle: Lifecycle;
  openOnArrival: boolean;
  executions: Execution[];
  save: SaveDecision;
  disabled: boolean;
}) {
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    if (openOnArrival) {
      summary.current?.focus();
      summary.current?.scrollIntoView({ block: "center" });
    }
  }, [openOnArrival]);
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 16));
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const instruments = new Map(
    executions.map((e) => [e.instrument.key, e.instrument]),
  );
  const positions = lifecycle.positions
    .filter((p) => !/^[-+]?0(?:\.0*)?$/.test(p.quantity))
    .map((position) => {
      const instrument = instruments.get(position.instrumentKey);
      const label = instrument
        ? [instrument.symbol, contractLabel(instrument)]
            .filter(Boolean)
            .join(" ")
        : position.instrumentKey;
      return { ...position, label };
    });
  if (!positions.length) return null;
  const seen = new Set<string>();
  const duplicateLabels = new Set<string>();
  for (const { label } of positions) {
    if (seen.has(label)) duplicateLabels.add(label);
    seen.add(label);
  }
  const displayLabel = (p: (typeof positions)[number]) =>
    duplicateLabels.has(p.label) ? `${p.label} (${p.instrumentKey})` : p.label;
  return (
    <details open={openOnArrival || undefined}>
      <summary ref={summary}>Add dated manual prices</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const result = ValuationSnapshotSchema.safeParse({
            account: lifecycle.account,
            currency: lifecycle.currency,
            asOf: `${asOf}:00Z`,
            marks: positions.map((p) => ({
              instrumentKey: p.instrumentKey,
              price: prices[p.instrumentKey] ?? "",
            })),
          });
          if (!result.success) {
            setError(
              "Enter a nonnegative price for every remaining instrument and a valid valuation time.",
            );
            return;
          }
          if (Date.parse(result.data.asOf) > Date.now()) {
            setError("Valuation time cannot be in the future.");
            return;
          }
          setError(null);
          if (preview) void save("lifecycle_valuation", result.data);
          else setPreview(true);
        }}
      >
        <fieldset disabled={disabled}>
          <legend>One complete price snapshot · {lifecycle.currency}</legend>
          <p>
            Enter all remaining instruments at the same time. Fill prices are
            not current prices. These marks change open valuation only.
          </p>
          <label>
            Valuation time (UTC)
            <input
              type="datetime-local"
              required
              value={asOf}
              onChange={(e) => {
                setPreview(false);
                setAsOf(e.target.value);
              }}
            />
          </label>
          {positions.map((p) => (
            <label key={p.instrumentKey}>
              {displayLabel(p)} · {p.quantity} units
              <input
                aria-label={`Price for ${p.label} (${p.instrumentKey})`}
                inputMode="decimal"
                required
                value={prices[p.instrumentKey] ?? ""}
                onChange={(e) => {
                  setPreview(false);
                  setPrices({ ...prices, [p.instrumentKey]: e.target.value });
                }}
              />
            </label>
          ))}
          {preview && (
            <div className="lifecycle-status">
              <p>
                Save {positions.length} manual prices as of{" "}
                {asOf.replace("T", " ")} UTC for {lifecycle.account} in{" "}
                {lifecycle.currency}.
              </p>
              <ul aria-label="Prices to save">
                {positions.map((p) => (
                  <li key={p.instrumentKey}>
                    {displayLabel(p)} · {p.quantity}{" "}
                    {p.quantity === "1" ? "unit" : "units"} at{" "}
                    {prices[p.instrumentKey]} {lifecycle.currency}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button type="submit">
            {preview ? "Save prices and rebuild" : "Preview valuation"}
          </button>
          {error && <p role="alert">{error}</p>}
        </fieldset>
      </form>
    </details>
  );
}
