# Agent Tools: Portfolio Summaries and Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent exact current-position summaries and usable full-scope analytics downloads without adding live market data or persistent export storage.

**Architecture:** Aggregate existing remaining strategy positions against their source instrument/account evidence, and link existing validated CSV export routes from chat. Reuse release 1 snapshot and paging helpers. This release can ship before or after proposal expansion.

**Tech Stack:** Existing TypeScript, decimal.js, Zod, Fastify, React, Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-agent-tool-expansion-design.md`, project-wide requirements and release 3. Review draft.

## Global Constraints

- Node.js >=22.19.0; use existing TypeScript, Zod, decimal.js, Fastify and Vitest.
- No new runtime dependencies or database migrations.
- Money and quantities remain decimal strings; null means unavailable, never zero.
- Never sum currencies together or silently fall back between P&L bases.
- All new read tools use `approval: "never"` and the existing read repeat guard.
- Output must fit the existing model byte/line budgets; no silent loss of rows or numeric coverage.
- Keep `profile: "none"`; do not add shell, arbitrary SQL, filesystem or generic network tools.
- Other project-wide requirements in the spec apply unchanged.

## Review Focus

- Same ticker with distinct contracts/accounts: never net across instrument/account boundaries (Task 1).
- Partial closes and offsetting positions: use remaining positions and retain gross long/short quantities (Task 1).
- Missing or conflicting account attribution: show unresolved coverage, do not guess an account (Task 1).
- Rebuild between export creation and download: existing expectedBuildId validation rejects the download (Task 2).
- Model-authored URLs or markup: only allow the specific internal export path; render other links as text (Task 3).

---

## File structure

- Create `src/server/analytics/open-positions.ts`: exact deterministic position aggregation.
- Create `src/server/chat/tools/positions.ts`: bounded agent summary adapter.
- Create `src/server/chat/tools/exports.ts`: validated local download descriptor.
- Modify `src/server/chat/tools/index.ts` and `src/server/chat/instructions.ts`: registration and routing.
- Modify `src/web/chat/{markdown.ts,Markdown.tsx}`: allowlisted local download links.
- Add focused service/tool tests and `e2e/chat-exports.spec.ts`; update README.

### Task 1: Current-position summary with complete attribution

**Files:** Create `src/server/analytics/open-positions.ts`, `src/server/chat/tools/positions.ts`, `test/integration/chat-position-tools.test.ts`; modify `src/server/chat/tools/index.ts`.

**Interfaces:**
- Export `OpenPositionQuery` with optional account, currency, underlying, assetClass and instrumentKey.
- Export `OpenPositionRow`: account:string; currency:string; instrument:Instrument; netQuantity:string; longQuantity:string; shortQuantity:string; strategyCount:number; lifecycleCount:number. Gross quantities are nonnegative decimal strings; net=long-short.
- Export `OpenPositionSelection`: items:OpenPositionRow[]; unresolved:Array<{strategyId:string; instrumentKey:string; quantity:string; reason:"missing_instrument"|"missing_account"|"conflicting_account"}>; contributions:Array<{account:string; currency:string; instrumentKey:string; strategyId:string; quantity:string; lifecycleIds:string[]}>.
- Export `selectOpenPositions(snapshot: AnalyticsSnapshot, query: OpenPositionQuery): OpenPositionSelection`.
- Export `positionTools(ctx: ChatToolContext): ChatTool[]` with get_open_positions_summary. Input adds expectedBuildId, offset/limit and section:"positions"|"contributors"|"unresolved" (default positions). Output provenance, scope:"current_build", filters, totalPositionGroups, unresolvedCount and exactly one paged section.

- [x] **Step 1: Write failing tests.** Add `partial_close_uses_remaining_quantity`, `distinct_accounts_and_contracts_stay_separate`, `opposing_contributors_keep_gross_and_zero_net_row`, `missing_or_conflicting_account_is_disclosed`, `expiry_metadata_alone_does_not_zero_position`, and `large_contributors_page_without_truncation`. Use quantities 0.1 and 0.2 and assert netQuantity="0.3". Closing executions must not be counted again on top of Strategy.positions.

```ts
expect(decimalRow.netQuantity).toBe("0.3");
expect(offsettingRow).toMatchObject({ netQuantity: "0", longQuantity: "100", shortQuantity: "100" });
expect(partiallyClosedRow.netQuantity).toBe("40"); // opened 100, closed 60
expect(selection.unresolved[0].reason).toBe("conflicting_account");
expect(allContributors).toEqual(expectedContributors);
```
- [x] **Step 2: Verify failure.** Run `npx vitest run test/integration/chat-position-tools.test.ts`; expect missing aggregation and tool.
- [x] **Step 3: Implement exact aggregation.** Iterate nonzero Strategy.positions once per strategy/instrument. Resolve instrument/account from allocations joined to snapshot ledger executions; currency is strategy.currency and must agree with evidence. Ambiguous/missing evidence goes to unresolved, not an invented bucket. Group by account/currency/instrument.key with the shared high-precision Money type, preserving both gross signs. Derive lifecycle IDs only from matching membership/allocation references; do not add lifecycle quantities to strategy quantities. Keep contributor detail in its own paged section. Filters on unresolved rows require known evidence; disclose separately how many unresolved rows could not be assigned to the requested scope.
- [x] **Step 4: Verify.** Run `npx vitest run test/integration/chat-position-tools.test.ts test/integration/lifecycle-acceptance.test.ts`; expect exact signed quantities and unchanged lifecycle accounting.
- [x] **Step 5: Commit.** Stage task files and `git commit -m "feat: add exact current position summaries for chat"`.

### Task 2: Existing-route analytics export descriptor

**Files:** Create `src/server/chat/tools/exports.ts`, `test/integration/chat-export-tools.test.ts`; modify `src/server/chat/tools/index.ts`.

**Interfaces:**
- Export `exportTools(ctx: ChatToolContext): ChatTool[]` registering export_analytics.
- Input is ExportQuerySchema with expectedBuildId required at the tool boundary. Parse through parseExportQuery and reject any URL/path/filename supplied by the caller.
- Output provenance, resolved filters, dataset, filename and downloadUrl. Validate with serializeAnalyticsCsv on the captured snapshot and discard the CSV body after obtaining filename; no persistent file/artifact. Build downloadUrl using URLSearchParams from validated fields only, pinned to `/api/analytics/export` and expectedBuildId. Use resolved currency/filter values, not unresolved omitted defaults.
- Tool description tells the agent to render `[Download CSV](<downloadUrl>)`; the returned URL is relative to the application origin.

- [x] **Step 1: Write failing tests.** Add `descriptor_download_equals_full_scope_service_export`, `more_than_50_rows_are_exported`, `download_rejects_changed_build`, `currency_and_basis_are_pinned`, and `query_special_characters_are_encoded`. Assert returned model content contains no csv field, no filesystem path, and no external hostname. Prove an empty build does not create a misleading pinned export.

```ts
expect(descriptor.downloadUrl).toMatch(/^\/api\/analytics\/export\?/);
expect(descriptor).not.toHaveProperty("csv");
expect(download.body).toBe(serviceExport.csv);
expect(download.headers["content-type"]).toContain("text/csv");
expect(downloadAfterRebuild.statusCode).toBe(409);
```
- [x] **Step 2: Verify failure.** Run `npx vitest run test/integration/chat-export-tools.test.ts`; expect missing export tool.
- [x] **Step 3: Implement descriptor and registration.** Use existing parser, snapshot and serializer; preserve existing CSV escaping and exact decimals. Validate URL arguments, expose service errors through refuseInvalidInput, and register under read guards. Do not add a route or alter download-side build validation.
- [x] **Step 4: Verify.** Run `npx vitest run test/integration/chat-export-tools.test.ts test/integration/analytics-export.test.ts`; expect generated links to download equivalent full-scope CSV and reject old builds.
- [x] **Step 5: Commit.** Stage task files and `git commit -m "feat: expose validated analytics download links to chat"`.

### Task 3: Download link rendering and release integration

**Files:** Modify `src/web/chat/{markdown.ts,Markdown.tsx}`, `src/server/chat/instructions.ts`, `README.md`, `test/integration/chat.test.ts`; create `test/unit/chat-download-links.test.ts`, `e2e/chat-exports.spec.ts`.

**Interfaces:**
- Extend Inline union with `{kind:"download"; text:string; href:string}`.
- Export `isAnalyticsDownloadHref(value: string): boolean` from markdown.ts. Require a raw relative URL beginning `/api/analytics/export?`, exact pathname, no fragment/backslash/control character, and a nonempty expectedBuildId. Reject absolute/protocol-relative URLs, encoded path separators and path traversal. Query contents are still validated by the export endpoint.
- Recognize only `[label](href)` with a single-line plain-text label and a validated href; render other markdown links literally. Markdown.tsx renders the download token as a same-origin anchor with download attribute. No raw HTML, target mutation or automatic navigation/fetching.

- [x] **Step 1: Write failing tests.** Parameterize link parsing over the valid export URL, https:// destinations, //host paths, javascript:, /api/maintenance/reset, traversal, encoded separators, fragments, backslashes, embedded controls and missing build ID. Assert only the validated export yields a download token and hostile labels remain React text. In fake-inference integration, call export_analytics then return its link. In browser tests, click the rendered link, assert CSV download content/filename, and rebuild before a second click to assert stale-build rejection.

```ts
expect(isAnalyticsDownloadHref("/api/analytics/export?dataset=summary&expectedBuildId=build-1")).toBe(true);
expect(isAnalyticsDownloadHref("//example.com/api/analytics/export?expectedBuildId=build-1")).toBe(false);
expect(isAnalyticsDownloadHref("/api/maintenance/reset?expectedBuildId=build-1")).toBe(false);
expect(parseInline("[Download CSV](/api/analytics/export?dataset=summary&expectedBuildId=build-1)"))
  .toContainEqual({ kind: "download", text: "Download CSV", href: "/api/analytics/export?dataset=summary&expectedBuildId=build-1" });
