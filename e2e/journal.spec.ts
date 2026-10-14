import { Buffer } from "node:buffer";
import { expect, type Page, test } from "playwright/test";
import {
  buildExecutionTable,
  executionRow,
  fixtures,
  type ExecutionFields,
} from "../test/fixtures/scenarios.js";

/**
 * End-to-end acceptance for the journal/import/ledger/review UI. Every test
 * shares one server and one throwaway data dir (see playwright.config.ts), so
 * the suite runs serially and later steps build on earlier imports.
 */
test.describe.configure({ mode: "serial" });

const CSV = { name: "spread.csv", mimeType: "text/csv" };

function csvFile(name: string, bytes: Uint8Array) {
  return { name, mimeType: "text/csv", buffer: Buffer.from(bytes) };
}

function optionLeg(
  order: string,
  tradeId: string,
  overrides: Partial<ExecutionFields> = {},
): ExecutionFields {
  return executionRow({
    ClientAccountID: "SIM-Z",
    AssetClass: "OPT",
    Symbol: "TEST",
    UnderlyingSymbol: "TEST",
    Conid: `9${overrides.Strike ?? "100"}${overrides["Put/Call"] ?? "C"}${(
      overrides.Expiry ?? "2026-12-18"
    ).replaceAll("-", "")}`,
    CurrencyPrimary: "USD",
    TradeDate: overrides.TradeDate ?? "2026-09-03",
    DateTime: `${overrides.TradeDate ?? "2026-09-03"} 10:00:00`,
    Quantity: overrides.Quantity ?? "+1",
    TradePrice: overrides.TradePrice ?? "2",
    NetCash: overrides.NetCash ?? "-200",
    "Notes/Codes": overrides["Notes/Codes"] ?? "O",
    IBOrderID: order,
    BrokerageOrderID: order,
    IBExecID: `EXEC-${tradeId}`,
    TradeID: tradeId,
    Expiry: overrides.Expiry ?? "2026-12-18",
    Strike: overrides.Strike ?? "100",
    "Put/Call": overrides["Put/Call"] ?? "C",
    Multiplier: overrides.Multiplier ?? "100",
    ...overrides,
  });
}

async function confirmImport(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.goto("/imports");
  await page.getByLabel("CSV files").setInputFiles(files);
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByTestId("import-result")).toContainText("complete", {
    timeout: 30_000,
  });
}

test("journal shows the no-active-build state before any import", async ({
  page,
}) => {
  await page.goto("/journal");
  await expect(page.getByText("No active build")).toBeVisible();
});

test("imports a Flex CSV and renders the AXON journal row", async ({ page }) => {
  await page.goto("/journal");
  await page.getByRole("link", { name: "Journal" }).click();
  await page.getByRole("link", { name: "Imports" }).click();
  await page
    .getByLabel("CSV files")
    .setInputFiles({ ...CSV, buffer: Buffer.from(fixtures.spread) });
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByTestId("import-result")).toContainText("complete", {
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "Journal" }).click();

  const row = page.getByRole("row").filter({ hasText: "AXON" });
  await expect(row).toContainText("-451.66");
  await expect(row.locator('[data-column="debitCredit"]')).toContainText(
    "-284.50",
  );
  await expect(row.locator('[data-column="closeDate"]')).toContainText(
    "2026-09-25",
  );
  await expect(row.locator('[data-column="status"]')).toContainText("Closed");
});

test("journal deep link loads directly", async ({ page }) => {
  await page.goto("/journal");
  await expect(page.getByRole("row").filter({ hasText: "AXON" })).toContainText(
    "-451.66",
  );
});

test("duplicate upload adds no extra strategy row", async ({ page }) => {
  await confirmImport(page, [
    { ...CSV, buffer: Buffer.from(fixtures.spread) },
  ]);
  await expect(page.getByTestId("import-result")).toContainText(
    "Already imported",
  );
  await page.getByRole("link", { name: "Journal" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "AXON" }),
  ).toHaveCount(1);
});

test("drills from a strategy allocation to the source import row", async ({
  page,
}) => {
  await page.goto("/journal");
  await page.getByRole("link", { name: /AXON/ }).first().click();
  await page.getByRole("tab", { name: "Allocations" }).click();
  await page.getByRole("link", { name: "View source" }).first().click();
  await expect(page.getByTestId("import-row-detail")).toBeVisible();
  await expect(page.getByTestId("import-row-detail")).toContainText("AXON");
});

