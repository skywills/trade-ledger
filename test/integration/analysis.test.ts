import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEvidenceSnapshot,
  selectEvidenceBatch,
} from "../../src/server/ai/evidence.js";
import {
  type ProfileInput,
  saveProfile,
  selectDefaultProfile,
} from "../../src/server/ai/profiles.js";
import {
  acceptProposal,
  rejectProposal,
  tryParseProposal,
  validateProposal,
} from "../../src/server/ai/proposals.js";
import {
  appendRunProposal,
  insertRun,
  newProposalId,
  readRun,
} from "../../src/server/ai/runs.js";
import { createApp } from "../../src/server/app.js";
import {
  ALGORITHM_VERSION,
  activeLedgerSnapshot,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import { readConfig } from "../../src/server/config.js";
import { decisionWatermark } from "../../src/server/decisions/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { LEDGER_PARSER_VERSION } from "../../src/server/ledger/normalize.js";
import {
  closeStore,
  openStore,
  type Store,
} from "../../src/server/storage/database.js";
import type { Execution, LedgerSnapshot } from "../../src/shared/domain.js";
import {
  buildExecutionTable,
  executionRow,
  fixtures,
} from "../fixtures/scenarios.js";

const ORIGIN = "http://localhost:3000";
const stores: Store[] = [];
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

function baseInput(
  patch: Partial<ProfileInput> & Pick<ProfileInput, "name" | "endpoint">,
): ProfileInput {
  return {
    mode: "local",
    provider: "openai",
    protocol: "openai-completions",
    modelId: "test-local-a",
    contextWindow: 8192,
    maxTokens: 1024,
    timeoutSeconds: 10,
    supportsTools: true,
    thinkingLevels: ["off"],
    credentialRef: null,
    ...patch,
  };
}

async function testStore(): Promise<Store> {
  const dataDir = await mkdtemp(join(tmpdir(), "ibkr-analysis-"));
  dirs.push(dataDir);
  const store = openStore(dataDir);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(stores.splice(0).map((store) => closeStore(store)));
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function seedFrom(
  store: Store,
  bytes: Uint8Array,
): Promise<{ buildId: string; ledger: LedgerSnapshot }> {
  const preview = await previewImport(store, {
    filename: "seed.csv",
    bytes,
    timezone: "UTC",
  });
  const committed = await commitImport(store, preview.id);
  expect(committed.duplicate).toBe(false);
  await rebuild(store, {
    mode: "full",
    parserVersion: LEDGER_PARSER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    signal: new AbortController().signal,
  });
  const ledger = activeLedgerSnapshot(store);
  const buildId = activeProjection(store).buildId;
  if (ledger === null || buildId === null) throw new Error("seed failed");
  return { buildId, ledger };
}

function conservingProposal(
  execution: Execution,
  strategyId = "strategy-test",
) {
  return {
    kind: "manual_allocation" as const,
    strategyIds: [strategyId],
    sources: execution.sources,
    rationale: "conserving allocation",
    payload: {
      strategyId,
      source: execution.sources[0] as Execution["sources"][number],
      allocations: [
        {
          executionKey: execution.key,
          quantity: execution.quantity,
          netCash: execution.netCash,
          brokerPnl: null,
        },
      ],
    },
  };
}

describe("evidence snapshots and proposal validation", () => {
  it("exposes broker P/L so a closing trade is distinguishable", async () => {
    const store = await testStore();
    const { buildId } = await seedFrom(
      store,
      buildExecutionTable([
        executionRow({
          ClientAccountID: "SIM-X",
          AssetClass: "STK",
          Symbol: "AAA",
          Conid: "1",
          CurrencyPrimary: "USD",
          TradeDate: "2026-09-03",
          DateTime: "2026-09-03 10:00:00",
          Quantity: "-1",
          TradePrice: "12",
          NetCash: "12",
          FifoPnlRealized: "2",
          "Notes/Codes": "C",
          IBExecID: "CLOSE1",
          TradeID: "TC1",
          Multiplier: "1",
        }),
      ]),
    );
    const snapshot = buildEvidenceSnapshot(store, { buildId, issueKeys: [] });
    expect(snapshot.rows[0]).toMatchObject({
      brokerPnl: "2",
      action: "close",
    });
  });

  it("survives cross-batch source references and rejects oversized rows", async () => {
    const store = await testStore();
    const rows: ReturnType<typeof executionRow>[] = [];
    for (let index = 0; index < 60; index += 1) {
      rows.push(
        executionRow({
          ClientAccountID: "SIM-X",
          AssetClass: "STK",
          Symbol: "AAA",
          Conid: `1${index}`,
          CurrencyPrimary: "USD",
          TradeDate: "2026-09-03",
          DateTime: "2026-09-03 10:00:00",
          Quantity: "+1",
          TradePrice: "10",
          NetCash: "-10",
          "Notes/Codes": "O",
          IBExecID: `X${index}`,
          TradeID: `T${index}`,
          Multiplier: "1",
        }),
      );
    }
    const { buildId, ledger } = await seedFrom(
      store,
      buildExecutionTable(rows),
    );
    const snapshot = buildEvidenceSnapshot(store, { buildId, issueKeys: [] });
    expect(snapshot.rows.length).toBe(60);

    const first = selectEvidenceBatch(snapshot.rows, 0, 50);
    expect(first.rows).toHaveLength(50);
    expect(first.nextOffset).toBe(50);
    const second = selectEvidenceBatch(snapshot.rows, first.nextOffset, 50);
    expect(second.rows.length).toBe(10);

    // A proposal referencing a source first seen in the second batch still
    // validates against the full snapshot.
    const lateRow = second.rows[0];
    if (lateRow === undefined) throw new Error("no late row");
    const execution = ledger.executions.find(
      (entry) => entry.key === lateRow.executionKey,
    );
    if (execution === undefined) throw new Error("execution missing");
    const issues = validateProposal(ledger, conservingProposal(execution));
    expect(issues.filter((issue) => issue.severity === "error")).toHaveLength(
      0,
    );
  });

  it("rejects an oversized single evidence row for manual review", async () => {
    const store = await testStore();
    const huge = "A".repeat(9000);
    const { buildId } = await seedFrom(
      store,
      buildExecutionTable([
        executionRow({
          ClientAccountID: "SIM-H",
          AssetClass: "STK",
          Symbol: huge,
          Conid: "1",
          CurrencyPrimary: "USD",
          TradeDate: "2026-09-03",
          DateTime: "2026-09-03 10:00:00",
          Quantity: "+1",
          TradePrice: "1",
          NetCash: "-1",
          "Notes/Codes": "O",
          IBExecID: "H1",
          TradeID: "H1",
          Multiplier: "1",
        }),
      ]),
    );
    const snapshot = buildEvidenceSnapshot(store, { buildId, issueKeys: [] });
    expect(snapshot.rows).toHaveLength(0);
    expect(snapshot.rejected.length).toBeGreaterThan(0);
    expect(snapshot.rejected[0]?.reason).toBe("ROW_TOO_LARGE");
  });

  it("flags an over-allocated proposal as OVER_ALLOCATION", async () => {
    const store = await testStore();
    const { ledger } = await seedFrom(store, fixtures.spread);
    const execution = ledger.executions[0] as Execution;

    const overAllocated = {
      kind: "manual_allocation" as const,
      sources: execution.sources,
      strategyIds: ["strategy-test"],
      payload: {
        strategyId: "strategy-test",
        source: execution.sources[0] as Execution["sources"][number],
        allocations: [
          {
            executionKey: execution.key,
            quantity: String(Number(execution.quantity) + 5),
            netCash: execution.netCash,
            brokerPnl: null,
          },
        ],
      },
    };
    expect(
      validateProposal(ledger, overAllocated).map((issue) => issue.code),
    ).toContain("OVER_ALLOCATION");

    // App-level decimal validation applies regardless of model schema.
    const badDecimal = {
      ...overAllocated,
      payload: {
        ...overAllocated.payload,
        allocations: [
          {
            executionKey: execution.key,
            quantity: "not-a-number",
            netCash: execution.netCash,
            brokerPnl: null,
          },
        ],
      },
    };
    expect(
      validateProposal(ledger, badDecimal).map((issue) => issue.code),
    ).toContain("INVALID_DECIMAL");
  });
});

describe("proposal acceptance and rejection", () => {
  async function seedLedgerOnce(store: Store) {
    const { buildId, ledger } = await seedFrom(store, fixtures.spread);
    return { buildId, execution: ledger.executions[0] as Execution };
  }

  async function seededRun(
    store: Store,
    buildId: string,
    proposals: unknown[],
  ) {
    const profile = await saveProfile(
      store,
      baseInput({
        name: `p-${randomUUID()}`,
        endpoint: "http://127.0.0.1:1/v1",
      }),
      null,
    );
    const runId = randomUUID();
    await insertRun(
      store,
      {
        id: runId,
        profileSnapshot: profile,
        evidence: buildEvidenceSnapshot(store, { buildId, issueKeys: [] }),
        sessionId: "s",
        createdAt: new Date().toISOString(),
      },
      "proposal_ready",
    );
    for (const proposal of proposals) {
      const parsed = tryParseProposal(proposal);
      if (!parsed.ok) throw new Error(parsed.message);
      await appendRunProposal(store, runId, {
        id: newProposalId(),
        proposal: parsed.proposal,
        submittedAt: new Date().toISOString(),
        accepted: false,
      });
    }
    const run = readRun(store, runId);
    if (run === null) throw new Error("no run");
    return run;
  }

  it("only a person's acceptance appends a decision, and a stale watermark is refused", async () => {
    const store = await testStore();
    const { buildId, execution } = await seedLedgerOnce(store);
    const run = await seededRun(store, buildId, [
      conservingProposal(execution),
    ]);
    const proposalId = run.proposals[0]?.id;
    if (proposalId === undefined) throw new Error("no proposal");
    expect(decisionWatermark(store)).toBe(0);

    const decisions = await acceptProposal(store, run.id, proposalId, 0);
    expect(decisions).toHaveLength(1);
    expect(decisionWatermark(store)).toBe(1);

    // A second run seeded before the decision still carries the old watermark.
    const staleRun = await seededRun(store, buildId, [
      conservingProposal(execution),
    ]);
    const staleProposal = staleRun.proposals[0]?.id;
    if (staleProposal === undefined) throw new Error("no stale proposal");
    await expect(
      acceptProposal(store, staleRun.id, staleProposal, 0),
    ).rejects.toMatchObject({ code: "STALE_INPUT" });
    expect(decisionWatermark(store)).toBe(1);
  });

  it("rebuilds accepted close bindings into existing strategy IDs without duplicates", async () => {
    const store = await testStore();
    const rows = [
      {
        id: "OPEN-A",
        time: "2025-04-01 10:00:00",
        quantity: "2",
        cash: "-100",
        price: "50",
        pnl: "0",
        role: "O",
      },
      {
        id: "OPEN-B",
        time: "2025-04-01 10:00:00",
        quantity: "2",
        cash: "-101",
        price: "50.5",
        pnl: "0",
        role: "O",
      },
      {
        id: "CLOSE-A",
        time: "2025-04-01 11:00:00",
        quantity: "-2",
        cash: "110.5",
        price: "55.25",
        pnl: "10.5",
        role: "C",
      },
      {
        id: "CLOSE-B",
        time: "2025-04-15 10:00:00",
        quantity: "-2",
        cash: "121.25",
        price: "60.625",
        pnl: "20.25",
        role: "C",
      },
    ];
    const { buildId, ledger } = await seedFrom(
      store,
      buildExecutionTable(
        rows.map((row) =>
          executionRow({
            ClientAccountID: "SIM-LOTS",
            AssetClass: "STK",
            Symbol: "TEST",
            Conid: "TEST",
            CurrencyPrimary: "USD",
            Multiplier: "1",
            TradeDate: row.time.slice(0, 10),
            DateTime: row.time,
            Quantity: row.quantity,
            NetCash: row.cash,
            FifoPnlRealized: row.pnl,
            TradePrice: row.price,
            "Notes/Codes": row.role,
            IBExecID: row.id,
            TradeID: row.id,
            IBOrderID: row.id,
            BrokerageOrderID: row.id,
          }),
        ),
      ),
    );
    const initial = activeProjection(store).projection;
    if (!initial) throw new Error("No initial projection");
    expect(
      initial.issues.filter((issue) => issue.code === "AMBIGUOUS_CLOSE"),
    ).toHaveLength(2);
    const targets = ["A", "B"].map((suffix) => {
      const opening = ledger.executions.find(
        (e) => e.brokerIds.IBExecID === `OPEN-${suffix}`,
      );
      const closing = ledger.executions.find(
        (e) => e.brokerIds.IBExecID === `CLOSE-${suffix}`,
      );
      const strategyId = initial.allocations.find(
        (a) => a.executionKey === opening?.key,
      )?.strategyId;
      const source = closing?.sources[0];
      if (!strategyId || !source) throw new Error("Missing stock execution");
      return { strategyId, source };
    });
    const run = await seededRun(
      store,
      buildId,
      targets.map((target) => ({
        kind: "group_explicit",
        strategyIds: [target.strategyId],
        sources: [target.source],
        payload: target,
      })),
    );
    for (const proposal of run.proposals) {
      await acceptProposal(
        store,
        run.id,
        proposal.id,
        decisionWatermark(store),
      );
      const result = await rebuild(store, {
        mode: "full",
        parserVersion: LEDGER_PARSER_VERSION,
        algorithmVersion: ALGORITHM_VERSION,
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("active");
      const projected = activeProjection(store).projection;
      expect(projected?.issues).toEqual([]);
      expect(projected?.strategies.map((s) => s.id).sort()).toEqual(
        targets.map((t) => t.strategyId).sort(),
      );
      expect(projected?.strategies.map((s) => s.status)).toEqual([
        "closed",
        "closed",
      ]);
      expect(
        projected?.strategies
          .flatMap((s) => s.positions)
          .map((p) => p.quantity),
      ).toEqual(["0", "0"]);
      expect(projected?.strategies.map((s) => s.brokerPnl).sort()).toEqual([
        "10.5",
        "20.25",
      ]);
    }
  });

  it("records a retained rejection carrying the evidence hash", async () => {
    const store = await testStore();
    const { buildId, execution } = await seedLedgerOnce(store);
    const run = await seededRun(store, buildId, [
      conservingProposal(execution),
    ]);
    const decision = await rejectProposal(store, run.id, "wrong strategy", 0);
    expect(decision.kind).toBe("rejection");
    expect(decision.payload.evidenceHash).toBe(run.evidence.contentHash);
    expect(decisionWatermark(store)).toBe(1);
  });
});

describe("analysis HTTP routes", () => {
  async function routeApp(store: Store) {
    const app = await createApp(
      readConfig({ DATA_DIR: store.dataDir, ALLOWED_ORIGIN: ORIGIN }),
    );
    apps.push(app);
    return app;
  }

  it("rejects cross-origin analysis mutations", async () => {
    const store = await testStore();
    const app = await routeApp(store);
    const response = await app.inject({
      method: "POST",
      url: "/api/analysis/x/reject",
      headers: { origin: "https://evil.test" },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "CROSS_ORIGIN_REJECTED" });
  });
});

describe("analysis fails closed without breaking manual review", () => {
  it("keeps journal and review readable when the local endpoint is down", async () => {
    const store = await testStore();
    await seedFrom(store, fixtures.spread);
    const dead = await saveProfile(
      store,
      baseInput({ name: "dead", endpoint: "http://127.0.0.1:1/v1" }),
      null,
    );
    await selectDefaultProfile(store, dead.id);
    const app = await createApp(
      readConfig({ DATA_DIR: store.dataDir, ALLOWED_ORIGIN: ORIGIN }),
    );
    apps.push(app);

    const journal = await app.inject("/api/journal");
    expect(journal.statusCode).toBe(200);
    const review = await app.inject("/api/review");
    expect(review.statusCode).toBe(200);

    const started = await app.inject({
      method: "POST",
      url: "/api/chat/threads",
      headers: { origin: ORIGIN },
      payload: {},
    });
    expect(started.statusCode).toBe(409);
    expect(started.json()).toMatchObject({ code: "PROFILE_NOT_VERIFIED" });

    const after = await app.inject("/api/journal");
    expect(after.statusCode).toBe(200);
  });
});
