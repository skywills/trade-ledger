# Agent Tools: Reads and Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the chat agent dashboard-consistent analytics, lifecycle/campaign evidence and source-row diagnostics through bounded read tools.

**Architecture:** Wrap existing services with focused tool factories and one snapshot/paging adapter. Preserve current tools and use the same registration path and repeat guard. This is release 1; the linked proposals and portfolio plans can follow independently.

**Tech Stack:** Node.js >=22.19.0, TypeScript, Zod, decimal.js, better-sqlite3, Vitest, existing nax-agent runtime.

**Spec:** `docs/superpowers/specs/2026-10-20-agent-tool-expansion-design.md`, project-wide requirements and release 1. Approved for implementation on 2026-10-20; native execution on `feat/agent-read-tools`.

## Global Constraints

- Node.js >=22.19.0; use existing TypeScript, Zod, decimal.js, Fastify and Vitest.
- No new runtime dependencies or database migrations.
- Money and quantities remain decimal strings; null means unavailable, never zero.
- Never sum currencies together or silently fall back between P&L bases.
- Analytics default to `unit=lifecycle` and `basis=broker`, matching the dashboard.
- All new read tools use `approval: "never"` and the existing read repeat guard.
- Keep `profile: "none"`; do not add shell, arbitrary SQL, filesystem or generic network tools.
- List tools use offset/limit, default 50 and maximum 50, and return total and nextOffset.
- Existing tool names and existing proposal JSON remain compatible.
- Other project-wide requirements in the spec apply unchanged.

## Review Focus

- Build activation between summary and drill: reject the old expectedBuildId, never mix generations (Task 1).
- A large individual source field: retrieve every character with explicit continuation (Task 4).
- Multiple currencies or unavailable broker P&L: preserve selection errors/null coverage (Task 2).
- An active build predating lifecycle projections: require rebuild rather than return empty success (Task 3).
- A large detail row shrinking a page: continue at the actual consumed offset, without skips or repeats (Tasks 1–2).

---

## File structure and execution order

- Create `src/server/chat/tools/snapshot.ts`: capture provenance/build checks and page already-selected rows.
- Create `src/server/chat/tools/analytics.ts`: summary/detail/breakdown tools.
- Create `src/server/lifecycles/queries.ts`: reusable lifecycle/campaign evidence selection; keep route behavior compatible.
- Create `src/server/chat/tools/lifecycles.ts`: bounded lifecycle/campaign tools.
- Create `src/server/chat/tools/imports.ts`: source metadata and field chunk reads.
- Modify `src/server/chat/tools/{journal,status,index}.ts`: consistent filters, preview paging and registration.
- Create `src/server/chat/tools/capabilities.ts`: registry-derived capability disclosure.
- Modify `src/server/chat/instructions.ts` and `README.md`: tool routing and user-visible semantics.
- Create focused integration tests per task; reuse `test/helpers/{store,chat}.ts` and existing scenario fixtures. Add scenario fixtures locally to each test file unless shared by multiple suites.

### Task 1: Snapshot checks and bounded selection paging

**Files:** Create `src/server/chat/tools/snapshot.ts`; modify `src/server/chat/tools/{shared,journal}.ts`; create `test/integration/chat-tool-snapshots.test.ts`.

**Interfaces:**
- Consumes `readAnalyticsSnapshot(store, now): AnalyticsSnapshot`, existing `checkBuild` from `src/server/analytics/details.ts`, and `pagedResult`.
- Produces `readToolSnapshot(ctx: ChatToolContext, expectedBuildId?: string): AnalyticsSnapshot` and `pageSelectedResult(meta: Record<string, unknown>, rows: readonly unknown[], total: number, offset: number, limit: number): EmbedderToolResult` in `snapshot.ts`.
- `pageSelectedResult` receives a window starting at offset, not the full dataset. It uses the existing byte-aware formatter, preserves global total and sets nextOffset from the actual number emitted. No-data pages terminate with nextOffset null.

- [x] **Step 1: Write failing tests.** Use `seedLedger` and `createTestStore`. Add `rejects_old_build_after_activation` (seed, capture id, rebuild, call get_strategy with old expectedBuildId; assert error), `preserves_null_build_metadata` (empty store), and `shortened_window_continues_without_skip` (large rows, assert global total, concatenate continuations and compare all original IDs). Add expectedBuildId as an optional strict field to all four journal tool calls in the tests.

