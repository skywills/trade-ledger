# Whole-repository review tracker

Reviewed `main` at `b4726a3426aba03f1040629a8cbd4f6f2de6395f` on November 25, 2026. IDs R01–R24 preserve the numbering of the original review. The evidence sections describe that commit. The checklist and resolution table record subsequent fixes.

**Baseline findings.** 22 defects reproduced with synthetic inputs, one additional concurrency defect established by source trace (R07), and one observed compatibility gap awaiting a product decision (R13). The full unit and integration suite passed again during reassessment (**1,172 tests across 122 files**). On this same commit, the original review also recorded 137 passing browser tests and successful compiled-server and Docker smoke tests.

**What changed on recheck**

- Full rebuilds and persisted reads confirmed accounting errors visible in the journal. R03 generates two reconciliation warnings despite conserving the total. R09 turns a winner and a loser into two breakevens in both reporting units.
- R18 concerns unique staged bytes. A restored preview duplicating a committed file still works. R19 can leave a final archive on disk while its job is marked interrupted. The compiled CLI successfully restores in Docker, narrowing R16 to the packaged commands.
- R24 now has a browser reproduction on both send screens. R07 remains a concurrency proof by source inspection. R13 is a supported-format decision because the import contract does not establish that explicit offsets are required.

## Status and priority

The checkboxes track resolution. Mark an entry complete after its closure check passes, and record the fix commit or documented decision beside the entry. P1 covers incorrect financial results, unintended delivery of journal data, or loss of storage exclusion. P2 covers narrower correctness, recovery, and workflow failures. P3 covers limited API impact or a product decision.

