# IBKR trade journal design

Date: 2026-10-13
Status: approved for implementation; standalone repository placement approved.

This document is the complete first-release design. Implementation and acceptance tests must not require access to prior conversation, private CSV/ODS files, or a live broker account.

## Purpose and scope

Build a single-user web application for manually importing IBKR Flex CSVs, retaining every source transaction, and presenting shares, single options, and multi-leg strategies in a journal. The database is authoritative. Strategy and position projections are disposable and rebuildable. User decisions survive rebuilds. Docker support is required; the user manages deployment. LLM provider, endpoint, and model are configurable, with local inference as the primary deployment mode and cloud inference explicitly optional.

First release includes imports, ledger, strategy consolidation, review, journal, backups, and rebuilds. Exclude Google Sheets integration, automatic downloads, live prices, automated trading, and advanced payoff/risk calculations. Existing ODS files inform the journal layout; importing historical spreadsheet rows is outside this release.

The application is separate from nax's orchestration domain and consumes public @nathapp/nax-agent and @nathapp/nax-ai APIs, pinned to matching exact versions. Trading concepts must not be added to either library. The application uses a standalone directory with its own package manifest, React/TypeScript frontend, TypeScript Node >=22.19 backend, SQLite, and decimal arithmetic library. It is not a new lockstep-published nax package. The implementation lives at this standalone Git repository root and installs matching exact published library versions without altering the nax monorepo.

## Source evidence and input contract

Inspected user-provided exports demonstrate:

- Activity exports contain execution rows and separate ST closed-lot rows repeating realized P/L. Store both, but never sum them as independent trades.
- Assignment and exercise records link option and stock legs through PositionActionID.
- The expanded execution/P&L CSV contains 54 transactions for September 23–25, matching same-period activity transactions and accounting amounts, including partial-fill multiplicity.
- Its 50 exchange executions have unique IBExecID and populated BrokerageOrderID across multiple days. Treat field availability as actual input capability, not a presumed single-day restriction.
- Its four assignment/exercise records have no IBExecID or BrokerageOrderID. OrigOrderID is zero; OrigTradeID and RelatedTradeID are blank throughout. These cannot substitute for demonstrated lifecycle links.

Preferred input: one Activity Flex CSV at Executions detail with account, TradeID, execution/order IDs, contract fields, quantities, timestamps, multiplier, opening/closing indicators, codes, PositionActionID, commissions, taxes, net cash, cost basis, and realized P/L. Closed Lots are optional supporting records with explicit LevelOfDetail. Accept header-first CSVs and BOF/BOA/BOS/header/data/trailer formats; locate headers by field names, never fixed row offsets.

Older samples remain usable with a capability report and unresolved cases. Normalize exact header aliases (`Price` → `TradePrice`, `Commission` → `IBCommission`, `Code` → `Notes/Codes`, `Date/Time` → `DateTime`, `OrderID` → `IBOrderID`, `ExecID` → `IBExecID`). Missing fields do not justify invented values. Preserve unknown columns. Explicit missing lifecycle indicators prevent definitive assignment classification even if price is zero. Parse contract descriptions only as a flagged fallback.

### Required and optional capabilities

Minimum execution input: account, asset class, symbol or contract identifier, trade date/time, signed quantity, currency, and either NetCash or sufficient proceeds/commission/tax fields to derive it. Price and broker identifiers may be absent for special booked events; preserve them as unresolved evidence. Invalid decimals or missing minimum fields quarantine a row. Preview identifies affected rows before commit. UTF-8 CSV with optional BOM, quoted commas/newlines, and CRLF/LF are supported. Other encodings are rejected with an explanation. Default upload limit is 20 MiB, configurable server-side; filenames never determine storage paths.

Read `LevelOfDetail` when supplied. Otherwise recognize the inspected layouts' no-TradeID, ST/LT supporting rows using both shape and fields; ST/LT alone is not sufficient to exclude an execution. Unknown row types are quarantined. Trailer checksums/counts are verified only when their documented meaning is supported; no inferred checksum formula is allowed. Accounts and sections may repeat within one file.

