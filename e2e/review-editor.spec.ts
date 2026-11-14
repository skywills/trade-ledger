import { expect, type Page, test } from "./fixtures.js";

/**
 * Browser acceptance for the manual decision editor's submit guards and
 * picker coverage. The editor's inputs and the decisions endpoint are mocked,
 * so these tests never write to the shared e2e data directory.
 */

const strategy = {
  id: "strategy-one",
  type: "single",
  currency: "USD",
  description: "ABC long call",
  openingDate: "2026-10-01",
  closeDate: null,
  expiry: null,
  expiryYear: null,
  status: "open",
  complete: true,
  openingAmount: "100",
  cashflow: "-100",
  brokerPnl: null,
  reconstructedPnl: null,
  positions: [{ instrumentKey: "call", quantity: "1" }],
  reasons: [],
};
const importSummary = {
  id: "import-one",
  filename: "spread.csv",
  sha256: "abc",
  originalFilePath: "/tmp/spread.csv",
  importedAt: "2026-10-01T00:00:00Z",
  status: "committed",
};
const envelope = (items: unknown[], total = items.length) => ({
  items,
  page: 1,
  pageSize: 100,
  total,
  buildId: "build-1",
  stale: false,
});

interface Posted {
  clientRequestId: string;
  kind: string;
}

async function mockEditor(
  page: Page,
  options: {
    journalTotal?: number;
    transactionsStatus?: number;
    respond?: (posted: Posted[]) => { status: number; json: unknown };
  } = {},
) {
  const posted: Posted[] = [];
  await page.route("**/api/journal?*", (route) =>
    route.fulfill({ json: envelope([strategy], options.journalTotal) }),
  );
  await page.route("**/api/imports?*", (route) =>
    route.fulfill({ json: envelope([importSummary]) }),
  );
  await page.route("**/api/transactions?*", (route) =>
    options.transactionsStatus === undefined
      ? route.fulfill({ json: envelope([]) })
      : route.fulfill({
          status: options.transactionsStatus,
          json: { code: "INTERNAL_ERROR", message: "transactions failed" },
        }),
  );
  await page.route("**/api/decisions", async (route) => {
    posted.push(route.request().postDataJSON() as Posted);
    // Hold the response so a second click lands while the first is in flight.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const reply = options.respond?.(posted) ?? {
      status: 201,
      json: {
        decision: {
          id: `decision-${posted.length}`,
          sequence: posted.length,
          kind: posted.at(-1)?.kind,
          payload: {},
        },
      },
    };
    await route.fulfill(reply);
  });
  return posted;
}

test("double-clicking Record decision records exactly one decision", async ({
  page,
}) => {
  const posted = await mockEditor(page);
  await page.goto("/review");
  await page.getByLabel("Notes").fill("one note");
  const record = page.getByRole("button", { name: "Record decision" });
  await record.dblclick();
  await expect(record).toBeDisabled();
  await expect(page.getByTestId("decision-result")).toContainText("Sequence 1");
  expect(posted).toHaveLength(1);
});

test("double-clicking Confirm decision records exactly one decision", async ({
  page,
}) => {
  const posted = await mockEditor(page);
  await page.goto("/review");
  await page.getByLabel("Decision kind").selectOption("import_exclusion");
  await page.getByLabel("Import").selectOption({ label: "spread.csv" });
  await page.getByRole("button", { name: "Preview decision" }).click();
  await page.getByRole("button", { name: "Confirm decision" }).dblclick();
  await expect(page.getByTestId("decision-result")).toContainText("Sequence 1");
  expect(posted).toHaveLength(1);
});

test("retrying the same payload after a failure reuses its client request id", async ({
  page,
}) => {
  const posted = await mockEditor(page, {
    respond: (calls) =>
      calls.length === 1
        ? {
            status: 500,
            json: { code: "INTERNAL_ERROR", message: "temporary failure" },
          }
        : {
            status: 201,
            json: {
              decision: {
                id: "decision",
                sequence: 1,
                kind: "notes",
                payload: {},
              },
            },
          },
  });
  await page.goto("/review");
  await page.getByLabel("Notes").fill("retry me");
  const record = page.getByRole("button", { name: "Record decision" });
  await record.click();
  await expect(page.getByTestId("error-summary")).toContainText(
    "temporary failure",
  );
  await record.click();
  await expect(page.getByTestId("decision-result")).toContainText("Sequence 1");
  expect(posted).toHaveLength(2);
  expect(posted[1]?.clientRequestId).toBe(posted[0]?.clientRequestId);

  // A new payload after success is a new request.
  await page.getByLabel("Notes").fill("another note");
  await record.click();
  await expect.poll(() => posted.length).toBe(3);
  expect(posted[2]?.clientRequestId).not.toBe(posted[0]?.clientRequestId);
});

