import { useState } from "react";
import { useJobSignal } from "../api.js";
import { rebuildLifecycles } from "./api.js";
export function BuildAction({ onBuilt }: { onBuilt: () => void }) {
  const jobSignal = useJobSignal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          const signal = jobSignal();
          setBusy(true);
          setError(null);
          try {
            await rebuildLifecycles(signal);
            signal.throwIfAborted();
            onBuilt();
          } catch (e) {
            if (!signal.aborted)
              setError(e instanceof Error ? e.message : String(e));
          } finally {
            if (!signal.aborted) setBusy(false);
          }
        }}
      >
        {busy ? "Rebuilding…" : "Rebuild journal"}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
