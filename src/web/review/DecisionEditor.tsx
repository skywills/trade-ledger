import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  DecisionResponseSchema,
  type Execution,
  ImportsEnvelope,
  JournalEnvelope,
  requestJson,
  TransactionsEnvelope,
  useJson,
} from "../api.js";
import { ErrorPanel, Loading } from "../components.js";

export interface DecisionRecord {
  id: string;
  sequence: number;
  kind: string;
  summary: string;
  strategyIds: string[];
  at: string;
}

/** Session-scoped revision history. Retained decisions themselves live server-side. */
const log: DecisionRecord[] = [];

export function listDecisions(strategyId?: string): DecisionRecord[] {
  return strategyId
    ? log.filter((entry) => entry.strategyIds.includes(strategyId))
    : [...log];
}

const KINDS = [
  { value: "notes", label: "Notes", consequential: false },
  { value: "stop_loss", label: "Stop loss", consequential: false },
  { value: "identity_binding", label: "Identity binding", consequential: true },
  { value: "group_explicit", label: "Group (explicit)", consequential: true },
  { value: "group_merge", label: "Merge strategies", consequential: true },
  { value: "lifecycle", label: "Lifecycle event", consequential: true },
  {
    value: "manual_allocation",
    label: "Manual allocation",
    consequential: true,
  },
  { value: "import_exclusion", label: "Exclude import", consequential: true },
  {
    value: "import_inclusion",
    label: "Reinstate import",
    consequential: true,
  },
  { value: "rejection", label: "Reject evidence", consequential: true },
] as const;

type Kind = (typeof KINDS)[number]["value"];

interface Preview {
  payload: Record<string, unknown>;
  summary: string;
}

interface Built {
  payload: Record<string, unknown>;
  summary: string;
}

function sourceOf(execution: Execution) {
  const source = execution.sources[0];
  if (source === undefined) {
    throw new Error(`Execution ${execution.key} has no retained source row.`);
  }
  return { importId: source.importId, rowNumber: source.rowNumber };
}

/**
 * Manual reconciliation editor. It lists stable references with quantities and
 * never asks the user to edit JSON; financially consequential decisions are
 * shown as a confirmation preview before the retained append.
 */
