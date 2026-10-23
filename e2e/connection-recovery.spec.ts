import {
  buildExecutionTable,
  executionRow,
} from "../test/fixtures/scenarios.js";
import { expect, test } from "./fixtures.js";

test("closing an uncertain save refreshes the journal and exposes its rebuild action", async ({
  page,
  request,
  baseURL,
}) => {
  const headers = { Origin: baseURL };
  const rows = (
    [
      ["shares-open", "STK", "1", "100", "-10000", "O"],
      ["call-open", "OPT", "2", "-1", "100", "O"],
      ["call-close", "OPT", "3", "1", "-50", "C"],
      ["shares-close", "STK", "4", "-100", "10100", "C"],
    ] as const
  ).map(([id, asset, day, quantity, cash, action]) =>
    executionRow({
      ClientAccountID: "A",
      CurrencyPrimary: "USD",
      AssetClass: asset,
      Symbol: asset === "OPT" ? "XYZ CALL" : "XYZ",
      UnderlyingSymbol: "XYZ",
      Conid: asset === "OPT" ? "2" : "1",
      TradeDate: `2024-06-0${day}`,
      DateTime: `2024-06-0${day} 12:00:00`,
      Quantity: quantity,
      NetCash: cash,
      IBExecID: id,
      IBOrderID: id,
      "Notes/Codes": action,
      Multiplier: asset === "OPT" ? "100" : "1",
      Expiry: asset === "OPT" ? "2024-06-21" : "",
      Strike: asset === "OPT" ? "105" : "",
      "Put/Call": asset === "OPT" ? "C" : "",
    }),
  );
  const imported = await request.post("/api/imports/preview", {
    headers,
    multipart: {
      file: {
        name: "connection-recovery.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(buildExecutionTable(rows)),
      },
    },
  });
  const { previews } = await imported.json();
  expect(
    (
      await request.post(`/api/imports/${previews[0].id}/commit`, { headers })
    ).ok(),
  ).toBe(true);
  const build = await request.post("/api/builds", {
    headers,
    data: { mode: "full" },
  });
  const { jobId } = await build.json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/jobs/${jobId}`)).json()).job.status,
    )
    .toBe("complete");
  const before = (await (await request.get("/api/lifecycles")).json())
    .lifecycles;
  const opening = before.suggestions[0].callOpening.executionKey;
  const owner = before.members.find(
    (m: { allocation: { executionKey: string } }) =>
      m.allocation.executionKey === opening,
  ).lifecycleId;
  const target = before.suggestions[0].candidateLifecycleIds[0];
  let dropped = false;
  await page.route("**/api/decisions", async (route) => {
    if (!dropped) {
      dropped = true;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else await route.fallback();
  });
  await page.goto(`/lifecycles/${owner}`);
  await page
    .getByRole("button", { name: "Review connection", exact: true })
    .click();
  const panel = page.getByRole("dialog", { name: "Connect XYZ trades" });
  await expect(
    panel.getByRole("button", { name: "Confirm connection", exact: true }),
  ).toBeEnabled();
  const impact = panel.getByRole("region", { name: "Connection preview" });
  await expect(impact).toBeVisible();
  await expect(impact.getByRole("columnheader", { name: "Before", exact: true })).toBeVisible();
  await expect(impact.getByRole("columnheader", { name: "After", exact: true })).toBeVisible();
  await expect(impact.getByRole("row", { name: "Lifecycles 2 1", exact: true })).toBeVisible();
  // Previewing must not save a decision.
  expect((await (await request.get("/api/lifecycles")).json()).watermark).toBe(0);
  await panel
    .getByRole("button", { name: "Confirm connection", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toBeVisible();
  expect((await (await request.get("/api/lifecycles")).json()).stale).toBe(
    true,
  );
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  const rebuild = page.getByRole("button", {
    name: "Rebuild journal",
    exact: true,
  });
  await expect(rebuild).toBeVisible();
  await rebuild.click();
  await expect
    .poll(
      async () => (await (await request.get("/api/lifecycles")).json()).stale,
    )
    .toBe(false);
  await page.goto(`/lifecycles/${target}`);
  await expect(
    page.getByRole("heading", { name: "Lifecycle holdings" }),
  ).toBeVisible();
  const after = await (await request.get("/api/lifecycles")).json();
  expect(after.watermark).toBe(1);
  expect(after.lifecycles.suggestions).toHaveLength(0);
});
