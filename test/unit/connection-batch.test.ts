import { expect, it } from "vitest";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import { validateLifecycleDecision } from "../../src/server/lifecycles/validate-decision.js";
import type { Decision } from "../../src/shared/domain.js";
import {
  type BatchIO,
  canonicalProposalPayload,
  connectionSections,
  createConnectionBatch,
  runConnectionBatch,
} from "../../src/web/lifecycles/connection-batch.js";
import { call, execution, fixture, stock } from "../fixtures/lifecycles.js";

function setup(overlapping = false, sameContract = false) {
  const { ledger, projection } = fixture([
    ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
    [
      "late",
      execution(
        "late",
        sameContract ? call : { ...call, key: "late", conid: "4" },
        "-1",
        "80",
        overlapping ? 3 : 4,
        "open",
      ),
    ],
    ["early", execution("early", call, "-1", "70", 2, "open")],
    [
      "early",
      execution("early-close", call, "1", "-30", overlapping ? 4 : 3, "close"),
    ],
  ]);
  const decisions: Decision[] = [];
  let built = 0;
  const data = () => ({
    buildId: `build-${built}`,
    ledgerId: ledger.id,
    stale: built !== decisions.length,
    watermark: built,
    generatedAt: "",
    rebuildRequired: false,
    lifecycles: projectLifecycles(
      ledger,
      projection,
      decisions.slice(0, built),
    ),
    connectionExecutions: ledger.executions,
  });
  let failRebuild = false;
  let loseResponse = false;
  const savedRequests: unknown[] = [];
  const io: BatchIO = {
    load: async () => data(),
    preview: async (proposal, current) => {
      validateLifecycleDecision(ledger, projection, decisions, {
        ...proposal,
        id: "__validate__",
        sequence: decisions.length + 1,
        sources: [],
        strategyIds: [],
        supersedesId: null,
      });
      return {
        valid: true,
        buildId: current.buildId ?? "",
        ledgerId: ledger.id,
        watermark: current.watermark,
        stale: false,
        generatedAt: "",
        issues: [],
        impact: null,
      };
    },
    save: async (request) => {
      savedRequests.push(structuredClone(request));
      let decision = decisions.find((d) => d.id === request.clientRequestId);
      if (!decision) {
        expect(request.expectedWatermark).toBe(decisions.length);
        decision = {
          ...request,
          id: request.clientRequestId,
          sequence: decisions.length + 1,
          sources: [],
          strategyIds: [],
          supersedesId: null,
        };
        validateLifecycleDecision(ledger, projection, decisions, decision);
        decisions.push(decision);
      }
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Response lost");
      }
      return { id: decision.id, sequence: decision.sequence };
    },
    rebuild: async () => {
      if (failRebuild) {
        failRebuild = false;
        throw new Error("Build failed");
      }
      built = decisions.length;
    },
  };
  const initial = data();
  const section = connectionSections(initial)[0];
  if (!section) throw Error("Missing section");
  const target = section.groups[0]?.candidateIds[0] ?? "";
  const batch = () =>
    createConnectionBatch(
      initial,
      section.groups.map((g) => g.key).reverse(),
      target,
      false,
    );
  return {
    initial,
    section,
    target,
    batch,
    io,
    decisions,
    savedRequests,
    failRebuild: () => {
      failRebuild = true;
    },
    loseResponse: () => {
      loseResponse = true;
    },
  };
}

it("compares proposals canonically by assignment identity and quantity", () => {
  const assignment = (executionKey: string) => ({
    allocation: {
      strategyId: "calls",
      executionKey,
      role: "open" as const,
    },
    lifecycleId: "shares",
    quantity: "-1",
  });
  const a = assignment("a");
  const b = assignment("b");
  expect(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a, b],
    }),
  ).toBe(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [b, a],
    }),
  );
  expect(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a, b],
    }),
  ).not.toBe(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a, { ...b, quantity: "-2" }],
    }),
  );
  expect(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a],
    }),
  ).not.toBe(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [{ ...a, lifecycleId: "other" }],
    }),
  );
  expect(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a],
    }),
  ).not.toBe(
    canonicalProposalPayload({
      requireCallCoverage: false,
      assignments: [a],
    }),
  );
  expect(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [a],
    }),
  ).not.toBe(
    canonicalProposalPayload({
      requireCallCoverage: true,
      assignments: [
        {
          ...a,
          allocation: { ...a.allocation, role: "close" as const },
        },
      ],
    }),
  );
});

