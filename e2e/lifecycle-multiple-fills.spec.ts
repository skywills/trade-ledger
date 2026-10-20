import {
  buildExecutionTable,
  executionRow,
} from "../test/fixtures/scenarios.js";
import { startInferenceServer } from "../test/helpers/inference-server.js";
import { expect, test } from "./fixtures.js";

test("confirms all WFC opening fills with their explicit closing source partitions", async ({
  page,
  request,
  baseURL,
}) => {
  const headers = { Origin: baseURL };
  // Two distinct fills in one call component, followed by two whole closes.
  const rows = (
    [
      ["stock-open", "STK", "2024-06-27", "16:20:00", "200", "-11800", "O"],
      ["call-open-1", "OPT", "2024-06-28", "09:50:24", "-1", "72.9458028", "O"],
      ["call-open-2", "OPT", "2024-06-28", "09:50:24", "-1", "73.6458028", "O"],
      [
        "stock-close-1",
        "STK",
        "2024-06-28",
        "15:51:22",
        "-89",
        "5284.103295633",
        "C",
      ],
      ["call-close-1", "OPT", "2024-07-01", "09:32:49", "1", "-131.04685", "C"],
      ["call-close-2", "OPT", "2024-07-01", "09:32:49", "1", "-130.34685", "C"],
      [
        "stock-close-2",
        "STK",
        "2024-07-01",
        "09:33:31",
        "-111",
        "6656.576487716",
        "C",
      ],
    ] as const
  ).map(([id, asset, date, time, quantity, cash, action]) =>
    executionRow({
      ClientAccountID: "A",
      AssetClass: asset,
      Symbol: asset === "OPT" ? "WFC CALL" : "WFC",
      UnderlyingSymbol: "WFC",
      Conid: asset === "OPT" ? "2" : "1",
      CurrencyPrimary: "USD",
      TradeDate: date,
      DateTime: `${date} ${time}`,
      Quantity: quantity,
      NetCash: cash,
      IBExecID: id,
      IBOrderID: asset === "OPT" ? `call-${action}` : id,
      "Notes/Codes": action,
      Multiplier: asset === "OPT" ? "100" : "1",
      Expiry: asset === "OPT" ? "2024-07-26" : "",
      Strike: asset === "OPT" ? "61" : "",
      "Put/Call": asset === "OPT" ? "C" : "",
    }),
  );
  const preview = await request.post("/api/imports/preview", {
    headers,
    multipart: {
      file: {
        name: "multiple-fills.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(buildExecutionTable(rows)),
      },
    },
  });
  expect(preview.ok()).toBe(true);
  const { previews } = await preview.json();
  const commit = await request.post(`/api/imports/${previews[0].id}/commit`, {
    headers,
  });
  expect(commit.ok()).toBe(true);
  const build = await request.post("/api/builds", {
    headers,
    data: { mode: "full" },
  });
  const { jobId } = await build.json();
  await expect
    .poll(async () => {
      const result = await request.get(`/api/jobs/${jobId}`);
      return (await result.json()).job.status;
    })
    .toBe("complete");
  const before = (await (await request.get("/api/lifecycles")).json())
    .lifecycles;
  const call = before.lifecycles.find(
    (l: { status: string; originStrategyType: string }) =>
      l.status === "unresolved" && l.originStrategyType === "short_call",
  );
  let loseSaveResponse = true,
    loseUndoResponse = true;
  await page.route("**/api/decisions", async (route) => {
    const payload = route.request().postDataJSON();
    if (
      (payload.kind === "lifecycle_membership" && loseSaveResponse) ||
      (payload.kind === "rejection" && loseUndoResponse)
    ) {
      if (payload.kind === "lifecycle_membership") loseSaveResponse = false;
      else loseUndoResponse = false;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else await route.fallback();
  });
  await page.goto(`/lifecycles/${call.id}`);
  await expect(
    page.getByRole("button", { name: "Review connection", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Review connection", exact: true })
    .click();
  const panel = page.getByRole("dialog", { name: "Connect WFC trades" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("2 contracts");
  await expect(panel).toContainText("200 shares");
  await expect(
    panel.getByRole("button", { name: "Confirm connection", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: "/tmp/connection-review-desktop.png" });
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review connection", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Review connection", exact: true })
    .click();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  expect(
    await panel.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  const confirmBounds = await panel
    .getByRole("button", { name: "Confirm connection", exact: true })
    .boundingBox();
  expect(confirmBounds && confirmBounds.y + confirmBounds.height <= 812).toBe(
    true,
  );
  await page.screenshot({ path: "/tmp/connection-review-mobile.png" });
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/decisions") && r.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "Confirm connection", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await panel
    .getByRole("button", { name: "Confirm connection", exact: true })
    .click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const decision = response.request().postDataJSON();
  expect(decision.kind).toBe("lifecycle_membership");
  expect(decision.payload.requireCallCoverage).toBe(true);
  expect(decision.payload.assignments).toHaveLength(4);
  await expect(panel).toContainText("Connection confirmed");
  const after = (await (await request.get("/api/lifecycles")).json())
    .lifecycles;
  expect(after.issues).toEqual([]);
  expect(
    after.lifecycles.filter(
      (l: { status: string }) => l.status === "unresolved",
    ),
  ).toEqual([]);
  const resolved = after.lifecycles.find(
    (l: { id: string }) =>
      l.id === before.suggestions[0].candidateLifecycleIds[0],
  );
  expect(resolved).toMatchObject({
    status: "closed",
    closeDate: "2024-07-01",
    positions: [],
    cashflow: "25.877688949",
  });
  await panel
    .getByRole("button", { name: "Undo connection", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await panel.getByRole("button", { name: "Retry undo", exact: true }).click();
  await expect(panel).toContainText("Connection undone");
  const undone = (await (await request.get("/api/lifecycles")).json())
    .lifecycles;
  expect(undone.suggestions).toHaveLength(2);
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  // A real Agent proposal uses the same preview and explicit confirmation.
  const inference = await startInferenceServer({
    mode: "tool-call",
    planGateTool: "submit_proposal",
    plan: [
      {
        kind: "tool-call",
        toolName: "submit_proposal",
        arguments: {
          kind: "lifecycle_membership",
          payload: decision.payload,
          rationale: "Connect both WFC call fills to the share trade.",
        },
      },
      { kind: "text", text: "Review the WFC connection below." },
    ],
  });
  try {
    const created = await request.post("/api/models", {
      headers,
      data: {
        name: "connection-review-test",
        endpoint: inference.url,
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
      },
    });
    expect(created.ok()).toBe(true);
    const modelId = (await created.json()).profile.id;
    expect(
      (await request.post(`/api/models/${modelId}/test`, { headers })).ok(),
    ).toBe(true);
    expect(
      (
        await request.post("/api/models/default", {
          headers,
          data: { id: modelId },
        })
      ).ok(),
    ).toBe(true);
    await page.goto("/review");
    await expect(
      page.getByText("1 connection needs review", { exact: false }),
    ).toBeVisible();
    const seededThread = page.waitForRequest(
      (r) => r.url().endsWith("/api/chat/threads") && r.method() === "POST",
    );
    await page.getByTestId("ask-agent").click();
    expect((await seededThread).postDataJSON().seed.issueKeys).toHaveLength(2);
    await page
      .getByTestId("composer-input")
      .fill("Propose the WFC covered-call connection.");
    let releaseConnections = () => {};
    const connectionsGate = new Promise<void>((resolve) => {
      releaseConnections = resolve;
    });
    const delayedConnections = async (
      route: import("playwright/test").Route,
    ) => {
      await connectionsGate;
      await route.fulfill({
        status: 500,
        json: {
          code: "TEST_CONNECTION_LOAD_FAILED",
          message: "Connection load failed",
        },
      });
    };
    await page.route("**/api/lifecycles", delayedConnections);
    await page.getByTestId("composer-send").click();
    const agentCard = page.getByTestId("proposal-list");
    try {
      await expect(agentCard.locator(".proposal-card")).toBeVisible();
      await expect(
        agentCard.getByRole("button", { name: "Accept", exact: true }),
      ).toHaveCount(0);
    } finally {
      releaseConnections();
      await page.unroute("**/api/lifecycles", delayedConnections);
    }
    await expect(agentCard.getByRole("alert")).toBeVisible();
    await expect(
      agentCard.getByRole("button", { name: "Accept", exact: true }),
    ).toHaveCount(0);
    await agentCard.getByRole("button", { name: "Retry", exact: true }).click();
    await agentCard
      .getByRole("button", { name: "Review connection", exact: true })
      .click();
    const agentPanel = page.getByRole("dialog", { name: "Connect WFC trades" });
    await expect(
      agentPanel.getByRole("button", {
        name: "Confirm connection",
        exact: true,
      }),
    ).toBeEnabled();
    let loseAgentResponse = true;
    let agentDecision: { id: string; sequence: number } | null = null;
    await page.route("**/api/analysis/*/accept", async (route) => {
      if (loseAgentResponse) {
        loseAgentResponse = false;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        agentDecision = (await response.json()).decisions[0];
        await route.abort("failed");
      } else await route.fallback();
    });
    await agentPanel
      .getByRole("button", { name: "Confirm connection", exact: true })
      .click();
    await expect(agentPanel.getByRole("alert")).toBeVisible();
    await agentPanel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(agentCard.getByRole("button", { name: "Rebuild journal", exact: true })).toBeVisible();
    await agentCard.getByRole("button", { name: "Rebuild journal", exact: true }).click();
    await expect.poll(async () => (await (await request.get("/api/lifecycles")).json()).stale).toBe(false);
    // Restore this throwaway journal's pending review for the independent-trade case.
    if (!agentDecision) throw new Error("The Agent save did not reach the server");
    const savedAgent = agentDecision as { id: string; sequence: number };
    const undoAgent = await request.post("/api/decisions", { headers, data: {
      kind: "rejection", clientRequestId: "restore-agent-review", author: "user", expectedWatermark: savedAgent.sequence,
      supersedesId: savedAgent.id, payload: { evidenceHash: "restore-agent-review" },
    } });
    expect(undoAgent.ok()).toBe(true);
    const restore = await request.post("/api/builds", { headers, data: { mode: "projection" } });
    const restoreJob = (await restore.json()).jobId;
    await expect.poll(async () => (await (await request.get(`/api/jobs/${restoreJob}`)).json()).job.status).toBe("complete");
  } finally {
    await inference.close();
  }
  await page.goto("/review");
  await expect(
    page.getByText("1 connection needs review", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review connection", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("link", { name: "Review connection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Keep trades separate", exact: true })
    .click();
  const separate = page.getByRole("dialog", {
    name: "Keep WFC trades separate",
  });
  await expect(separate).toBeVisible();
  await separate
    .getByRole("button", { name: "Confirm separate trades", exact: true })
    .click();
  await expect(separate).toContainText("Trades kept separate");
  const independent = (await (await request.get("/api/lifecycles")).json())
    .lifecycles;
  expect(independent.suggestions).toHaveLength(0);
  expect(independent.lifecycles).toHaveLength(2);
});
