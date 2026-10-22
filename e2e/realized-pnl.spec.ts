import { buildExecutionTable, executionRow } from "../test/fixtures/scenarios.js";
import { expect, test } from "./fixtures.js";

test("realized cards and chart reconcile completed and still-open lifecycles with period-aware contributor links", async ({ page, request, baseURL }) => {
  const headers = { Origin: baseURL };
  const row = (symbol: string, close: boolean) => executionRow({
    ClientAccountID: "SIM", AssetClass: "STK", Symbol: symbol, Conid: symbol, UnderlyingSymbol: symbol,
    CurrencyPrimary: "USD", Multiplier: "1", IBExecID: `${symbol}-${close}`, IBOrderID: `${symbol}-${close}`,
    TradeDate: close ? symbol === "HELD" ? "20260902" : "20260903" : "20260901",
    DateTime: `${close ? symbol === "HELD" ? "20260902" : "20260903" : "20260901"};100000`,
    Quantity: close ? "-1" : symbol === "HELD" ? "2" : "1",
    NetCash: close ? symbol === "HELD" ? "110" : "120" : symbol === "HELD" ? "-200" : "-100",
    CostBasis: close ? "-100" : symbol === "HELD" ? "200" : "100",
    FifoPnlRealized: close ? symbol === "HELD" ? "10" : "20" : "0",
    "Notes/Codes": close ? "C" : "O",
  });
  const preview = await request.post("/api/imports/preview", { headers, multipart: { file: { name: "realized.csv", mimeType: "text/csv", buffer: Buffer.from(buildExecutionTable([row("HELD", false), row("HELD", true), row("DONE", false), row("DONE", true)])) } } });
  expect(preview.ok()).toBe(true);
  const { previews } = await preview.json();
  expect((await request.post(`/api/imports/${previews[0].id}/commit`, { headers })).ok()).toBe(true);
  const { jobId } = await (await request.post("/api/builds", { headers, data: { mode: "full" } })).json();
  await expect.poll(async () => (await (await request.get(`/api/jobs/${jobId}`)).json()).job.status).toBe("complete");
  const dashboard = "/dashboard?currency=USD&basis=broker&preset=all";
  await page.goto(dashboard);
  await expect(page.getByTestId("metric-pnl")).toContainText("20.00");
  await expect(page.getByTestId("metric-open-realized")).toContainText("10.00");
  await expect(page.getByTestId("metric-total-realized")).toContainText("30.00");
  await page.getByTestId("metric-open-realized").click();
  await expect(page).toHaveURL(/scope=realized-open/);
  const contributors = page.getByRole("table", { name: "Realized P&L in open lifecycles", exact: true });
  await expect(contributors.locator("tbody tr")).toHaveCount(1);
  await expect(contributors).toContainText("HELD");
  await expect(contributors).toContainText("10.00");
  await contributors.getByRole("link").click();
  await expect(page).toHaveURL(/\/lifecycles\//);
  await page.goto(dashboard);
  await page.getByRole("button", { name: "Show data table for Realized P&L by lifecycle status", exact: true }).click();
  const chart = page.getByRole("table", { name: "Realized P&L by lifecycle status data", exact: true });
  await expect(chart).toContainText("Category");
  await expect(chart.locator("tbody tr")).toHaveCount(2);
  await chart.getByRole("row").filter({ hasText: "Open lifecycles" }).getByRole("button", { name: "View trades" }).click();
  await expect(page).toHaveURL(/scope=realized-open/);
  await page.goto("/dashboard?currency=USD&basis=broker&preset=custom&from=2026-09-02&to=2026-09-02");
  await expect(page.getByTestId("metric-total-realized")).toContainText("10.00");
  await expect(page.getByTestId("metric-open-realized")).toContainText("10.00");
  await page.getByTestId("metric-total-realized").click();
  await expect(page.getByRole("table", { name: "Transaction details", exact: true }).locator("tbody tr")).toHaveCount(1);
  await page.goto("/dashboard?currency=USD&basis=reconstructed&preset=all");
  await expect(page.getByTestId("metric-pnl")).toBeVisible();
  await expect(page.getByTestId("metric-open-realized")).toHaveCount(0);
  await page.goto(dashboard);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("metric-open-realized")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
