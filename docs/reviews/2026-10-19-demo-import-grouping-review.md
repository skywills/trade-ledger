# Import grouping review and fixes — TradeLedger

Date: 2026-10-19

Status: **D1 and D2 corrected; unique quantity-and-basis matching now addresses D4, including closes spanning opening fills and strategies. D3 reconciliation reporting remains a separate follow-up. The isolated imported journal no longer reports missing openings or ambiguous closes; P&L discrepancies remain visible.**

Related: [whole-repository code review](./2026-10-19-whole-repo-code-review.md).

## Privacy and scope

The source exports derive from real trading. This review omits their filenames, paths, fingerprints, import identifiers, row references, symbols, contract descriptions, execution dates and times, quantities, portfolio counts, and financial totals. Repository regression examples use fabricated identifiers and values. Do not attach source exports, database snapshots, or private probe output to this document.

The original investigation reported using application import, build, review, and journal APIs with a scratch data directory. It also used modified inputs and direct grouping probes. Those historical runs are context, not independently reproduced end-to-end evidence for the current revision. Their private results are not reproduced here.

## D1 — inconsistent share metadata split instrument identity (High, corrected)

Share executions can name the same instrument while differing in whether `UnderlyingSymbol` is populated. The previous `sameInstrument()` comparison required the underlying fields to match unconditionally, which could prevent a closing share execution from matching an opening.

In [matching.ts](../../src/server/strategies/matching.ts), identity checks preserve asset-class separation, use broker contract IDs when both sides have them, and otherwise compare symbols and contract terms. The underlying field participates only when at least one side carries expiry, strike, or put/call terms. This resolves the reported share-metadata mismatch while preserving checks for distinct known contracts and differing option terms. A display key alone does not establish identity.

Permanent coverage: [instrument-identity.test.ts](../../test/unit/instrument-identity.test.ts), with existing option and contract-lifecycle tests providing additional guards.

## D2 — tied timestamps must not use CSV line order as chronology (High, corrected)

The previous close-candidate rule could reject an explicitly marked opening at the same timestamp as a close when the opening appeared later in the report. An intermediate fix trusted shared-report line order, but this still made interpretation depend on export sorting.

In [grouping-close-candidates.ts](../../src/server/strategies/grouping-close-candidates.ts), explicit broker open/close roles now allow same-instant exposure regardless of line order. Instrument, account, currency, capacity and comparable-time requirements still apply. Unzoned rows need a shared clock/report; date-only or otherwise incomparable timestamps remain uncertain. Existing lifecycle-event ties retain their own evidence rule.

This establishes grouping at a tied timestamp; it does not invent assignment or expiry classification. The [design specification](../superpowers/specs/2026-10-13-ibkr-trade-journal-design.md) still requires lifecycle indicators for definitive classification. Presence of an opening alone also does not establish unconsumed exposure.

Permanent coverage: [grouping-chronology.test.ts](../../test/unit/grouping-chronology.test.ts), including reverse and conflicting export line orders and separate unzoned reports.

## D3 — overlapping reconciliation findings (Medium, open)

Strategy and lifecycle accounting can both emit `PNL_RECONCILIATION` findings involving the same allocations. This can inflate the review queue. A lifecycle containing a flagged strategy does not by itself prove that both findings describe exactly the same discrepancy: aggregation and lifecycle membership can change the comparison.

A follow-up should correlate affected allocations and amounts before consolidating findings. Preserve source attribution and access to both accounting scopes.

## D4 — use unique basis evidence and support closes spanning lots (corrected)

A close can be uniquely attributable even when several opening fills exist. In [grouping-basis.ts](../../src/server/strategies/grouping-basis.ts), a bounded whole-contract search uses original opening cost basis, remaining capacity and the closing cost basis to find a unique allocation within the currency's minor-unit tolerance.

The search supports multiple opening fills inside one broker-order strategy and closes spanning strategies. Equal-basis fills within a strategy are treated as interchangeable. The search compares solutions by per-strategy quantities: different fill combinations that prove the same strategy allocation do not create strategy ambiguity. In-build fill provenance is tracked only where it is established; uncertain provenance is omitted rather than guessed, so it cannot later justify a cross-strategy split. Broker lot references, unsupported identity or multiplier combinations, and manual partial allocations are not overridden. Grouped inventory with prior closes lacking fill-level basis provenance is not guessed.