No transaction disappears merely because it is absent from a later reporting window. Deleting an import is outside the first release. A user can exclude a faulty import through a retained, reversible decision; raw evidence remains available. Preview shows the resulting effect before acceptance.

## Storage model

All IDs are application-generated stable identifiers unless marked as broker identifiers. Financial decimals use canonical TEXT, never SQLite REAL. Foreign keys are enabled. Currency accompanies monetary amounts. Unknown timezone stays unknown; preserve original timestamps and configured report timezone.

| Table | Key fields and relationships | Retention |
| --- | --- | --- |
| accounts | id, broker_account_id unique, base_currency nullable | retained |
| imports | id, filename, sha256, original_file_path, imported_at, report_period, parser_version, status, capability_json | retained |
| import_rows | id, import_id, row_number, section, raw_fields_json, row_kind, parse_errors_json; unique(import_id,row_number) | retained raw evidence |
| ledger_builds | id, input_manifest_hash, parser_version, status, created_at | retained build metadata |
| transaction_revisions | id, ledger_build_id, logical_transaction_key, revision_number, account_id, instrument_json, broker_ids_json, event_type, original timestamps, signed quantity, accounting decimals, revision_state | reproducible normalized evidence |
| transaction_sources | ledger_build_id, revision_id, import_row_id | reproducible provenance |
| lot_details | id, ledger_build_id, import_row_id, closing_reference, opening_datetime, signed lot quantity, basis, reported P/L | reproducible supporting evidence |
| strategy_identities | id, stable_anchor_key unique, created_at, retired_at nullable | retained identity registry |
| identity_bindings | id, source/logical references, canonical identity, decision reference, created_at | retained resolution of weak or conflicting transaction identity |
| decisions | id, sequence, kind, stable source references, strategy_ids, payload_json, author, supersedes_id, created_at | retained append-only decisions |
| jobs | id, kind, input_snapshot, status, progress, error, created_at, finished_at | retained operation history |
| llm_profiles | id, name, mode(local/cloud), provider adapter, protocol, base_url, model_id, context/output limits, capability declarations, credential reference, timeout, revision, enabled | retained nonsecret configuration |
| ai_runs | id, input references/hash, immutable profile snapshot, requested/returned model, prompt/schema version, proposal_json, validation_json, decision references, usage/cost and cost source, status | retained proposals/audit |
| builds | id, ledger_build_id, decision_watermark, algorithm_version, input_hash, status, validation_json | retained generation metadata |
| strategy_views | build_id, strategy_id, description, type, currency, dates, expiry_year, status, history_complete, opening_amount, realized_pnl, remaining_exposure | discardable projection |
| strategy_allocations | build_id, strategy_id, revision_id, allocation_role, allocated_quantity, allocated_cash | discardable projection |
| strategy_links | build_id, source_strategy_id, target_strategy_id, link_type, event/source references | discardable lifecycle/roll projection |
| position_views | build_id, strategy_id, instrument_key, remaining_quantity, basis, completeness | discardable projection |
| review_items | build_id, stable_issue_key, reason, source references, candidate_json, severity | discardable projection |
| app_state | singleton, active_build_id | retained generation pointer |

Index broker transaction/execution IDs with account scope, source links, build/strategy IDs, and filter columns. Never use symbol/date/price alone as a unique constraint: similar partial fills exist in the samples.

Retain immutable originals and each imported occurrence. Repeated identical file hashes are idempotent. Re-exported records match by account plus TradeID, then suitable execution identifiers. Changed payloads create revisions; cancellation/correction evidence determines active state. Conflicting snapshots without reliable correction ordering produce review items. Documented sentinel identifiers such as zero OrigOrderID and N/A normalize to absent while raw values remain intact; do not erase meaningful numeric zero quantities, prices, or P/L. Weak identity matches require review instead of collapsing records. Booked lifecycle events with missing strong IDs remain identifiable by retained source references until resolved.