it("does not abort when equivalent assignments arrive in a different order", async () => {
  const f = setup();
  const load = f.io.load;
  f.io.load = async () => {
    const current = await load();
    return current.lifecycles === null
      ? current
      : {
          ...current,
          lifecycles: {
            ...current.lifecycles,
            members: [...current.lifecycles.members].reverse(),
          },
        };
  };
  const batch = f.batch();
  await runConnectionBatch(batch, f.io);
  expect(batch.items.every((i) => i.status === "complete")).toBe(true);
});

it("groups contracts by underlying and keeps oldest first regardless of input selection", () => {
  const f = setup();
  expect(f.section.underlying).toBe("XYZ");
  expect(f.section.groups.map((g) => g.instrument.key)).toEqual([
    "call",
    "late",
  ]);
  expect(f.batch().items.map((i) => i.group.instrument.key)).toEqual([
    "call",
    "late",
  ]);
});

it("resolves successive calls against one share lifecycle using fresh projections", async () => {
  const f = setup();
  const batch = f.batch();
  await runConnectionBatch(batch, f.io);
  expect(batch.items.map((i) => i.status)).toEqual(["complete", "complete"]);
  expect(f.decisions).toHaveLength(2);
  const fresh = await f.io.load();
  expect(fresh.lifecycles?.suggestions).toHaveLength(0);
  expect(
    fresh.lifecycles?.members
      .filter((m) => m.allocation.executionKey !== "shares")
      .every((m) => m.lifecycleId === f.target),
  ).toBe(true);
});

it("blocks a later connection when an earlier related connection was omitted", async () => {
  const f = setup();
  const late = f.section.groups[1];
  if (!late) throw Error("Missing late call");
  const batch = createConnectionBatch(f.initial, [late.key], f.target, false);
  await expect(runConnectionBatch(batch, f.io)).rejects.toThrow();
  expect(f.decisions).toHaveLength(0);
  expect(batch.items[0]?.status).toBe("pending");
});

it("retries a saved decision's failed rebuild without saving it again", async () => {
  const f = setup();
  const batch = f.batch();
  f.failRebuild();
  await expect(runConnectionBatch(batch, f.io)).rejects.toThrow("Build failed");
  expect(batch.items.map((i) => i.status)).toEqual(["saved", "pending"]);
  await runConnectionBatch(batch, f.io);
  expect(f.savedRequests).toHaveLength(2);
  expect(f.decisions).toHaveLength(2);
});

it("retries a lost response using the exact original request and resolves no later item before recovery", async () => {
  const f = setup();
  const batch = f.batch();
  f.loseResponse();
  await expect(runConnectionBatch(batch, f.io)).rejects.toThrow(
    "Response lost",
  );
  expect(f.decisions).toHaveLength(1);
  await runConnectionBatch(batch, f.io);
  expect(f.savedRequests[1]).toEqual(f.savedRequests[0]);
  expect(f.decisions).toHaveLength(2);
  expect(batch.items.every((i) => i.status === "complete")).toBe(true);
});

it("stops on a changed journal before writing any decision", async () => {
  const f = setup();
  const batch = f.batch();
  f.io.load = async () => ({ ...f.initial, buildId: "another-build" });
  await expect(runConnectionBatch(batch, f.io)).rejects.toThrow(
    "journal changed",
  );
  expect(f.decisions).toHaveLength(0);
});

it("keeps selected calls separate without moving their allocations to shares", async () => {
  const f = setup();
  const batch = createConnectionBatch(
    f.initial,
    f.section.groups.map((g) => g.key),
    "",
    true,
  );
  await runConnectionBatch(batch, f.io);
  const fresh = await f.io.load();
  expect(fresh.lifecycles?.suggestions).toHaveLength(0);
  expect(
    fresh.lifecycles?.members
      .filter((m) => m.allocation.executionKey !== "shares")
      .every((m) => m.lifecycleId !== f.target),
  ).toBe(true);
});

it("rejects selections without a common eligible share lifecycle", () => {
  const f = setup();
  expect(() =>
    createConnectionBatch(
      f.initial,
      f.section.groups.map((g) => g.key),
      "unknown",
      false,
    ),
  ).toThrow("share lifecycle");
});

