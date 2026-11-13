# Connection review guidance — design

Date: 2026-11-13
Status: draft for approval (builder-checked)

## Why

The "Trade connections" review list (`src/web/lifecycles/ConnectionQueue.tsx`)
shows pending short calls per ticker with only a date, the contract and the
eligible share lifecycle. The user cannot tell which calls belong to which
share position, which calls can be connected together, or why a batch fails.
On NVDA, five calls from two different share positions were mixed in one list;
two of them (Jun20'25 145C, Jan16'26 192.5C) look eligible but can never join
their share position, and a batch that includes them fails with a generic
"cannot all be connected with the available shares".

Root of the confusion: the server evaluates each pending call **alone**,
against already-saved decisions only (`projectLifecycles` suggestion loop,
`src/server/lifecycles/project.ts` ~L610–720). It never asks "if the earlier
pending calls on these shares are connected first, does this one still fit?".

Success: the user opens the list and can resolve every row with confidence —
each row says what to do and why, in plain words, and following the advice
never produces a rejected save.

## Goals

1. Group pending calls by the share position they could join, not just by
   ticker.
2. Give every pending call a **recommended action** (connect to a named share
   position / keep separate / review individually) computed by the server.
3. Give every row a **plain-language explanation** with specifics (dates,
   times, the other contract involved), for both connect and separate
   recommendations.
4. One button per share position: **Apply recommended** — runs the
   recommended separates, then the recommended connects, with a confirmation
   listing exactly what will be saved.
5. When a batch save is still rejected, the error names the call and date
   that ran out of shares instead of the generic message.

## Non-goals

- Changing the coverage rules themselves (what counts as covered).
- A decision-history / undo screen for older decisions.
- Changes to the AI chat or proposal flows.
- Manual per-fill splitting (MembershipEditor) — unchanged.

## Anti-goals (failure even if it "works")

- A recommendation the server then rejects when applied. Advice must come
  from the same coverage code that validates saves (`shareAvailability`,
  `validateCallCoverage`).
- Hiding the manual path: the user can still select rows and connect/separate
  by hand, ignoring the advice.
- Noticeably slower rebuilds or page loads.

## Approaches considered

- **A. Server computes the plan during rebuild (chosen).** For each share
  position, walk its pending calls oldest first, assuming earlier
  recommended-connect calls are connected, and classify each call using the
  existing coverage code. Advice cannot disagree with validation. Most new
  code; some extra rebuild work.
- B. Page probes combinations through `/api/lifecycles/connection-preview`.
  No new rules, but each preview clones the store and rebuilds (seconds per
  call), and it can only say "fails", not why.
- C. Page computes it in the browser from the trade list. Fast, but duplicates
  the server's coverage rules (legged/expiry-day rolls, share exits) and
  drifts — the exact mismatch that made FIG confusing.

User picked A.

## Design

### Server: connection plan

Computed in the lifecycle projection after suggestions are built
(`projectLifecycles`), stored with the projection, so it is produced once per
rebuild and served by `GET /api/lifecycles`. Bump `ALGORITHM_VERSION`
(`src/server/builds/service.ts`) so existing builds are marked for rebuild.

Plans are per **review row**, i.e. per `ConnectionGroup` (strategy +
contract, `src/web/lifecycles/connections.ts`), because Connect/Keep separate
act on whole rows. The server groups suggestions the same way; every
suggestion of a row carries the row's plan. If the fills of one row would get
different verdicts, the row is `manual` / `PARTIAL`.

Each `AttachmentSuggestion` gains an optional `plan` field (optional so old
stored projections still parse until rebuilt):

```ts
interface ConnectionPlan {
  action: "connect" | "separate" | "manual";
  lifecycleId: Id | null;        // share position to connect to (connect only)
  reason: PlanReason;            // code, rendered to text by the page
  // specifics for the explanation; all optional, filled when known
  sharesAtOpening?: string;      // shares free in the position when sold
  heldBy?: AllocationRef;        // the earlier call holding the shares
  sharesSold?: { executionKey: string };  // share sale that ended coverage
  pairedWith?: AllocationRef;    // long call opened in the same instant
  dependsOn?: AllocationRef[];   // earlier pending calls that must connect first
}
```

Reason codes (initial set; builder may add if a real case needs one):

| Code | Action | Meaning / example text |
|---|---|---|
| `COVERED` | connect | "100 shares were free when this call was sold." |
| `COVERED_AFTER_EARLIER` | connect | "Covered once the 12-08 195C is connected; this was its roll." (has `dependsOn`) |
| `ROLL_RELEASE` | connect | "Sold before the May23 110C was bought back / expired the same day; the shares passed to this call." |
| `HELD_BY_EARLIER_CALL` | separate | "When this call was sold (12-22 10:37), the Jan16 190C still held the 100 shares." |
| `SHARES_SOLD` | separate | "The shares were sold on 05-13 10:24 while this call stayed open." |
| `SPREAD_LEG` | separate | Added to a separate reason when `pairedWith` exists: "Sold together with a long Jan16 197.5C — likely a call spread." |
| `MULTIPLE_POSITIONS` | manual | More than one share position could cover it; choose one. |
| `PARTIAL` | manual | Only some of the contracts (or fills of the row) are covered. Links to individual review (MembershipEditor); keeping the whole row separate is also offered. |
| `ORDER_UNKNOWN` | manual | Trade times can't establish the order; review individually. |

Algorithm (per account/currency/underlying, per candidate share position):