Transaction revision uniqueness is scoped to ledger generation plus logical key and revision number. Derived rows use build-scoped composite keys; foreign keys prevent cross-generation allocations. Broker identifiers are stored as strings, preserving leading zeros. Raw row references remain usable even if normalization fails. Quarantine errors are visible directly from Imports and are not dependent on a successfully normalized transaction.

Decisions refer to durable source/logical references rather than projection row IDs. Re-normalization remaps accepted references; changed quantities or unmappable references invalidate the affected decision visibly, never silently apply it. Retain metadata such as notes, stop loss, custom names, and grouping membership in decisions. User corrections cannot edit broker raw evidence.

### Stable identity and decisions

Accepted identity bindings are authoritative retained inputs to normalization. Weak rows start with source-based identities; heuristic matches cannot merge them without a retained decision. Exact strong-ID duplicates preserve multiple source links to one logical transaction. Different payloads on one strong ID are conflicts unless explicit broker revision/cancellation evidence resolves them; unresolved revisions cannot silently become active.

Automatic strategy identity is anchored to the account and sorted stable opening-transaction references for a verified opening group. Allocate or retrieve its registry ID once, then reuse it across generations. User splits create child identities; merges retain an explicit chosen identity and retire the others through decisions. Notes are not silently reassigned during a merge. Missing-opening groups use retained source anchors until review establishes a lineage. Identity registration is serialized and does not change financial build inputs.

Decision kinds are identity resolution, import inclusion/exclusion, group membership, quantity allocation, lifecycle link, roll link, split, merge, proposal rejection, and metadata edit. Decisions are ordered by monotonically increasing sequence; supersession references an earlier decision. Apply the latest nonsuperseded decision for a target/action. Overlapping contradictory allocations become review items. Rejected proposals remain rejected for the same evidence hash; changed evidence can create a new proposal.

## Consolidation and accounting

1. Classify executions, supporting lots, summaries, and non-data rows.
2. Build current transaction revisions, handling cancellations and corrections.
3. Aggregate partial fills within verified order/contract groups without dropping executions.
4. Propose strategy groups using BrokerageOrderID, contract identity, opening/closing actions, and quantities. One order may contain both closes and opens, including rolls; split these before strategy classification.
5. Match closes against known openings/lots. Missing history stays unresolved; never invent opening transactions.
6. Link assignment/exercise events using account and PositionActionID where available. Verify contract, quantity, and stock/cash movement consistency. Missing multipliers prevent definitive quantity reconciliation.
7. Apply retained user decisions, then compute allocations, remaining positions, and journal views.

Support shares, long/short single options, common vertical spreads, and explicit custom multi-leg groups. Derive strategy names from actual leg directions and ratios, not existing free-text names alone. Ambiguous structures remain custom/unclassified. Rolls are linked strategies, not automatically one P/L record.

Default assignment presentation is separate option and stock rows connected by a lifecycle link, with a user action to consolidate them into one continuing strategy. Closing the option does not close remaining stock exposure. Cash settlements require an explicit supported source event; do not assume shares for every exercised option.

Opening journal amount is negative opening NetCash (credit negative, debit positive). Keep net cash and broker realized P/L distinct: assignment basis adjustments mean simple cashflow is not universally realized P/L. Completed full-history cashflows may be compared against broker accounting only when no unmodeled basis transfers or corporate actions are involved. Compare at source precision with tolerance equal to one display minor unit per strategy/currency (USD: 0.01); differences beyond tolerance require review. Display USD using two decimals, rounding half away from zero; preserve source precision throughout calculations. Partial closes show realized P/L alongside remaining exposure. Unknown P/L is null with a reason, never zero. Closed means no remaining exposure and lifecycle completion established; incomplete history blocks definitive completion. Never add lot-detail P/L to execution P/L. Do not aggregate currencies without a verified FX conversion policy. Expiry year is contract expiry year; shares have no expiry/year. Mixed expiries display Mixed with actual dates in detail. Unrealized P/L is unavailable without market prices.

