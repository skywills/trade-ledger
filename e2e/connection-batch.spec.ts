import { buildExecutionTable, executionRow } from "../test/fixtures/scenarios.js";
import { expect, test, type APIRequestContext } from "./fixtures.js";

async function importConnections(request: APIRequestContext, origin: string, symbol: string) {
  const rows = ([
    ["shares", "STK", "1", "100", "-10000", "O", "1"],
    ["early", "OPT", "2", "-1", "100", "O", "2"],
    ["early-close", "OPT", "3", "1", "-50", "C", "2"],
    ["late", "OPT", "4", "-1", "100", "O", "3"],
  ] as const).map(([id, asset, day, quantity, cash, action, conid]) => executionRow({
    ClientAccountID: "A", CurrencyPrimary: "USD", AssetClass: asset,
    Symbol: asset === "OPT" ? `${symbol} CALL ${conid}` : symbol,
    UnderlyingSymbol: symbol, Conid: `${symbol}-${conid}`,
    TradeDate: `2024-06-0${day}`, DateTime: `2024-06-0${day} 12:00:00`,
    Quantity: quantity, NetCash: cash, IBExecID: `${symbol}-${id}`, IBOrderID: `${symbol}-${id}`,
    "Notes/Codes": action, Multiplier: asset === "OPT" ? "100" : "1",
    Expiry: asset === "OPT" ? "2024-06-21" : "",
    Strike: asset === "OPT" ? (conid === "2" ? "105" : "110") : "",
    "Put/Call": asset === "OPT" ? "C" : "",
  }));
  const headers = { Origin: origin };
  const imported = await request.post("/api/imports/preview", {
    headers, multipart: { file: { name: `${symbol}.csv`, mimeType: "text/csv", buffer: Buffer.from(buildExecutionTable(rows)) } },
  });
  const { previews } = await imported.json();
  expect((await request.post(`/api/imports/${previews[0].id}/commit`, { headers })).ok()).toBe(true);
  const { jobId } = await (await request.post("/api/builds", { headers, data: { mode: "full" } })).json();
  await expect.poll(async () => (await (await request.get(`/api/jobs/${jobId}`)).json()).job.status).toBe("complete");
  return (await request.get("/api/lifecycles")).json();
}

test("batch review enforces earlier connections and recovers a lost save response in date order", async ({ page, request, baseURL }) => {
  const before = await importConnections(request, baseURL, "BATCH");
  const target = before.lifecycles.suggestions[0].candidateLifecycleIds[0];
  await page.goto("/lifecycles");
  const section = page.getByRole("region", { name: "BATCH connection reviews", exact: true });
  const rows = section.getByRole("checkbox");
  await expect(rows).toHaveCount(3); // select all plus two contract groups
  await expect(section.getByRole("listitem").nth(0)).toContainText("2024-06-02");
  await expect(section.getByRole("listitem").nth(1)).toContainText("2024-06-04");
  await rows.nth(2).check();
  await section.getByRole("button", { name: "Connect selected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect BATCH connections" });
  await dialog.getByRole("button", { name: "Confirm connections", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("earlier connection");
  expect((await (await request.get("/api/lifecycles")).json()).watermark).toBe(before.watermark);
  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  await section.getByRole("checkbox", { name: "Select all BATCH connections", exact: true }).check();
  await section.getByRole("button", { name: "Connect selected", exact: true }).click();
  await expect(dialog.getByLabel("Share lifecycle")).toHaveValue(target);
  let saves = 0;
  await page.route("**/api/decisions", async (route) => {
    saves++;
    if (saves === 2) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else await route.fallback();
  });
  await dialog.getByRole("button", { name: "Confirm connections", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("1 of 2 connections resolved");
  await dialog.getByRole("button", { name: "Retry remaining connections", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("2 of 2 connections resolved");
  const after = await (await request.get("/api/lifecycles")).json();
  expect(after.watermark).toBe(before.watermark + 2);
  expect(after.lifecycles.suggestions).toHaveLength(0);
  expect(new Set(after.lifecycles.members.map((m: { lifecycleId: string }) => m.lifecycleId))).toEqual(new Set([target]));
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(section).not.toBeVisible();
});

test("selected connections can be kept separate with one confirmation", async ({ page, request, baseURL }) => {
  const before = await importConnections(request, baseURL, "SEPARATE");
  await page.goto("/lifecycles");
  const section = page.getByRole("region", { name: "SEPARATE connection reviews", exact: true });
  await section.getByRole("checkbox", { name: "Select all SEPARATE connections", exact: true }).check();
  await section.getByRole("button", { name: "Keep selected separate", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Keep SEPARATE connections separate" });
  await dialog.getByRole("button", { name: "Confirm separate trades", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("2 of 2 connections resolved");
  const after = await (await request.get("/api/lifecycles")).json();
  expect(after.watermark).toBe(before.watermark + 2);
  expect(after.lifecycles.suggestions).toHaveLength(0);
  const owners = new Map(after.lifecycles.members.map((m: { allocation: { executionKey: string }; lifecycleId: string }) => [m.allocation.executionKey, m.lifecycleId]));
  for (const member of before.lifecycles.members)
    expect(owners.get(member.allocation.executionKey)).toBe(member.lifecycleId);
});

test("grouped review and its confirmation fit a narrow Review page", async ({ page, request, baseURL }) => {
  await importConnections(request, baseURL, "MOBILE");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/review");
  const section = page.getByRole("region", { name: "MOBILE connection reviews", exact: true });
  await section.getByRole("checkbox", { name: "Select all MOBILE connections", exact: true }).check();
  await section.getByRole("button", { name: "Connect selected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect MOBILE connections" });
  await expect(dialog.getByRole("button", { name: "Confirm connections", exact: true })).toBeVisible();
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/trade-ledger-batch-mobile.png" });
  await dialog.getByRole("button", { name: "Confirm connections", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("2 of 2 connections resolved");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(section).not.toBeVisible();
  await expect(page.getByText("No review issues in the active build. Nothing needs attention.")).toBeVisible();
});
