import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { strategyId } from "../../src/server/decisions/registry.js";
import {
  type DecisionInput,
  exclusionInput,
  groupExplicitInput,
  groupMergeInput,
  groupSplitInput,
  identityBindingInput,
  lifecycleInput,
  manualAllocationInput,
  notesInput,
  reinclusionInput,
  rejectionInput,
  stopLossInput,
} from "../../src/server/decisions/schemas.js";
import {
  appendDecision,
  decisionWatermark,
  effectiveDecisions,
  readDecisions,
} from "../../src/server/decisions/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import {
  normalizeLedger,
  readLedger,
} from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import {
  buildExecutionTable,
  type ExecutionFields,
  executionRow,
  fixtures,
} from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  const { store, dispose } = await createTestStore();
  try {
    await run(store);
  } finally {
    await dispose();
  }
}

async function commitBytes(
  store: Store,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const preview = await previewImport(store, {
    filename,
    bytes,
    timezone: "UTC",
  });
  const committed = await commitImport(store, preview.id);
  expect(committed.duplicate).toBe(false);
  return committed.importId;
}

async function activateLatestBuild(
  store: Store,
): Promise<{ ledgerId: string; buildId: string }> {
  const ledgerId = await normalizeLedger(store, {
    parserVersion: "flex-v1",
    decisionWatermark: 0,
  }).then((ledger) => ledger.id);

  const buildId = randomUUID();
  store.db
    .prepare(
      `INSERT INTO builds (
         id, ledger_build_id, decision_watermark, algorithm_version,
         input_hash, status, validation_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(buildId, ledgerId, 0, "test-v1", "test-hash", "active", "{}");

  store.db
    .prepare(
      `UPDATE app_state SET active_build_id = ?, updated_at = ? WHERE singleton = 1`,
    )
    .run(buildId, new Date().toISOString());

  return { ledgerId, buildId };
}

function firstImportRow(store: Store): { importId: string; rowNumber: number } {
  const row = store.db
    .prepare(
      `SELECT import_id AS importId, row_number AS rowNumber
       FROM import_rows ORDER BY import_id, row_number LIMIT 1`,
    )
    .get() as { importId: string; rowNumber: number } | undefined;
  if (row === undefined) throw new Error("No import rows found");
  return row;
}

function axonExecution(
  strike: string,
  conid: string,
  quantity: string,
  netCash: string,
  execId: string,
  tradeId: string,
): ExecutionFields {
  return {
    ClientAccountID: "SIM-A",
    AssetClass: "OPT",
    Symbol: "AXON",
    UnderlyingSymbol: "AXON",
    Conid: conid,
    CurrencyPrimary: "USD",
    TradeDate: "2026-09-03",
    DateTime: "2026-09-03 10:00:00",
    Quantity: quantity,
    TradePrice: strike === "470" ? "14.02" : "16.87",
    NetCash: netCash,
    "Notes/Codes": "O",
    IBOrderID: "OPEN-SPREAD",
    BrokerageOrderID: "BROKER-OPEN-SPREAD",
    IBExecID: execId,
    TradeID: tradeId,
    Expiry: "2026-10-16",
    Strike: strike,
    "Put/Call": "P",
    Multiplier: "100",
  };
}

describe("retained decisions and stable strategy identities", () => {
  it("yields the same strategyId for the same account and opening keys in any order", async () =>
    withStore(async (store) => {
      expect(decisionWatermark(store)).toBe(0);

      const left = await strategyId(store, {
        account: "A",
        openingKeys: ["b", "a"],
      });
      const right = await strategyId(store, {
        account: "A",
        openingKeys: ["a", "b"],
      });
      expect(left).toBe(right);

      const otherAccount = await strategyId(store, {
        account: "B",
        openingKeys: ["a", "b"],
      });
      expect(otherAccount).not.toBe(left);

      const differentKeys = await strategyId(store, {
        account: "A",
        openingKeys: ["a", "c"],
      });
      expect(differentKeys).not.toBe(left);
    }));

  it("appends the first decision with sequence=1 and rejects a stale watermark with STALE_INPUT", async () =>
    withStore(async (store) => {
      const input = notesInput({
        strategyId: "strategy-1",
        text: "Held through volatility",
      });

      const first = await appendDecision(store, input, 0);
      expect(first.sequence).toBe(1);
      expect(decisionWatermark(store)).toBe(1);

      const staleInput = stopLossInput({
        strategyId: "strategy-1",
        price: "2.50",
      });
      await expect(appendDecision(store, staleInput, 0)).rejects.toMatchObject({
        code: "STALE_INPUT",
      });

      expect(readDecisions(store, 1)).toHaveLength(1);
      expect(readDecisions(store, 1)[0]?.payload).toEqual(input.payload);
    }));

  it("rejects appendDecision when expectedWatermark is below the current high-water mark", async () =>
    withStore(async (store) => {
      await appendDecision(
        store,
        notesInput({ strategyId: "s", text: "first" }),
        0,
      );
      const second = await appendDecision(
        store,
        notesInput({ strategyId: "s", text: "second" }),
        1,
      );
      expect(second.sequence).toBe(2);

      await expect(
        appendDecision(
          store,
          notesInput({ strategyId: "s", text: "third" }),
          0,
        ),
      ).rejects.toMatchObject({ code: "STALE_INPUT" });
      await expect(
        appendDecision(
          store,
          notesInput({ strategyId: "s", text: "third" }),
          1,
        ),
      ).rejects.toMatchObject({ code: "STALE_INPUT" });
    }));

  it("is idempotent for duplicate client request IDs and returns the original decision", async () =>
    withStore(async (store) => {
      const first = await appendDecision(
        store,
        notesInput({
          strategyId: "s-1",
          text: "Idempotent note",
          clientRequestId: "req-1",
        }),
        0,
      );
      const second = await appendDecision(
        store,
        notesInput({
          strategyId: "s-1",
          text: "Idempotent note",
          clientRequestId: "req-1",
        }),
        1,
      );
      expect(second.id).toBe(first.id);
      expect(second.sequence).toBe(first.sequence);
      expect(decisionWatermark(store)).toBe(1);
    }));

  it("only supersedes earlier decisions and rejects unknown supersede targets", async () =>
    withStore(async (store) => {
      const first = await appendDecision(
        store,
        notesInput({ strategyId: "s-1", text: "first" }),
        0,
      );
      const replacement = await appendDecision(
        store,
        notesInput({
          strategyId: "s-1",
          text: "second",
          supersedesId: first.id,
        }),
        1,
      );
      expect(replacement.sequence).toBe(2);
      expect(replacement.supersedesId).toBe(first.id);

      await expect(
        appendDecision(
          store,
          notesInput({
            strategyId: "s-1",
            text: "ghost",
            supersedesId: "00000000-0000-0000-0000-000000000000",
          }),
          2,
        ),
      ).rejects.toMatchObject({ code: "STALE_INPUT" });
    }));

  it("rejects an identity_binding decision whose sources are not present in the current ledger", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await activateLatestBuild(store);

      const validSource = firstImportRow(store);

      const invalidSource = {
        importId: "00000000-0000-0000-0000-000000000000",
        rowNumber: 999,
      };

      const valid = identityBindingInput({
        source: validSource,
        canonicalIdentity: "strategy-1",
        expectedQuantity: "1",
      });
      const validDecision = await appendDecision(store, valid, 0);
      expect(validDecision.sequence).toBe(1);

      const invalid = identityBindingInput({
        source: invalidSource,
        canonicalIdentity: "strategy-1",
        expectedQuantity: "1",
      });
      await expect(appendDecision(store, invalid, 1)).rejects.toMatchObject({
        code: "INVALID_SOURCE",
      });

      store.db
        .prepare(
          "UPDATE app_state SET active_build_id = NULL WHERE singleton = 1",
        )
        .run();

      const invalidNoActive = identityBindingInput({
        source: invalidSource,
        canonicalIdentity: "strategy-1",
        expectedQuantity: "1",
      });
      await expect(
        appendDecision(store, invalidNoActive, 1),
      ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }));

  it("flags an identity_binding decision as orphan after the source's quantity is corrected", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await activateLatestBuild(store);

      const source = firstImportRow(store);

      const decision = await appendDecision(
        store,
        identityBindingInput({
          source,
          canonicalIdentity: "strategy-1",
          expectedQuantity: "1",
        }),
        0,
      );
      expect(decision.sequence).toBe(1);

      store.db
        .prepare(
          `UPDATE transaction_revisions
           SET signed_quantity = '2'
           WHERE ledger_build_id = (SELECT id FROM ledger_builds ORDER BY created_at DESC LIMIT 1)
             AND logical_transaction_key LIKE '%'`,
        )
        .run();

      const decisions = readDecisions(store, decisionWatermark(store));
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.payload).toMatchObject({ expectedQuantity: "1" });
      const rebuilt = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: decisionWatermark(store),
      });
      expect(rebuilt.executions.length).toBeGreaterThan(0);
      const decisionStill = readDecisions(store, decisionWatermark(store));
      expect(decisionStill[0]?.payload).toMatchObject({
        expectedQuantity: "1",
      });
      void decision;
    }));

  it("does not apply a contradictory manual_allocation as an implicit last-writer-wins", async () =>
    withStore(async (store) => {
      await commitBytes(
        store,
        "single.csv",
        buildExecutionTable([
          executionRow({
            ClientAccountID: "SIM-A",
            AssetClass: "OPT",
            Symbol: "AXON",
            UnderlyingSymbol: "AXON",
            Conid: "9000470",
            CurrencyPrimary: "USD",
            TradeDate: "2026-09-03",
            DateTime: "2026-09-03 10:00:00",
            Quantity: "+1",
            TradePrice: "14.02",
            NetCash: "-1402.23006",
            "Notes/Codes": "O",
            IBOrderID: "OPEN-SPREAD",
            BrokerageOrderID: "BROKER-OPEN-SPREAD",
            IBExecID: "EXEC-A-1",
            TradeID: "TRADE-A-1",
            Expiry: "2026-10-16",
            Strike: "470",
            "Put/Call": "P",
            Multiplier: "100",
          }),
        ]),
      );
      await activateLatestBuild(store);

      const source = firstImportRow(store);

      const first = await appendDecision(
        store,
        manualAllocationInput({
          strategyId: "strategy-1",
          source,
          allocations: [
            {
              executionKey: "exec:1:1",
              quantity: "1",
              netCash: "-1402.23006",
              brokerPnl: null,
            },
          ],
        }),
        0,
      );
      void first;

      await expect(
        appendDecision(
          store,
          manualAllocationInput({
            strategyId: "strategy-2",
            source,
            allocations: [
              {
                executionKey: "exec:1:1",
                quantity: "1",
                netCash: "-1402.23006",
                brokerPnl: null,
              },
            ],
          }),
          1,
        ),
      ).rejects.toMatchObject({ code: "ALLOCATION_CONFLICT" });
    }));

  it("validates manual_allocation quantities as canonical decimal text", async () =>
    withStore(async (store) => {
      await commitBytes(
        store,
        "single.csv",
        buildExecutionTable([
          axonExecution(
            "470",
            "9000470",
            "+1",
            "-1402.23006",
            "EXEC-A-1",
            "TRADE-A-1",
          ),
        ]),
      );
      await activateLatestBuild(store);

      const source = firstImportRow(store);
      let caught: unknown;
      try {
        await appendDecision(
          store,
          manualAllocationInput({
            strategyId: "strategy-1",
            source,
            allocations: [
              {
                executionKey: "exec:1:1",
                quantity: "abc",
                netCash: "-1402.23006",
                brokerPnl: null,
              },
            ],
          }),
          0,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect((caught as { code?: string }).code).toBe("INVALID_INPUT");
    }));

  it("records splits/merges with explicit identity and metadata ownership", async () =>
    withStore(async (store) => {
      await commitBytes(
        store,
        "split-merge.csv",
        buildExecutionTable([
          axonExecution(
            "470",
            "9000470",
            "+1",
            "-1402.23006",
            "EXEC-A-1",
            "TRADE-A-1",
          ),
          axonExecution(
            "480",
            "9000480",
            "-1",
            "1686.7318978",
            "EXEC-A-2",
            "TRADE-A-2",
          ),
        ]),
      );
      await activateLatestBuild(store);
      const source = firstImportRow(store);
      void source;

      const parent = await strategyId(store, {
        account: "SIM-A",
        openingKeys: ["txn:SIM-A:trade:TRADE-A-1"],
      });
      const childA = await strategyId(store, {
        account: "SIM-A",
        openingKeys: ["txn:SIM-A:split:1"],
      });
      const childB = await strategyId(store, {
        account: "SIM-A",
        openingKeys: ["txn:SIM-A:split:2"],
      });
      const otherStrategy = await strategyId(store, {
        account: "SIM-A",
        openingKeys: ["txn:SIM-A:trade:OTHER"],
      });

      const split = await appendDecision(
        store,
        groupSplitInput({
          parentStrategyId: parent,
          childStrategyIds: [childA, childB],
          notesOwnerStrategyId: childA,
        }),
        0,
      );
      expect(split.sequence).toBe(1);

      const merge = await appendDecision(
        store,
        groupMergeInput({
          chosenStrategyId: parent,
          mergedStrategyIds: [otherStrategy],
        }),
        1,
      );
      expect(merge.sequence).toBe(2);

      const decisions = readDecisions(store, decisionWatermark(store));
      const splitDecision = decisions.find((d) => d.kind === "group_split");
      const mergeDecision = decisions.find((d) => d.kind === "group_merge");
      expect(splitDecision?.payload).toMatchObject({
        parentStrategyId: parent,
        childStrategyIds: [childA, childB],
        notesOwnerStrategyId: childA,
      });
      expect(mergeDecision?.payload).toMatchObject({
        chosenStrategyId: parent,
        mergedStrategyIds: [otherStrategy],
      });
    }));

  it("retains the evidence hash on rejection decisions and ignores superseded rejections", async () =>
    withStore(async (store) => {
      const rejection = await appendDecision(
        store,
        rejectionInput({ evidenceHash: "abc123", reason: "stale proposal" }),
        0,
      );
      expect(rejection.payload).toMatchObject({ evidenceHash: "abc123" });

      const rejectionSuperseded = await appendDecision(
        store,
        rejectionInput({
          evidenceHash: "def456",
          reason: "follow-up",
          supersedesId: rejection.id,
        }),
        1,
      );
      void rejectionSuperseded;

      const decisions = readDecisions(store, decisionWatermark(store));
      expect(decisions).toHaveLength(2);
      const effective = effectiveDecisions(decisions);
      expect(effective).toHaveLength(1);
      expect(effective[0]?.payload).toMatchObject({ evidenceHash: "def456" });
    }));

  it("records exclusion and reinclusion of imports and remaps processed decisions", async () =>
    withStore(async (store) => {
      const importId = await commitBytes(store, "spread.csv", fixtures.spread);

      const exclusion = await appendDecision(
        store,
        exclusionInput({ importId }),
        0,
      );
      expect(exclusion.kind).toBe("exclusion");

      const reinclusion = await appendDecision(
        store,
        reinclusionInput({ importId }),
        1,
      );
      expect(reinclusion.kind).toBe("reinclusion");

      const decisions = readDecisions(store, decisionWatermark(store));
      expect(decisions).toHaveLength(2);

      const baseline = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: decisionWatermark(store),
      });
      const executions = baseline.executions;
      expect(executions.length).toBeGreaterThan(0);
    }));

  it("records notes and stop_loss on strategies with stable strategy IDs across reopens", async () =>
    withStore(async (store) => {
      const id = await strategyId(store, {
        account: "SIM-A",
        openingKeys: ["txn:SIM-A:trade:T1"],
      });
      await appendDecision(
        store,
        notesInput({ strategyId: id, text: "Volatility play" }),
        0,
      );
      await appendDecision(
        store,
        stopLossInput({ strategyId: id, price: "2.50" }),
        1,
      );

      const decisions = readDecisions(store, decisionWatermark(store));
      expect(decisions).toHaveLength(2);
      expect(decisions[0]?.kind).toBe("notes");
      expect(decisions[1]?.kind).toBe("stop_loss");
      expect(decisions[0]?.strategyIds).toEqual([id]);
    }));

  it("records group_explicit membership decisions preserving the strategy ID", async () =>
    withStore(async (store) => {
      await commitBytes(
        store,
        "group.csv",
        buildExecutionTable([
          axonExecution(
            "470",
            "9000470",
            "+1",
            "-1402.23006",
            "EXEC-A-1",
            "TRADE-A-1",
          ),
        ]),
      );
      await activateLatestBuild(store);
      const source = firstImportRow(store);
      const strategy = await strategyId(store, {
        account: "SIM-A",
        openingKeys: ["txn:SIM-A:trade:TRADE-A-1"],
      });

      const group = await appendDecision(
        store,
        groupExplicitInput({ strategyId: strategy, source }),
        0,
      );
      expect(group.sequence).toBe(1);

      const decisions = readDecisions(store, decisionWatermark(store));
      expect(decisions[0]?.strategyIds).toEqual([strategy]);
    }));

  it("records lifecycle correction decisions retaining stable references", async () =>
    withStore(async (store) => {
      await commitBytes(
        store,
        "lifecycle.csv",
        buildExecutionTable([
          executionRow({
            ClientAccountID: "SIM-A",
            AssetClass: "OPT",
            Symbol: "BIDU",
            UnderlyingSymbol: "BIDU",
            Conid: "9100105",
            CurrencyPrimary: "USD",
            TradeDate: "2026-09-24",
            DateTime: "2026-09-24 15:00:00",
            Quantity: "+1",
            TradePrice: "0",
            NetCash: "0",
            "Notes/Codes": "A;C",
            TradeID: "TRADE-LC-1",
            Expiry: "2026-10-02",
            Strike: "105",
            "Put/Call": "P",
            Multiplier: "100",
          }),
          executionRow({
            ClientAccountID: "SIM-A",
            AssetClass: "STK",
            Symbol: "BIDU",
            UnderlyingSymbol: "BIDU",
            Conid: "9100001",
            CurrencyPrimary: "USD",
            TradeDate: "2026-09-24",
            DateTime: "2026-09-24 15:00:00",
            Quantity: "+100",
            TradePrice: "105",
            NetCash: "-10500",
            "Notes/Codes": "A;O",
            TradeID: "TRADE-LC-2",
            Multiplier: "1",
            "Put/Call": "",
          }),
        ]),
      );
      await activateLatestBuild(store);

      const source = firstImportRow(store);
      const target = {
        importId: source.importId,
        rowNumber: source.rowNumber + 1,
      };

      const lifecycle = await appendDecision(
        store,
        lifecycleInput({
          event: "assignment",
          source,
          target,
        }),
        0,
      );
      expect(lifecycle.payload).toMatchObject({ event: "assignment" });

      const decisions = readDecisions(store, decisionWatermark(store));
      expect(decisions[0]?.payload).toMatchObject({
        event: "assignment",
        sourceRef: source,
        targetRef: target,
      });
    }));

  it("uses effectiveDecisions to filter out superseded entries while preserving payload equality", async () =>
    withStore(async (store) => {
      const input = notesInput({ strategyId: "s", text: "first note" });
      const first = await appendDecision(store, input, 0);
      const replacement = await appendDecision(
        store,
        notesInput({
          strategyId: "s",
          text: "second note",
          supersedesId: first.id,
        }),
        1,
      );
      const third = await appendDecision(
        store,
        stopLossInput({ strategyId: "s", price: "5.00" }),
        2,
      );
      void third;

      const all = readDecisions(store, decisionWatermark(store));
      expect(all).toHaveLength(3);

      const effective = effectiveDecisions(all);
      expect(effective).toHaveLength(2);
      expect(effective.find((d) => d.kind === "notes")?.payload).toMatchObject({
        text: "second note",
      });
      expect(
        effective.find((d) => d.kind === "stop_loss")?.payload,
      ).toMatchObject({ price: "5.00" });
      void replacement;
    }));

  it("preserves decisions across re-normalization with the same watermark", async () =>
    withStore(async (store) => {
      await appendDecision(
        store,
        notesInput({ strategyId: "s", text: "kept" }),
        0,
      );
      await appendDecision(store, exclusionInput({ importId: "import-1" }), 1);

      const watermark = decisionWatermark(store);
      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: watermark,
      });
      const snapshot = readLedger(store, ledger.id);
      void snapshot;

      const decisions = readDecisions(store, watermark);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]?.payload).toMatchObject({ text: "kept" });
      expect(decisions[1]?.payload).toMatchObject({ importId: "import-1" });
    }));

  it("rejects unknown decision kinds at the boundary with INVALID_KIND", async () =>
    withStore(async (store) => {
      const input = {
        kind: "totally-unknown-kind",
        clientRequestId: "x",
        sources: [],
        strategyIds: [],
        payload: {},
        supersedesId: null,
        author: "user",
      } as unknown as DecisionInput;
      await expect(appendDecision(store, input, 0)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }));
});
