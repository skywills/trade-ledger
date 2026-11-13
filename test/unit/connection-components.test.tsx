import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import type { Execution } from "../../src/shared/domain.js";
import type { ConnectionPlan } from "../../src/shared/lifecycles.js";
import { useJson } from "../../src/web/api.js";
import { ConnectionDialog } from "../../src/web/lifecycles/ConnectionDialog.js";
import { ConnectionQueue } from "../../src/web/lifecycles/ConnectionQueue.js";
import type { ConnectionData } from "../../src/web/lifecycles/connection-batch.js";
import { connectionGroups } from "../../src/web/lifecycles/connections.js";
import { LifecycleDetail } from "../../src/web/lifecycles/LifecycleDetail.js";
import { call, execution, fixture, stock } from "../fixtures/lifecycles.js";

vi.mock("../../src/web/api.js", async (original) => ({
  ...(await original<object>()),
  useJson: vi.fn(),
  useJobSignal: () => () => new AbortController().signal,
}));
vi.mock("../../src/web/navigation.js", async (original) => ({
  ...(await original<object>()),
  useLocation: () => ({ pathname: "/lifecycles/test", search: "" }),
}));
beforeEach(() => vi.mocked(useJson).mockReset());

it("shows a complete, reviewable group on a share lifecycle acquired between call fills", () => {
  const { ledger, projection } = fixture([
    ["shares-a", execution("shares-a", stock, "200", "-20000", 1, "open")],
    ["calls", execution("call-1", call, "-1", "70", 2, "open")],
    ["shares-b", execution("shares-b", stock, "200", "-20000", 3, "open")],
    ["calls", execution("call-2", call, "-1", "75", 4, "open")],
    [
      "other-shares",
      execution(
        "other-shares",
        { ...stock, key: "other-stock", symbol: "OTHER" },
        "100",
        "-10000",
        1,
        "open",
      ),
    ],
    [
      "unrelated",
      execution(
        "unrelated",
        {
          ...call,
          key: "other-call",
          symbol: "OTHER CALL",
          underlying: "OTHER",
        },
        "-1",
        "75",
        4,
        "open",
      ),
    ],
  ]);
  const p = projectLifecycles(ledger, projection, []);
  const id = p.members.find(
    (m) => m.allocation.executionKey === "shares-b",
  )?.lifecycleId;
  const lifecycle = p.lifecycles.find((l) => l.id === id);
  if (!id || !lifecycle) throw Error("Missing shares B");
  const local = p.suggestions.filter((s) =>
    s.candidateLifecycleIds.includes(id),
  );
  expect(
    p.suggestions.filter((s) => s.callOpening.strategyId === "calls"),
  ).toHaveLength(2);
  expect(
    local.filter((s) => s.callOpening.strategyId === "calls"),
  ).toHaveLength(1);
  const provenance = {
    buildId: "build",
    ledgerId: "ledger",
    stale: false,
    generatedAt: "",
    watermark: 0,
    rebuildRequired: false,
  };
  vi.mocked(useJson).mockImplementation(
    (path) =>
      ({
        status: "ready",
        data:
          path === "/api/lifecycles"
            ? {
                ...provenance,
                lifecycles: p,
                connectionExecutions: ledger.executions,
              }
            : {
                ...provenance,
                lifecycle,
                members: p.members.filter((m) => m.lifecycleId === id),
                executions: ledger.executions,
                suggestions: local,
                valuation: null,
                campaigns: [],
              },
        error: null,
        reload: vi.fn(),
      }) as ReturnType<typeof useJson>,
  );
  const html = renderToStaticMarkup(<LifecycleDetail id={id} />);
  expect(html).toContain('class="primary">Review connection</button>');
  expect(html).toContain('class="secondary">Keep trades separate</button>');
  expect(html).not.toContain("Some fills already have a review decision");
  expect(html).toContain("2 calls</strong>");
  expect(html.match(/class="connection-card"/g)).toHaveLength(1);
  expect(html).not.toContain("OTHER connection review");
});

function renderSequence(shares: Execution, calls: Execution) {
  const { ledger, projection } = fixture([
    ["shares", shares],
    ["calls", calls],
  ]);
  const p = projectLifecycles(ledger, projection, []);
  const groups = connectionGroups(
    [
      {
        id: "suggestion",
        callOpening: {
          strategyId: "calls",
          executionKey: calls.key,
          role: "open",
        },
        candidateLifecycleIds: [
          p.members.find((m) => m.allocation.executionKey === shares.key)
            ?.lifecycleId ?? "",
        ],
        quantity: "1",
        sources: [],
        reasons: [],
      },
    ],
    p.members,
    ledger.executions,
  );
  const group = groups[0];
  if (!group) throw Error("Missing group");
  return renderToStaticMarkup(
    <ConnectionDialog
      context={{
        group,
        lifecycles: p.lifecycles,
        members: p.members,
        executions: ledger.executions,
        buildId: "build",
        watermark: 0,
      }}
      onDismiss={() => {}}
    />,
  );
}

