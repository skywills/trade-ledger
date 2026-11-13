# Connection Review Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every pending call in the "Trade connections" review gets a server-computed recommendation (connect / keep separate / needs your choice) with a plain explanation, rows are grouped by share position, and each position has an "Apply recommended" button.

**Architecture:** A new server module `connection-plan.ts` runs after `projectLifecycles` in the build. For each share position it walks pending review rows oldest first and asks the real decision validator (`validateLifecycleDecision`) whether the row can connect given the earlier recommendations; the verdict plus specifics is stored on each suggestion as `plan`. The web page groups rows by position, renders explanations from the plan, and applies recommendations through the existing batch flow (separates first, then connects).

**Tech Stack:** TypeScript, Fastify, React 19, zod 4, decimal.js, vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-connection-review-guidance-design.md`

## Global Constraints

- Advice must come from the same code that validates saves (`validateLifecycleDecision` → `applyMembershipChanges` / `shareAvailability` / `assertConnectionOrder`); no re-implemented coverage rules.
- `plan` is optional on `AttachmentSuggestion` and in the web `SuggestionSchema`, so old stored projections still parse.
- Bump `ALGORITHM_VERSION` in `src/server/builds/service.ts` from `"lifecycles-v11"` to `"lifecycles-v12"`.
- Plans are per review row: key `JSON.stringify([callOpening.strategyId, instrument.key])` (same as `connectionGroups` in `src/web/lifecycles/connections.ts`). Every suggestion in a row carries the same plan.
- Apply recommended order: separate batch first, then connect batch; stop on first failure.
- Full rebuild time on the 2023–2025 sample must not grow more than 10%.
- Manual select / Connect selected / Keep selected separate / Select all stay working.
- Contract names in UI text use the readable form, e.g. `Jun20'25 145C`, not the OCC symbol.

## Review Focus

1. A row whose fills would get different verdicts (two opening fills of one contract) → whole row `manual`/`PARTIAL`, never a split recommendation. Test in Task 3.
2. A position whose older row is `manual` → Apply disabled for that position with the reason shown; later rows list it in `dependsOn`. Tests in Task 3 (server) and Task 6 (UI).
3. Stored projection from before this change (no `plan`) → page renders today's list without badges and without Apply, no crash. Test in Task 5.
4. Apply interrupted after the separate batch saved but the connect batch failed → error shown, list reloads showing the saved separates, Apply available again for what remains. Test in Task 6.
5. Rows with `SHARES_RESERVED_BY_OTHER_CALLS` (empty candidates) → shown under the position whose shares they would have used, recommended separate, naming the holding call. Test in Task 3.

---

### Task 1: Plan types and the core walk (connect / held by earlier call)

**Files:**
- Modify: `src/shared/lifecycles.ts` (add types; add `plan?: ConnectionPlan` to `AttachmentSuggestion`)
- Create: `src/server/lifecycles/connection-plan.ts`
- Test: `test/unit/connection-plan.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export type PlanAction = "connect" | "separate" | "manual";
  export type PlanReason =
    | "COVERED" | "COVERED_AFTER_EARLIER" | "ROLL_RELEASE"
    | "HELD_BY_EARLIER_CALL" | "SHARES_SOLD"
    | "MULTIPLE_POSITIONS" | "PARTIAL" | "ORDER_UNKNOWN";
  export interface ConnectionPlan {
    action: PlanAction;
    lifecycleId: Id | null;          // target position; set for connect and separate (the position it was judged against), null for MULTIPLE_POSITIONS
    reason: PlanReason;
    sharesAtOpening?: string;
    heldBy?: AllocationRef;
    sharesSold?: { executionKey: string };
    pairedWith?: AllocationRef;
    dependsOn?: AllocationRef[];
  }
  ```
- Produces (server):
  ```ts
  export function planConnections(args: {
    ledger: LedgerSnapshot;
    projection: Projection;
    decisions: readonly Decision[];
    lifecycles: LifecycleProjection;
    origins?: Projection;
    retainedAnchors?: readonly RetainedLifecycleAnchor[];
  }): LifecycleProjection   // new object; suggestions copied with `plan` set; input not mutated
  ```
  Internal helper (exported for tests): `planRowKey(s: AttachmentSuggestion, exec: Map<string, Execution>): string`.