test("a failed transactions fetch shows an error instead of empty pickers", async ({
  page,
}) => {
  await mockEditor(page, { transactionsStatus: 500 });
  await page.goto("/review");
  await expect(
    page.getByRole("alert").filter({ hasText: "Failed to load review data." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record decision" }),
  ).toHaveCount(0);
});

test("pickers say when they show only the first page of a larger list", async ({
  page,
}) => {
  await mockEditor(page, { journalTotal: 250 });
  await page.goto("/review");
  await expect(page.getByTestId("picker-truncated")).toContainText(
    "Showing the first 1 of 250 strategies",
  );
});

test("review displays grouped owners, exact differences, and seeds all raw keys", async ({
  page,
}) => {
  await mockEditor(page);
  const owners = [
    { kind: "strategy", id: "strategy-one" },
    { kind: "lifecycle", id: "cycle-one" },
  ];
  const entries = ["first", "second"].map((key, index) => ({
    key,
    code: "PNL_RECONCILIATION",
    severity: "warning",
    sources: [{ importId: "import-one", rowNumber: index + 1 }],
    issueKeys: [`${key}-strategy`, `${key}-lifecycle`],
    owners,
    reconciliation: {
      version: 1,
      owners,
      slices: [],
      currency: "USD",
      brokerPnl: "1.0000001",
      reconstructedPnl: "1.0210003",
    },
  }));
  await page.route("**/api/review?*", (route) =>
    route.fulfill({ json: envelope(entries) }),
  );
  await page.route("**/api/lifecycles", (route) =>
    route.fulfill({
      json: {
        buildId: "build-1",
        ledgerId: null,
        stale: false,
        generatedAt: "",
        watermark: 0,
        rebuildRequired: false,
        lifecycles: {
          version: 1,
          lifecycles: [
            {
              ...strategy,
              id: "cycle-one",
              description: "ABC lifecycle",
              account: "SIM",
              underlyingKey: "ABC",
              originStrategyType: "single",
              stage: "options",
              campaignId: null,
              coveredShares: "0",
              uncoveredShares: "0",
              componentIds: [],
            },
          ],
          members: [],
          campaigns: [],
          suggestions: [],
          issues: [],
          valuations: [],
        },
      },
    }),
  );
  let seed: unknown;
  await page.route("**/api/chat/threads", (route) => {
    seed = route.request().postDataJSON();
    return route.fulfill({
      status: 500,
      json: { code: "TEST", message: "captured" },
    });
  });
  await page.goto("/review");
  const table = page.getByRole("table", { name: "Review items" });
  await expect(
    table.getByRole("columnheader", { name: "Affected items" }),
  ).toBeVisible();
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(
      row.getByRole("link", { name: "ABC long call" }),
    ).toHaveAttribute(
      "href",
      "/strategies/strategy-one?expectedBuildId=build-1",
    );
    await expect(
      row.getByRole("link", { name: "ABC lifecycle" }),
    ).toHaveAttribute("href", "/lifecycles/cycle-one?expectedBuildId=build-1");
    await expect(row).toContainText("Broker: 1.0000001 USD");
    await expect(row).toContainText("Reconstructed: 1.0210003 USD");
    await expect(row).toContainText("Difference: +0.0210002 USD");
  }
  await page.getByTestId("ask-agent").click();
  await expect
    .poll(() => seed)
    .toEqual({
      seed: {
        issueKeys: [
          "first-strategy",
          "first-lifecycle",
          "second-strategy",
          "second-lifecycle",
        ],
      },
    });
});

test("review falls back to owner IDs across builds and labels unattributed issues", async ({
  page,
}) => {
  await mockEditor(page);
  const owner = { kind: "lifecycle", id: "cycle-one" };
  await page.route("**/api/review?*", (route) =>
    route.fulfill({
      json: envelope([
        {
          key: "one",
          code: "PNL_RECONCILIATION",
          severity: "warning",
          sources: [],
          issueKeys: ["one"],
          owners: [owner],
          reconciliation: {
            version: 1,
            owners: [owner],
            slices: [],
            currency: "USD",
            brokerPnl: "0",
            reconstructedPnl: "0",
          },
        },
        {
          key: "two",
          code: "OTHER",
          severity: "warning",
          sources: [],
          issueKeys: ["two"],
          owners: [],
        },
      ]),
    }),
  );
  await page.route("**/api/lifecycles", (route) =>
    route.fulfill({
      json: {
        buildId: "other-build",
        ledgerId: null,
        stale: false,
        generatedAt: "",
        watermark: 0,
        rebuildRequired: false,
        lifecycles: {
          version: 1,
          lifecycles: [
            {
              ...strategy,
              id: "cycle-one",
              description: "WRONG LABEL",
              account: "SIM",
              underlyingKey: "ABC",
              originStrategyType: "single",
              stage: "options",
              campaignId: null,
              coveredShares: "0",
              uncoveredShares: "0",
              componentIds: [],
            },
          ],
          members: [],
          campaigns: [],
          suggestions: [],
          issues: [],
          valuations: [],
        },
      },
    }),
  );
  await page.goto("/review");
  const table = page.getByRole("table", { name: "Review items" });
  await expect(table.getByRole("link", { name: "cycle-one" })).toHaveAttribute(
    "href",
    "/lifecycles/cycle-one?expectedBuildId=build-1",
  );
  await expect(table).not.toContainText("WRONG LABEL");
  await expect(table).toContainText("Unattributed issue");
});
