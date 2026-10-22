import {
  bothSettlements,
  cashRow,
  fundsCsv,
  settlementTrades,
} from "../test/fixtures/settlements.js";
import { expect, test } from "./fixtures.js";

test("trade-only imports remain usable and a cash companion completes reconstruction", async ({
  page,
  request,
}) => {
  await page.goto("/imports");
  await page
    .getByLabel("CSV files")
    .setInputFiles({
      name: "trades.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(settlementTrades()),
    });
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  await expect(page.getByTestId("import-result")).toContainText(
    "Import complete",
  );
  const before = await (
    await request.get("/api/analytics?currency=USD&basis=reconstructed")
  ).json();
  expect(before.performance).toMatchObject({
    closed: 2,
    missing: 2,
    eligible: 0,
  });
  await page.goto("/review");
  await expect(
    page
      .getByRole("table", { name: "Review items", exact: true })
      .getByText("EVENT_CASH_UNRESOLVED", { exact: false }),
  ).toHaveCount(2);
  await page.goto("/imports");
  await page
    .getByLabel("CSV files")
    .setInputFiles({
      name: "funds.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        fundsCsv([
          ...bothSettlements(),
          cashRow({
            ActivityCode: "SELL",
            ActivityDescription: "ordinary trade already present",
            TradeID: "short-open",
            Debit: "",
            Credit: "100",
          }),
        ]),
      ),
    });
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  await expect(page.getByTestId("import-result")).toContainText(
    "Import complete",
  );
  await expect(page.getByTestId("import-preview")).toContainText(
    "3 cash evidence rows",
  );
  await expect(page.getByTestId("import-preview")).toContainText(
    "0 executions",
  );
  const after = await (
    await request.get("/api/analytics?currency=USD&basis=reconstructed")
  ).json();
  expect(after.performance).toMatchObject({
    closed: 2,
    missing: 0,
    eligible: 2,
    pnl: "-120",
  });
  expect(after.transactions.executions).toBe(4);
  await page.goto("/review");
  await expect(
    page.getByText("No review issues in the active build.", { exact: false }),
  ).toBeVisible();
  const { lifecycles } = await (await request.get("/api/lifecycles")).json();
  const short = lifecycles.lifecycles.find(
    (l: { brokerPnl: string }) => l.brokerPnl === "-200",
  );
  await page.goto(`/lifecycles/${short.id}`);
  await expect(
    page
      .getByRole("table", { name: "Lifecycle timeline", exact: true })
      .getByText("cash settlement", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText("Completed reconstructed P&L", { exact: true })
      .locator("+ dd"),
  ).toHaveText("-200.00");
});