```
- [x] **Step 2: Verify failure.** Run `npx vitest run test/unit/chat-download-links.test.ts test/integration/chat.test.ts`; expect missing download token/renderer behavior.
- [x] **Step 3: Implement rendering and instructions.** Prefer position tools for current holdings; explicitly state quantities are not live values. Explain that export links cover all selected rows and must be regenerated after a rebuild. Update capability-discovery tests to include new registered tools automatically; do not claim quotes, Greeks, FX or live valuation support.
- [x] **Step 4: Verify release.** Run `npm run check:all`, `npm test`, `npm run test:e2e -- e2e/chat-exports.spec.ts e2e/chat.spec.ts`, and `npm run test:build-smoke`; expect exit 0 for each. Record any existing unrelated warnings separately rather than broadening this change.
- [x] **Step 5: Commit.** Stage task files and `git commit -m "feat: render validated analytics downloads in agent replies"`.

## Handoff and self-review

Release 3 covers positions, contributors, unresolved attribution and full-scope
download links. All five Review Focus conditions have named tests. It requires
only release 1; proposal expansion can be delivered separately. No live market
integration or new storage subsystem is implied by this plan.


## Execution record (2026-10-20)

Implemented on `feat/agent-portfolio-tools` from merged release 2 (`4ba339b`).
All three tasks are complete. No new dependencies, migrations or export storage.

- Ruling: added a `conflicting_currency` unresolved reason and
  `unscopedUnresolvedCount` to the selector/tool metadata. Currency disagreement
  and attribution gaps under requested filters must be disclosed accurately;
  the original account/instrument-only reason enum could not express both.
  Cost if wrong: localized additive response-contract revision.
- Position quantities come only from `Strategy.positions`; exact allocation
  evidence supplies account/instrument attribution and matching lifecycle links.
  Contributor, position and unresolved sections have independent paging.
- Export descriptors pin resolved currency, basis, filters and build to the
  existing CSV route. Download bodies never enter model context or new storage.
- Chat links allow only the exact relative analytics export route with a build
  ID. Other markdown links stay literal and labels render as React text.
- Verification: 888 unit/integration tests across 82 files; 9 targeted browser
  tests; `npm run check:all` and built-server smoke passed. Existing lint
  warnings/information and Playwright color-environment warnings remain.
- Browser regression verifies a real CSV download, then a canceled download on
  a stale link and HTTP409 from the same endpoint. Chromium exposes these
  downloads through download events rather than ordinary response interception.

### Final independent review

The review found two Important issues, both reproduced before the single fix
pass: lowercase/value-prefixed underlying filters returned false empty results,
and a contributor containing many lifecycle IDs could exceed the output budget.
Filters now use the existing journal normalization, including aliases. A real
1,000-lifecycle merge regression verifies the contributor quantity is returned
once and every linked lifecycle is retrievable through the guarded tool.

Ruling: add `section=lifecycle_links`, `totalLifecycleLinks`, and contributor
`lifecycleCount` instead of embedding an unbounded ID array in each tool row.
This preserves numeric coverage and provides independent continuation for IDs.
Cost if wrong: additive tool section and contributor response revision before
release. Internal selector contributions retain the complete ID arrays.

Five regressions failed before the fixes; all 14 position tests then passed.
Final verification passed: 888 tests in 82 files, 9 browser tests, lint/typecheck
and built-server smoke. No Critical or Minor findings; nothing was declined for
judgment and no review findings remain deferred.