When choosing between strategies, multiple valid solutions and exhausted search budgets remain unresolved, and the ordinary whole-close fallback cannot bypass those outcomes. Fully equivalent whole lots retain the established deterministic tie-break only after all compatible partial exposure is considered. A single compatible strategy with enough exposure remains a valid strategy match without inventing which of its internal fills supplied the basis; that untracked fill attribution cannot later be used as proof for a cross-strategy split. A search without applicable basis evidence does not replace the pre-existing matching rules. The search is bounded to twelve distinct basis lots after equivalent-fill coalescing, ten thousand closing contracts and twenty thousand search nodes.

Cash splits use the existing decimal residual-preserving helper. When a broker P&L total is apportioned across strategies, attribution is explicitly estimated. Every affected closing strategy retains its roll links to replacement openings.

Permanent coverage: [grouping-basis.test.ts](../../test/unit/grouping-basis.test.ts), with fabricated basis-selection, grouped-fill, split-close, residual-capacity, ambiguity, cash-conservation and roll-link regressions.

## In-app agent diagnostics and reports

The existing chat agent now has `diagnose_review_issue` and `create_issue_report`, registered alongside its journal tools in [review.ts](../../src/server/chat/tools/review.ts).

Diagnosis pins the active build, resolves issue source or accounting scope, and pages private execution history and current allocations. Per-close opening evidence travels with its execution row so large findings remain pageable. Findings without available normalized source evidence explicitly direct investigation to import diagnostics rather than implying an empty result proves anything.

The agent uses the existing `submit_proposal` flow for supported journal corrections. A user must accept a proposal before it becomes a retained decision. The agent does not edit broker files or application code and cannot dismiss unsupported cases silently.

Reports use fixed, allowlisted technical templates and coarse structural observations. They omit trading details and source identifiers, accept no model-authored report text, and are returned in chat without external publication. The synthetic reproduction is a template, not a replay of private trades. Instructions tell the agent to keep private evidence separate from a shareable report.

Permanent coverage: [chat-review-tools.test.ts](../../test/integration/chat-review-tools.test.ts), including privacy, current-build references, accounting scopes, consumed-opening evidence, large-result pagination and unsupported source scopes.

## Rebuild and version behavior

The grouping algorithm version is now `lifecycles-v3`; the parser version is unchanged. Existing projections built with the previous algorithm are detected as stale by the active-projection version check.

Both full and projection-only builds call `computeProjection()` and rerun grouping and accounting. A projection-only rebuild applies these fixes when its retained normalized ledger passes the existing validation checks:

```json
{ "mode": "projection" }
```

Use `POST /api/builds` to request the rebuild. A full rebuild is needed when normalization rules, source imports, or relevant identity/inclusion decisions invalidate the retained ledger. A full rebuild is not required solely because these grouping rules changed. Only the isolated scratch journal was rebuilt for verification; the repository's existing journal data was not changed.

## Verification

New matching and diagnostic regressions were observed failing before the corresponding changes. Final checks:

| Gate | Result |
|---|---|
| `npm test` | PASS — 67 files, 748 tests |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — no errors; existing warning/info profile |
| `npm run test:e2e` | PASS — 94 Chromium tests |
| `npm run test:build-smoke` | PASS — compiled server health, migrations and graceful shutdown |
| `npm run test:docker` | PASS — non-root image, import and restart persistence |
| `git diff --check` | PASS |
| Isolated journal full rebuild | No missing-opening or ambiguous-close findings; reconciliation discrepancies remain visible |
| Privacy checks | No identified private source filenames, fingerprints, trade identifiers, precise financial figures or credential/account formats in this review |

The live verification uses only the isolated scratch journal; original exports and the repository's existing journal data are not modified. Private details and financial totals are not reproduced here.

## Follow-ups

- Correlate strategy and lifecycle reconciliation findings before deduplicating them.
- Extend basis matching only when additional broker evidence can be handled without guessing unsupported allocations.
- Measure chronology and grouping throughput on large journals using synthetic data.
- Treat exports without lifecycle codes as weaker evidence; zero price or cash alone does not establish expiry or assignment.