export function DecisionEditor({
  fixedStrategyId,
  initialNotes,
  initialStopLoss,
}: {
  fixedStrategyId?: string;
  initialNotes?: string | null;
  initialStopLoss?: string | null;
}) {
  const journal = useJson("/api/journal?pageSize=100", JournalEnvelope);
  const imports = useJson("/api/imports?pageSize=100", ImportsEnvelope);
  const transactions = useJson(
    "/api/transactions?pageSize=100",
    TransactionsEnvelope,
  );

  const strategies = journal.data?.items ?? [];
  const importList = imports.data?.items ?? [];
  const executions = transactions.data?.items ?? [];

  const [kind, setKind] = useState<Kind>("notes");
  const [strategyId, setStrategyId] = useState(fixedStrategyId ?? "");
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [stopPrice, setStopPrice] = useState(initialStopLoss ?? "");
  const [importId, setImportId] = useState("");
  const [evidenceHash, setEvidenceHash] = useState("");
  const [reason, setReason] = useState("");
  const [sourceKey, setSourceKey] = useState("");
  const [targetKey, setTargetKey] = useState("");
  const [canonical, setCanonical] = useState("");
  const [expectedQuantity, setExpectedQuantity] = useState("");
  const [chosenId, setChosenId] = useState("");
  const [mergedIds, setMergedIds] = useState<string[]>([]);
  const [lifecycleEvent, setLifecycleEvent] = useState<
    "assignment" | "exercise" | "expiry" | "roll"
  >("assignment");
  const [allocQuantity, setAllocQuantity] = useState("");
  const [allocCash, setAllocCash] = useState("");

  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    sequence: number;
    kind: string;
  } | null>(null);
  const [lastSequence, setLastSequence] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  // Synchronous guard: a second click can land before React re-renders the
  // disabled button.
  const inFlight = useRef(false);
  // One clientRequestId per built payload, reused when the same payload is
  // retried so the server's idempotency check can recognise the repeat.
  const pendingRequest = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (fixedStrategyId !== undefined || strategyId !== "") return;
    const first = journal.data?.items[0];
    if (first !== undefined) setStrategyId(first.id);
  }, [fixedStrategyId, strategyId, journal.data]);

  const kindDef = KINDS.find((entry) => entry.value === kind) ?? KINDS[0];
  const selectedExecution = executions.find((entry) => entry.key === sourceKey);
  const effectiveStrategyId = fixedStrategyId ?? strategyId;
  const strategyById = new Map(strategies.map((entry) => [entry.id, entry]));

  function resetFrivolous() {
    setResult(null);
  }

  function build(): Built {
    switch (kind) {
      case "notes": {
        if (effectiveStrategyId === "")
          throw new Error("Select a strategy first.");
        if (notes.trim() === "") throw new Error("Please enter note text.");
        return {
          payload: {
            kind: "notes",
            sources: [],
            strategyIds: [effectiveStrategyId],
            payload: { strategyId: effectiveStrategyId, text: notes.trim() },
          },
          summary: `Note on ${strategyById.get(effectiveStrategyId)?.description ?? effectiveStrategyId}: ${notes.trim()}`,
        };
      }
      case "stop_loss": {
        if (effectiveStrategyId === "")
          throw new Error("Select a strategy first.");
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(stopPrice.trim()))
          throw new Error("Enter a numeric stop loss price.");
        return {
          payload: {
            kind: "stop_loss",
            sources: [],
            strategyIds: [effectiveStrategyId],
            payload: {
              strategyId: effectiveStrategyId,
              price: stopPrice.trim(),
            },
          },
          summary: `Stop loss ${stopPrice.trim()} on ${strategyById.get(effectiveStrategyId)?.description ?? effectiveStrategyId}`,
        };
      }
      case "import_exclusion":
      case "import_inclusion": {
        if (importId === "") throw new Error("Select an import.");
        const entry = importList.find((item) => item.id === importId);
        const verb = kind === "import_exclusion" ? "Exclude" : "Reinstate";
        return {
          payload: {
            kind,
            sources: [],
            strategyIds: [],
            payload: { importId },
          },
          summary: `${verb} import ${entry?.filename ?? importId}`,
        };
      }
      case "rejection": {
        if (evidenceHash.trim() === "")
          throw new Error("Enter the evidence hash to reject.");
        return {
          payload: {
            kind,
            sources: [],
            strategyIds: [],
            payload: {
              evidenceHash: evidenceHash.trim(),
              ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
            },
          },
          summary: `Reject evidence ${evidenceHash.trim()}`,
        };
      }
      case "identity_binding": {
        if (selectedExecution === undefined)
          throw new Error("Select a source execution.");
        if (canonical.trim() === "")
          throw new Error("Enter the canonical identity.");
        const quantity = expectedQuantity.trim() || selectedExecution.quantity;
        return {
          payload: {
            kind,
            sources: [sourceOf(selectedExecution)],
            strategyIds: [canonical.trim()],
            payload: {
              source: sourceOf(selectedExecution),
              canonicalIdentity: canonical.trim(),
              expectedQuantity: quantity,
            },
          },
          summary: `Bind ${selectedExecution.instrument.symbol} (qty ${quantity}) to ${canonical.trim()}`,
        };
      }
      case "group_explicit": {
        if (effectiveStrategyId === "") throw new Error("Select a strategy.");
        if (selectedExecution === undefined)
          throw new Error("Select a source execution.");
        return {
          payload: {
            kind,
            sources: [sourceOf(selectedExecution)],
            strategyIds: [effectiveStrategyId],
            payload: {
              strategyId: effectiveStrategyId,
              source: sourceOf(selectedExecution),
            },
          },
          summary: `Group ${selectedExecution.instrument.symbol} into ${strategyById.get(effectiveStrategyId)?.description ?? effectiveStrategyId}`,
        };
      }
      case "group_merge": {
        if (chosenId === "") throw new Error("Choose the surviving strategy.");
        if (mergedIds.length === 0)
          throw new Error("Select at least one strategy to merge.");
        return {
          payload: {
            kind,
            sources: [],
            strategyIds: [chosenId, ...mergedIds],
            payload: {
              chosenStrategyId: chosenId,
              mergedStrategyIds: mergedIds,
            },
          },
          summary: `Merge ${mergedIds.length} strateg${mergedIds.length === 1 ? "y" : "ies"} into ${strategyById.get(chosenId)?.description ?? chosenId}`,
        };
      }
      case "lifecycle": {
        const source = executions.find((entry) => entry.key === sourceKey);
        const target = executions.find((entry) => entry.key === targetKey);
        if (source === undefined) throw new Error("Select a source execution.");
        if (target === undefined) throw new Error("Select a target execution.");
        return {
          payload: {
            kind,
            sources: [sourceOf(source), sourceOf(target)],
            strategyIds: [],
            payload: {
              event: lifecycleEvent,
              sourceRef: sourceOf(source),
              targetRef: sourceOf(target),
            },
          },
          summary: `${lifecycleEvent} from ${source.instrument.symbol} to ${target.instrument.symbol}`,
        };
      }
      case "manual_allocation": {
        if (effectiveStrategyId === "") throw new Error("Select a strategy.");
        if (selectedExecution === undefined)
          throw new Error("Select a source execution.");
        const quantity = allocQuantity.trim() || selectedExecution.quantity;
        const netCash = allocCash.trim() || selectedExecution.netCash;
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(quantity))
          throw new Error("Allocated quantity must be numeric.");
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(netCash))
          throw new Error("Allocated cash must be numeric.");
        return {
          payload: {
            kind,
            sources: [sourceOf(selectedExecution)],
            strategyIds: [effectiveStrategyId],
            payload: {
              strategyId: effectiveStrategyId,
              source: sourceOf(selectedExecution),
              allocations: [
                {
                  executionKey: selectedExecution.key,
                  quantity,
                  netCash,
                  brokerPnl: selectedExecution.brokerPnl,
                },
              ],
            },
          },
          summary: `Allocate ${quantity} of ${selectedExecution.instrument.symbol} (cash ${netCash}) to ${strategyById.get(effectiveStrategyId)?.description ?? effectiveStrategyId}`,
        };
      }
    }
  }

  function validate(): Built | null {
    try {
      return build();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    }
  }

  function onPreview() {
    resetFrivolous();
    setError(null);
    const built = validate();
    if (built !== null) setPreview(built);
  }

  function requestIdFor(built: Built): string {
    const key = JSON.stringify(built.payload);
    if (pendingRequest.current?.key !== key) {
      pendingRequest.current = { key, id: crypto.randomUUID() };
    }
    return pendingRequest.current.id;
  }

  async function submit(built: Built) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    setResult(null);
    const body: Record<string, unknown> = {
      clientRequestId: requestIdFor(built),
      author: "user",
      supersedesId: null,
      ...built.payload,
      ...(lastSequence === null ? {} : { expectedWatermark: lastSequence }),
    };
    try {
      const response = await requestJson(
        "/api/decisions",
        DecisionResponseSchema,
        "POST",
        body,
      );
      pendingRequest.current = null;
      const sequence = response.decision.sequence;
      setLastSequence(sequence);
      setResult({ sequence, kind: response.decision.kind });
      setPreview(null);
      const strategyIds = Array.isArray(built.payload.strategyIds)
        ? (built.payload.strategyIds as string[])
        : [];
      log.unshift({
        id: response.decision.id,
        sequence,
        kind: response.decision.kind,
        summary: built.summary,
        strategyIds,
        at: new Date().toISOString(),
      });
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        (caught.code === "STALE_INPUT" || caught.code === "ALLOCATION_CONFLICT")
      ) {
        // Drop the cached water mark so the retry re-reads the server state.
        setLastSequence(null);
        setError("Inputs changed; the view was refreshed. Please try again.");
        journal.reload();
        imports.reload();
        transactions.reload();
      } else if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError(String(caught));
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  function onRecord() {
    if (inFlight.current) return;
    resetFrivolous();
    setError(null);
    const built = validate();
    if (built !== null) void submit(built);
  }

  if (
    journal.status === "loading" ||
    imports.status === "loading" ||
    transactions.status === "loading"
  ) {
    return <Loading label="Loading review editor…" testId="editor-loading" />;
  }
  if (journal.status === "error" || imports.status === "error") {
    return (
      <ErrorPanel
        message="Failed to load review data."
        onRetry={() => {
          journal.reload();
          imports.reload();
          transactions.reload();
        }}
      />
    );
  }

  const toggle = (
    list: string[],
    setList: (next: string[]) => void,
    id: string,
  ) => {
    setList(
      list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id],
    );
  };

  return (
    <section className="decision-editor" aria-label="Manual decisions">
      <h3>Manual decisions</h3>

      <div data-testid="candidates" className="candidates">
        <h4>Stable references</h4>
        <ul>
          {strategies.map((strategy) => (
            <li key={strategy.id}>
              {strategy.description} · {strategy.currency} ·{" "}
              {strategy.status.replaceAll("_", " ")} · qty{" "}
              {strategy.positions.map((entry) => entry.quantity).join("/") ||
                "0"}
            </li>
          ))}
        </ul>
      </div>

      <p>
        <label>
          Decision kind{" "}
          <select
            aria-label="Decision kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as Kind);
              setPreview(null);
              setError(null);
            }}
          >
            {KINDS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </p>

      {fixedStrategyId === undefined &&
      kind !== "import_exclusion" &&
      kind !== "import_inclusion" &&
      kind !== "rejection" &&
      kind !== "lifecycle" ? (
        <p>
          <label>
            Strategy{" "}
            <select
              aria-label="Strategy"
              value={strategyId}
              onChange={(event) => setStrategyId(event.target.value)}
            >
              <option value="">Select a strategy</option>
              {strategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.description}
                </option>
              ))}
            </select>
          </label>
        </p>
      ) : null}

      {kind === "notes" ? (
        <p>
          <label>
            Notes{" "}
            <textarea
              aria-label="Notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
        </p>
      ) : null}

      {kind === "stop_loss" ? (
        <p>
          <label>
            Stop loss price{" "}
            <input
              aria-label="Stop loss price"
              value={stopPrice}
              onChange={(event) => setStopPrice(event.target.value)}
            />
          </label>
        </p>
      ) : null}

      {kind === "import_exclusion" || kind === "import_inclusion" ? (
        <p>
          <label>
            Import{" "}
            <select
              aria-label="Import"
              value={importId}
              onChange={(event) => setImportId(event.target.value)}
            >
              <option value="">Select an import</option>
              {importList.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.filename}
                </option>
              ))}
            </select>
          </label>
        </p>
      ) : null}

      {kind === "rejection" ? (
        <>
          <p>
            <label>
              Evidence hash{" "}
              <input
                aria-label="Evidence hash"
                value={evidenceHash}
                onChange={(event) => setEvidenceHash(event.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              Reason{" "}
              <input
                aria-label="Reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          </p>
        </>
      ) : null}

      {kind === "identity_binding" ? (
        <>
          <p>
            <label>
              Source execution{" "}
              <select
                aria-label="Source execution"
                value={sourceKey}
                onChange={(event) => setSourceKey(event.target.value)}
              >
                <option value="">Select a source execution</option>
                {executions.map((execution) => (
                  <option key={execution.key} value={execution.key}>
                    {execution.instrument.symbol} {execution.date} qty{" "}
                    {execution.quantity}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Canonical identity{" "}
              <input
                aria-label="Canonical identity"
                value={canonical}
                onChange={(event) => setCanonical(event.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              Expected quantity{" "}
              <input
                aria-label="Expected quantity"
                value={expectedQuantity}
                onChange={(event) => setExpectedQuantity(event.target.value)}
              />
            </label>
          </p>
        </>
      ) : null}

      {kind === "group_explicit" || kind === "manual_allocation" ? (
        <p>
          <label>
            Source execution{" "}
            <select
              aria-label="Source execution"
              value={sourceKey}
              onChange={(event) => {
                setSourceKey(event.target.value);
                const execution = executions.find(
                  (entry) => entry.key === event.target.value,
                );
                setAllocQuantity(execution?.quantity ?? "");
                setAllocCash(execution?.netCash ?? "");
              }}
            >
              <option value="">Select a source execution</option>
              {executions.map((execution) => (
                <option key={execution.key} value={execution.key}>
                  {execution.instrument.symbol} {execution.date} qty{" "}
                  {execution.quantity}
                </option>
              ))}
            </select>
          </label>
        </p>
      ) : null}

      {kind === "manual_allocation" ? (
        <fieldset>
          <legend>Explicit allocation quantities</legend>
          <p className="muted">
            {selectedExecution === undefined
              ? "Choose a source execution to edit its allocation."
              : `${selectedExecution.instrument.symbol} source quantity ${selectedExecution.quantity}, source cash ${selectedExecution.netCash}`}
          </p>
          <p>
            <label>
              Allocated quantity{" "}
              <input
                aria-label="Allocated quantity"
                value={allocQuantity}
                onChange={(event) => setAllocQuantity(event.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              Allocated cash{" "}
              <input
                aria-label="Allocated cash"
                value={allocCash}
                onChange={(event) => setAllocCash(event.target.value)}
              />
            </label>
          </p>
        </fieldset>
      ) : null}

      {kind === "group_merge" ? (
        <fieldset>
          <legend>Merge strategies</legend>
          <p>
            <label>
              Surviving strategy{" "}
              <select
                aria-label="Surviving strategy"
                value={chosenId}
                onChange={(event) => setChosenId(event.target.value)}
              >
                <option value="">Choose the survivor</option>
                {strategies.map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>
                    {strategy.description}
                  </option>
                ))}
              </select>
            </label>
          </p>
          {strategies.map((strategy) => (
            <label key={strategy.id} className="check-row">
              <input
                type="checkbox"
                checked={mergedIds.includes(strategy.id)}
                onChange={() => toggle(mergedIds, setMergedIds, strategy.id)}
              />
              {strategy.description} · qty{" "}
              {strategy.positions.map((entry) => entry.quantity).join("/") ||
                "0"}
            </label>
          ))}
        </fieldset>
      ) : null}

      {kind === "lifecycle" ? (
        <>
          <p>
            <label>
              Lifecycle event{" "}
              <select
                aria-label="Lifecycle event"
                value={lifecycleEvent}
                onChange={(event) =>
                  setLifecycleEvent(event.target.value as typeof lifecycleEvent)
                }
              >
                <option value="assignment">Assignment</option>
                <option value="exercise">Exercise</option>
                <option value="expiry">Expiry</option>
                <option value="roll">Roll</option>
              </select>
            </label>
          </p>
          <p>
            <label>
              Source execution{" "}
              <select
                aria-label="Source execution"
                value={sourceKey}
                onChange={(event) => setSourceKey(event.target.value)}
              >
                <option value="">Select a source execution</option>
                {executions.map((execution) => (
                  <option key={execution.key} value={execution.key}>
                    {execution.instrument.symbol} {execution.date}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Target execution{" "}
              <select
                aria-label="Target execution"
                value={targetKey}
                onChange={(event) => setTargetKey(event.target.value)}
              >
                <option value="">Select a target execution</option>
                {executions.map((execution) => (
                  <option key={execution.key} value={execution.key}>
                    {execution.instrument.symbol} {execution.date}
                  </option>
                ))}
              </select>
            </label>
          </p>
        </>
      ) : null}

      {preview !== null ? (
        <div className="preview" data-testid="decision-preview">
          <h4>Confirm this decision</h4>
          <p>{preview.summary}</p>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit(preview)}
          >
            Confirm decision
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => setPreview(null)}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {error !== null ? (
        <div
          role="alert"
          tabIndex={-1}
          ref={errorRef}
          data-testid="error-summary"
          className="error-summary"
        >
          {error}
        </div>
      ) : null}

      {result !== null ? (
        <p data-testid="decision-result" role="status">
          Sequence {result.sequence} · {result.kind} recorded
        </p>
      ) : null}

      {preview === null ? (
        kindDef.consequential ? (
          <button type="button" disabled={submitting} onClick={onPreview}>
            Preview decision
          </button>
        ) : (
          <button type="button" disabled={submitting} onClick={onRecord}>
            Record decision
          </button>
        )
      ) : null}
    </section>
  );
}