Allocation quantities use the execution's signed units and retain source IDs. Each execution is allocated at most once in total; partial allocations partition its quantity and cash. Distribute commissions, taxes, and execution P/L proportionally when no explicit lot allocation exists, labeling apportioned P/L as estimated rather than broker-verified at strategy level; assign the final decimal residual to the last allocation in stable strategy-ID order. Lot-derived P/L may inform distribution of the execution total, never add to it. Available authoritative execution P/L remains visible even when opening history is incomplete, labeled broker-reported; independently reconstructed lifecycle P/L is null until history is complete.

Strategy status is `open`, `partially_closed`, `closed`, or `unresolved`. Completeness is a separate field and reason list. Unassigned or ambiguous events appear in an unresolved journal bucket, so account totals never omit them. Totals distinguish verified, unresolved, and quarantined evidence; any ambiguous identity/conflict prevents a definitive combined account total until resolved. An opening quantity is zero only when explicitly established, never because the opening is missing. Unsupported transfers/corporate actions affecting inventory block definitive exposure and completion until resolved; accepting a label cannot override a hard accounting invariant.

## Rebuild lifecycle

Serialize mutations through one writer/job queue. Import original bytes into content-addressed storage and commit their database metadata/rows together; use staging plus recovery cleanup so a crash cannot leave a committed import pointing to an incomplete file. Retain failed jobs and diagnostics, not partial active data. Queue normalization and projection builds after committed imports/decisions; batch closely spaced requests into one rebuild. Builds capture a fixed import manifest, ledger generation, and decision watermark. A rebuild writes a new candidate generation without modifying the active view. Readers query one build ID consistently.

Validate conservation of allocated signed quantities and cash, no over-allocation, accounting totals by account/currency, lifecycle consistency, and orphaned decisions. Completeness warnings may activate with review items; hard invariant failures cannot activate. Activate atomically only after validation and only if inputs remain current. A stale candidate is not activated. Crashes leave the old active generation intact. Rollback switches to a retained successful generation and marks it stale if inputs differ; raw imports and decisions remain untouched.

Full rebuild means re-normalizing raw imports with retained identity decisions, then regenerating all projections with the chosen parser/algorithm version. Projection-only rebuild reuses a validated ledger generation. Retain parser/algorithm version metadata and reject a request to recreate an unavailable historical version rather than claim identical results.

Identical inputs, algorithms, and decisions produce identical financial content, excluding timestamps and generated metadata. Rebuild never calls the LLM. Re-analyze unresolved cases is a separate explicit action.

## Application screens and actions

- Journal: spreadsheet-style rows, filters by symbol/status/type/date/currency, sorting, pagination, opening/close dates, expiry/year, description, quantities, debit/credit, realized P/L, and remaining exposure. Notes and stop loss editable through decisions. Deferred risk metrics remain absent/unavailable.
- Strategy detail: legs, allocations, remaining quantities, lifecycle timeline, broker P/L versus cashflows, source CSV rows, linked rolls/assignments, and completeness explanations.
- Transactions: execution ledger, separate lot-detail view, broker identifiers, revision/correction history, and source evidence.
- Imports: upload one or multiple files, preview detected capabilities and new/duplicate/conflicting rows, confirm import, display errors and history. Invalid financial rows are retained and quarantined with review items.
- Review: proposed groups, links, splits/merges, ambiguous identity, missing history, and discrepancies. Acceptance records a decision; rejection and manual edits are retained. No model response auto-commits a financial grouping.
- Maintenance: saved LLM profiles, active model selection, connection/tool-call test, nonsecret configuration and credential-source status, AI usage, rebuild progress/history, rollback, and consistent backup/export/restore. Restore targets a stopped app or validated replacement database.

The backend exposes bounded import preview/commit, ledger browsing, journal/detail browsing, review/decision, rebuild/status/rollback, AI analysis/event streaming, health, and backup operations. Validate all requests and stable references server-side. Existing projections show an Updating or Stale badge when newer inputs await activation. When there is no active build, display an empty journal with import/review guidance. No opaque error page for incomplete data.