```ts
expect(staleResult.isError).toBe(true);
expect(emptySnapshot).toMatchObject({ buildId: null, ledgerId: null });
expect(allReturnedIds).toEqual(originalIds);
expect(lastPage.nextOffset).toBeNull();
```
- [x] **Step 2: Verify failure.** Run `npx vitest run test/integration/chat-tool-snapshots.test.ts`; expect missing adapter or rejected new schema fields.
- [x] **Step 3: Implement the interfaces.** Check the build immediately after synchronous snapshot capture; reuse the existing mismatch error. Move journal reads onto the captured projection/ledger without extra live reads. Preserve existing metadata and strategy note reads; capture notes within the same synchronous database transaction. Extend date validation using `validDay` and reject inverted ranges.
- [x] **Step 4: Verify.** Run `npx vitest run test/integration/chat-tool-snapshots.test.ts test/integration/chat-tools.test.ts`; expect all tests passing, including backward-compatible calls without expectedBuildId.
- [x] **Step 5: Commit.** `git add src/server/chat/tools/snapshot.ts src/server/chat/tools/shared.ts src/server/chat/tools/journal.ts test/integration/chat-tool-snapshots.test.ts` then `git commit -m "feat: add snapshot-consistent agent read helpers"`.

### Task 2: Dashboard-backed analytics tools

**Files:** Create `src/server/chat/tools/analytics.ts` and `test/integration/chat-analytics-tools.test.ts`; modify `src/server/chat/tools/index.ts`.

**Interfaces:**
- Consumes Task 1 helpers, `aggregateAnalytics(snapshot, query): AnalyticsResponse`, `parseAnalyticsQuery`, `parseDetailQuery`, and `selectAnalyticsDetails(snapshot, query): AnalyticsDetailsResponse`.
- Produces `analyticsTools(ctx: ChatToolContext): ChatTool[]` registering get_analytics_summary, get_analytics_details and get_analytics_breakdown.
- Summary input: existing AnalyticsQuery fields plus optional expectedBuildId. Output: provenance, resolved filters, unit, performance, transactions, quality and `drawdownBasis: "closed_pnl"`.
- Detail input: existing DetailQuery filters/drills/kind/sort/direction, replacing page/pageSize with offset/limit. For arbitrary offsets fetch up to two adjacent service pages with pageSize 50, merge their windows, then use pageSelectedResult. Do not expand service page-size limits.
- Breakdown input: analytics filters, optional expectedBuildId, offset/limit and `section: "daily" | "monthly" | "byStrategyType" | "byUnderlying" | "recent" | "best" | "worst"`. Return one section with full-scope totals.

- [x] **Step 1: Write failing tests.** Add `summary_equals_dashboard_for_both_units_and_bases` (compare to direct service result, exact decimal strings), `selects_dashboard_default_currency_without_combining`, `does_not_fallback_from_missing_broker`, `details_support_arbitrary_offset` (offset 47, limit 10), `large_details_resume_at_actual_offset`, `breakdowns_reassemble_full_service_series`, and `rejects_invalid_dates_and_unknown_fields`. Use deterministic seeded lifecycles; do not assert only that the tools exist.

```ts
expect(summary.performance).toEqual(dashboard.performance);
expect(summary.filters).toEqual(dashboard.filters);
expect(summary.drawdownBasis).toBe("closed_pnl");
expect(detail.items).toEqual(allServiceRows.slice(47, 57));
expect(missingBrokerSummary.performance.pnl).toBeNull();
```
- [x] **Step 2: Verify failure.** Run `npx vitest run test/integration/chat-analytics-tools.test.ts`; expect missing analytics factory/tools.
- [x] **Step 3: Implement analyticsTools.** Derive model schemas from Zod input schemas using the established proposal-schema conversion pattern. Strip tool-only keys before calling strict service parsers. Reuse dashboard results without independent metric formulas. Register all three factories in the guarded read array.
- [x] **Step 4: Verify.** Run `npx vitest run test/integration/chat-analytics-tools.test.ts test/integration/chat-tool-snapshots.test.ts`; expect parity for every requested basis/unit and complete continuation.
- [x] **Step 5: Commit.** Stage the three task files and `git commit -m "feat: expose dashboard analytics to the chat agent"`.

### Task 3: Lifecycle and campaign queries

**Files:** Create `src/server/lifecycles/queries.ts`, `src/server/chat/tools/lifecycles.ts`, `test/integration/chat-lifecycle-tools.test.ts`; modify `src/server/http/routes-lifecycles.ts` and `src/server/chat/tools/index.ts`.

