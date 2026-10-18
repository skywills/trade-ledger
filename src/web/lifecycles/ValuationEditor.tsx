import { useState } from "react";
import type { Lifecycle } from "../../shared/lifecycles.js";
import { ValuationSnapshotSchema } from "../../shared/lifecycles.js";
import type { Execution } from "../api.js";
import type { SaveDecision } from "./api.js";
export function ValuationEditor({
  lifecycle,
  executions,
  save,
  disabled,
}: {
  lifecycle: Lifecycle;
  executions: Execution[];
  save: SaveDecision;
  disabled: boolean;
}) {
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 16));
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const positions = lifecycle.positions.filter(
    (p) => !/^[-+]?0(?:\.0*)?$/.test(p.quantity),
  );
  if (!positions.length) return null;
  return (
    <details>
      <summary>Add dated manual prices</summary>
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
              {executions.find((e) => e.instrument.key === p.instrumentKey)
                ?.instrument.symbol ?? p.instrumentKey}{" "}
              · {p.quantity} units
              <input
                aria-label={`Price for ${p.instrumentKey}`}
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
            <p className="lifecycle-status">
              Save {positions.length} manual prices as of{" "}
              {asOf.replace("T", " ")} UTC for {lifecycle.account} in{" "}
              {lifecycle.currency}.
            </p>
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