1. Take the pending rows whose `candidateLifecycleIds` include the
   position, plus rows already listed with `SHARES_RESERVED_BY_OTHER_CALLS`
   (empty candidates) whose unreserved shares would come from this position
   (`shareAvailability(..., reserveCalls=false)`); those always get
   `separate` / `HELD_BY_EARLIER_CALL` naming the connected call holding the
   shares, ordered with the existing chronology helpers (oldest first; ties
   resolved the same way the batch dialog orders them).
2. Keep a working set of "assumed connected" calls (initially empty).
3. For each call, evaluate coverage at its opening as if the working set plus
   this call were connected with `requireCallCoverage: true`, using the same
   code path as `validateCallCoverage`/`shareAvailability`. If it passes →
   `connect` (add to working set). Otherwise → `separate`, with the reason
   derived from what blocked it (an earlier call still open → `HELD_BY_EARLIER_CALL`
   + `heldBy`; a lifecycle share close same day that denied the roll release
   → `SHARES_SOLD`; plus `SPREAD_LEG` detection).
4. A call with several candidate positions, partial coverage or unknown order
   gets `manual` and is not added to any working set. Later rows in each of
   its candidate positions get it in `dependsOn`, and Apply recommended is
   disabled for those positions until it is resolved (the plan is recomputed
   on the rebuild after each save).

`separate` is final under the current rules: coverage is judged at the call's
opening instant, so a call blocked then (held by an earlier call, or its
roll release denied by a share sale) can never become covered later.

`SPREAD_LEG` detection: a long call on the same underlying, same account,
opened at the same instant (`compareLifecycleTime === 0`) as the short call.

The plan must agree with validation: after saving a position's `separate`
plans, saving all its `connect` plans as one batch must pass
`connection-preview`, including the oldest-first ordering check
(`assertConnectionOrder`, `src/server/lifecycles/connection-order.ts`) —
keeping calls separate is not subject to that check, which is why Apply saves
separates first.

Performance constraint: measure full rebuild time on the 2023–2025 sample
before/after; the increase must stay small (target < 10%). How to evaluate
coverage cheaply (e.g. adjusting draft members and reusing
`shareAvailability`, vs re-running the decision pass) is left to the builder,
as long as it shares the validation code rather than re-implementing rules.

### Page: review list

Within each ticker section, group rows by share position (the plan's
`lifecycleId`, or the single candidate). Calls with `manual` plans that span
positions go in an "Needs your choice" group at the end of the ticker.

```
NVDA · Account U4441279 · USD
┌ 100 shares from NVDA Apr17'25 109 Short Put (assigned 2025-04-17)
│  ☐ 2025-04-21  May23'25 110C · 1 call     → Connect
│     100 shares were free when this call was sold.
│  ☐ 2025-05-13  Jun20'25 145C · 1 call     → Keep separate
│     When sold (10:20), the May23 110C still held the shares. They were
│     sold at 10:24 together with the 110C buy-back, so they never covered
│     this call.
│  [ Apply recommended: connect 1, keep 1 separate ]
└
┌ 100 shares from NVDA Dec5'25 190 Short Put (assigned 2025-12-05)
│  … 195C → Connect, 190C → Connect (roll of the 195C), 192.5C → Keep separate
│  [ Apply recommended: connect 2, keep 1 separate ]
└
  ☐ manual rows / Connect selected / Keep selected separate (unchanged)
```

- Each row: date, contract, recommended action badge, explanation text
  (rendered from the reason code + specifics; contract names shown in the
  readable form "Jun20'25 145C", not the OCC symbol).
- Checkboxes, "Connect selected" and "Keep selected separate" stay for
  manual control. The "Select all" checkbox per ticker stays.
- **Apply recommended** opens a confirmation listing each call and its action,
  then runs the existing batch flow (`runConnectionBatch`): first one
  separate batch, then one connect batch to the position. If either fails,
  nothing further is saved and the error is shown. Disabled (with the reason
  shown) while an older `manual` row shares the position. Progress and rebuild
  behaviour are the same as today's batch dialog.
- Shared copy: one sentence at the top of the queue explaining the model —
  "A share position covers one short call per 100 shares at a time. Calls are
  connected oldest first; a call sold while the shares were already covering
  another call, or kept open after the shares were sold, is kept separate."

### Better batch error

When the combined-selection preview fails, the batch dialog uses the plans of
the selected calls to name the first one whose plan isn't `connect` for the
chosen target: "Jun20'25 145C (2025-05-13) can't be covered: …explanation…".
Falls back to today's text if no plan explains it.

## Testing

- Unit tests (server, fixtures in `test/fixtures/lifecycles.ts`) for each
  reason code, modelled on the real cases: FIG expiry-day roll (all connect),
  NVDA Apr17 (connect + `SHARES_SOLD`/held), NVDA Dec5 (connect,
  `COVERED_AFTER_EARLIER`, `HELD_BY_EARLIER_CALL` + `SPREAD_LEG`), multiple
  positions → manual.
- Agreement test: for each fixture, saving a position's `separate` plans and
  then all its `connect` plans as one membership decision passes validation,
  including `assertConnectionOrder`.
- Web unit tests for grouping, explanation text and the apply flow (connect
  then separate; stop on failure).
- Manual check on a copy of the live journal: every pending call on the
  current data gets a plan, and applying recommendations for NVDA succeeds.

## Left to the builder

- Exact file layout (a new `src/server/lifecycles/connection-plan.ts` is
  suggested to keep `project.ts` from growing).
- How coverage is evaluated cheaply, within the "same code path" constraint.
- Exact wording of explanations, within the examples above.
- Styling, following `connections.css`.
