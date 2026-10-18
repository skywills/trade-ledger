import { useState } from "react";
import { rebuildLifecycles } from "./api.js";
export function BuildAction({ onBuilt }: { onBuilt: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await rebuildLifecycles();
            onBuilt();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Rebuilding…" : "Rebuild journal"}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