it("orders same-day connections using known execution times", () => {
  const f = setup();
  for (const e of f.initial.connectionExecutions) {
    if (e.key === "early" || e.key === "late") {
      e.date = "2026-10-02";
      e.rawDateTime = `2026-10-02T${e.key === "early" ? "14" : "09"}:00:00Z`;
    }
  }
  expect(
    connectionSections(f.initial)[0]?.groups.map((g) => g.instrument.key),
  ).toEqual(["late", "call"]);
});

it("keeps accounts and currencies in separate selection sections", () => {
  const rows: Parameters<typeof fixture>[0] = [];
  for (const [account, currency] of [
    ["A", "USD"],
    ["B", "USD"],
    ["A", "EUR"],
  ]) {
    const key = `${account}-${currency}`;
    rows.push(
      [
        `shares-${key}`,
        {
          ...execution(`shares-${key}`, stock, "100", "-10000", 1, "open"),
          account: account ?? "",
          currency: currency ?? "",
        },
      ],
      [
        `calls-${key}`,
        {
          ...execution(`calls-${key}`, call, "-1", "70", 2, "open"),
          account: account ?? "",
          currency: currency ?? "",
        },
      ],
    );
  }
  const { ledger, projection } = fixture(rows);
  for (const strategy of projection.strategies)
    strategy.currency =
      rows.find(([id]) => id === strategy.id)?.[1].currency ?? "USD";
  const initial = {
    ...setup().initial,
    connectionExecutions: ledger.executions,
    lifecycles: projectLifecycles(ledger, projection, []),
  };
  const sections = connectionSections(initial);
  expect(sections).toHaveLength(3);
  expect(sections.map((s) => [s.account, s.currency])).toEqual([
    ["A", "USD"],
    ["B", "USD"],
    ["A", "EUR"],
  ]);
  expect(() =>
    createConnectionBatch(
      initial,
      sections.flatMap((s) => s.groups.map((g) => g.key)),
      "",
      true,
    ),
  ).toThrow("one underlying, account and currency");
});

it("stops after partial success when a later connection is invalid", async () => {
  const f = setup();
  const batch = f.batch();
  const preview = f.io.preview;
  f.io.preview = async (...args) => {
    const result = await preview(...args);
    return { ...result, valid: args[1].watermark === 0 };
  };
  await expect(runConnectionBatch(batch, f.io)).rejects.toThrow(
    "cannot be resolved",
  );
  expect(batch.items.map((i) => i.status)).toEqual(["complete", "pending"]);
  expect(f.decisions).toHaveLength(1);
});

it("finishes a saved rebuild but does not save another item after navigation", async () => {
  const f = setup();
  const batch = f.batch();
  const controller = new AbortController();
  const save = f.io.save;
  f.io.save = async (payload) => {
    const receipt = await save(payload);
    controller.abort();
    return receipt;
  };
  await expect(
    runConnectionBatch(batch, f.io, undefined, controller.signal),
  ).rejects.toThrow();
  expect(batch.items.map((i) => i.status)).toEqual(["complete", "pending"]);
  expect((await f.io.load()).stale).toBe(false);
  expect(f.decisions).toHaveLength(1);
});

it("resolves interleaved opening fills together without bypassing earlier-dependency validation", async () => {
  const { ledger, projection } = fixture([
    ["shares", execution("shares", stock, "400", "-40000", 1, "open")],
    ["a", execution("a-first", call, "-1", "70", 2, "open")],
    [
      "b",
      execution(
        "b",
        { ...call, key: "call-b", conid: "4" },
        "-1",
        "70",
        3,
        "open",
      ),
    ],
    ["a", execution("a-second", call, "-1", "70", 4, "open")],
    [
      "c",
      execution(
        "c",
        { ...call, key: "call-c", conid: "5" },
        "-1",
        "70",
        5,
        "open",
      ),
    ],
  ]);
  const decisions: Decision[] = [];
  let built = 0;
  const data = () => ({
    ...setup().initial,
    buildId: `build-${built}`,
    watermark: built,
    connectionExecutions: ledger.executions,
    lifecycles: projectLifecycles(ledger, projection, decisions),
  });
  const io: BatchIO = {
    load: async () => data(),
    preview: async (proposal, current) => {
      validateLifecycleDecision(ledger, projection, decisions, {
        ...proposal,
        id: "__validate__",
        sequence: decisions.length + 1,
        sources: [],
        strategyIds: [],
        supersedesId: null,
      });
      return {
        valid: true,
        buildId: current.buildId ?? "",
        ledgerId: ledger.id,
        watermark: current.watermark,
        stale: false,
        generatedAt: "",
        issues: [],
        impact: null,
      };
    },
    save: async (request) => {
      const decision = {
        ...request,
        id: request.clientRequestId,
        sequence: decisions.length + 1,
        sources: [],
        strategyIds: [],
        supersedesId: null,
      };
      validateLifecycleDecision(ledger, projection, decisions, decision);
      decisions.push(decision);
      return decision;
    },
    rebuild: async () => {
      built = decisions.length;
    },
  };
  const initial = data();
  const groups = connectionSections(initial)[0]?.groups ?? [];
  const target = groups[0]?.candidateIds[0] ?? "";
  const batch = createConnectionBatch(
    initial,
    groups.map((g) => g.key),
    target,
    false,
  );
  await runConnectionBatch(batch, io);
  expect(batch.items.every((i) => i.status === "complete")).toBe(true);
  expect(decisions).toHaveLength(2);
  expect(data().lifecycles.suggestions).toHaveLength(0);
  expect(data().lifecycles.members.every((m) => m.lifecycleId === target)).toBe(
    true,
  );
});

