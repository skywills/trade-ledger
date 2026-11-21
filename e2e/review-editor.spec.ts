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

test("pickers can select strategies beyond the first page", async ({
  page,
}) => {
  await mockEditor(page);
  await page.route("**/api/journal?*", (route) => {
    const pageNumber = Number(
      new URL(route.request().url()).searchParams.get("page") ?? 1,
    );
    const items =
      pageNumber === 1
        ? Array.from({ length: 100 }, (_, i) => ({
            ...strategy,
            id: "s" + i,
            description: "Contract " + i,
          }))
        : [{ ...strategy, id: "s100", description: "Later contract" }];
    return route.fulfill({
      json: { ...envelope(items, 101), page: pageNumber },
    });
  });
  await page.goto("/review");
  await page
    .getByRole("button", { name: "Load more strategies" })
    .click({ timeout: 3000 });
  await page
    .getByLabel("Strategy", { exact: true })
    .selectOption({ label: "Later contract" });
  await expect(page.getByLabel("Strategy", { exact: true })).toHaveValue(
    "s100",
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

test("editing a previewed exclusion requires reviewing the changed file", async ({
  page,
}) => {
  const posted = await mockEditor(page);
  await page.route("**/api/imports?*", (route) =>
    route.fulfill({
      json: envelope([
        importSummary,
        { ...importSummary, id: "import-two", filename: "other.csv" },
      ]),
    }),
  );
  await page.goto("/review");
  await page.getByLabel("Decision kind").selectOption("import_exclusion");
  await page.getByLabel("Import", { exact: true }).selectOption("import-one");
  await page.getByRole("button", { name: "Preview decision" }).click();
  await page.getByLabel("Import", { exact: true }).selectOption("import-two");
  await expect(
    page.getByRole("button", { name: "Confirm decision" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Preview decision" }).click();
  await expect(page.getByTestId("decision-preview")).toContainText("other.csv");
  await page.getByRole("button", { name: "Confirm decision" }).click();
  await expect
    .poll(() => posted[0])
    .toMatchObject({ payload: { importId: "import-two" } });
});

test("review paging preserves the issue source and older analysis page", async ({
  page,
}) => {
  await mockEditor(page);
  await page.route("**/api/review?*", (route) => {
    const n = Number(new URL(route.request().url()).searchParams.get("page"));
    const issue = {
      key: "review-" + n,
      code: n === 2 ? "LATER_ISSUE" : "FIRST_ISSUE",
      severity: "warning",
      sources: [{ importId: "import-one", rowNumber: n === 2 ? 101 : 1 }],
      owners: [],
      issueKeys: ["issue-" + n],
    };
    return route.fulfill({ json: { ...envelope([issue], 101), page: n } });
  });
  await page.route("**/api/analysis?*", (route) => {
    const n = Number(new URL(route.request().url()).searchParams.get("page"));
    return route.fulfill({
      json: {
        ...envelope(
          [
            {
              id: "run-" + n,
              status: "proposal_ready",
              createdAt: "2026-10-01T00:00:00Z",
              threadId: "thread-" + n,
              pendingProposals: 1,
            },
          ],
          21,
        ),
        pageSize: 20,
        page: n,
      },
    });
  });
  await page.goto("/review");
  const analyses = page.getByTestId("past-analyses");
  await analyses.getByRole("link", { name: "Next" }).click();
  await expect(
    analyses.getByRole("link", { name: "conversation" }),
  ).toHaveAttribute("href", "/chat/thread-2");
  await page.getByRole("link", { name: "Next", exact: true }).click();
  const issue = page.getByRole("row").filter({ hasText: "LATER_ISSUE" });
  const source = issue.getByRole("link", { name: "101" });
  await expect(source).toHaveAttribute(
    "href",
    "/imports?import=import-one&row=101",
  );
  await source.click();
  await page.goBack();
  await expect(issue).toBeVisible();
  await expect(
    analyses.getByRole("link", { name: "conversation" }),
  ).toHaveAttribute("href", "/chat/thread-2");
});

test("a later execution, changed allocation quantity and changed target require fresh previews", async ({
  page,
}) => {
  const posted = await mockEditor(page);
  await page.route("**/api/journal?*", (route) =>
    route.fulfill({
      json: envelope([
        strategy,
        { ...strategy, id: "next", description: "Other position" },
      ]),
    }),
  );
  const execution = (i: number) => ({
    key: "fill-" + i,
    account: "TEST",
    instrument: {
      key: "stock",
      assetClass: "STK",
      symbol: "SYM" + i,
      underlying: null,
      conid: null,
      expiry: null,
      strike: null,
      putCall: null,
      multiplier: null,
    },
    date: "2026-10-01",
    rawDateTime: "2026-10-01",
    timezone: "UTC",
    quantity: "2",
    price: "30",
    currency: "USD",
    netCash: "-60",
    proceeds: null,
    commission: null,
    taxes: null,
    basis: null,
    brokerPnl: null,
    action: "open",
    event: "trade",
    brokerIds: {},
    codes: [],
    sources: [{ importId: "import-one", rowNumber: i + 1 }],
  });
  await page.route("**/api/transactions?*", (route) => {
    const n = Number(
      new URL(route.request().url()).searchParams.get("page") ?? 1,
    );
    const items =
      n === 1
        ? Array.from({ length: 100 }, (_, i) => execution(i + 1))
        : Array.from({ length: 10 }, (_, i) => execution(i + 101));
    return route.fulfill({ json: { ...envelope(items, 110), page: n } });
  });
  await page.goto("/review");
  await page.getByLabel("Decision kind").selectOption("manual_allocation");
  await page.getByRole("button", { name: "Load more executions" }).click();
  await page.getByLabel("Source execution").selectOption("fill-110");
  const preview = page.getByRole("button", { name: "Preview decision" });
  const confirm = page.getByRole("button", { name: "Confirm decision" });
  await preview.click();
  await page.getByLabel("Allocated quantity").fill("1");
  await expect(confirm).toHaveCount(0);
  await preview.click();
  await page.getByLabel("Strategy", { exact: true }).selectOption("next");
  await expect(confirm).toHaveCount(0);
  await preview.click();
  await expect(page.getByTestId("decision-preview")).toContainText(
    "Allocate 1 of SYM110",
  );
  await confirm.click();
  await expect
    .poll(() => posted[0])
    .toMatchObject({
      payload: {
        strategyId: "next",
        allocations: [{ executionKey: "fill-110", quantity: "1" }],
      },
    });
});
