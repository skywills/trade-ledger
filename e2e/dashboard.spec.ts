import { expect, test, type Page } from "playwright/test";
import { aggregateAnalytics } from "../src/server/analytics/aggregate.js";
import { performanceFixture } from "../test/fixtures/analytics.js";
const data = aggregateAnalytics(performanceFixture(), {
  currency: "USD",
  basis: "broker",
});
async function stub(page: Page) {
  await page.route("**/api/analytics?*", (route) =>
    route.fulfill({ json: data }),
  );
  await page.route("**/api/analytics", (route) =>
    route.fulfill({ json: data }),
  );
}
test("dashboard routes preserve scope, controls, and existing navigation", async ({
  page,
}) => {
  await stub(page);
  await page.goto("/dashboard?currency=USD&preset=all");
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Dashboard", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Analysis", exact: true }).click();
  await expect(page).toHaveURL(/dashboard\/analysis.*currency=USD/);
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page).toHaveURL(/dashboard\/reports.*preset=all/);
  await expect(page.getByLabel("P&L basis")).toBeVisible();
  await page.getByRole("link", { name: "Agent", exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
});
test("custom range reports an error without losing entered dates", async ({
  page,
}) => {
  await stub(page);
  await page.goto(
    "/dashboard?preset=custom&from=2026-10-20&to=2026-10-01&currency=USD",
  );
  await expect(page.getByRole("alert")).toContainText("Start date");
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(
    "2026-10-20",
  );
});
test("dashboard fits a small viewport and unknown views stay not found", async ({
  page,
}) => {
  await stub(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/dashboard?currency=USD");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.goto("/dashboard/unknown");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});
test("initial empty snapshot offers an import path", async ({ page }) => {
  await page.route("**/api/analytics*", (r) =>
    r.fulfill({
      json: aggregateAnalytics(
        {
          ...performanceFixture(),
          buildId: null,
          ledgerId: null,
          projection: null,
          ledger: null,
        },
        { basis: "broker" },
      ),
    }),
  );
  await page.goto("/dashboard");
  await expect(
    page.getByText("No active build", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Import trades" })).toBeVisible();
});
test("retries failures and ignores late results from an earlier scope", async ({
  page,
}) => {
  let failed = true;
  await page.route("**/api/analytics*", async (route) => {
    const url = new URL(route.request().url());
    if (failed) {
      await route.fulfill({
        status: 500,
        json: { code: "FAILED", message: "Analytics temporarily unavailable" },
      });
      return;
    }
    if (url.searchParams.get("basis") === "broker") {
      await new Promise((r) => setTimeout(r, 350));
      await route.fulfill({ json: data });
    } else {
      await route.fulfill({
        json: {
          ...data,
          filters: { ...data.filters, basis: "reconstructed" },
          performance: { ...data.performance, pnl: "7", eligible: 1 },
        },
      });
    }
  });
  await page.goto("/dashboard?currency=USD&preset=all");
  await expect(
    page.getByText("Analytics temporarily unavailable"),
  ).toBeVisible();
  failed = false;
  await page.getByRole("button", { name: /Retry/i }).click();
  await page.getByLabel("P&L basis").selectOption("reconstructed");
  await expect(
    page.getByText("1 / 679 closed trades with reconstructed P&L", {
      exact: false,
    }),
  ).toBeVisible();
  await page.waitForTimeout(450);
  await expect(
    page.getByText("1 / 679 closed trades with reconstructed P&L", {
      exact: false,
    }),
  ).toBeVisible();
});
test("Overview shows metrics, exact chart tables and strategy links", async ({
  page,
}) => {
  await stub(page);
  await page.goto("/dashboard?currency=USD&preset=all");
  await expect(page.getByTestId("metric-pnl")).toContainText("10456.24");
  await expect(page.getByTestId("metric-win-rate")).toContainText("70.84%");
  await expect(page.getByTestId("metric-closed")).toContainText("679");
  await expect(page.getByTestId("metric-open")).toContainText("19");
  await page
    .getByRole("button", {
      name: "Show data table for Cumulative realized P&L",
    })
    .click();
  await expect(
    page.getByRole("table", { name: "Cumulative realized P&L data" }),
  ).toContainText("10456.24");
  await expect(
    page.getByRole("link", { name: "Synthetic trade" }).first(),
  ).toHaveAttribute("href", /\/strategies\/s-/);
  await expect(
    page.getByRole("link", { name: "Explore transactions" }),
  ).toBeVisible();
});
test("Analysis exposes transaction analytics, filters and current-open drill-down", async ({
  page,
}) => {
  await stub(page);
  await page.route("**/api/analytics/details?*", (r) =>
    r.fulfill({
      json: {
        kind: "strategies",
        items: [],
        page: 1,
        pageSize: 25,
        total: 19,
        filters: {
          basis: "broker",
          kind: "strategies",
          scope: "current-open",
          page: 1,
          pageSize: 25,
          direction: "desc",
          currency: "USD",
        },
        buildId: "build",
        ledgerId: "ledger",
        stale: false,
        generatedAt: data.generatedAt,
      },
    }),
  );
  await page.goto("/dashboard?currency=USD&preset=all");
  await page.getByTestId("metric-open").click();
  await expect(
    page.getByRole("heading", { name: "Current open trades", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Back to analysis", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Transactions", exact: true })
    .last()
    .click();
  await expect(
    page.getByText("Charges / credits", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Underlying", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Activity by event", exact: true }),
  ).toBeVisible();
});
test("changed-build drill-down offers explicit refresh", async ({ page }) => {
  await stub(page);
  let changed = true;
  await page.route("**/api/analytics/details?*", (r) =>
    r.fulfill(
      changed
        ? {
            status: 409,
            json: {
              code: "ANALYTICS_BUILD_CHANGED",
              message:
                "The active build changed. Refresh analytics before continuing.",
            },
          }
        : {
            json: {
              kind: "strategies",
              items: [],
              page: 1,
              pageSize: 25,
              total: 0,
              filters: {
                basis: "broker",
                kind: "strategies",
                scope: "closed",
                page: 1,
                pageSize: 25,
                direction: "desc",
              },
              buildId: "build",
              ledgerId: "ledger",
              stale: false,
              generatedAt: data.generatedAt,
            },
          },
    ),
  );
  await page.goto(
    "/dashboard/analysis?currency=USD&kind=strategies&expectedBuildId=old",
  );
  await expect(
    page.getByRole("button", { name: "Refresh analytics" }),
  ).toBeVisible();
  changed = false;
  await page.getByRole("button", { name: "Refresh analytics" }).click();
  await expect(
    page.getByText("No matching records.", { exact: true }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/expectedBuildId=old/);
});
test("transaction pagination and sorting preserve server scope", async ({
  page,
}) => {
  await stub(page);
  await page.route("**/api/analytics/details?*", (route) => {
    const url = new URL(route.request().url());
    const current = Number(url.searchParams.get("page") ?? 1);
    return route.fulfill({
      json: {
        kind: "transactions",
        items: [],
        page: current,
        pageSize: 25,
        total: 150,
        filters: {
          basis: "broker",
          kind: "transactions",
          scope: "closed",
          page: current,
          pageSize: 25,
          direction: url.searchParams.get("direction") ?? "desc",
          currency: "USD",
        },
        buildId: "build",
        ledgerId: "ledger",
        stale: false,
        generatedAt: data.generatedAt,
      },
    });
  });
  await page.goto("/dashboard/analysis?currency=USD&section=transactions");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 6", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Net cash/ }).click();
  await expect(page).toHaveURL(/sort=netCash/);
  await expect(page.getByText("Page 1 of 6", { exact: true })).toBeVisible();
});
test("Reports keeps reviewed values and notes in a printable report", async ({
  page,
}) => {
  await stub(page);
  await page.goto("/dashboard/reports?currency=USD&preset=all");
  await expect(
    page.getByRole("heading", { name: "Trading report", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("metric-pnl")).toContainText("10456.24");
  await expect(page.getByText("Ledger ledger", { exact: false })).toBeVisible();
  await page
    .getByLabel("Unsaved review notes")
    .fill("Review September sizing.");
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
  await expect(page.getByTestId("report-print-notes")).toContainText(
    "Review September sizing.",
  );
  await expect(
    page
      .getByRole("table", { name: "Performance by strategy", exact: true })
      .getByText("stock", { exact: true }),
  ).toBeVisible();
  await page.pdf({
    path: "/tmp/trade-ledger-report.pdf",
    format: "A4",
    printBackground: true,
  });
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page.getByLabel("Unsaved review notes")).toHaveValue("");
});
test("CSV download uses the current scope and exposes failures", async ({
  page,
}) => {
  await stub(page);
  let failed = true;
  await page.route("**/api/analytics/export?*", (route) => {
    if (failed)
      return route.fulfill({
        status: 409,
        json: {
          code: "ANALYTICS_BUILD_CHANGED",
          message:
            "The active build changed. Refresh analytics before continuing.",
        },
      });
    expect(
      new URL(route.request().url()).searchParams.get("expectedBuildId"),
    ).toBe("build");
    return route.fulfill({
      contentType: "text/csv",
      headers: {
        "content-disposition":
          'attachment; filename="trade-ledger-summary-USD.csv"',
      },
      body: '"metric","value"\r\n"pnl","10456.24"\r\n',
    });
  });
  await page.goto("/dashboard/reports?currency=USD&preset=all");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("active build changed");
  failed = false;
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  expect((await download).suggestedFilename()).toBe(
    "trade-ledger-summary-USD.csv",
  );
});
test("real imports feed full-dataset analytics and repeated imports stay idempotent", async ({
  browser,
}) => {
  const { startDashboardServer } = await import("./dashboard-server.js");
  const server = await startDashboardServer();
  const context = await browser.newContext({ baseURL: server.origin });
  const page = await context.newPage();
  try {
    const { buildExecutionTable, executionRow } = await import(
      "../test/fixtures/scenarios.js"
    );
    const rows = Array.from({ length: 150 }, (_, i) =>
      [false, true].map((close) =>
        executionRow({
          ClientAccountID: `DASH-E2E-${i}`,
          AssetClass: "STK",
          Symbol: "DASH-E2E",
          UnderlyingSymbol: "DASH-E2E",
          Conid: "990000",
          CurrencyPrimary: "USD",
          TradeDate: close ? "2026-09-20" : "2026-09-01",
          DateTime: close ? "2026-09-20 12:00:00" : "2026-09-01 12:00:00",
          Quantity: close ? "-1" : "1",
          TradePrice: close ? "11" : "10",
          NetCash: close ? "11" : "-10",
          FifoPnlRealized: close ? "1" : "0",
          IBCommission: "0",
          "Notes/Codes": close ? "C" : "O",
          TradeID: `DASH-${i}-${close}`,
          IBExecID: `DASH-EXEC-${i}-${close}`,
          IBOrderID: `DASH-ORDER-${i}-${close}`,
          Multiplier: "1",
        }),
      ),
    ).flat();
    const file = {
      name: "dashboard-synthetic.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(buildExecutionTable(rows)),
    };
    async function upload() {
      await page.goto("/imports");
      await page.getByLabel("CSV files").setInputFiles(file);
      await page.getByRole("button", { name: "Confirm import" }).click();
      await expect(page.getByTestId("import-result")).toContainText(
        /complete|duplicate/i,
        { timeout: 30000 },
      );
    }
    await upload();
    await page.goto(
      "/dashboard/analysis?currency=USD&preset=all&symbol=DASH-E2E",
    );
    await expect(page.getByTestId("metric-pnl")).toContainText("150.00");
    await expect(page.getByTestId("metric-closed")).toContainText("150");
    await page.getByTestId("metric-closed").click();
    await expect(page.getByText("Page 1 of 6", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 2 of 6", { exact: true })).toBeVisible();
    const res = await page.request.get(
      "/api/analytics?currency=USD&symbol=DASH-E2E",
    );
    expect((await res.json()).transactions.executions).toBe(300);
    await upload();
    const after = await page.request.get(
      "/api/analytics?currency=USD&symbol=DASH-E2E",
    );
    expect((await after.json()).transactions.executions).toBe(300);
    await page.goto(
      "/dashboard/analysis?currency=USD&symbol=DASH-E2E&section=transactions",
    );
    await expect(
      page.getByRole("table", { name: "Transaction details" }),
    ).toContainText("DASH-E2E");
    await page
      .getByRole("link", { name: "View source", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/imports\?import=.*&row=/);
  } finally {
    await context.close();
    await server.close();
  }
});
test("themes, keyboard controls and responsive layouts remain readable", async ({
  page,
}) => {
  await stub(page);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/dashboard?currency=USD&preset=all");
      await expect(page.getByTestId("metric-pnl")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    const ratios = await page.evaluate(() => {
      const rgb = (v: string) =>
        v
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((v) => {
            const x = v / 255;
            return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          });
      const lum = (v: string) => {
        const [r, g, b] = rgb(v);
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const card = document.querySelector('[data-testid="metric-pnl"]')!;
      const text = card.querySelector("strong")!;
      const a = lum(getComputedStyle(card).backgroundColor),
        b = lum(getComputedStyle(text).color);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratios).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({
      path: `/tmp/trade-ledger-dashboard-${colorScheme}.png`,
      fullPage: true,
    });
  }
  await page
    .getByRole("button", {
      name: "Show data table for Cumulative realized P&L",
    })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("table", { name: "Cumulative realized P&L data" }),
  ).toBeVisible();
});