test("multi-currency filter shows rows without a global summed P/L", async ({
  page,
}) => {
  const rows = buildExecutionTable([
    optionLeg("USD-OPEN", "T-U", {
      Symbol: "USDX",
      UnderlyingSymbol: "USDX",
      Conid: "6010001",
      CurrencyPrimary: "USD",
      Quantity: "+1",
      NetCash: "-1000",
      TradePrice: "10",
    }),
    optionLeg("EUR-OPEN", "T-E", {
      Symbol: "EURO",
      UnderlyingSymbol: "EURO",
      Conid: "6020001",
      CurrencyPrimary: "EUR",
      Quantity: "+1",
      NetCash: "-900",
      TradePrice: "9",
    }),
  ]);
  await confirmImport(page, [csvFile("mixed.csv", rows)]);
  await page.getByRole("link", { name: "Journal" }).click();
  await expect(page.getByTestId("journal-total")).toHaveCount(0);
  await page.getByLabel("Currency").selectOption("EUR");
  await expect(page.getByRole("row").filter({ hasText: "EURO" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "USDX" })).toHaveCount(
    0,
  );
  await page.getByLabel("Currency").selectOption("");
});

test("unknown P/L displays Unavailable, never zero", async ({ page }) => {
  const rows = buildExecutionTable([
    optionLeg("NULL-OPEN", "T-N1", {
      Symbol: "NULLA",
      UnderlyingSymbol: "NULLA",
      Conid: "7000100",
      Quantity: "-1",
      "Put/Call": "P",
      Strike: "100",
      NetCash: "500",
      TradePrice: "5",
      "Notes/Codes": "O",
    }),
    optionLeg("NULL-ASSIGN", "T-N2", {
      Symbol: "NULLA",
      UnderlyingSymbol: "NULLA",
      Conid: "7000100",
      Quantity: "+1",
      "Put/Call": "P",
      Strike: "100",
      NetCash: "0",
      TradePrice: "0",
      "Notes/Codes": "A",
    }),
  ]);
  await confirmImport(page, [csvFile("nulla.csv", rows)]);
  await page.getByRole("link", { name: "Journal" }).click();
  const row = page.getByRole("row").filter({ hasText: "NULLA" });
  await expect(row.locator('[data-column="brokerPnl"]')).toContainText(
    "Unavailable",
  );
  await expect(row.locator('[data-column="brokerPnl"]')).not.toContainText(
    "0.00",
  );
});

test("partial close shows status and expiry year, stock shows no year", async ({
  page,
}) => {
  const partial = buildExecutionTable([
    optionLeg("PART-ALL", "T-P1", {
      Symbol: "PART",
      UnderlyingSymbol: "PART",
      Conid: "6100001",
      Quantity: "+2",
      NetCash: "-200",
      TradePrice: "1",
      "Notes/Codes": "O",
    }),
    optionLeg("PART-ALL", "T-P2", {
      Symbol: "PART",
      UnderlyingSymbol: "PART",
      Conid: "6100001",
      Quantity: "-1",
      NetCash: "150",
      TradePrice: "1.5",
      TradeDate: "2026-09-10",
      "Notes/Codes": "C",
    }),
  ]);
  const expiry = buildExecutionTable([
    optionLeg("YEAR-OPEN", "T-Y1", {
      Symbol: "YEAR27",
      UnderlyingSymbol: "YEAR27",
      Conid: "6200001",
      Quantity: "+1",
      NetCash: "-1000",
      TradePrice: "10",
      Expiry: "2027-01-15",
      "Notes/Codes": "O",
    }),
  ]);
  const stock = buildExecutionTable([
    executionRow({
      ClientAccountID: "SIM-Z",
      AssetClass: "STK",
      Symbol: "STOCK",
      UnderlyingSymbol: "STOCK",
      Conid: "6300001",
      CurrencyPrimary: "USD",
      TradeDate: "2026-09-03",
      DateTime: "2026-09-03 10:00:00",
      Quantity: "+100",
      TradePrice: "20",
      NetCash: "-2000",
      "Notes/Codes": "O",
      IBOrderID: "STK-OPEN",
      BrokerageOrderID: "STK-OPEN",
      IBExecID: "EXEC-STK-1",
      TradeID: "T-S1",
      Multiplier: "1",
    }),
  ]);
  await confirmImport(page, [
    csvFile("partial.csv", partial),
    csvFile("expiry.csv", expiry),
    csvFile("stock.csv", stock),
  ]);
  await page.getByRole("link", { name: "Journal" }).click();

  const partialRow = page.getByRole("row").filter({ hasText: "PART" });
  await expect(partialRow.locator('[data-column="status"]')).toContainText(
    "Partially",
  );

  const expiryRow = page.getByRole("row").filter({ hasText: "YEAR27" });
  await expect(expiryRow.locator('[data-column="year"]')).toContainText("2027");

  const stockRow = page.getByRole("row").filter({ hasText: "STOCK" });
  await expect(stockRow.locator('[data-column="year"]')).toContainText("—");
});