- [ ] **Step 1: Write failing tests** in `test/unit/connection-plan.test.ts` using `fixture`/`execution`/`stock`/`call` from `test/fixtures/lifecycles.ts` and `projectLifecycles`. Model the NVDA Dec5 case: 100 shares day 1; call A sold day 2 10:00; call A bought back and call B sold in the same instant day 3 10:00; call C sold day 4 10:00 while B is open.
  - `it("recommends connect for each call in a roll chain")`: plans of A and B → `action: "connect"`, `lifecycleId` = the share lifecycle; A `reason: "COVERED"`, B `reason: "COVERED_AFTER_EARLIER"` with `dependsOn` = [A's opening ref].
  - `it("recommends separate when an earlier recommended call still holds the shares")`: C → `{ action: "separate", reason: "HELD_BY_EARLIER_CALL", heldBy: <B opening ref> }`.
  - `it("agrees with validation")`: save a `lifecycle_membership` decision with `requireCallCoverage: false` for every `separate` row (each member to its own `lifecycleId`), then one `requireCallCoverage: true` decision assigning all `connect` rows' members to the target; `validateLifecycleDecision` (`src/server/lifecycles/validate-decision.ts`) does not throw for either.
  - `it("does not mutate its input")`: input `lifecycles.suggestions[*]` have no `plan` after the call.

- [ ] **Step 2: Run** `npx vitest run test/unit/connection-plan.test.ts` — expect FAIL (module missing).

- [ ] **Step 3: Add the shared types and implement `planConnections`.** Group pending suggestions into rows by `planRowKey`; rows with exactly one common candidate join that position's walk; order rows by their earliest opening via `compareLifecycleTime` (`src/server/lifecycles/chronology.js`), date as tie-breaker. Walk:
  ```
  separates = [], connects = []
  for row in position rows (oldest first):
    sepDecisions = hypothetical requireCallCoverage:false memberships for `separates`
    candidate   = hypothetical requireCallCoverage:true membership: members of connects + row → target
    try validateLifecycleDecision(ledger, projection, [...decisions, ...sepDecisions], candidate, origins, anchors)
      → connect (push to connects)
    catch AppError (code INVALID_LIFECYCLE_MEMBERSHIP or EARLIER_CONNECTION_UNRESOLVED)
      → separate (push to separates)
  ```
  Build hypothetical assignments the way `connectionProposal` does (`src/web/lifecycles/connections.ts:168`): one assignment per member allocation of the row (from `lifecycles.members`, matching strategyId + instrument key), quantities summed. Hypothetical decision ids/sequences must not collide with real ones (e.g. `plan:<n>`, sequence `Number.MAX_SAFE_INTEGER - n`).
  Reasons in this task: connect → `COVERED_AFTER_EARLIER` with `dependsOn` when a row in `connects` closes at the same instant or earlier the same day as this row opens, else `COVERED`; separate → `HELD_BY_EARLIER_CALL` with `heldBy` = the earliest short call among existing target members + `connects` that is still open at this row's opening (opened before, not closed before).

- [ ] **Step 4: Run** `npx vitest run test/unit/connection-plan.test.ts` — expect PASS.

- [ ] **Step 5: Commit** `git commit -m "feat: plan pending call connections per share position"`

### Task 2: Explanations for exits, roll releases and spreads

**Files:**
- Modify: `src/server/lifecycles/connection-plan.ts`
- Test: `test/unit/connection-plan.test.ts`

**Interfaces:**
- Consumes: `planConnections`, `ConnectionPlan` (Task 1).
- Produces: plans carrying `reason: "SHARES_SOLD"` + `sharesSold`, `reason: "ROLL_RELEASE"`, and `pairedWith` on any plan.

- [ ] **Step 1: Write failing tests:**
  - `it("explains a call left open after the shares were sold")` — NVDA Apr17 shape: 100 shares day 1; call A sold day 2; day 3 10:20 call B sold; day 3 10:24 A bought back and 100 shares sold. A → connect `COVERED`; B → `{ action: "separate", reason: "SHARES_SOLD", sharesSold: { executionKey: <share sale key> }, heldBy: <A ref> }`.
  - `it("explains an expiry-day roll")` — FIG shape: A sold day 2; day 3 09:48 B sold; day 3 16:20 A expires (`event: "expiry"`, cash `"0"`). B → connect `ROLL_RELEASE`.
  - `it("explains a same-day legged roll")` — A bought back by `trade` day 3 10:27 after B sold 09:48 → B connect `ROLL_RELEASE`.
  - `it("flags a call sold together with a long call as a spread leg")` — NVDA Dec22 shape: long call D and short call C opened in the same instant (`rawDateTime` equal), same underlying; C's plan has `pairedWith: <D opening ref>` (C is separate `HELD_BY_EARLIER_CALL` because B holds the shares).

- [ ] **Step 2: Run** the file — expect the four new tests FAIL.

- [ ] **Step 3: Implement.** After a verdict: for `connect`, if a short call among target members/`connects` was open at the row's opening and closes later the same day (trade buy-back or zero-cash expiry), reason `ROLL_RELEASE`. For `separate` with `heldBy` whose close is later the same day, if a STK `close` member of the target lifecycle occurs that day at or after the row's opening (or with unknown order), reason `SHARES_SOLD` with that sale. `pairedWith`: a long-call (`putCall "C"`, quantity > 0, action `open`) execution in the same account and underlying with `compareLifecycleTime(x, opening) === 0`.

- [ ] **Step 4: Run** the file — expect PASS.

- [ ] **Step 5: Commit** `git commit -m "feat: explain share exits, roll releases and spread legs in connection plans"`

### Task 3: Rows that need a choice, partial rows and reserved rows

**Files:**
- Modify: `src/server/lifecycles/connection-plan.ts`
- Test: `test/unit/connection-plan.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `manual` plans (`MULTIPLE_POSITIONS`, `PARTIAL`, `ORDER_UNKNOWN`); `dependsOn` on later rows listing the manual row; plans for rows with empty `candidateLifecycleIds`.

- [ ] **Step 1: Write failing tests:**
  - `it("asks for a choice when two share positions could cover a call")` — two share lifecycles (two assigned puts, e.g. via the existing `assigned()` helper pattern) both candidates → `{ action: "manual", reason: "MULTIPLE_POSITIONS", lifecycleId: null }`; a later row in either position has `dependsOn` containing that row's opening ref.
  - `it("marks a row partial when only some of its fills fit")` — one contract opened in two fills (two `open` executions, same instrument, same strategy) where only the first fits → both suggestions carry `{ action: "manual", reason: "PARTIAL" }`.
  - `it("asks for review when trade order is unknown")` — row opening with date-only `rawDateTime` on the same day as a target call event → `ORDER_UNKNOWN`.
  - `it("recommends separate for a call already blocked by saved connections")` — save a decision connecting call A; call B (sold while A open) is listed with `SHARES_RESERVED_BY_OTHER_CALLS` and empty candidates → plan `{ action: "separate", reason: "HELD_BY_EARLIER_CALL", lifecycleId: <share lifecycle>, heldBy: <A ref> }`.

- [ ] **Step 2: Run** the file — expect the new tests FAIL.

- [ ] **Step 3: Implement.** Rows with >1 common candidate → `MULTIPLE_POSITIONS`, excluded from walks, added to `dependsOn` of later rows in each candidate position. Evaluate each fill of a row separately inside the walk; if verdicts differ → `PARTIAL` (row excluded from `connects`/`separates`). `compareLifecycleTime(...) === null` against any target event that day → `ORDER_UNKNOWN`. Empty-candidate rows: find the position via `shareAvailability(ledger, lifecycles, false)` (unreserved shares ≥ row shares at opening), then `heldBy` as in Task 1.

- [ ] **Step 4: Run** the file — expect PASS.

- [ ] **Step 5: Commit** `git commit -m "feat: mark connection rows needing a choice, partial or blocked"`

### Task 4: Compute plans in the build

**Files:**
- Modify: `src/server/builds/service.ts:57` (version) and `:173-184` (call `planConnections` on the projected lifecycles before `accountLifecycles`, or on its result — whichever keeps `suggestions` intact; check `accountLifecycles` does not drop the field)
- Modify: `src/web/lifecycles/api.ts` (`SuggestionSchema` gains `plan: ConnectionPlanSchema.optional()`)
- Modify: `src/shared/lifecycles.ts` (export `ConnectionPlanSchema` zod schema matching the type)
- Test: `test/unit/connection-plan-build.test.ts`

**Interfaces:**
- Consumes: `planConnections` (Task 1).
- Produces: `GET /api/lifecycles` suggestions with `plan`; `ConnectionPlanSchema`.

- [ ] **Step 1: Write failing tests:** `it("parses suggestions with and without a plan")` against `LifecycleListSchema`; and a build-level test following the pattern of existing build tests (find one with `rg -l "runBuild\|rebuild(" test/integration`) asserting a built projection's suggestions carry `plan`.
- [ ] **Step 2: Run** them — expect FAIL.
- [ ] **Step 3: Implement** the wiring, schema and version bump.
- [ ] **Step 4: Run** `npx vitest run` — expect all PASS (fix any snapshot/version expectations that reference `lifecycles-v11`).
- [ ] **Step 5: Measure** full rebuild time on the 2023–2025 sample before and after (`git stash` for before; use the existing sample-data build script or an integration test timing). Expected: < 10% increase. If over, cache per-position hypothetical results or reuse one `projectLifecycles` per position — without re-implementing coverage rules — and re-measure.
- [ ] **Step 6: Commit** `git commit -m "feat: compute connection plans during lifecycle builds"`

### Task 5: Page grouping and explanation text

**Files:**
- Create: `src/web/lifecycles/connection-guidance.ts`
- Test: `test/unit/connection-guidance.test.ts`

**Interfaces:**
- Consumes: `ConnectionGroup`, `ConnectionSection` (`connections.ts`, `connection-batch.ts`), `ConnectionPlan`.
- Produces:
  ```ts
  export function contractLabel(i: Execution["instrument"]): string;          // "Jun20'25 145C"
  export function groupPlan(g: ConnectionGroup): ConnectionPlan | null;        // plan of the row's first suggestion; null when absent
  export interface PositionGroup {
    lifecycleId: string | null;          // null = "Needs your choice"
    title: string;                       // "100 shares from NVDA Apr17'25 109 Short Put (assigned 2025-04-17)"
    groups: ConnectionGroup[];
    applicable: { connect: ConnectionGroup[]; separate: ConnectionGroup[] };
    blockedBy: ConnectionGroup | null;   // older manual row disabling Apply
  }
  export function positionGroups(section: ConnectionSection, data: ConnectionData): PositionGroup[];
  export function explainPlan(plan: ConnectionPlan, data: ConnectionData): string;
  ```

- [ ] **Step 1: Write failing tests** with hand-built `ConnectionData`:
  - `contractLabel` of the NVDA 260116 192.5 call → `"Jan16'26 192.5C"`; of 250620 145 → `"Jun20'25 145C"`.
  - `positionGroups` splits a ticker into two positions plus a "Needs your choice" group last; rows keep oldest-first order; `applicable` counts match plans; `blockedBy` set when an older manual row shares the position.
  - `explainPlan` texts (exact strings):
    - COVERED: `"100 shares were free when this call was sold."`
    - COVERED_AFTER_EARLIER: `"Rolled from the Jan16'26 195C; covered once that call is connected."`
    - ROLL_RELEASE: `"Sold before the Nov7'25 64C closed later that day; the shares passed to this call."`
    - HELD_BY_EARLIER_CALL: `"When this call was sold (2025-12-22 10:37), the Jan16'26 190C still held the shares."`
    - SHARES_SOLD: `"When this call was sold (2025-05-13 10:20), the May23'25 110C still held the shares. The shares were sold at 10:24 the same day, so they never covered this call."`
    - pairedWith suffix: `" Sold together with a long Jan16'26 197.5C — likely a call spread."`
    - MULTIPLE_POSITIONS: `"More than one share position could cover this call. Choose one."`
    - PARTIAL: `"Only some of these contracts can be covered. Review this call individually."`
    - ORDER_UNKNOWN: `"Trade times can't show what happened first. Review this call individually."`
  - Data without any `plan` → `positionGroups` returns a single group with `lifecycleId: null`, empty `applicable`, and `explainPlan` is never needed (caller checks `groupPlan`).
- [ ] **Step 2: Run** `npx vitest run test/unit/connection-guidance.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Reuse a symbol/expiry formatter from `src/shared/symbols.ts` if one exists; times from `rawDateTime` (HH:MM) when present.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: group connection rows by share position and explain plans"`

### Task 6: Review list UI and Apply recommended

**Files:**
- Modify: `src/web/lifecycles/ConnectionQueue.tsx`
- Modify: `src/web/lifecycles/connection-batch.ts` (add `applyRecommended`)
- Create: `src/web/lifecycles/ApplyRecommendedDialog.tsx`
- Modify: `src/web/lifecycles/connections.css`
- Test: `test/unit/connection-batch.test.ts`, `test/unit/connection-components.test.tsx`

**Interfaces:**
- Consumes: Task 5 exports; `createConnectionBatch`, `runConnectionBatch`, `BatchIO`.
- Produces:
  ```ts
  export async function applyRecommended(
    data: ConnectionData, position: PositionGroup, io?: BatchIO,
    onProgress?: (m: string) => void, signal?: AbortSignal,
  ): Promise<void>;   // separate batch (if any) then connect batch to position.lifecycleId; throws on first failure
  ```

- [ ] **Step 1: Write failing tests:**
  - `connection-batch.test.ts`: `applyRecommended` with a fake `BatchIO` saves the separate request before the connect request; when the separate save succeeds and the connect preview is invalid, it throws and no connect save happens; with no separate rows it runs only the connect batch.
  - `connection-components.test.tsx`: the queue renders position headings, each row's action badge (`Connect` / `Keep separate` / `Needs your choice`) and explanation; "Apply recommended: connect 1, keep 1 separate" button per position; the button is disabled with text `"Resolve the 2025-…" ` naming the blocking row when `blockedBy` is set; with no plans the list renders as today (no badges, no Apply button); checkbox selection and "Connect selected" still work.
- [ ] **Step 2: Run** both files — expect FAIL.
- [ ] **Step 3: Implement** `applyRecommended` (second batch is created from the `batch.data` the first run leaves fresh), the dialog (lists each call and action, Confirm / Cancel, progress text, error panel, calls `onDismiss` → list reload), and the queue layout per the spec sketch, keeping manual controls. Add the one-sentence explainer at the top of the queue (exact text from the spec's "Shared copy").
- [ ] **Step 4: Run** both files, then `npx vitest run` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: show recommended actions and apply them per share position"`

### Task 7: Name the call in a failed batch

**Files:**
- Modify: `src/web/lifecycles/connection-batch.ts:380-389`
- Test: `test/unit/connection-batch.test.ts`

**Interfaces:**
- Consumes: `groupPlan`, `explainPlan`, `contractLabel` (Task 5).

- [ ] **Step 1: Write failing test** `it("names the call that cannot be covered")`: a connect batch whose combined preview is invalid and whose second item's plan is `separate`/`SHARES_SOLD` → error message starts with `"Jun20'25 145C (2025-05-13) can't be covered: "` followed by `explainPlan` text and ends with today's `savedNote` + advice. Without plans, message is unchanged.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** in the `!selection.valid && !selection.blockingConnection` branch: first remaining item whose plan is not `connect` to `batch.target`.
- [ ] **Step 4: Run** `npx vitest run` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: name the uncovered call when a connection batch fails"`

### Task 8: Verify on real data and finish

**Files:** none (verification only)

- [ ] **Step 1:** `npm run build && npm run typecheck && npx vitest run && ./node_modules/.bin/biome check <changed files>` — all pass.
- [ ] **Step 2:** Copy the live journal DB with `better-sqlite3` `.backup()` plus `originals/` into the scratchpad, start dev (`DATA_DIR=<copy> PORT=3020 HOST=127.0.0.1 ALLOWED_ORIGIN=http://127.0.0.1:3020 npx tsx src/server/main.ts`), run a full build (`POST /api/builds {"mode":"full"}`).
- [ ] **Step 3:** `GET /api/lifecycles`: every suggestion has a `plan`. NVDA: Apr17 position → 110C connect, 145C separate `SHARES_SOLD`; Dec5 position → 195C connect, 190C connect, 192.5C separate with `pairedWith`.
- [ ] **Step 4:** In the browser on the copy, use Apply recommended for both NVDA positions; both succeed and NVDA leaves the queue.
- [ ] **Step 5:** Stop dev, delete the copy, then follow superpowers:finishing-a-development-branch.