- [x] **P1** [R01 · Overlapping exports double-count a corrected trade](#r01)
- [x] **P1** [R02 · FIFO skips the older remaining shares](#r02)
- [x] **P1** [R03 · Rebuild redistributes lifecycle P&L](#r03)
- [x] **P1** [R04 · Another account’s lot changes realized P&L](#r04)
- [x] **P1** [R05 · Invalid assignment marks a strategy complete](#r05)
- [x] **P1** [R06 · A live chat uses the retired model endpoint](#r06)
- [x] **P1** [R07 · Data-directory lock has an acquisition race](#r07)
- [x] **P1** [R08 · Compact TWS timestamp selects the wrong lot](#r08)
- [x] **P1** [R09 · Futures win and loss appear as breakevens](#r09)
- [ ] **P2** [R10 · Cross-account adjusted-option matching](#r10)
- [x] **P1** [R11 · Decimal spelling removes a cash settlement](#r11)
- [ ] **P2** [R12 · Colliding action IDs drop an assignment link](#r12)
- [ ] **P3** [R13 · CSV timestamp support for explicit offsets](#r13) — support decision needed
- [ ] **P2** [R14 · Transaction CSV loses account identifiers](#r14)
- [ ] **P3** [R15 · Quantity sort misorders paginated transactions](#r15)
- [ ] **P2** [R16 · Packaged offline maintenance commands fail](#r16)
- [ ] **P2** [R17 · Backup accepts an altered retained original](#r17)
- [ ] **P2** [R18 · Restored preview offers an impossible commit](#r18)
- [ ] **P2** [R19 · Shutdown loses the backup completion receipt](#r19)
- [ ] **P2** [R20 · Offline backup snapshots an interrupted restore](#r20)
- [ ] **P2** [R21 · Late model check hides current verification](#r21)
- [ ] **P2** [R22 · Model probe accepts a missing argument](#r22)
- [ ] **P2** [R23 · Simultaneous limits leave chat open](#r23)
- [ ] **P2** [R24 · Retrying a lost acknowledgement duplicates a turn](#r24)

## P1 resolution

All ten P1 findings were fixed in `133cd70` on `fix/review-2026-11-25`. Twelve P2 findings and two P3 entries remain open, including the R13 support decision.

**Existing journals need one full rebuild after upgrading.** The old active build is marked stale. The revised normalization manifest prevents a projection-only rebuild from reusing the old ledger. A full rebuild reads retained imports and decisions using the corrected rules. [Upgrade regression](../../test/integration/builds.test.ts#L933)

| ID | Fix and verification |
|---|---|
| R01 | Correction lineage uses the original trade ID from all corroborating occurrences. Both import orderings produced one active replacement with both sources. [Correction regression](../../test/integration/review-p1-ledger.test.ts#L108) |
| R02 | Both strategy and lifecycle FIFO consume the older lot’s remaining 50 shares and then 30 newer shares on the second sale. A saved ownership correction can override the split. A manual split of one opening retains its existing matching semantics. [Strategy regression](../../test/integration/fifo-accounting.test.ts#L65) · [Lifecycle and override regression](../../test/integration/lifecycle-acceptance.test.ts#L257) · [Manual allocation control](../../test/unit/grouping-phases.test.ts#L98) |
| R03 | Presentation remapping retains reconciled member P&L when it sums to the final allocation. Persisted rebuilds with and without a presentation merge retain 500 and 1,500 on the sale and 700 and 1,700 on the closed cycles. [Rebuild regression](../../test/integration/lifecycle-acceptance.test.ts#L337) |
| R04 | Lot evidence is scoped by account and trade ID. A row from B leaves A’s FIFO gain at 50. The corresponding row from A selects the other lot and yields 10. [Account and lot controls](../../test/integration/fifo-accounting.test.ts#L89) |
| R05 | Assignment validation checks the stock symbol when its underlying is blank, the currency, and the signed delivery for the option right. Rebuilt put and call fixtures retain valid deliveries and leave reversed or unrelated deliveries unresolved. [Decision and rebuild regression](../../test/integration/lifecycle-acceptance.test.ts#L403) |
| R06 | Each admitted turn uses one verified profile snapshot. Session reuse requires the same profile ID and revision. After an endpoint edit the admitted turn finishes on A, and the next turn resumes on B with its transcript. A receives zero follow-ups. [Endpoint and default-profile regressions](../../test/integration/chat.test.ts#L341) |
| R07 | An exclusive SQLite transaction on a stable file guards PID publication, recovery and release. Restore preserves that file. Two independent processes contended for one directory: one acquired it, the other received `DATA_DIR_LOCKED`, and ownership was recoverable after process death. [Process and restore regressions](../../test/integration/restore-hardening.test.ts#L130) |
| R08 | The close matcher parses the lot’s opening date. ISO and compact TWS timestamps now select the same opening and produce the same gain of 10. [Timestamp regression](../../test/integration/fifo-accounting.test.ts#L89) |
| R09 | Futures allocation uses trade proceeds and fees for consumed units. The two lots receive +50 and −50. Missing or inconsistent proceeds produce explicitly estimated shares of the broker total. [Futures regressions](../../test/integration/fifo-accounting.test.ts#L114) |
| R11 | Amount-only settlements use a normalized decimal representation. Equivalent spellings retain one payment and both sources. Conflicting amounts still raise an ambiguity. [Settlement regressions](../../test/integration/settlement-imports.test.ts#L187) |

**Verification on the fix branch.** All 1,195 unit and integration tests and all 137 Chromium tests passed. Typecheck, compiled-server smoke, and Docker smoke passed. Lint exited successfully with four existing warnings.

## Evidence and closure checks

<a id="r01"></a>

### R01 · A correction can leave both trade versions active

Confirmed in two fresh stores using CSV preview, commit and a full rebuild. The first file contained T1 for +1 and T2 for +2. An overlapping export repeated T2 with `OrigTradeID=T1`. When the sparse occurrence sorted first by generated import ID, the active ledger contained both T1 and T2, totaling +3, with no ledger issue. Reversing that source order produced only T2, totaling +2. The failure requires a partial identifier set across overlapping occurrences. Both runs preserved `OrigTradeID=T1` on the merged T2, but revision processing reads its predecessor from the first occurrence.

**Close when** both orderings yield one active T2, a superseded T1 and both T2 sources. [Identity merge](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ledger/identity.ts#L383) · [Revision activation](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ledger/revisions.ts#L55) · [Overlapping-export test fixture](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/integration/identity-fingerprint.test.ts#L100)

<a id="r02"></a>

### R02 · A newer lot absorbs a sale that should span two lots

**Confirmed in two full rebuilds.** Buy 100 shares at $100 and 100 at $90 on successive days. Sell 50, then 80, both at $105, with no lot references or cost-basis column. CSV import, full rebuild and a read of the persisted allocations showed the first sale consuming 50 from the older lot and the second consuming all 80 from the newer lot. FIFO requires the second sale to consume the older lot’s remaining 50 and 30 from the newer lot. Recorded balances were 50 and 20 shares. The correct balances are 0 and 70. A second import reproduced the same error in lifecycle membership when two put assignments delivered these lots into one stock strategy. Both paths take the single owner capable of covering the whole sale before considering partial owners. [Strategy matching](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/strategies/grouping-closes.ts#L141) · [Lifecycle matching](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/lifecycles/project.ts#L350)

**Limits and closure.** The example has known chronological order and no overriding evidence or user pairing. Existing lifecycle tests cover single sales of 100 and 200 against two full 100-share lots. Add persisted assertions for the 50/80 sequence in both shapes, including lot balances and the $250/$450 broker P&L split of the second sale. Retain coverage for explicit lot evidence and covered-call decisions that intentionally override default ownership. [Existing FIFO cases](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/unit/lifecycle-stock-fifo.test.ts#L66)

<a id="r03"></a>

### R03 · A rebuild replaces basis-reconciled lifecycle P&L with estimates

**Confirmed in a full rebuild.** Two put assignments delivered 100 shares each into one stock strategy, costing $10,000 and $9,000. A single sale of all 200 shares for $21,000 reported $2,000 broker P&L. Each lot received $10,500 of proceeds, yielding $500 and $1,500. A full rebuild persisted $1,000 per lot, both marked estimated. With $200 option P&L per lifecycle, the resulting closed cycles both displayed $1,200 broker P&L against reconstructed values of $700 and $1,700. Both lifecycles showed reconciliation warnings. The build always supplies an origin projection, even with no merge decisions. During remapping, the code retains owner quantities and repartitions the sale total, losing the lot-specific amounts and their attribution. [Build caller](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/builds/service.ts#L178) · [Remapping](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/lifecycles/project.ts#L751) · [Lot-specific attribution](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/lifecycles/fifo-pnl.ts#L61)

**Limits and closure.** Aggregate P&L and sale quantities remain correct. The existing unit test obtains $500/$1,500 by omitting the origin projection. Add a full rebuild and persistence read asserting both amounts, basis-reconciled attribution, closed-cycle broker totals and absence of those reconciliation warnings. Repeat with a presentation merge to cover the purpose of the remapping branch. [Existing unit test](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/unit/lifecycle-stock-fifo.test.ts#L324)

<a id="r04"></a>

### R04 · Another account’s closed lot changes which holding a trade closes

Confirmed with two full CSV rebuilds. Account A bought one share for 100 on October 1 and another for 140 on October 2, then sold one for 150 on October 3, trade TC. With no closed-lot evidence, A closed the first holding and reconstructed a gain of 50. Adding only a `CLOSED_LOT` row for account B with trade ID TC and the October 2 opening changed A’s gain to 10 and left its first holding open. No closing broker P&L or basis selected either opening. The lookup checks only trade ID. This requires a reused trade ID across accounts and two eligible openings.

**Close when** adding B’s row preserves A’s result and the equivalent A row selects October 2. [Lot lookup](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/strategies/grouping-closes.ts#L45) · [Account-scoped identity requirement](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/docs/superpowers/specs/2026-10-13-ibkr-trade-journal-design.md#L67) · [Existing lot-reference fixture](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/integration/strategies.test.ts#L339)

<a id="r05"></a>

### R05 · Invalid assignment corrections can certify a closed strategy

**Confirmed through decision append and full rebuild.** An XYZ short put collected $200 and later had a booked +1 close with zero price and cash. Initially the strategy was unresolved, incomplete and had unavailable reconstructed P&L. A manual assignment decision pointed its close at a sale of 100 OTHER shares with an empty underlying field. The writer accepted the decision and the rebuild became active. The persisted strategy was closed, complete and showed $200 reconstructed P&L, with an assignment link and zero review issues. Independent controls showed that selling 100 XYZ also passed, and buying 100 OTHER passed when its underlying field was empty. The writer verifies the rows exist. Grouping skips an underlying comparison when the stock field is empty and compares only absolute quantities, then resolves both executions. [Decision checks](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/decisions/service.ts#L607) · [Underlying validation](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/strategies/lifecycle.ts#L66) · [Quantity comparison](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/strategies/lifecycle.ts#L87) · [Resolution](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/strategies/grouping-links.ts#L102)

**Limits and closure.** Buying 100 XYZ correctly passed. Explicitly naming OTHER as the stock underlying did produce inconsistency and unresolved issues. The demonstrated false completion affects strategy results. Lifecycle cash attribution has additional currency, symbol and signed-quantity checks. Test manual corrections for both puts and calls using the valid delivery, reversed sign, and wrong stock with a blank underlying. For incompatible evidence, assert no assignment link, unresolved strategy and unavailable reconstructed P&L after rebuild. [Lifecycle cash checks](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/lifecycles/event-cash.ts#L158)

<a id="r06"></a>

### R06 · Existing conversations send follow-ups to the previous endpoint

**Confirmed through HTTP with two loopback providers.** A conversation sent its first message to A. Editing the same profile to B preserved the model ID. Before B passed verification, the existing conversation correctly returned `409 PROFILE_NOT_VERIFIED`. After B passed, A received the existing conversation’s next unique prompt once and B received it zero times. A new conversation on the same profile sent its unique prompt to B once and A zero times. The affected condition is reuse of a live session. The probe used synthetic prompts and local endpoints. [Maintenance edit](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/web/maintenance/ModelsPanel.tsx#L133) · [Send validation](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/chat/service.ts#L219) · [Provider/model identity](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ai/session-host.ts#L79) · [Session reuse](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/chat/service.ts#L441) · [Gateway destination](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ai/transport.ts#L330)

**Closure test.** After an endpoint change and successful verification, submit a unique prompt on the existing thread. A must receive zero copies. Either route the prompt to B or reject the send before contacting a provider and tell the user to start a new thread. Preserve the existing rejection before verification.

<a id="r07"></a>

### R07 · Lock acquisition can admit two owners of one data directory

**Proof · Source trace.** Exclusive create establishes ownership of a directory entry, then a separate write publishes its PID record. A competing acquisition during that interval gets an unreadable record. The recovery branch accepts that as grounds for removal. The first writer can finish on its still-open descriptor after its pathname has been replaced. Both callers can therefore leave acquisition believing they own the directory. A second race exists when competing recoveries inspect the same stale record and deletion acts on a subsequently replaced entry. Server startup and offline restore both depend on this lock. [Lock creation](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/maintenance/lock.ts#L138) · [Record decoding](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/maintenance/lock.ts#L81) · [Recovery](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/maintenance/lock.ts#L181) · [Restore caller](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/maintenance/restore.ts#L407)

**Boundary.** A second acquisition with a fully published, live owner returned `DATA_DIR_LOCKED` in the control. The issue requires process overlap during publication or stale recovery. The source establishes a loss of exclusion. Actual concurrent database damage and its frequency remain unmeasured. The existing tests cover an established live lock and recovery of one stale lock. [Existing tests](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/integration/backup.test.ts#L429)

**Close when** ownership publication, stale recovery, and release preserve the same exclusive owner across competing processes, including after a crash. A two-contender regression must keep the maximum number of simultaneous owners at one.

<a id="r08"></a>

### R08 · A compact TWS opening timestamp sends a close to the wrong lot

Confirmed with the same two A openings and one sale, using only account A. A closed lot naming October 2 as `2026-10-02 12:00:00` closed the second holding for a gain of 10. Changing that one field to `20261002;120000` closed the first holding for 50. The import path normalizes the compact timestamp, but the snapshot reloads raw fields and grouping compares the first ten raw characters with an ISO date. This probe establishes a wrong result for distinct opening dates.

**Close when** both formats identify the same October 2 opening and produce 10 after a full rebuild. [Lot normalization](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ledger/normalize.ts#L221) · [Snapshot reload](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/storage/ledger.ts#L313) · [Raw comparison](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/strategies/grouping-closes.ts#L52) · [Existing ISO fixture](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/integration/strategies.test.ts#L362)

<a id="r09"></a>

### R09 · Futures FIFO turns a winning and a losing lot into two breakevens

Confirmed through CSV import, a full rebuild and the analytics HTTP route. Two separate long futures lots opened at 100 and 200. A single fill closed both at 150 with a multiplier of one, zero fees, zero net cash and zero reported total P&L. Signed trade proceeds were −100, −200 and +300. Both strategy and lifecycle dashboards reported two breakevens on broker basis. Reconstructed basis correctly reported one win and one loss. FIFO used net cash to assign zero to each close allocation and marked both unestimated. The broker reported only the aggregate zero. The aggregate stays correct while the lot outcomes change.

**Close when** proceeds-supported allocation recognizes +50 and −50, or the report identifies the attribution as unavailable or estimated where unsupported. [FIFO calculation](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/strategies/grouping-fifo.ts#L148) · [Futures proceeds rule](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/docs/superpowers/specs/2026-11-14-futures-pnl.md#L9) · [Existing split-lot fixture](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/integration/strategies.test.ts#L251)

<a id="r10"></a>

### R10 · A second account can undo a valid adjusted-option match

Confirmed in successive full builds. Account A opened one XYZ call and expired the adjusted XYZ2 contract with the same expiry, strike and right. A alone mapped the expiry to the original contract and produced one closed strategy. Importing an earlier XYZ2 opening in B made A’s expiry retain the adjusted conid. The build then reported two open strategies and an unresolved close with `MISSING_OPENING`. Contract selection starts with account and currency, but the continuity check receives all rows sharing the conid. The trigger is overlapping option-contract history across accounts.

**Close when** adding or removing B leaves A’s mapped instrument and closed status identical and B’s own opening remains attached to B. [Scope contract](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ledger/adjusted-options.ts#L11) · [Grouping and lookup](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ledger/adjusted-options.ts#L40) · [Single-account fixture](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/unit/adjusted-option-roots.test.ts#L56)

<a id="r11"></a>

### R11 · A change in decimal spelling can remove a matched settlement

Confirmed through two full builds using the repository’s settlement trades. A Statement of Funds row with `TransactionID=payment`, blank Debit/Credit and `Amount=-300` set the short close’s cash to −300 and its reconstructed lifecycle P&L to −200. Adding a corroborating export with the same fields except `Amount=-300.00` reset cash to zero, made that P&L unavailable and produced two ambiguity warnings. Amount-only rows preserve trailing zeros in the deduplication key. The two records shared an explicit ID and came from separate imports.

**Close when** both spellings produce one −300 payment with both sources and genuine conflicting values still trigger review. [Amount-only branch](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ledger/settlements.ts#L35) · [Fingerprint](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ledger/settlements.ts#L193) · [Corroborating-import fixture](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/integration/settlement-imports.test.ts#L211)

<a id="r12"></a>

### R12 · Repeated action IDs across accounts drop a valid assignment link

**Confirmed for colliding IDs.** Two accounts each imported a short put, a +1 assignment close and its own +100-share delivery. In separate full builds, both accounts produced one assignment link and one lifecycle. In a combined import using the same position action ID, the persisted projection contained only A’s link. B’s option and stock appeared as two cycles, producing three cycles overall. Changing only the action IDs to be distinct restored two links and two cycles. The global lookup uses just the action ID, then selects the first derivative and first stock in the entire bucket. [Grouping key](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/strategies/grouping-links.ts#L55) · [Leg selection](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/strategies/grouping-links.ts#L64)

**Limits and closure.** This proves behavior for an accepted multi-account import. The frequency of such cross-account collisions in broker exports remains unknown. Build and reload a combined import with the same action ID, then assert one same-account link and one assigned lifecycle per account. Keep distinct-ID and separate-account controls, and confirm an option in A cannot pair with a lone stock delivery in B. The existing assignment integration test uses distinct IDs. [Existing integration test](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/integration/strategies.test.ts#L809) · [Fixture identifiers](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/fixtures/scenarios.ts#L222)

<a id="r13"></a>

### R13 · Explicit-offset timestamps work in grouping but are rejected on CSV import

Confirmed compatibility gap. CSV preview, commit and a full rebuild retained the source rows but excluded two executions with `2026-10-01T10:00:00+02:00` and `2026-10-01T09:30:00Z` from the active ledger. Each produced `invalid_datetime.DateTime`. A local timestamp imported successfully. The existing grouping test feeds those exact offset forms directly into grouping. The setup guide names DateTime and TimeZone without promising offset-bearing CSV input, and availability of those forms in native Flex exports is unverified. Treat the product requirement as conditional.

**Closure options.** Pass that grouping test through import while preserving the offsets, or document the supported import formats and the reason this path intentionally rejects them. [Timestamp grammar](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/shared/timestamps.ts#L6) · [Import error](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/imports/normalization.ts#L173) · [Grouping fixture](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/unit/grouping-chronology.test.ts#L10) · [Setup guide](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/docs/SETUP.md#L164)

<a id="r14"></a>

### R14 · An all-account transaction CSV drops the account on every row

Confirmed on the HTTP routes after CSV import and a full rebuild. The transaction details endpoint returned two USD rows with accounts A and B. Exporting those same transactions through `/api/analytics/export` with `dataset=transactions` and the same scope returned HTTP 200, and parsing its CSV yielded an empty account cell for both execution keys. The serializer spreads the optional account filter over each execution’s own account. A single-account filter masks the issue. The observed loss affects the dedicated CSV column even when a strong-identity execution key happens to contain an account.

**Close when** unfiltered rows carry A and B respectively, and filtering A still returns only A rows with account A. [Export metadata](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/analytics/csv.ts#L59) · [Transaction mapping](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/analytics/csv.ts#L227) · [HTTP export test](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/integration/analytics-export.test.ts#L5)

<a id="r15"></a>

### R15 · Quantity sorting orders transaction pages lexically

**Proof · HTTP.** Committed two executions with quantities 2 and 10, built the journal, and called `GET /api/transactions?sort=quantity&order=asc&pageSize=1` for pages 1 and 2. The API returned **10, 2** with a total of 2. Descending returned **2, 10**. The route passes quantity strings to a comparator that switches to arithmetic only when both inputs are JavaScript numbers. The default Transactions screen requests date-ordered pages, so this finding applies to callers selecting quantity sort. [Route](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/http/routes-journal.ts#L32) · [Comparator](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/shared/api.ts#L367) · [Web request](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/web/transactions/TransactionsPage.tsx#L16)

**Close when** the HTTP route orders the full result by exact decimal quantity before pagination in both directions. Cover negative values, unequal digit lengths, fractions, and quantities beyond binary floating-point precision.

<a id="r16"></a>

### R16 · Both documented maintenance commands fail in the runtime image

**Proof · Docker.** Built the reviewed checkout. In a disposable native runtime container, `npm run backup -- --data-dir /tmp/test-src --output /tmp/test-out.tar` exited **127** with `tsx: not found`. Created a valid archive with the compiled CLI and ran `npm run restore` against it. That also exited **127**. Both package scripts use a development dependency and a source file, while the runtime contains the pruned dependencies and compiled output. [Scripts](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/package.json#L47) · [Image contents](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/Dockerfile#L47) · [Operator instructions](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/README.md#L255)

**Verified workaround.** In the same container, `node dist/src/server/maintenance/cli.js backup --data-dir /tmp/test-src --output /tmp/test-out.tar` and `node dist/src/server/maintenance/cli.js restore --archive /tmp/test-out.tar --data-dir /tmp/test-target` both succeeded. Substitute the stopped journal volume and intended archive path for operational use. The fault is specific to the packaged commands.

**Close when** the documented offline commands complete a synthetic backup and restore inside the final image as its normal user, and the documented commands agree with the maintenance UI instructions.

<a id="r17"></a>

### R17 · Backup records a fresh checksum for a damaged original

**Proof · Backup, restore, and restart.** Committed a synthetic CSV, changed one byte in the retained original without changing its length, created a backup, restored it, and started the application on the restored directory. Readiness returned **200**. The import still recorded SHA-256 beginning `f5db2074`. Both the manifest and restored file hashed to `4fdca9f6`. Backup checks existence and then hashes the copied bytes. Startup checks the canonical pathname and existence. Neither check compares those bytes with the committed digest. [Collection](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/maintenance/backup.ts#L131) · [Archive digest](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/maintenance/backup.ts#L259) · [Startup validation](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/imports/service.ts#L578)

**Boundary.** This requires corruption before the snapshot. The archive’s own checksum correctly detects later damage to an archived file. The demonstrated loss concerns the integrity of retained source evidence. Existing tests exercise an intact original and damaged archive entries. [Round-trip control](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/test/integration/backup.test.ts#L217)

**Close when** a same-length mutation of a committed original prevents a successful backup, and restore rejects an archive whose original bytes and committed import digest disagree before replacing a journal. Preserve the clean round trip.

<a id="r18"></a>

### R18 · A restored preview can advertise a commit that returns HTTP 500

**Proof · Restore and HTTP commit.** Snapshotted a fresh, committable preview with a unique content hash. The restored preview summary reported `committable: true`. Posting its preview ID to the commit route returned **500 INTERNAL_ERROR**. The same backup also contained a staged duplicate of an already committed file. That preview returned **200** with `duplicate: true` because those bytes already existed under their content hash. SQLite preserves both preview rows while backup copies only committed originals. Startup iterates staged files that exist, so the row with missing bytes survives. [Snapshot](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/maintenance/backup.ts#L228) · [Preview summary](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/imports/service.ts#L280) · [Recovery](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/imports/service.ts#L549) · [Promotion](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/imports/files.ts#L95)

**Scope revision.** The backup contract emphasizes committed evidence. A consistent expiry of transient previews is also a valid remedy. The defect is the surviving committable preview and internal error within its TTL. [Backup contract](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/docs/superpowers/specs/2026-10-13-ibkr-trade-journal-design.md#L150)

**Close when** an unexpired unique preview either commits from the restored data or explicitly requires re-upload and cannot advertise a successful commit. Verify both the unique-file and committed-duplicate cases.

<a id="r19"></a>

### R19 · SIGTERM during an accepted backup can produce an archive with an interrupted job

**Proof · Compiled process.** Started the compiled server with a temporary journal and a 12 MiB synthetic transcript. Posted to `/api/maintenance/backups`, received **202**, and sent SIGTERM immediately. The process exited **1** with `Error: The storage store is closed.` A final `.tar` existed, but reopening the database recorded the job as **interrupted**. Repeated with the same data and waited for completion before SIGTERM. The process exited **0** and the job stayed **complete**. The maintenance archive list skips files whose corresponding job is incomplete. [Signal handler](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/main.ts#L14) · [Shutdown drain](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/maintenance/shutdown.ts#L31) · [Archive finalization](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/maintenance/backup-job.ts#L21) · [Listing](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/http/routes-maintenance.ts#L54)

**Scope revision.** An accepted backup can reach archive rename and still lose its completion receipt. The snapshot uses the writer queue, but archive creation and the later completion write outlive that queued operation. Timing determines the outcome. Archive byte corruption was outside this check.

**Close when** shutdown waits for admitted backup work to reach a durable terminal state before closing the store. Test a real SIGTERM after admission and verify a clean exit, a consistent job/archive pair after restart, and no leftover partial archive.

<a id="r20"></a>

### R20 · Offline backup creates an empty journal during an interrupted restore

**Proof · CLI control and round trip.** Prepared the interrupted-swap state with one imported trade file in `.pre-restore-example/`, its name in `.restore-in-progress`, and no database yet in the target root. Server startup rejected the target with `RESTORE_INCOMPLETE`. The compiled backup CLI on that same target exited **0**, initialized a fresh database, and produced an archive that restored successfully with **zero imports**. The displaced database still had **one import**, and the marker survived. This state is reachable between the outgoing and incoming rename loops. [Swap order](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/maintenance/restore.ts#L310) · [Server guard](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/app.ts#L167) · [Offline backup](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/maintenance/cli.ts#L49)

**Scope revision.** The previous journal remained recoverable in its pre-restore directory. The failure is a successful but misleading backup of the wrong state plus creation of a new database during recovery.

**Close when** the CLI honors the interrupted-restore marker under the lock before opening storage. Verify an actionable error, no archive or new database, intact prior data, and a successful backup after recovery.

<a id="r21"></a>

### R21 · An old profile test can hide a newer successful result

**Confirmed through the model and chat HTTP routes.** Held revision 1’s synthetic provider response open, edited the profile, and verified revision 2. The models endpoint showed revision 2 as verified. Releasing revision 1 returned its own successful result, changed the current profile’s displayed compatibility to `unchecked`, and caused chat creation to return `409 PROFILE_NOT_VERIFIED`. Retesting revision 2 restored `verified`. Two independent clients can overlap these actions. Maintenance’s busy state serializes actions in a single panel. The probe stamps its snapshot at completion. The lookup picks the last completion across revisions and discards it on a revision mismatch. [Maintenance test](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/web/maintenance/ModelsPanel.tsx#L151) · [Snapshot and completion](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ai/compatibility.ts#L113) · [Compatibility lookup](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ai/profiles.ts#L564) · [Chat admission](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ai/session-host.ts#L61)

**Closure test.** Use the same controlled completion order and verify that the revision 2 result stays visible and chat creation succeeds without a third test. An edited revision with no check of its own should remain unchecked.

<a id="r22"></a>

### R22 · A schema-invalid tool response earns model verification

**Confirmed through the profile-test and create-thread HTTP routes.** Three synthetic providers returned valid protocol messages. The correct `journal_probe({"value":"ok"})` response produced `verified` and allowed thread creation (201). An incorrect tool name produced `failed / TOOL_MISMATCH` and blocked creation (409). The correct name with `{}` produced `verified` and allowed creation (201), although the advertised schema requires a string `value`. This false positive allows a provider that fails this particular tool check to pass the setup gate. Subsequent tool calls depend on the provider’s own output. [Advertised schema and prompt](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ai/compatibility.ts#L40) · [Verification predicate](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ai/compatibility.ts#L92) · [Profile requirement](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/README.md#L196)

**Closure test.** Run the three responses above through the public profile-test route. The missing required argument must yield a failed compatibility result, and chat creation must continue to reject the unverified profile.

<a id="r23"></a>

### R23 · A turn that also crosses the thread cap leaves the thread open

**Confirmed at production limits using the chat service called by the message route.** The fixture seeded prior cumulative usage and supplied synthetic provider usage on four successive tool rounds of 25,001 output tokens each. The profile allowed 32,000 tokens per response. With 900,000 prior tokens, the turn crossed both the 100,000-token turn cap and the 1,000,000-token thread cap on round four. The stored total was **1,000,004**, message error `limit:max_generated_tokens`, thread status `idle`. The next send was accepted. With zero prior tokens the identical turn produced 100,004 total and the next send was correctly accepted. With 999,999 prior tokens and one three-token round, only the thread limit fired, yielding `limit_reached` and `THREAD_LIMIT_REACHED` on the next send. The collision proves erroneous admission of another turn. Additional charges were not measured. [Documented cap](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/README.md#L183) · [Per-turn limits](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/ai/session-host.ts#L37) · [First matching reason](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/chat/turn.ts#L72) · [Persisted thread status](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/chat/turn.ts#L159) · [Next-send guard](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/chat/service.ts#L213)

**Closure test.** Preserve both single-limit controls. In the simultaneous case, require `limit_reached` and reject the next send with `409 THREAD_LIMIT_REACHED`, independently of which error the prior message displays.

<a id="r24"></a>

### R24 · Retrying an accepted chat message can run it twice

**Confirmed in Chromium on both the Agent landing page and an open thread.** Playwright forwarded the actual message POST to the compiled app, observed its 202, then aborted the browser response. Each composer displayed “Send failed.” and retained its draft. After the first reply finished, clicking Send again submitted the same text to the same thread with a second UUID. Each path produced two accepted POSTs, **two stored user messages and two provider calls** for the draft. Sending the second POST again with its exact UUID returned the existing IDs and added zero messages. This reproduces a lost acknowledgement after acceptance, followed by an unchanged retry. A click during a still-running turn can instead encounter the busy guard. [First send](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/web/chat/AgentHome.tsx#L93) · [Home retry thread](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/web/chat/AgentHome.tsx#L131) · [Follow-up send](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/web/chat/useThread.ts#L96) · [Draft retention](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/web/chat/Composer.tsx#L118) · [202 response](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/http/routes-chat.ts#L108) · [Server deduplication and busy guard](https://github.com/skywills/trade-ledger/blob/b4726a3426aba03f1040629a8cbd4f6f2de6395f/src/server/chat/service.ts#L174)

**Closure test.** Repeat the dropped-202 case on both screens. An unchanged retry must retain the original key, recover the original message pair, and leave the provider call count at one. Editing the draft into a new message must allocate a fresh key.
