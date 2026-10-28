# Connection Batch Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden batch connection review against partial retries, hung requests, and assignment-order changes without changing the basis-reconciled P&L tier.

**Architecture:** Add canonical proposal comparison and repeat combined coverage validation inside the existing sequential runner. Add opt-in per-request timeouts in the shared web client, plumb them through the batch IO, and let the dialog close once a save receipt exists. Document the intentional basis-reconciled/estimated split.

**Tech Stack:** TypeScript, React 19, Zod, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-10-28-connection-batch-robustness-design.md

## Global Constraints

- Node.js `>=22.19.0`; TypeScript strict mode with `exactOptionalPropertyTypes`.
- Preserve retry idempotency: reuse the retained `clientRequestId` and exact payload; never save an acknowledged decision twice.
- Keep all server-side chronology, coverage and stale-build validation in force.
- Keep money and quantities as decimal strings; never parse them into JavaScript numbers on the client.
- Do not add a global request timeout to import uploads, analytics downloads or chat requests.
- Do not move basis-reconciled rows back into `estimatedClosed`.
- Preserve the existing separate-versus-connect behavior and contract-group review flow.

## Review Focus

- A batch retried after a partial save where the remaining items together exceed available shares must fail before another save.
- A hung load, preview or save must surface a retryable timeout instead of freezing the dialog forever.
- Closing the dialog after a confirmed save while a rebuild hangs must keep the saved decision and must not save it twice.
- Equivalent assignments emitted in a different order must not abort a batch with “selected trades changed”.
- A real change to an assignment quantity, lifecycle target, role or coverage requirement must still abort.

---

### Task 1: Canonical proposal comparison

**Files:**
- Modify: `src/web/lifecycles/connection-batch.ts:287-296`
- Test: `test/unit/connection-batch.test.ts`

**Interfaces:**
- Consumes: `Proposal`, `runConnectionBatch`, and the existing `setup()` fixture in `test/unit/connection-batch.test.ts`.
- Produces: `export function canonicalProposalPayload(payload: Proposal["payload"]): string`. `runConnectionBatch` keeps the same signature; only the semantic-equality comparison changes.

- [ ] **Step 1: Write the failing tests**

Add the import and tests to `test/unit/connection-batch.test.ts`:

```ts
import {
  canonicalProposalPayload,
  type BatchIO,
  connectionSections,
  createConnectionBatch,
  runConnectionBatch,
} from "../../src/web/lifecycles/connection-batch.js";

it("compares proposals canonically by assignment identity and quantity", () => {
  const assignment = (executionKey: string) => ({
    allocation: {
      strategyId: "calls",
      executionKey,
      role: "open" as const,
    },
    lifecycleId: "shares",
    quantity: "-1",
  });
  const a = assignment("a");
  const b = assignment("b");
  expect(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a, b],
    }),
  ).toBe(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [b, a],
    }),
  );
  expect(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a, b],
    }),
  ).not.toBe(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a, { ...b, quantity: "-2" }],
    }),
  );
  expect(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a],
    }),
  ).not.toBe(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [{ ...a, lifecycleId: "other" }],
    }),
  );
  expect(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a],
    }),
  ).not.toBe(
    canonicalProposalPayload({
      requireCallCoverage: false,
      assignments: [a],
    }),
  );
  expect(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a],
    }),
  ).not.toBe(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [
        {
          ...a,
          allocation: { ...a.allocation, role: "close" as const },
        },
      ],
    }),
  );
});

it("does not abort when equivalent assignments arrive in a different order", async () => {
  const f = setup();
  const load = f.io.load;
  f.io.load = async () => {
    const current = await load();
    return current.lifecycles === null
      ? current
      : {
          ...current,
          lifecycles: {
            ...current.lifecycles,
            members: [...current.lifecycles.members].reverse(),
          },
        };
  };
  const batch = f.batch();
  await runConnectionBatch(batch, f.io);
  expect(batch.items.every((i) => i.status === "complete")).toBe(true);
});
```

- [ ] **Step 2: Run the tests and observe the failure**

Run: `npx vitest run test/unit/connection-batch.test.ts`
Expected: FAIL because `canonicalProposalPayload` is not exported and the runner rejects the reversed-order batch with “selected trades changed”.

- [ ] **Step 3: Implement `canonicalProposalPayload`**

In `src/web/lifecycles/connection-batch.ts`, add this near the `Proposal` type:

```ts
function assignmentKey(
  assignment: Proposal["payload"]["assignments"][number],
): string {
  return [
    assignment.allocation.strategyId,
    assignment.allocation.executionKey,
    assignment.allocation.role,
    assignment.lifecycleId,
  ].join("\u0000");
}

export function canonicalProposalPayload(
  payload: Proposal["payload"],
): string {
  return JSON.stringify({
    requireCallCoverage: payload.requireCallCoverage,
    assignments: [...payload.assignments]
      .sort((a, b) => assignmentKey(a).localeCompare(assignmentKey(b)))
      .map((assignment) => ({
        allocation: {
          strategyId: assignment.allocation.strategyId,
          executionKey: assignment.allocation.executionKey,
          role: assignment.allocation.role,
        },
        lifecycleId: assignment.lifecycleId,
        quantity: assignment.quantity,
      })),
  });
}
```

Replace the comparison at `connection-batch.ts:293` with:

```ts
if (
  canonicalProposalPayload(proposal.payload) !==
  canonicalProposalPayload(original.payload)
)
  throw new Error(
    "The selected trades changed. Close this review and review the latest connections.",
  );
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/connection-batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/lifecycles/connection-batch.ts test/unit/connection-batch.test.ts
git commit -m "fix: compare connection proposals canonically"
```

---

### Task 2: Re-run combined coverage for all remaining items

**Files:**
- Modify: `src/web/lifecycles/connection-batch.ts:297-322`
- Test: `test/unit/connection-batch.test.ts`

**Interfaces:**
- Consumes: `ConnectionBatch`, `BatchItem`, `batchProposal`, and `runConnectionBatch` from Task 1.
- Produces: no new exported API. On every fresh-preview attempt, the runner previews all non-complete items when the current item is the first non-complete item without a request.

- [ ] **Step 1: Extend the test fixture with an optional third independent group**

In `test/unit/connection-batch.test.ts`, change `setup()` to accept `third = false`, build a `rows` array, give the share lifecycle enough shares for three opens, and push the third call:

```ts
function setup(overlapping = false, sameContract = false, third = false) {
  const rows: Parameters<typeof fixture>[0] = [
    [
      "shares",
      execution(
        "shares",
        stock,
        third ? "200" : "100",
        third ? "-20000" : "-10000",
        1,
        "open",
      ),
    ],
    [
      "late",
      execution(
        "late",
        sameContract ? call : { ...call, key: "late", conid: "4" },
        "-1",
        "80",
        overlapping ? 3 : 4,
        "open",
      ),
    ],
    ["early", execution("early", call, "-1", "70", 2, "open")],
    [
      "early",
      execution("early-close", call, "1", "-30", overlapping ? 4 : 3, "close"),
    ],
  ];
  if (third)
    rows.push([
      "third",
      execution(
        "third",
        { ...call, key: "third", conid: "5" },
        "-1",
        "70",
        5,
        "open",
      ),
    ]);
  const { ledger, projection } = fixture(rows);
  // ...keep the existing decisions, data, io, initial, section, target and return code unchanged
}
```

Add the regression test:

```ts
it("re-runs combined coverage for all remaining items after a partial-save retry", async () => {
  const f = setup(false, false, true);
  const batch = f.batch();
  f.failRebuild();
  await expect(runConnectionBatch(batch, f.io)).rejects.toThrow("Build failed");
  expect(batch.items.map((i) => i.status)).toEqual([
    "saved",
    "pending",
    "pending",
  ]);

  const preview = f.io.preview;
  const assignmentCounts: number[] = [];
  f.io.preview = async (proposal, data) => {
    assignmentCounts.push(proposal.payload.assignments.length);
    return preview(proposal, data);
  };

  await runConnectionBatch(batch, f.io);
  expect(assignmentCounts[0]).toBe(2);
  expect(batch.items.every((i) => i.status === "complete")).toBe(true);
  expect(f.decisions).toHaveLength(3);
});
```

- [ ] **Step 2: Run the tests and observe the failure**

Run: `npx vitest run test/unit/connection-batch.test.ts`
Expected: FAIL because the first preview after the retry is the single remaining item (`1` assignment), not the combined remaining preview (`2`).

- [ ] **Step 3: Replace the `index === 0` guard**

Inside the `if (!item.request) { ... }` block in `runConnectionBatch`, compute the remaining items and replace the existing combined-coverage condition:

```ts
const remaining = batch.items.filter((i) => i.status !== "complete");
const firstFresh = remaining.find((i) => !i.request);
// Check combined coverage before any fresh save. Individual suggestions can
// compete for the same shares even when each is eligible on its own. Repeat
// this for all non-complete items on every fresh-preview attempt so a retry
// cannot save one remaining item before a later one fails.
if (!batch.separate && remaining.length > 1 && item === firstFresh) {
  onProgress("Checking available shares for all selected connections…");
  const selection = await io.preview(
    batchProposal(
      remaining.map((i) => i.group),
      batch.target,
      false,
    ),
    fresh,
  );
  if (
    selection.buildId !== fresh.buildId ||
    selection.watermark !== fresh.watermark
  )
    throw new Error(
      "Your journal changed. Close this review and review the latest connections.",
    );
  if (!selection.valid)
    throw new ConnectionSelectionError(
      selection.blockingConnection
        ? `Resolve the earlier connection dated ${selection.blockingConnection.date} first. No decisions were saved. Close this review and include it in your selection.`
        : "The selected calls cannot all be connected with the available shares. No decisions were saved. Close this review and select fewer connections, or review them individually.",
    );
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/connection-batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/lifecycles/connection-batch.ts test/unit/connection-batch.test.ts
git commit -m "fix: revalidate remaining batch coverage on retries"
```

---

### Task 3: Opt-in request timeouts for batch requests

**Files:**
- Modify: `src/web/api.ts:256-292`, `src/web/api.ts:394-425`
- Modify: `src/web/lifecycles/api.ts:96-112`
- Modify: `src/web/lifecycles/connection-batch.ts:151-181`, `src/web/lifecycles/connection-batch.ts:254-371`
- Test: `test/unit/web-api-timeout.test.ts` (create)

**Interfaces:**
- Consumes: existing `request`, `requestJson`, `pollJob`, `rebuildLifecycles`, and `BatchIO` callers.
- Produces: `export interface RequestOptions extends RequestInit { timeoutMs?: number }`; `request(path, schema, options?: RequestOptions)`; `requestJson(path, schema, method, payload?, options?: RequestOptions)`; `BatchIO` methods accept an optional trailing `signal?: AbortSignal`.

- [ ] **Step 1: Write the failing timeout tests**

Create `test/unit/web-api-timeout.test.ts`:

```ts
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, request } from "../../src/web/api.js";

afterEach(() => vi.unstubAllGlobals());

it("maps an opt-in request timeout to REQUEST_TIMEOUT", async () => {
  vi.stubGlobal(
    "fetch",
    (_path: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      }),
  );
  await expect(
    request("/api/slow", z.null(), { timeoutMs: 5 }),
  ).rejects.toMatchObject({
    code: "REQUEST_TIMEOUT",
    status: 0,
    message: "The request timed out. Please retry.",
  });
});

it("does not convert a caller abort into REQUEST_TIMEOUT", async () => {
  vi.stubGlobal(
    "fetch",
    (_path: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      }),
  );
  const controller = new AbortController();
  const pending = request("/api/slow", z.null(), {
    signal: controller.signal,
    timeoutMs: 60_000,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(controller.signal.aborted).toBe(true);
  expect(ApiError).toBeDefined();
});
```

- [ ] **Step 2: Run the test and observe the failure**

Run: `npx vitest run test/unit/web-api-timeout.test.ts`
Expected: FAIL because `request` ignores `timeoutMs` and the first promise never settles, or the rejection is not an `ApiError` with code `REQUEST_TIMEOUT`.

- [ ] **Step 3: Implement opt-in timeouts in `src/web/api.ts`**

Add the options type and timeout handling:

```ts
export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const { timeoutMs, signal: callerSignal, ...init } = options;
  const timeout =
    timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const signal =
    timeout === undefined
      ? callerSignal
      : callerSignal
        ? AbortSignal.any([callerSignal, timeout])
        : timeout;
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (typeof init.body === "string" && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const fetchOptions: RequestInit = { ...init, headers };
  if (signal !== undefined) fetchOptions.signal = signal;
  let response: Response;
  try {
    response = await fetch(path, fetchOptions);
  } catch (error) {
    if (timeout?.aborted)
      throw new ApiError(
        "REQUEST_TIMEOUT",
        "The request timed out. Please retry.",
        0,
      );
    throw error;
  }
  const body = await readBody(response);
  if (!response.ok) throw errorFrom(response, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(
      "INVALID_RESPONSE",
      `Unexpected response shape from ${path}.`,
      response.status,
      parsed.error.issues,
    );
  return parsed.data;
}

export function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  method: string,
  payload?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  return request(path, schema, {
    ...options,
    method,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}
```

