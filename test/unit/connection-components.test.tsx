import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import type { Execution } from "../../src/shared/domain.js";
import { useJson } from "../../src/web/api.js";
import { ConnectionDialog } from "../../src/web/lifecycles/ConnectionDialog.js";
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