test("mixed-expiry strategies show Mixed and actual dates in detail", async ({
  page,
}) => {
  const mixed = buildExecutionTable([
    optionLeg("MIX-OPEN", "T-MIX1", {
      Symbol: "MIXEXP",
      UnderlyingSymbol: "MIXEXP",
      Conid: "6400001",
      Expiry: "2026-12-18",
      Quantity: "+1",
      NetCash: "-200",
      TradePrice: "2",
      "Notes/Codes": "O",
    }),
    optionLeg("MIX-OPEN", "T-MIX2", {
      Symbol: "MIXEXP",
      UnderlyingSymbol: "MIXEXP",
      Conid: "6400002",
      Expiry: "2027-01-15",
      Strike: "110",
      Quantity: "-1",
      NetCash: "150",
      TradePrice: "1.5",
      "Notes/Codes": "O",
    }),
  ]);
  await confirmImport(page, [csvFile("mixed-expiry.csv", mixed)]);
  await page.getByRole("link", { name: "Journal" }).click();

  const row = page.getByRole("row").filter({ hasText: "MIXEXP" });
  await expect(row.locator('[data-column="expiry"]')).toContainText("Mixed");
  await expect(row.locator('[data-column="year"]')).toContainText("—");

  await row.getByRole("link", { name: /MIXEXP/ }).click();
  const dates = page.getByTestId("actual-expiries");
  await expect(dates).toContainText("2026-12-18");
  await expect(dates).toContainText("2027-01-15");
});

test("notes and stop loss survive a full rebuild", async ({ page }) => {
  await page.goto("/review");
  await page.getByLabel("Decision kind").selectOption("notes");
  await page.getByLabel("Notes").fill("first note");
  await page.getByRole("button", { name: "Record decision" }).click();
  const first = await page.getByTestId("decision-result").textContent();
  const firstSequence = Number(/Sequence (\d+)/.exec(first ?? "")?.[1]);

  await page.getByLabel("Decision kind").selectOption("stop_loss");
  await page.getByLabel("Stop loss price").fill("1.25");
  await page.getByRole("button", { name: "Record decision" }).click();
  const second = await page.getByTestId("decision-result").textContent();
  const secondSequence = Number(/Sequence (\d+)/.exec(second ?? "")?.[1]);
  expect(secondSequence).toBeGreaterThan(firstSequence);

  await page.getByRole("link", { name: "Maintenance" }).click();
  await page.getByRole("button", { name: "Rebuild full" }).click();
  await expect(page.getByTestId("job-status")).toContainText("complete", {
    timeout: 30_000,
  });

  await page.getByRole("link", { name: "Review" }).click();
  await page.getByLabel("Decision kind").selectOption("notes");
  await page.getByLabel("Notes").fill("after rebuild");
  await page.getByRole("button", { name: "Record decision" }).click();
  const third = await page.getByTestId("decision-result").textContent();
  const thirdSequence = Number(/Sequence (\d+)/.exec(third ?? "")?.[1]);
  // Decisions were retained across the rebuild, so the water mark kept rising.
  expect(thirdSequence).toBeGreaterThan(secondSequence);
});

test("financially consequential decisions preview before confirmation", async ({
  page,
}) => {
  await page.goto("/review");
  await page.getByLabel("Decision kind").selectOption("import_exclusion");
  await page.getByLabel("Import").selectOption({ label: "spread.csv" });
  await page.getByRole("button", { name: "Preview decision" }).click();
  const preview = page.getByTestId("decision-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("spread.csv");
  await page.getByRole("button", { name: "Confirm decision" }).click();
  await expect(page.getByTestId("decision-result")).toContainText("Sequence");
});

test("a stale write is rejected and can be refreshed", async ({ page }) => {
  await page.goto("/review");
  await page.getByLabel("Decision kind").selectOption("notes");
  await page.getByLabel("Notes").fill("prime the watermark");
  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(page.getByTestId("decision-result")).toContainText("Sequence");

  // A concurrent append moves the server watermark out from under the editor.
  const strategyId = await page.evaluate(async () => {
    const response = await fetch("/api/journal?pageSize=100");
    const body = (await response.json()) as {
      items: Array<{ id: string; description: string }>;
    };
    return body.items.find((item) => item.description.includes("AXON"))?.id;
  });
  await page.evaluate(async (id) => {
    await fetch("/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "notes",
        clientRequestId: `out-of-band-${Date.now()}`,
        sources: [],
        strategyIds: [id],
        supersedesId: null,
        author: "test",
        payload: { strategyId: id, text: "out of band" },
      }),
    });
  }, strategyId);

  await page.getByLabel("Notes").fill("stale attempt");
  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(page.getByRole("alert")).toContainText("Inputs changed");

  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(page.getByTestId("decision-result")).toContainText("Sequence");
});