- [ ] **Step 4: Run the timeout tests and verify they pass**

Run: `npx vitest run test/unit/web-api-timeout.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply timeouts and signals to the batch and rebuild paths**

In `src/web/lifecycles/connection-batch.ts`, add `const CONNECTION_REQUEST_TIMEOUT_MS = 30_000;` and change `BatchIO` to:

```ts
export interface BatchIO {
  load(signal?: AbortSignal): Promise<ConnectionData>;
  preview(
    proposal: Proposal,
    data: ConnectionData,
    signal?: AbortSignal,
  ): Promise<ProposalPreview>;
  save(payload: SaveRequest, signal?: AbortSignal): Promise<Receipt>;
  rebuild(signal?: AbortSignal): Promise<void>;
}
```

Update `batchIO` to pass the signal and timeout to each request:

```ts
const connectionRequestOptions = (signal?: AbortSignal): RequestOptions => ({
  ...(signal ? { signal } : {}),
  timeoutMs: CONNECTION_REQUEST_TIMEOUT_MS,
});

const batchIO: BatchIO = {
  load: (signal) =>
    request(
      "/api/lifecycles",
      LifecycleListSchema,
      connectionRequestOptions(signal),
    ),
  preview: (proposal, data, signal) =>
    requestJson(
      "/api/lifecycles/connection-preview",
      ProposalPreviewSchema,
      "POST",
      {
        proposal,
        expectedBuildId: data.buildId,
        expectedWatermark: data.watermark,
      },
      connectionRequestOptions(signal),
    ),
  save: async (payload, signal) =>
    (
      await requestJson(
        "/api/decisions",
        DecisionResponseSchema,
        "POST",
        {
          ...payload,
          sources: [],
          strategyIds: [],
          supersedesId: null,
        },
        connectionRequestOptions(signal),
      )
    ).decision,
  rebuild: (signal) => rebuildLifecycles(signal),
};
```

Import `RequestOptions` from `../api.js`. In `runConnectionBatch`, pass `signal` to `io.load(signal)`, `io.preview(..., fresh, signal)`, `io.save(item.request, signal)`, and `io.rebuild(signal)`.

In `src/web/lifecycles/api.ts`, add `const JOB_REQUEST_TIMEOUT_MS = 30_000;` and use it for the rebuild POST:

```ts
const { jobId } = await requestJson(
  "/api/builds",
  BuildResponseSchema,
  "POST",
  { mode: "projection" },
  { timeoutMs: JOB_REQUEST_TIMEOUT_MS },
);
```

In `src/web/api.ts`, add a per-request timeout to `pollJob`'s job lookup:

```ts
const { job } = await request(
  `/api/jobs/${encodeURIComponent(jobId)}`,
  JobEnvelopeSchema,
  {
    ...(signal ? { signal } : {}),
    timeoutMs: 30_000,
  },
);
```

- [ ] **Step 6: Run the batch and timeout tests**

Run: `npx vitest run test/unit/web-api-timeout.test.ts test/unit/connection-batch.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/api.ts src/web/lifecycles/api.ts src/web/lifecycles/connection-batch.ts test/unit/web-api-timeout.test.ts
git commit -m "fix: add opt-in timeouts to batch requests"
```

---

### Task 4: Allow dismissal after a confirmed save

**Files:**
- Modify: `src/web/lifecycles/BatchConnectionDialog.tsx:34-40`, `64-68`, `121-128`, `242-261`
- Test: `e2e/connection-batch.spec.ts`

**Interfaces:**
- Consumes: the retained `receipt` on `ConnectionBatch.items` from Task 3.
- Produces: no exported API. Closing is blocked only while a request is in flight and no item has a receipt.

- [ ] **Step 1: Write the failing browser test**

Append to `e2e/connection-batch.spec.ts`:

```ts
test("closing after a confirmed save leaves the decision saved and the background rebuild running", async ({ page, request, baseURL }) => {
  const before = await importConnections(request, baseURL, "CLOSE");
  await page.goto("/lifecycles");
  const section = page.getByRole("region", { name: "CLOSE connection reviews", exact: true });
  await section.getByRole("checkbox", { name: "Select all CLOSE connections", exact: true }).check();
  await section.getByRole("button", { name: "Connect selected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect CLOSE connections" });

  let releaseBuild = () => {};
  const buildGate = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  await page.route("**/api/builds", async (route) => {
    if (route.request().method() === "POST") await buildGate;
    await route.fallback();
  });

  await dialog.getByRole("button", { name: "Confirm connections", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Updating journal");
  await expect(dialog.getByRole("button", { name: "Close review", exact: true })).toBeEnabled();
  await expect(dialog).toContainText("journal rebuild continues in the background");

  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  releaseBuild();

  await expect.poll(async () => {
    const after = await (await request.get("/api/lifecycles")).json();
    return {
      watermark: after.watermark,
      suggestions: after.lifecycles.suggestions.length,
    };
  }).toEqual({
    watermark: before.watermark + 1,
    suggestions: before.lifecycles.suggestions.length - 1,
  });
});
```

- [ ] **Step 2: Run the browser test and observe the failure**

Run: `npx playwright test e2e/connection-batch.spec.ts --grep "closing after a confirmed save"`
Expected: FAIL because the Close review button stays disabled while `busy` is true, so the test cannot close during the held rebuild.

- [ ] **Step 3: Implement receipt-aware dismissal**

In `BatchConnectionDialog.tsx`, derive the saved state and allow dismissal once a receipt exists:

```tsx
const saved = batch.current?.items.some((item) => item.receipt) ?? false;

function hasReceipt() {
  return batch.current?.items.some((item) => item.receipt) ?? false;
}

function dismiss() {
  if (inFlight.current && !hasReceipt()) return;
  dialog.current?.close();
  onDismiss();
}
```

Change both close buttons from `disabled={busy}` to `disabled={busy && !saved}`. Add this warning inside the status block after the progress line:

```tsx
{busy && saved && (
  <p>
    A decision was saved. Closing stops watching; the journal rebuild
    continues in the background.
  </p>
)}
```

- [ ] **Step 4: Run the browser test and verify it passes**

Run: `npx playwright test e2e/connection-batch.spec.ts --grep "closing after a confirmed save"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/lifecycles/BatchConnectionDialog.tsx e2e/connection-batch.spec.ts
git commit -m "fix: allow closing the batch dialog after a saved decision"
```

---

### Task 5: Document the basis-reconciled tier

**Files:**
- Modify: `src/server/strategies/grouping-closes.ts:119-128`
- Modify: `README.md:26-30`
- Test: existing `test/unit/lifecycle-analytics.test.ts`, `test/integration/basis-pnl.test.ts`, `e2e/quality-details.spec.ts`

**Interfaces:**
- Consumes: existing `pnlAttribution: "basis-reconciled"` behavior.
- Produces: no behavior change; a comment and user-facing documentation only.

- [ ] **Step 1: Add the intent comment and README sentence**

Above the `pnlEstimated: false` branch in `grouping-closes.ts`, add:

```ts
// Basis-reconciled amounts are intentionally reported in the separate
// "basis-reconciled" tier, not the estimated-P&L warning tier.
```

After the estimated broker-P&L paragraph in `README.md`, add:

```markdown
Basis-reconciled broker P&L is disclosed separately from estimated P&L: matched
opening costs reconcile to the broker total, so those lifecycles are not counted
in the estimated warning tier.
```

- [ ] **Step 2: Verify the existing behavior and coverage still pass**

Run: `npx vitest run test/unit/lifecycle-analytics.test.ts test/integration/basis-pnl.test.ts`
Expected: PASS.

Run: `npx playwright test e2e/quality-details.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/server/strategies/grouping-closes.ts README.md
git commit -m "docs: document the basis-reconciled P&L tier"
```

---

### Task 6: Whole-branch regression sweep

**Files:** none changed unless a check fails.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: verification evidence for the final review.

- [ ] **Step 1: Run lint and typecheck**

Run: `npm run check:all`
Expected: PASS. Existing unrelated lint warnings may remain; no new warnings in changed files.

- [ ] **Step 2: Run the full unit and integration suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Run the affected browser specs**

Run: `npx playwright test e2e/connection-batch.spec.ts e2e/quality-details.spec.ts`
Expected: PASS.

- [ ] **Step 4: Run the production build**

Run: `npm run build`
Expected: PASS. The existing main-chunk-size warning is acceptable.

- [ ] **Step 5: Review the final diff**

Run: `git diff main...HEAD --check && git status --short`
Expected: no whitespace errors and no unintended files.