The browser never receives provider credentials. Long operations return job IDs and progress; cancellation does not partially activate builds.

## AI boundary

Use createAgentSession/nativeBackend from nax-agent with custom read and proposal tools; nax-ai supplies provider transport. Tools inspect bounded transaction/strategy evidence and submit schema-validated proposals. Use profile `none`, omit workdir so the native session receives its private temporary root, and expose only verified embedder read/proposal tools. Verify the installed public API cannot enable coding tools through this configuration; do not rely solely on prompting. No shell, arbitrary filesystem, raw SQL write, or external financial side-effect tools. CSV content is untrusted data, never instructions. The application independently verifies references and allocations; only user acceptance creates retained decisions. Persist accepted proposals so rebuilding does not depend on repeated LLM answers. Analysis operates on a fixed evidence snapshot with configurable per-job time and token/cost limits. Proposals from stale snapshots require revalidation before acceptance. Cancellation and provider failure leave existing decisions intact. App-level decimal validation applies regardless of model schema enforcement; structured tool sampling is capability-dependent and is not a guarantee of a proposal call. Imports, journal, manual review, and rebuilds work without configured AI credentials.

### Configurable local inference

Local inference is the default workflow. No model name is hardcoded, and no cloud provider is selected on first startup. Users configure named profiles with endpoint URL, model ID, provider adapter, protocol, explicit context window and maximum output tokens, declared tool support, timeout, optional reasoning settings supported by the adapter, and a credential reference. A profile is marked local or cloud for display; this label does not prove the endpoint itself avoids forwarding requests. Model hosting, downloads, hardware, and GPU setup remain user-managed and outside the app image.

