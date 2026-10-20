import { aggregateAnalytics } from "../src/server/analytics/aggregate.js";
import { serializeAnalyticsCsv } from "../src/server/analytics/csv.js";
import { selectAnalyticsDetails } from "../src/server/analytics/details.js";
import {
  parseAnalyticsQuery,
  parseDetailQuery,
  parseExportQuery,
} from "../src/server/analytics/query.js";
import { execution, snapshot, strategy } from "../test/fixtures/analytics.js";
import { expect, test, type Page } from "./fixtures.js";

async function stubPositions(page: Page) {
  const source = snapshot();
  source.projection.strategies = [
    strategy({
      id: "open",
      description: "A open stock",
      status: "open",
      closeDate: null,
      positions: [{ instrumentKey: "STK:A", quantity: "12" }],
    }),
    strategy({
      id: "partial",
      description: "A partial stock",
      status: "partially_closed",
      closeDate: null,
      positions: [{ instrumentKey: "STK:A", quantity: "3" }],
    }),
    strategy({ id: "closed", description: "Closed stock" }),
  ];
  source.ledger.executions = [execution()];
  source.projection.allocations = source.projection.strategies.map((s) => ({
    strategyId: s.id,
    executionKey: "e",
    quantity: "1",
    netCash: "-100",
    brokerPnl: "0",
    pnlEstimated: false,
    role: "open" as const,
  }));
  source.projection.lifecycles = {
    version: 1,
    lifecycles: source.projection.strategies.map((s) => ({
      ...s,
      id: `cycle-${s.id}`,
      account: "SIM",
      underlyingKey: "STK:A",
      originStrategyType: s.type,
      stage: s.status === "closed" ? "closed" : "assigned_stock",
      campaignId: null,
      coveredShares: "0",
      uncoveredShares: "0",
      componentIds: [s.id],
    })),
    members: source.projection.allocations.map((a) => ({
      lifecycleId: `cycle-${a.strategyId}`,
      allocation: {
        strategyId: a.strategyId,
        executionKey: a.executionKey,
        role: a.role,
      },
      quantity: a.quantity,
      netCash: a.netCash,
      brokerPnl: a.brokerPnl,
      estimated: false,
      sources: [],
    })),
    campaigns: [],
    suggestions: [],
    issues: [],
    valuations: [],
  };
  await page.route("**/api/analytics/export?*", (route) =>
    route.fulfill({
      contentType: "text/csv",
      body: serializeAnalyticsCsv(
        source,
        parseExportQuery(
          Object.fromEntries(new URL(route.request().url()).searchParams),
        ),
      ).csv,
    }),
  );
  await page.route("**/api/analytics?*", (route) =>
    route.fulfill({
      json: aggregateAnalytics(
        source,
        parseAnalyticsQuery(
          Object.fromEntries(new URL(route.request().url()).searchParams),
        ),
      ),
    }),
  );
  await page.route("**/api/analytics/details?*", (route) => {
    const query = parseDetailQuery(
      Object.fromEntries(new URL(route.request().url()).searchParams),
    );
    if (query.expectedBuildId && query.expectedBuildId !== source.buildId)
      return route.fulfill({
        status: 409,
        json: {
          code: "ANALYTICS_BUILD_CHANGED",
          message:
            "The active build changed. Refresh analytics before continuing.",
        },
      });
    return route.fulfill({ json: selectAnalyticsDetails(source, query) });
  });
}

test("open positions include partial trades outside the period and paginate on their own tab", async ({
  page,
}) => {
  await stubPositions(page);
  await page.goto(
    "/dashboard?unit=strategy&currency=USD&preset=custom&from=2026-10-01&to=2026-10-20",
  );
  await page.getByRole("link", { name: "Open Positions", exact: true }).click();
  await expect(page).toHaveURL(/dashboard\/open-positions/);
  await expect(
    page.getByRole("link", { name: "Open Positions", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const table = page.getByRole("table", {
    name: "Open positions",
    exact: true,
  });
  await expect(table).toContainText("A open stock");
  await expect(table).toContainText("A partial stock");
  await expect(table).not.toContainText("Closed stock");
  await expect(
    table.getByRole("columnheader", { name: "Remaining quantity" }),
  ).toBeVisible();
  await expect(table).toContainText("12");
  await expect(table).toContainText("2026-09-01");
  await expect(
    table.getByRole("link", { name: "A open stock" }),
  ).toHaveAttribute("href", "/strategies/open?expectedBuildId=build");
  await expect(
    page.getByText(/period bounds do not filter this list/),
  ).toBeVisible();
  await page.goto(`${page.url()}&pageSize=1`);
  await expect(table).toContainText("A open stock");
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page).toHaveURL(/open-positions.*page=2/);
  await expect(table).toContainText("A partial stock");
  await page.reload();
  await expect(table).toContainText("A partial stock");
  await page.getByLabel("Underlying", { exact: true }).selectOption("value:A");
  await expect(page).toHaveURL(/open-positions.*underlying=value%3AA/);
  await expect(table).toContainText("A open stock");
  await expect(page.getByText("Page 1 of 1")).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("open positions discard closed-trade drill-down filters and show an empty state", async ({
  page,
}) => {
  await stubPositions(page);
  await page.goto(
    "/dashboard/analysis?unit=strategy&currency=USD&kind=strategies&scope=closed&outcome=win&page=8",
  );
  await page.getByRole("link", { name: "Open Positions", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Open positions", exact: true }),
  ).toContainText("A open stock");
  expect(new URL(page.url()).searchParams.has("outcome")).toBe(false);
  await page.goto(
    "/dashboard/open-positions?unit=strategy&currency=USD&symbol=MISSING",
  );
  await expect(page.getByText("No matching records.")).toBeVisible();
});

test("open positions use lifecycle links by default and export the current open scope", async ({
  page,
}) => {
  await stubPositions(page);
  await page.goto("/dashboard/open-positions?currency=USD");
  const table = page.getByRole("table", {
    name: "Open positions",
    exact: true,
  });
  await expect(
    table.getByRole("link", { name: "A open stock" }),
  ).toHaveAttribute("href", "/lifecycles/cycle-open?expectedBuildId=build");
  await expect(table).toContainText("A partial stock");
  await expect(page.getByLabel("Export data", { exact: true })).toHaveValue(
    "strategies",
  );
  const request = page.waitForRequest("**/api/analytics/export?*");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  const params = new URL((await request).url()).searchParams;
  expect(params.get("scope")).toBe("current-open");
  expect(params.get("dataset")).toBe("strategies");
  expect(params.get("expectedBuildId")).toBe("build");
  await download;
  await page.goto("/dashboard/open-positions?currency=USD&expectedBuildId=old");
  await expect(
    page.getByRole("button", { name: "Refresh analytics", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh analytics", exact: true })
    .click();
  await expect(page).toHaveURL(/dashboard\/open-positions/);
  await expect(table).toContainText("A open stock");
});