it.each([false, true])(
  "rejects overlapping connections before saving (same contract: %s)",
  async (sameContract) => {
    const f = setup(true, sameContract);
    const batch = f.batch();
    expect(batch.items).toHaveLength(2);
    await expect(runConnectionBatch(batch, f.io)).rejects.toThrow();
    expect(f.decisions).toHaveLength(0);
    expect(batch.items.map((i) => i.status)).toEqual(["pending", "pending"]);
    expect((await f.io.load()).lifecycles?.suggestions).toHaveLength(2);
  },
);

it.each([false, true])(
  "keeps competing calls reviewable after one connection (same contract: %s)",
  async (sameContract) => {
    const f = setup(true, sameContract);
    const first = f.section.groups[0];
    if (!first) throw Error("Missing first connection");
    await runConnectionBatch(
      createConnectionBatch(f.initial, [first.key], f.target, false),
      f.io,
    );
    const fresh = await f.io.load();
    const remaining = connectionSections(fresh)[0]?.groups[0];
    expect(remaining?.instrument.key).toBe(sameContract ? "call" : "late");
    expect(remaining?.candidateIds).toEqual([]);
    expect(remaining?.canReviewWhole).toBe(true);
    expect(remaining?.suggestions[0]?.reasons).toContain(
      "SHARES_RESERVED_BY_OTHER_CALLS",
    );
    if (!remaining) throw Error("Missing blocked connection");
    await runConnectionBatch(
      createConnectionBatch(fresh, [remaining.key], "", true),
      f.io,
    );
    expect(f.decisions).toHaveLength(2);
    expect((await f.io.load()).lifecycles?.suggestions).toHaveLength(0);
  },
);

it("retains a blocked review whose original share coverage spans multiple lifecycles", () => {
  const { ledger, projection } = fixture([
    ["shares-a", execution("shares-a", stock, "100", "-10000", 1, "open")],
    ["shares-b", execution("shares-b", stock, "100", "-10000", 1, "open")],
    ["first", execution("first", call, "-1", "70", 2, "open")],
    [
      "remaining",
      execution(
        "remaining",
        { ...call, key: "other-call", conid: "4" },
        "-2",
        "140",
        3,
        "open",
      ),
    ],
  ]);
  const initial = projectLifecycles(ledger, projection, []);
  const opening = initial.suggestions.find(
    (s) => s.callOpening.executionKey === "first",
  );
  const target = opening?.candidateLifecycleIds[0];
  if (!opening || !target) throw Error("Missing initial connection");
  expect(initial.suggestions).toHaveLength(2);
  const confirmed: Decision = {
    id: "__validate__",
    sequence: 1,
    sources: [],
    strategyIds: [],
    supersedesId: null,
    kind: "lifecycle_attachment",
    payload: {
      opening: opening.callOpening,
      targets: [{ lifecycleId: target, quantity: "-1" }],
    },
  };
  validateLifecycleDecision(ledger, projection, [], confirmed);
  const after = projectLifecycles(ledger, projection, [confirmed]);
  expect(after.suggestions).toHaveLength(1);
  expect(after.suggestions[0]).toMatchObject({
    callOpening: { executionKey: "remaining" },
    candidateLifecycleIds: [],
    reasons: ["CONFIRM_COVERED_CALL", "SHARES_RESERVED_BY_OTHER_CALLS"],
  });
});