Initial local integration targets OpenAI-compatible chat-completions endpoints. For example, a host-run Ollama endpoint commonly uses `http://localhost:11434/v1`, while LM Studio commonly uses `http://localhost:1234/v1`. These are examples, not container defaults. Endpoint/model-specific compatibility must be tested; do not promise every model/server supports tool calling or strict schemas. Relevant upstream contracts: [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [LM Studio tool use](https://lmstudio.ai/docs/developer/openai-compat/tools).

Implement local routing using the existing `openai-completions` protocol and a compatible existing provider adapter, with explicit base URL and model declarations. A nax-ai ProviderOverride amends an existing provider; it cannot introduce a provider called local, ollama, or lmstudio by declaration alone. The UI's profile name is independent of the adapter's provider ID. Via nax-agent, map profiles to `nativeBackend({ model, credentials, catalogOverrides })`; do not pass nax-ai overrides directly where nax-agent expects its own catalog shape. If constructing a nax-ai client directly, supply the same provider overrides to the client catalog and protocol factory. Use the public APIs only. Declare explicit context/output limits and verified reasoning mappings rather than inheriting a cloud model's limits. Distinct endpoints get isolated clients/sessions so provider-wide overrides cannot accidentally reroute another profile.

Settings include manual model-ID entry, optional model discovery when the endpoint supports it, and a Test action that checks connectivity and performs a small synthetic tool-call roundtrip without journal data. Show unreachable endpoint, unsupported protocol/model, malformed tool arguments, timeout, and missing tool-call support separately. A failed or skipped compatibility check must not be represented as verified. The first release's agent review requires verified tool calling; a text-only model can remain configured but cannot run agent review. Strict schema sampling is optional; application validation is mandatory. Split large evidence sets into bounded batches respecting the configured context budget, preserving source IDs and cross-batch references.

Choose a profile per analysis job, defaulting to the selected local profile. Snapshot its nonsecret endpoint/model/settings and revision into the job and ai_run before execution. Changing the default affects new jobs only; switching an active conversation to a different profile creates a new session with explicit evidence, rather than mutating the current client. Timeout, malformed output, or local-server unavailability produces a failed/reviewable analysis and leaves the manual workflow usable. No automatic cloud fallback. Cloud profiles use supported adapters and require explicit selection before transmitting trade evidence.

Provider keys and optional authorization headers come only from environment or mounted secret references; the browser can select a reference and view configured/missing status, never read the secret. Unauthenticated local endpoints need no user API key; if an adapter requires an authorization value, use a documented per-profile compatibility placeholder and never fall back to a real cloud credential. Restrict requests to the configured endpoint; reject redirects to a different origin. Record local token usage when available; show price as unpriced unless explicitly configured. Zero provider billing is not a claim that local hardware has no operating cost. Redact sensitive headers and URL credentials from logs and snapshots.

## Docker and operations

Deliver a multi-stage Dockerfile, compose example, environment template, and run/backup/restore instructions. One production container serves compiled frontend and backend on configurable PORT (default 3000). Container binds 0.0.0.0; compose's example binds host 127.0.0.1. Deployment is user-managed.

Document two local-inference network arrangements: another service on the compose network (for example `http://ollama:11434/v1`), or a host inference server through a configured host gateway (for example `http://host.docker.internal:11434/v1`). `localhost` inside the app container refers to the app container, not the host. Include the Linux host-gateway mapping in the compose example when needed and explain that the inference server must bind an address reachable from the container. The app image does not bundle a model server or weights, and does not require a GPU. Unavailable inference must not fail application readiness.

Run as a non-root user. Persist SQLite, original imports, and transcript state under a writable /data volume. Use SQLite WAL on local persistent storage, one application replica, busy timeout, and serialized mutations. Credentials come from environment or mounted secret files, not image layers or backups. No provider keys in client assets or logs. Frontend and API share one origin; mutations require same-origin checks and accept only expected content types. Remote exposure requires user-managed authenticating reverse proxy; built-in multi-user accounts are outside scope. Forwarded identity headers do not grant application authorization. Single-user means every authenticated visitor has the same journal access. Require an explicit allowed-origin configuration when deployed; reject cross-origin mutation/upload requests, and validate WebSocket origins if used.

Run versioned database migrations before readiness; fail closed on incompatible schema. Liveness indicates process health; readiness requires database/migrations ready. Graceful termination cancels AI work and stops jobs without activating partial generations. Backups pause source/decision commits long enough to capture a consistent database snapshot and its referenced file manifest, then include original files, transcripts, and retained decisions with checksums. The archive records schema and application versions. Restore validates checksums, schema compatibility, and referenced file completeness before replacing a stopped instance; make a pre-restore backup. Secrets are excluded; users reconfigure credentials after restore. Do not copy a live SQLite file without its consistency guarantees.

## Self-contained reference scenarios

These are synthetic test specifications. Descriptions and broker IDs can be invented; financial amounts and relationships below are the acceptance oracle. All amounts are USD. Tests require no private sample file or broker account.

### A. Vertical spread across imports

On 2026-09-03 open AXON puts expiring 2026-10-16: buy one 470 put with NetCash -1402.23006; sell one 480 put with NetCash +1686.7318978. Opening signed quantities are +1 and -1 respectively, with codes O; closing quantities are -1 and +1 with codes C. Both share an opening BrokerageOrderID and multiplier 100. On 2026-09-25 close: sell the 470 put with NetCash +3820.8776968 and FifoPnlRealized +2418.647637; buy the 480 put with NetCash -4557.04028 and FifoPnlRealized -2870.308382. Both share a different closing BrokerageOrderID. Each execution has a unique TradeID/IBExecID. Closing supporting lot rows repeat each leg's P/L and reference the opening time.

Expected: one bull put spread, opening amount -284.50, close date 2026-09-25, cashflow -451.6607454, broker P/L -451.660745, displayed P/L -451.66, zero remaining exposure. Supporting lots do not double totals.

### B. Assignment followed by exercise

On 2026-09-24 the BIDU 105 short put closes with signed quantity +1, codes `A;C`, PositionActionID 119280546, expiry 2026-10-02, multiplier 100; the matching stock event buys +100 shares at 105, NetCash -10500, codes `A;O`, and the same action ID. On 2026-09-25 the BIDU 100 long put closes with quantity -1, codes `C;Ex`, PositionActionID 119326170; the matching stock event sells -100 shares at 100, NetCash +9999.7745, codes `C;Ex`, and that action ID. These four records have unique TradeIDs but no execution or brokerage-order IDs. Opening option transactions are absent.

Expected: two explicit lifecycle links, missing-option-history warnings, and stock exposure +100 then zero across the known stock events, without asserting that missing earlier stock history is complete. Do not calculate a complete option strategy P/L from the stock cash difference. If action IDs and event codes are removed, retain all records and require review rather than assert those lifecycle links. OrigOrderID=0 and blank OrigTradeID/RelatedTradeID do not supply links.

### C. Partial fills and mixed order roles

Two option executions have equal account, symbol, timestamp, quantity +2, and price, but distinct execution IDs and one BrokerageOrderID. Expected total +4; importing them twice preserves +4, not +2 or +8. Another order contains closing and opening legs for a roll. Expected separate strategy episodes with an optional roll link.

### D. Formatting and discrepancy oracles

SHOP lifecycle cashflow +4.223592 displays +4.22. OKTA broker P/L -449.212451 displays -449.21; a manually supplied -449.22 is not silently adopted. A 2026 opening for a 2027 expiry displays Year 2027. Shares display no expiry/year. A supplied expiry label Oct1 conflicting with contract expiry 2026-10-21 produces review and preserves both source values.

## Acceptance checks

1. Header-first and sectioned CSV layouts parse correctly; summaries and ST lots never inflate trades or P/L.
2. Same-file and overlapping imports preserve evidence without duplicating executions; similar partial fills remain distinct.
3. Corrections preserve old revisions and replace/reverse active effects only with explicit evidence.
4. Reference scenario A reconciles opening credit 284.5018378 and completed cashflow -451.6607454; displayed opening amount -284.50 and result -451.66. Close date is 2026-09-25; a conflicting manually entered 2026-09-24 is retained as review evidence.
5. Reference scenario B option/stock lifecycle links reproduce the specified PositionActionIDs when present; the reduced export lacking those fields produces review, not invented links.
6. Reference scenario D reconciles source decimals before display; conflicting manually supplied values remain review evidence, not authoritative overrides.
7. Partial closure, multiple quantities, mixed expiries, assignment with remaining stock, missing openings, and multi-currency data retain correct exposure/completeness.
8. Rebuild deletion/recreation preserves decisions, metadata, financial results, and source traceability without AI calls.
9. Failed, cancelled, concurrent, or stale builds cannot corrupt or replace the active valid view.
10. AI proposals with invalid references or over-allocation are rejected; manual workflow works without AI.
11. Docker build/run, health, migration, volume persistence across restart, and backup/restore roundtrip pass smoke checks.
12. Private user source files are never committed as fixtures; tests use synthetic equivalents preserving relevant structure.
13. Normalization can be deleted and recreated from raw imports and retained identity decisions; quarantined rows remain visible, and duplicate-looking fills satisfy scenario C.
14. Rejections, splits/merges, notes, stop loss, import exclusions, and stale-decision diagnostics survive a full rebuild and backup/restore.
15. Opening/expiry years differ correctly, P/L null differs from zero, and no cross-currency combined total is shown.
16. Upload/parser limits, same-origin controls, bounded AI tools, secret exclusion, and crash recovery are verified with synthetic inputs.

17. Persist and select two model profiles with different local endpoints/model IDs; each analysis uses its immutable selected profile without provider-wide routing leakage.
18. A synthetic OpenAI-compatible server verifies streaming tool calls, proposal validation, context limits, timeout/cancellation, unauthenticated endpoint handling, and no cloud fallback; no live model is required in CI.
19. Document an optional real local-server smoke check plus compose-network and host-gateway configuration. Restart preserves nonsecret profiles and requires separately mounted credentials where applicable.
20. Changing the default model affects only new jobs; existing sessions and rebuilds retain their recorded model/decision provenance, and local inference failure leaves import, manual review, and journal functional.