**Interfaces:**
- Consumes Task 1 snapshots and the existing route selection logic and `campaignSummary`.
- Produces `selectLifecycleDetail(snapshot: AnalyticsSnapshot, id: string)` and `selectCampaignDetail(snapshot: AnalyticsSnapshot, id: string)` in queries.ts; infer/export return types from these selectors so routes and tools share them.
- Produces `lifecycleTools(ctx: ChatToolContext): ChatTool[]` with list_lifecycles, get_lifecycle, list_campaigns and get_campaign.
- Lists accept account, currency, underlying, status (lifecycles only), expectedBuildId and paging; use underlying contract evidence, not description substrings.
- get_lifecycle accepts lifecycleId, expectedBuildId, paging and `section: "members" | "executions" | "suggestions"` (default members). Return scalar lifecycle summary, valuation, matching campaign IDs and one paged collection; never all three arrays.
- get_campaign accepts campaignId, expectedBuildId and paging; return campaign, existing campaign summary and paged cycles.

- [x] **Step 1: Write failing tests.** Add `lifecycle_matches_existing_route_evidence`, `campaign_counts_cycle_once`, `legacy_build_requires_rebuild`, `rejects_unknown_or_other_build_ids`, and `large_members_are_fully_pageable`. Include overlapping same-symbol lifecycles in different accounts and prove filtering does not attach their executions.

```ts
expect(detail.lifecycle).toEqual(routeDetail.lifecycle);
expect(allPagedMembers).toEqual(routeDetail.members);
expect(campaign.summary).toEqual(routeCampaign.summary);
expect(legacyResult.isError).toBe(true);
expect(legacyResult.content).toContain("LIFECYCLE_REBUILD_REQUIRED");
```
- [x] **Step 2: Verify failure.** Run `npx vitest run test/integration/chat-lifecycle-tools.test.ts`; expect missing factories/selectors.
- [x] **Step 3: Extract selectors and implement tools.** Preserve existing HTTP response shape, including route-specific metadata. Scalar summaries omit nested evidence collections; get_lifecycle returns only the selected collection. Missing lifecycle projection raises LIFECYCLE_REBUILD_REQUIRED. Register tools through the read guard.
- [x] **Step 4: Verify.** Run `npx vitest run test/integration/chat-lifecycle-tools.test.ts test/integration/lifecycle-http.test.ts test/integration/lifecycle-acceptance.test.ts`; expect both tool/route parity and existing lifecycle behavior preserved.
- [x] **Step 5: Commit.** Stage the five task files and `git commit -m "feat: expose lifecycle and campaign evidence to chat"`.

### Task 4: Source rows and preview issue continuation

**Files:** Create `src/server/chat/tools/imports.ts`, `test/integration/chat-import-evidence-tools.test.ts`; modify `src/server/imports/service.ts`, `src/server/chat/tools/{status,index}.ts`.

**Interfaces:**
- Consumes `listImportRows(store, importId, query)` for bounded source metadata.
- Produces `readImportRow(store: Store, importId: string, rowNumber: number): ImportRowView` in imports/service.ts; use parameterized SQL, preserve IMPORT_NOT_FOUND, add IMPORT_ROW_NOT_FOUND for missing row.
- Produces `importEvidenceTools(ctx: ChatToolContext): ChatTool[]` with get_import_rows and get_import_row_field.
- get_import_rows: `{importId, expectedBuildId?, offset?, limit?}`; return rowNumber, section, kind, issue codes/severities and fieldNames, without raw field bodies. Sort by rowNumber ascending.
- get_import_row_field: `{importId, rowNumber, field, valueOffset?}`; return exact value chunk, totalCharacters and nextValueOffset; fixed chunk size 1,000 Unicode code points, nonnegative integer offsets. Unknown field fails explicitly.
- get_import_preview gains optional offset/limit; keep issues array and add total/nextOffset; retain counts, expiresAt and committable on every page.

- [x] **Step 1: Write failing tests.** Add `pages_quarantined_rows_without_normalized_execution`, `source_field_reassembles_over_1000_characters` (include emoji at a chunk boundary), `rejects_unknown_row_field_and_invalid_offsets`, and `preview_pages_more_than_50_issues`. Assert no instructions in imported data are executed and the tool description contains the shared UNTRUSTED notice.