test("the journal reports a stale build after inputs change", async ({
  page,
}) => {
  await page.goto("/review");
  const strategyId = await page.evaluate(async () => {
    const response = await fetch("/api/journal?pageSize=100");
    const body = (await response.json()) as {
      items: Array<{ id: string; description: string }>;
    };
    return body.items.find((item) => item.description.includes("AXON"))?.id;
  });
  await page.evaluate(async (id) => {
    await fetch("/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "notes",
        clientRequestId: `stale-${Date.now()}`,
        sources: [],
        strategyIds: [id],
        supersedesId: null,
        author: "test",
        payload: { strategyId: id, text: "make stale" },
      }),
    });
  }, strategyId);

  await page.goto("/journal");
  await expect(page.getByTestId("build-stale")).toBeVisible();
});

test("shows a loading state while the journal is fetched", async ({ page }) => {
  await page.route("**/api/journal**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  await page.goto("/journal");
  await expect(page.getByTestId("journal-loading")).toBeVisible();
  await expect(page.getByTestId("journal-loading")).toBeHidden({
    timeout: 10_000,
  });
});

test("shows a failure state with a retry", async ({ page }) => {
  await page.route("**/api/journal**", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "INTERNAL_ERROR", message: "boom" }),
    });
  });
  await page.goto("/journal");
  await expect(page.getByRole("alert")).toContainText("boom");
  await page.unroute("**/api/journal**");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("row").filter({ hasText: "AXON" })).toBeVisible();
});

test("decision validation failure shows a focused error summary", async ({
  page,
}) => {
  await page.goto("/review");
  await page.getByLabel("Decision kind").selectOption("notes");
  await page.getByLabel("Notes").fill("");
  await page.getByRole("button", { name: "Record decision" }).click();
  const summary = page.getByTestId("error-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
});

test("keyboard focus reaches the labelled CSV file input", async ({ page }) => {
  await page.goto("/imports");
  const input = page.getByLabel("CSV files");
  await expect(input).toBeVisible();
  await input.focus();
  await expect(input).toBeFocused();
});

test("imports same-origin directly from the browser", async ({ page }) => {
  const csv = Buffer.from(
    buildExecutionTable([
      optionLeg("BROWSER-OPEN", "T-BROWSER", {
        Symbol: "BROWSERX",
        UnderlyingSymbol: "BROWSERX",
        Conid: "6550001",
        Quantity: "+1",
        NetCash: "-250",
        TradePrice: "2.5",
        "Notes/Codes": "O",
      }),
    ]),
  ).toString("utf8");

  await page.goto("/imports");
  const result = await page.evaluate(async (bytes) => {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "text/csv" }), "browser.csv");
    const preview = await fetch("/api/imports/preview?timezone=UTC", {
      method: "POST",
      body: form,
    });
    const previewBody = (await preview.json()) as {
      previews: Array<{ id: string }>;
    };
    const commit = await fetch(
      `/api/imports/${previewBody.previews[0]?.id}/commit`,
      { method: "POST" },
    );
    const commitBody = (await commit.json()) as { duplicate: boolean };
    return {
      previewStatus: preview.status,
      commitStatus: commit.status,
      duplicate: commitBody.duplicate,
    };
  }, csv);

  expect(result.previewStatus).toBe(201);
  expect(result.commitStatus).toBe(200);
  expect(result.duplicate).toBe(false);
});

test("static fallback serves the SPA but leaves unknown API routes as JSON", async ({
  request,
}) => {
  const deep = await request.get("/review");
  expect(deep.status()).toBe(200);
  expect(deep.headers()["content-type"]).toContain("text/html");

  const api = await request.get("/api/does-not-exist");
  expect(api.status()).toBe(404);
  expect(api.headers()["content-type"]).toContain("application/json");
  expect(await api.json()).toMatchObject({ code: "NOT_FOUND" });

  const asset = await request.get("/assets/missing.js");
  expect(asset.status()).toBe(404);
  expect(asset.headers()["content-type"]).toContain("application/json");
});
