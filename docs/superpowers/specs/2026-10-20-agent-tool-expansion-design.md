# Agent tool expansion — review draft

## Intent and scope

Make the in-app TradeLedger assistant able to explain the same performance,
lifecycles, campaigns, and evidence available through the application, and help
prepare valid corrections without bypassing user acceptance. This document turns
the preceding tool audit into proposed requirements for the requested plans; it
has not been approved for product implementation.

Deliver three independently testable releases in order:

1. Read access and evidence: snapshot consistency, analytics, lifecycles,
   campaigns, source rows, richer journal filters, and capability discovery.
2. Correction workflow: decision history, isolated proposal previews, and selected
   additional proposal kinds.
3. Portfolio summaries and exports: exact remaining quantities and downloadable
   full-scope analytics through existing application routes.

Plans live at `../plans/2026-10-20-agent-tools-{reads,proposals,portfolio}.md`.
The first release does not depend on the second or third. Each subsequent release
builds on the first. The portfolio release does not depend on proposal expansion.

## Existing implementation to reuse

- `src/server/chat/tools/index.ts`: registers 15 application tools, wraps reads
  with repeat guards and approved writes with guard resets.
- `src/server/analytics/{snapshot,aggregate,details,query,csv}.ts`: coherent
  snapshots, dashboard calculations, validated queries, details and CSV exports.
- `src/server/http/routes-lifecycles.ts`: lifecycle and campaign evidence.
- `src/server/imports/service.ts`: retained raw rows and staged preview summaries.
- `src/server/ai/proposals.ts`: six proposal variants, conversion to decision input,
  validation and accept/reject. `src/server/decisions/schemas.ts` has 17 variants.
- `src/server/builds/service.ts`: projection/full rebuilds. `computeProjection`
  allocates durable IDs, so it must not run against the live store for a preview.

## Project-wide requirements

- Node.js >=22.19.0; use existing TypeScript, Zod, decimal.js, Fastify and Vitest.
- No new runtime dependencies or database migrations.
- Money and quantities remain decimal strings; null means unavailable, never zero.
- Never sum currencies together or silently fall back between P&L bases.
- Analytics default to `unit=lifecycle` and `basis=broker`, matching the dashboard.
- Reuse existing accounting and filter semantics; do not recalculate metrics in prompts.
- All new read tools use `approval: "never"` and the existing read repeat guard.
- Existing writes keep `approval: "always"`; decisions require explicit proposal acceptance.
- Keep `profile: "none"`; do not add shell, arbitrary SQL, filesystem or generic network tools.
- Broker content is untrusted data; private evidence must not enter sanitized issue reports.
- A read captures one build/ledger snapshot. An expected build mismatch fails with the existing analytics build-mismatch error.
- Build-dependent results include buildId, ledgerId, stale and generatedAt; decision-dependent results also include watermark.
- List tools use offset/limit, default 50 and maximum 50, and return total and nextOffset.
- Output must fit the existing model byte/line budgets; no silent loss of rows or numeric coverage.
- Dates must be real YYYY-MM-DD dates with from <= to. Unknown input keys are rejected.
- Existing tool names and existing proposal JSON remain compatible.
- No automatic commit, branch, deployment or product implementation during planning.

## Release 1 acceptance

`get_analytics_summary` returns fixed-size performance, transactions and quality
sections from `aggregateAnalytics`; it omits option lists and unbounded series.
`get_analytics_details` pages dashboard detail rows; `get_analytics_breakdown`
pages one of daily, monthly, byStrategyType, byUnderlying, recent, best or worst.
All accept the existing analytics filters, with expectedBuildId added at the tool
boundary. Preserve resolved filters and explicitly label closed-P&L drawdown.
Require an explicit currency if the existing service cannot select one uniquely;
use the existing service error rather than inventing combined currency totals.

`list_lifecycles`, `get_lifecycle`, `list_campaigns`, and `get_campaign` expose
existing projections. Single-item tools return bounded scalar summaries and
exactly one selected evidence collection per call. Legacy builds without lifecycle
data require rebuild; they must not look like a valid empty lifecycle set.

`get_import_rows` exposes source-row metadata with a field-name inventory;
`get_import_row_field` retrieves a named field in 1,000-character chunks. Never
silently truncate a source field. Staged preview issues gain offset/limit, total
and nextOffset while preserving the existing `issues` property.

Existing journal tools gain expectedBuildId; transaction filters gain underlying,
assetClass, instrumentKey, executionKey and account. Strategy underlying/asset
filters follow instrument evidence from allocations and intersect other filters;
retain existing description-search symbol behavior for compatibility.

`get_capabilities` derives tool names, approval modes, proposal kinds and limits
from the same factories/constants used for registration. It discloses absent live
quotes, Greeks, FX conversion, account equity reconstruction and multiplier fixes.

## Release 2 acceptance

`get_decision_history` reads a captured watermark and pages decisions scoped by
kind, strategyId, lifecycleId, campaignId or importId. Return effective/superseded
status based on the complete captured history before applying filters.

`preview_proposal` accepts one Proposal plus expectedBuildId and expectedWatermark.
It produces `{valid, buildId, ledgerId, watermark, issues, impact}`. Impact compares
before/after counts, per-currency strategy P&L summaries, and review-issue counts
by code; unknown amounts stay null with coverage. Do not compare ephemeral IDs.

Run full semantic validation and normal rebuild only on an isolated SQLite copy.
Capture and recheck the live build and watermark around cloning and simulation;
discard results on change. Clean temporary stores on success and error. A preview
creates no live decision, identity, job, ai_run or build. It is a hypothetical
result, not a guarantee of acceptance after later data changes.

`submit_proposal` performs the same validation before recording a card. Acceptance
still revalidates against current state; it never trusts a previous preview.
Preview is optional for the existing six variants, preserving old clients.

Add proposal variants group_merge, group_split, import_exclusion, import_inclusion,
lifecycle_attachment, lifecycle_membership, lifecycle_attachment_rejection,
wheel_campaign, and wheel_campaign_membership, using existing decision payload
schemas. Add optional supersedesId, default null, to proposal common fields. Keep
author/clientRequestId controlled by the application. Preserve rendering and
acceptance of legacy proposal records. Do not expose generic rejection or
lifecycle_valuation proposals in this release: manual marks need a separate
input/source/as-of UX design. Do not add multiplier correction support.

## Release 3 acceptance

`get_open_positions_summary` groups current signed quantities by account, currency
and instrument key using projection position quantities, not the sum of every
historical execution. Include strategy contributors, available contract metadata
and linked lifecycle IDs. Do not net distinct contracts or accounts. Disclose
unresolved attribution; no prices, Greeks, live exposure or implied valuation.
Return both signed net and gross long/short quantities so offsetting holdings
remain visible. Opposing nonzero contributors remain in the result even at net zero.

`export_analytics` validates the existing ExportQuery, checks the expected build,
and returns a relative download URL to `/api/analytics/export`, filename and
provenance. Do not put CSV bodies into model context or persist new artifacts.
The download revalidates the expected build; a rebuild requires a new export.
The UI renders this specific internal route as a download link and never auto-fetches
external destinations from model text.

## Review and verification

Every release has targeted regression tests and runs lint, typecheck, all Vitest
tests and production build smoke before handoff. Use the fake inference server
to prove new tools are actually offered and usable. Release 2 also exercises
proposal cards in browser tests; release 3 exercises the download link. No live
model, broker account or external API is required for acceptance.

Review these defaults with the plans before implementation, especially the cost
of isolated preview rebuilds and the deliberate deferral of manual valuations.