```ts
expect(chunks.join("")).toBe(originalField);
expect(Array.from(firstChunk.value)).toHaveLength(1_000);
expect(finalChunk.nextValueOffset).toBeNull();
expect(previewFirst.issues).toHaveLength(50);
expect(previewFirst.nextOffset).toBe(50);
expect(allPreviewIssues).toEqual(originalPreviewIssues);
```
- [x] **Step 2: Verify failure.** Run `npx vitest run test/integration/chat-import-evidence-tools.test.ts`; expect missing source tools and missing preview continuation.
- [x] **Step 3: Implement source tools and continuation.** Use transaction-scoped metadata capture, pageSelectedResult for database windows, and jsonResult for bounded field chunks. Keep private raw values out of create_issue_report. Document that row evidence is immutable retained source data rather than an editable CSV view.
- [x] **Step 4: Verify.** Run `npx vitest run test/integration/chat-import-evidence-tools.test.ts test/integration/chat-review-tools.test.ts test/integration/chat-tools.test.ts`; expect lossless field/issue continuation and sanitized report regressions passing.
- [x] **Step 5: Commit.** Stage the five task files and `git commit -m "feat: add bounded source evidence tools for chat"`.

### Task 5: Structured journal filters and capability discovery

**Files:** Modify `src/server/chat/tools/{journal,index}.ts`, `src/server/chat/instructions.ts`, `README.md`, `test/integration/chat.test.ts`; create `src/server/chat/tools/capabilities.ts`, `test/integration/chat-capabilities.test.ts`.

**Interfaces:**
- Extend list_transactions with optional underlying, assetClass, instrumentKey, executionKey and account. Extend list_strategies with optional underlying, assetClass and account. All filters intersect; preserve old symbol matching semantics.
- Produce `capabilitiesTool(ctx: ChatToolContext, tools: readonly ChatTool[]): ChatTool`. Build ordinary tools first, construct this tool from their metadata, then guard all reads. Include its own metadata without recursively calling createChatTools.
- Output registered names/approval modes, current PROPOSAL_KINDS, limits 50/20/30 (rows/proposals/read calls), supported analytics units/bases, current build metadata and explicit unavailable features listed in the spec. Import limit constants; do not duplicate numbers in production code.

- [x] **Step 1: Write failing tests.** Add `underlying_filter_includes_options_and_stock`, `filters_intersect_by_account_and_instrument`, `legacy_symbol_search_is_preserved`, and `capabilities_match_registered_tools_and_proposals`. Extend fake-inference chat integration: request analytics then lifecycle evidence, assert new tools are offered, executed and persisted in tool records; forbidden tools remain absent.

```ts
expect(filtered.items.map((e) => e.key)).toEqual(expectedExecutionKeys);
expect(capabilities.tools.map((t) => t.name).sort()).toEqual(registeredNames.sort());
expect(capabilities.proposalKinds).toEqual(PROPOSAL_KINDS);
expect(offeredNames).toContain("get_analytics_summary");
for (const name of FORBIDDEN_TOOL_NAMES) expect(offeredNames).not.toContain(name);
```
- [x] **Step 2: Verify failure.** Run `npx vitest run test/integration/chat-capabilities.test.ts test/integration/chat.test.ts`; expect missing discovery and new filter fields.
- [x] **Step 3: Implement and document routing.** In instructions, prefer analytics for performance questions, lifecycle tools for connected trades, source tools for missing normalized evidence, and expectedBuildId for drill-downs. Explicitly distinguish legacy strategy P&L and closed-P&L drawdown. Update README agent capabilities without claiming later releases exist.
- [x] **Step 4: Verify release.** Run `npm run check:all`, `npm test`, and `npm run test:build-smoke` sequentially; expect exit 0 for each. Check tool calls on an empty build, stale build and normal lifecycle build with fake inference.
- [x] **Step 5: Commit.** Stage task files and `git commit -m "feat: complete agent read capability discovery and filtering"`.

## Handoff and self-review

Release 1 implements every read/evidence requirement from the design. Proposal
previews/history and portfolio/export are intentionally in the sibling plans.
All five Review Focus conditions have regression tests. All five tasks completed on
`feat/agent-read-tools`; 803 Vitest tests passed before whole-branch review.

Execution ruling: the existing dashboard deterministically selects its first sorted
currency when omitted. The tools preserve that behavior and disclose filters.currency
instead of introducing the proposed ambiguity error. Shared defineReadTool and
PagingInput helpers keep model schemas aligned with strict runtime validation.
