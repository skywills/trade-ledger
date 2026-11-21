import { fixtures } from "../test/fixtures/scenarios.js";
import { expect, test } from "./fixtures.js";

test("a failed batch validation leaves all files uncommitted and can be retried", async ({
  page,
}) => {
  const good = {
    name: "spread.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(fixtures.spread),
  };
  const bad = {
    ...good,
    name: "broken.csv",
    buffer: Buffer.from("one,two\na,b\n"),
  };
  await page.goto("/imports");
  for (const files of [
    [good, bad],
    [bad, good],
  ]) {
    await page.getByLabel("CSV files").setInputFiles(files);
    await page.getByRole("button", { name: "Confirm import" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "No files were committed",
    );
    await expect(page.getByTestId("import-preview")).toContainText(
      "broken.csv",
    );
    const list = await page.request.get("/api/imports");
    expect((await list.json()).total).toBe(0);
  }
  await page.getByLabel("CSV files").setInputFiles(good);
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByTestId("import-result")).toContainText(
    "Build complete",
  );
  await page.getByRole("link", { name: "View rows" }).click();
  await expect(page.getByRole("heading", { name: "spread.csv" })).toBeVisible();
});

test("all destinations are disclosed in tablet portrait and phone landscape", async ({
  page,
}) => {
  for (const [width, height] of [
    [768, 1024],
    [812, 375],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/imports");
    const menu = page.getByRole("button", { name: "Menu" });
    await menu.click({ timeout: 3000 });
    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("link"),
    ).toHaveCount(8);
    await page.getByRole("link", { name: "Maintenance" }).click();
    await expect(
      page.getByRole("heading", { name: "Maintenance", exact: true }),
    ).toBeVisible();
  }
});

test("an import past the first page retains its filename, row issues, and return page", async ({
  page,
  request,
  baseURL,
}) => {
  const headers = { origin: baseURL };
  for (let index = 0; index < 101; index++) {
    const csv = [
      "ClientAccountID,AssetClass,Symbol,CurrencyPrimary,DateTime,Quantity,NetCash,TradeID,LevelOfDetail",
      `SIM,STK,TEST,USD,2026-09-03 10:00:00,1,-10,T${index},MYSTERY`,
    ].join("\n");
    const uploaded = await request.post("/api/imports/preview", {
      headers,
      multipart: {
        file: {
          name: `source-${index}.csv`,
          mimeType: "text/csv",
          buffer: Buffer.from(csv),
        },
      },
    });
    expect(uploaded.ok()).toBe(true);
    const { previews } = await uploaded.json();
    expect(
      (
        await request.post(`/api/imports/${previews[0].id}/commit`, { headers })
      ).ok(),
    ).toBe(true);
  }
  await page.goto("/imports");
  await page.getByRole("link", { name: "Next", exact: true }).click();
  await expect(page.getByText("Page 2 of 2")).toBeVisible();
  const row = page
    .getByRole("table", { name: "Imports", exact: true })
    .locator("tbody tr")
    .last();
  const filename = await row.getByRole("cell").first().innerText();
  await row.getByRole("link", { name: "View rows" }).click();
  await page.getByRole("link", { name: "Row 2", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: filename })).toBeVisible();
  await expect(page.getByRole("region", { name: "Row issues" })).toContainText(
    "unknown level of detail",
  );
  await page.getByRole("link", { name: "← Imports" }).click();
  await expect(page.getByText("Page 2 of 2")).toBeVisible();
});
