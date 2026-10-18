import { expect, type Page, test } from "playwright/test";

/**
 * Browser acceptance for the manual decision editor's submit guards. The editor's inputs and the decisions endpoint are mocked,
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
    respond?: (posted: Posted[]) => { status: number; json: unknown };
  } = {},
) {
  const posted: Posted[] = [];
  await page.route("**/api/journal?*", (route) =>
    route.fulfill({ json: envelope([strategy]) }),
  );
  await page.route("**/api/imports?*", (route) =>
    route.fulfill({ json: envelope([importSummary]) }),
  );
  await page.route("**/api/transactions?*", (route) =>
    route.fulfill({ json: envelope([]) }),
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
  await expect(page.getByTestId("decision-result")).toContainText(
    "Sequence 1",
  );
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
  await expect(page.getByTestId("decision-result")).toContainText(
    "Sequence 1",
  );
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
  await expect(page.getByTestId("decision-result")).toContainText(
    "Sequence 1",
  );
  expect(posted).toHaveLength(2);
  expect(posted[1]?.clientRequestId).toBe(posted[0]?.clientRequestId);

  // A new payload after success is a new request.
  await page.getByLabel("Notes").fill("another note");
  await record.click();
  await expect.poll(() => posted.length).toBe(3);
  expect(posted[2]?.clientRequestId).not.toBe(posted[0]?.clientRequestId);
});