it("orders preview trades by execution instants rather than written timestamp offsets", () => {
  const shares = {
    ...execution("shares", stock, "100", "-10000", 2, "open"),
    rawDateTime: "2026-10-02T10:00:00+02:00",
  };
  const calls = {
    ...execution("calls", call, "-1", "70", 2, "open"),
    rawDateTime: "2026-10-02T09:00:00Z",
  };
  const html = renderSequence(shares, calls);
  expect(html.indexOf("Acquired shares")).toBeLessThan(
    html.indexOf("Sold calls"),
  );
  expect(html).not.toContain("Exact trade order is uncertain");
});

it("explicitly labels uncertain preview ordering instead of implying a verified sequence", () => {
  const shares = {
    ...execution("shares", stock, "100", "-10000", 2, "open"),
    rawDateTime: "2026-10-02T10:00:00",
    timezone: null,
    sources: [{ importId: "a", rowNumber: 1 }],
  };
  const calls = {
    ...execution("calls", call, "-1", "70", 2, "open"),
    rawDateTime: "2026-10-02T09:00:00",
    timezone: null,
    sources: [{ importId: "b", rowNumber: 1 }],
  };
  expect(renderSequence(shares, calls)).toContain(
    "Exact trade order is uncertain",
  );
});

function queueData(plans: Record<string, Omit<ConnectionPlan, "lifecycleId">>) {
  const { ledger, projection } = fixture([
    ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
    [
      "late",
      execution(
        "late",
        { ...call, key: "late", conid: "4" },
        "-1",
        "80",
        4,
        "open",
      ),
    ],
    ["early", execution("early", call, "-1", "70", 2, "open")],
  ]);
  const p = projectLifecycles(ledger, projection, []);
  const target = p.suggestions[0]?.candidateLifecycleIds[0] ?? "";
  const withPlans = {
    ...p,
    suggestions: p.suggestions.map((s) => {
      const plan = plans[s.callOpening.executionKey];
      return plan ? { ...s, plan: { lifecycleId: target, ...plan } } : s;
    }),
  };
  return {
    buildId: "build",
    ledgerId: ledger.id,
    stale: false,
    watermark: 0,
    generatedAt: "",
    rebuildRequired: false,
    lifecycles: withPlans,
    connectionExecutions: ledger.executions,
  } as ConnectionData;
}

const covered = {
  action: "connect",
  reason: "COVERED",
  sharesAtOpening: "100",
} as const;
const kept = { action: "separate", reason: "HELD_BY_EARLIER_CALL" } as const;
const manual = { action: "manual", reason: "PARTIAL" } as const;

it("shows position headings, action badges, explanations and the apply button", () => {
  const html = renderToStaticMarkup(
    <ConnectionQueue data={queueData({ early: covered, late: kept })} />,
  );
  expect(html).toContain(
    "A share position covers one short call per 100 shares at a time.",
  );
  expect(html).toContain("Shares from");
  expect(html).toContain(">Connect</span>");
  expect(html).toContain(">Keep separate</span>");
  expect(html).toContain("100 shares were free when this call was sold.");
  expect(html).toContain("Apply recommended: connect 1, keep 1 separate");
  expect(html).not.toMatch(/Apply recommended[^<]*<[^>]*disabled/);
  expect(html).toContain("Connect selected");
  expect(html).toContain("Select all XYZ connections");
  expect(html).toContain("Review connection");
});

it("disables apply and names the older manual row that blocks it", () => {
  const html = renderToStaticMarkup(
    <ConnectionQueue data={queueData({ early: manual, late: covered })} />,
  );
  expect(html).toContain("Apply recommended: connect 1");
  expect(html).toMatch(/disabled[^>]*>Apply recommended: connect 1/);
  expect(html).toContain(
    "Resolve the 2026-10-02 Nov20&#x27;26 105C call first.",
  );
  expect(html).toContain(">Needs your choice</span>");
});

it("omits apply for the needs-your-choice group", () => {
  const html = renderToStaticMarkup(
    <ConnectionQueue
      data={queueData({
        early: { action: "manual", reason: "MULTIPLE_POSITIONS" },
        late: manual,
      })}
    />,
  );
  expect(html).not.toContain("Apply recommended");
});

it("renders the list as before when no plans are attached", () => {
  const html = renderToStaticMarkup(<ConnectionQueue data={queueData({})} />);
  expect(html).not.toContain("Apply recommended");
  expect(html).not.toContain("Keep separate</span>");
  expect(html).not.toContain("connection-badge");
  expect(html).toContain("Connect selected");
  expect(html).toContain("Keep selected separate");
  expect(html).toContain('type="checkbox"');
});

it("titles rows with the readable contract and a correct plural", () => {
  const html = renderToStaticMarkup(
    <ConnectionQueue data={queueData({ early: covered, late: kept })} />,
  );
  expect(html).toContain("Nov20&#x27;26 105C");
  expect(html).toMatch(/Nov20&#x27;26 105C · 1 short call</);
  expect(html).not.toContain("short calls<");
  expect(html).not.toMatch(/XYZ · \d+ short call/);
});
