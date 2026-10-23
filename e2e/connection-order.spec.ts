import { buildExecutionTable, executionRow } from "../test/fixtures/scenarios.js";
import { expect, test } from "./fixtures.js";

test("later connections link to their earlier review and unlock after it is resolved", async ({ page, request, baseURL }) => {
  const headers = { Origin: baseURL };
  const rows = ([
    ["shares", "STK", "1", "100", "-10000", "O", "1"],
    ["early", "OPT", "2", "-1", "100", "O", "2"],
    ["early-close", "OPT", "3", "1", "-50", "C", "2"],
    ["late", "OPT", "4", "-1", "100", "O", "3"],
  ] as const).map(([id, asset, day, quantity, cash, action, conid]) => executionRow({
    ClientAccountID: "A", CurrencyPrimary: "USD", AssetClass: asset,
    Symbol: asset === "OPT" ? `XYZ CALL ${conid}` : "XYZ", UnderlyingSymbol: "XYZ", Conid: conid,
    TradeDate: `2024-06-0${day}`, DateTime: `2024-06-0${day} 12:00:00`, Quantity: quantity, NetCash: cash,
    IBExecID: id, IBOrderID: id, "Notes/Codes": action,
    Multiplier: asset === "OPT" ? "100" : "1", Expiry: asset === "OPT" ? "2024-06-21" : "",
    Strike: asset === "OPT" ? (conid === "2" ? "105" : "110") : "", "Put/Call": asset === "OPT" ? "C" : "",
  }));
  const imported = await request.post("/api/imports/preview", {
    headers, multipart: { file: { name: "connection-order.csv", mimeType: "text/csv", buffer: Buffer.from(buildExecutionTable(rows)) } },
  });
  const { previews } = await imported.json();
  expect((await request.post(`/api/imports/${previews[0].id}/commit`, { headers })).ok()).toBe(true);
  const { jobId } = await (await request.post("/api/builds", { headers, data: { mode: "full" } })).json();
  await expect.poll(async () => (await (await request.get(`/api/jobs/${jobId}`)).json()).job.status).toBe("complete");
  const data = await (await request.get("/api/lifecycles")).json();
  const earlyExecution = data.connectionExecutions.find((e: { date: string }) => e.date === "2024-06-02");
  const lateExecution = data.connectionExecutions.find((e: { date: string }) => e.date === "2024-06-04");
  const owner = (key: string) => data.lifecycles.members.find((m: { allocation: { executionKey: string } }) => m.allocation.executionKey === key).lifecycleId;
  const earlyOwner = owner(earlyExecution.key);
  const lateOwner = owner(lateExecution.key);
  await page.goto(`/lifecycles/${lateOwner}`);
  await page.getByRole("button", { name: "Review connection", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Resolve the earlier connection dated 2024-06-02 first.");
  await expect(dialog.getByRole("button", { name: "Confirm connection", exact: true })).toBeDisabled();
  await dialog.getByRole("link", { name: "Review earlier connection" }).click();
  await expect(page).toHaveURL(new RegExp(`/lifecycles/${earlyOwner}$`));
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Keep trades separate", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm separate trades", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Trades kept separate" })).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.goto(`/lifecycles/${lateOwner}`);
  await page.getByRole("button", { name: "Review connection", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Confirm connection", exact: true })).toBeEnabled();
});
