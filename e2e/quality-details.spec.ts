import {
  buildExecutionTable,
  executionRow,
} from "../test/fixtures/scenarios.js";
import { expect, test } from "./fixtures.js";

test("quality notices lead to the exact allocations and settlement evidence", async ({
  page,
  request,
  baseURL,
}) => {
  const headers = { Origin: baseURL };
  const row = (
    id: string,
    symbol: string,
    date: string,
    quantity: string,
    cash: string,
    basis: string,
    pnl: string,
    codes: string,
  ) =>
    executionRow({
      ClientAccountID: "SIM",
      AssetClass: "OPT",
      Symbol: symbol,
      UnderlyingSymbol: "XYZ",
      CurrencyPrimary: "USD",
      TradeDate: date,
      DateTime: `${date} 12:00:00`,
      Quantity: quantity,
      NetCash: cash,
      CostBasis: basis,
      FifoPnlRealized: pnl,
      "Notes/Codes": codes,
      IBExecID: id,
      IBOrderID: id,
      Multiplier: "100",
      Expiry: "2026-10-16",
      Strike: "100",
      "Put/Call": "C",
    });
  const preview = await request.post("/api/imports/preview", {
    headers,
    multipart: {
      file: {
        name: "quality.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          buildExecutionTable([
            row("first", "XYZ CALL", "2026-09-01", "1", "-20", "20", "0", "O"),
            row("second", "XYZ CALL", "2026-09-02", "1", "-30", "30", "0", "O"),
            row(
              "shared-close",
              "XYZ CALL",
              "2026-09-03",
              "-2",
              "100",
              "-50",
              "50",
              "C",
            ),
            row(
              "short",
              "INDEX CALL",
              "2026-09-01",
              "-1",
              "100",
              "-100",
              "0",
              "O",
            ),
            row(
              "assign",
              "INDEX CALL",
              "2026-09-03",
              "1",
              "0",
              "100",
              "-200",
              "C;A",
            ),
          ]),
        ),
      },
    },
  });
  expect(preview.ok()).toBe(true);
  const { previews } = await preview.json();
  expect(
    (
      await request.post(`/api/imports/${previews[0].id}/commit`, { headers })
    ).ok(),
  ).toBe(true);
  const { jobId } = await (
    await request.post("/api/builds", { headers, data: { mode: "full" } })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/jobs/${jobId}`)).json()).job.status,
    )
    .toBe("complete");
  await page.goto("/dashboard?currency=USD&basis=broker&preset=all");
  await page
    .getByRole("link", {
      name: "2 completed lifecycles include estimated broker P&L",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/scope=estimated-closed/);
  const table = page.getByRole("table", {
    name: "Completed lifecycles with estimated broker P&L",
    exact: true,
  });
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await table.getByRole("link").first().click();
  const timeline = page.getByRole("table", {
    name: "Lifecycle timeline",
    exact: true,
  });
  await expect(
    timeline.getByRole("columnheader", { name: "Broker P&L", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByText("Allocated (estimated)", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "A shared closing execution was allocated across opening groups.",
      { exact: false },
    ),
  ).toBeVisible();
  await page.goto("/review");
  const review = page.getByRole("table", { name: "Review items", exact: true });
  await expect(
    review.getByText("reconstructed P&L is unavailable", { exact: false }),
  ).toBeVisible();
  await review.getByRole("link", { name: /Short Call/ }).click();
  await expect(
    page.getByText("Review", { exact: true }).locator("+ dd"),
  ).toHaveText("Needs review");
  await expect(
    page
      .getByText("Completed reconstructed P&L", { exact: true })
      .locator("+ dd"),
  ).toHaveText("Unavailable");
});
