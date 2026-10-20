import { expect, test, type Page } from "./fixtures.js";
import { aggregateAnalytics } from "../src/server/analytics/aggregate.js";
import { performanceFixture } from "../test/fixtures/analytics.js";

const source = { importId: "import-one", rowNumber: 12 };
const instrument = (
  key: string,
  symbol: string,
  assetClass = "STK",
  putCall: "P" | "C" | null = null,
) => ({
  key,
  symbol,
  assetClass,
  underlying: "ABC",
  conid: null,
  expiry: assetClass === "OPT" ? "2026-11-20" : null,
  strike: assetClass === "OPT" ? "100" : null,
  putCall,
  multiplier: assetClass === "OPT" ? "100" : "1",
});
const stock = instrument("stock", "ABC");
const put = instrument("put", "ABC protective put", "OPT", "P");
const call = instrument("call", "ABC short call", "OPT", "C");
const execution = (
  key: string,
  security: ReturnType<typeof instrument>,
  quantity: string,
  netCash: string,
  event = "trade",
) => ({
  key,
  account: "U1",
  instrument: security,
  date: "2026-10-01",
  rawDateTime: "2026-10-01T12:00:00",
  timezone: null,
  quantity,
  price: null,
  currency: "USD",
  netCash,
  proceeds: null,
  commission: null,
  taxes: null,
  basis: null,
  brokerPnl: null,
  action: "open",
  event,
  brokerIds: {},
  codes: [],
  sources: [source],
});
const executions = [
  execution("stock-open", stock, "200", "-20000", "assignment"),
  execution("put-open", put, "1", "-100"),
  execution("call-open", call, "-2", "400"),
  execution("call-close", call, "2", "-100"),
];
const lifecycle = {
  id: "cycle-one",
  type: "put_spread",
  currency: "USD",
  description: "ABC assigned spread",
  openingDate: "2026-10-01",
  closeDate: null,
  expiry: null,
  expiryYear: null,
  status: "open",
  complete: true,
  openingAmount: "200",
  cashflow: "-19900",
  brokerPnl: null,
  reconstructedPnl: null,
  positions: [
    { instrumentKey: "stock", quantity: "200" },
    { instrumentKey: "put", quantity: "1" },
  ],
  reasons: [],
  account: "U1",
  underlyingKey: "ABC",
  originStrategyType: "put_spread",
  stage: "assigned_stock",
  campaignId: null,
  coveredShares: "0",
  uncoveredShares: "200",
  componentIds: ["spread", "shares"],
};
const other = {
  ...lifecycle,
  id: "cycle-two",
  description: "ABC second cycle",
};
const opening = {
  strategyId: "call-component",
  executionKey: "call-open",
  role: "open",
};
const suggestion = {
  id: "suggestion",
  callOpening: opening,
  candidateLifecycleIds: [lifecycle.id, other.id],
  quantity: "-2",
  sources: [source],
  reasons: ["unreserved_stock"],
};
const members = [
  {
    lifecycleId: lifecycle.id,
    allocation: {
      strategyId: "shares",
      executionKey: "stock-open",
      role: "open",
    },
    quantity: "200",
    netCash: "-20000",
    brokerPnl: null,
    estimated: false,
    sources: [source],
  },
  {
    lifecycleId: lifecycle.id,
    allocation: {
      strategyId: "spread",
      executionKey: "put-open",
      role: "open",
    },
    quantity: "1",
    netCash: "-100",
    brokerPnl: null,
    estimated: false,
    sources: [source],
  },
];
const valuation = {
  lifecycleId: lifecycle.id,
  asOf: null,
  source: null,
  cashflow: "-19900",
  realizedBrokerPnl: null,
  unrealizedPnl: null,
  totalPnl: null,
  estimated: false,
  reasons: ["missing_price:stock", "missing_price:put"],
};
type Decision = {
  kind: string;
  payload: Record<string, unknown>;
  expectedWatermark: number;
};
async function setup(page: Page, closeQuantity = "2") {
  const state = {
    build: 1,
    decisions: [] as Decision[],
    suggestions: [suggestion],
    campaigns: [] as {
      id: string;
      name: string;
      account: string;
      currency: string;
      underlyingKey: string;
      lifecycleIds: string[];
    }[],
    campaignId: null as string | null,
    valuation: { ...valuation } as Record<string, unknown>,
    lifecycle: { ...lifecycle } as Record<string, unknown>,
  };
  const meta = () => ({
    buildId: `build-${state.build}`,
    ledgerId: "ledger",
    stale: false,
    generatedAt: "2026-10-18T00:00:00Z",
    watermark: state.decisions.length,
    rebuildRequired: false,
  });
  await page.route("**/api/lifecycles**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json:
        path === "/api/lifecycles"
          ? {
              ...meta(),
              lifecycles: {
                version: 1,
                lifecycles: [
                  { ...state.lifecycle, campaignId: state.campaignId },
                  other,
                ],
                members: [
                  ...members,
                  {
                    lifecycleId: "call-cycle",
                    allocation: opening,
                    quantity: "-2",
                    netCash: "400",
                    brokerPnl: null,
                    estimated: false,
                    sources: [source],
                  },
                  {
                    lifecycleId: "call-cycle",
                    allocation: {
                      ...opening,
                      executionKey: "call-close",
                      role: "close",
                    },
                    quantity: closeQuantity,
                    netCash: "-100",
                    brokerPnl: null,
                    estimated: false,
                    sources: [source],
                  },
                ],
                campaigns: state.campaigns,
                suggestions: state.suggestions,
                issues: [],
                valuations: [state.valuation],
              },
            }
          : {
              ...meta(),
              lifecycle: { ...state.lifecycle, campaignId: state.campaignId },
              members,
              executions: executions.map((e) =>
                e.key === "call-close" ? { ...e, quantity: closeQuantity } : e,
              ),
              suggestions: state.suggestions,
              valuation: state.valuation,
              campaigns: state.campaigns,
            },
    });
  });
  await page.route("**/api/decisions", async (route) => {
    const d = route.request().postDataJSON() as Decision;
    state.decisions.push(d);
    if (
      d.kind === "lifecycle_attachment" ||
      d.kind === "lifecycle_attachment_rejection"
    )
      state.suggestions = [];
    if (d.kind === "wheel_campaign")
      state.campaigns.push({
        id: String(d.payload.campaignId),
        name: String(d.payload.name),
        account: "U1",
        currency: "USD",
        underlyingKey: "ABC",
        lifecycleIds: [],
      });
    if (d.kind === "wheel_campaign_membership")
      state.campaignId = d.payload.campaignId as string | null;
    if (d.kind === "lifecycle_valuation")
      state.valuation = {
        ...valuation,
        asOf: d.payload.asOf,
        source: "manual",
        totalPnl: "-300",
        reasons: [],
      };
    await route.fulfill({
      status: 201,
      json: {
        decision: {
          id: `decision-${state.decisions.length}`,
          sequence: state.decisions.length,
          kind: d.kind,
          payload: d.payload,
        },
      },
    });
  });
  await page.route("**/api/builds", (route) => {
    state.build++;
    return route.fulfill({ json: { jobId: "job" } });
  });
  await page.route("**/api/jobs/job", (route) =>
    route.fulfill({
      json: {
        job: {
          id: "job",
          kind: "build",
          status: "complete",
          progress: null,
          error: null,
          input: {},
          createdAt: "2026-10-18T00:00:00Z",
          finishedAt: "2026-10-18T00:00:01Z",
        },
      },
    }),
  );
  return state;
}

test("lifecycle summary opens full timeline with assigned shares, protective put and original source links", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/lifecycles");
  await page
    .getByRole("link", { name: lifecycle.description, exact: true })
    .click();
  await expect(page).toHaveURL(/expectedBuildId=build-1/);
  await expect(
    page.getByRole("heading", { name: "Lifecycle holdings" }),
  ).toBeVisible();
  await expect(page.getByLabel("Remaining holdings")).toContainText("ABC: 200");
  await expect(page.getByLabel("Remaining holdings")).toContainText(
    "ABC protective put: 1",
  );
  const table = page.getByRole("table", { name: "Lifecycle timeline" });
  await expect(table).toContainText("assignment");
  await expect(table).toContainText("ABC protective put");
  await expect(
    table.getByRole("link", { name: "Row 12" }).first(),
  ).toHaveAttribute("href", "/imports?import=import-one&row=12");
  await expect(page.getByText("No complete dated prices")).toBeVisible();
  await expect(page.getByText("missing price:put")).toBeVisible();
});

test("attachment split previews exact reserved shares and cash, then survives rebuild", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/lifecycles/cycle-one?expectedBuildId=build-1");
  await page.getByText("Advanced adjustments", { exact: true }).click();
  await page.getByLabel("Contracts 1", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Split contracts" }).click();
  await page.getByLabel("Target lifecycle 2").selectOption("cycle-two");
  await page.getByRole("button", { name: "Preview attachment" }).click();
  await expect(
    page.getByText(
      "cycle-one: 1 contracts · 100 shares reserved · opening cash 200 USD · cash moving now 150 USD",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "cycle-two: 1 contracts · 100 shares reserved · opening cash 200 USD · cash moving now 150 USD",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Accept attachment and rebuild" })
    .click();
  await expect(page.getByTestId("build-id")).toContainText("build-2");
  expect(state.decisions[0]).toMatchObject({
    kind: "lifecycle_attachment",
    expectedWatermark: 0,
    payload: {
      opening,
      targets: [
        { lifecycleId: "cycle-one", quantity: "-1" },
        { lifecycleId: "cycle-two", quantity: "-1" },
      ],
    },
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Preview attachment" }),
  ).toHaveCount(0);
});

test("fractional or incomplete splits cannot be accepted and independent calls require a rejection reason", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/lifecycles/cycle-one");
  await page.getByText("Advanced adjustments", { exact: true }).click();
  await page.getByLabel("Contracts 1", { exact: true }).fill("0.5");
  await page.getByRole("button", { name: "Preview attachment" }).click();
  await expect(page.getByRole("alert")).toContainText("positive whole number");
  await expect(
    page.getByRole("button", { name: "Accept attachment and rebuild" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reject attachment and rebuild" }),
  ).toBeDisabled();
  await page
    .getByLabel("Reason to keep call independent")
    .fill("Independent call position");
  await page
    .getByRole("button", { name: "Reject attachment and rebuild" })
    .click();
  await expect(page.getByTestId("build-id")).toContainText("build-2");
  expect(state.decisions[0]).toMatchObject({
    kind: "lifecycle_attachment_rejection",
    payload: { reason: "Independent call position", callOpening: opening },
  });
});

test("campaign creation and cycle membership remain separate retained decisions", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/lifecycles/cycle-one");
  await page.getByLabel("New campaign name").fill("ABC wheel");
  await page
    .getByRole("button", { name: "Create campaign and rebuild" })
    .click();
  await expect(page.getByTestId("build-id")).toContainText("build-2");
  await page
    .getByLabel("Campaign", { exact: true })
    .selectOption({ label: "ABC wheel" });
  await page
    .getByRole("button", { name: "Save campaign membership and rebuild" })
    .click();
  await expect(page.getByRole("link", { name: "View campaign" })).toBeVisible();
  expect(state.decisions.map((d) => d.kind)).toEqual([
    "wheel_campaign",
    "wheel_campaign_membership",
  ]);
  expect(state.decisions[1]?.expectedWatermark).toBe(1);
  await page.getByLabel("Campaign", { exact: true }).selectOption("");
  await page
    .getByRole("button", { name: "Save campaign membership and rebuild" })
    .click();
  await expect(page.getByRole("link", { name: "View campaign" })).toHaveCount(
    0,
  );
  expect(state.decisions[2]?.payload.campaignId).toBeNull();
});

test("manual valuation requires a complete dated snapshot and shows its timestamp after rebuild", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/lifecycles/cycle-one");
  await page.getByText("Add dated manual prices", { exact: true }).click();
  await page.getByLabel("Valuation time (UTC)").fill("2026-10-17T12:00");
  await page.getByLabel("Price for stock").fill("95");
  await page.getByLabel("Price for put").fill("1");
  await page.getByRole("button", { name: "Preview valuation" }).click();
  await expect(
    page.getByText(
      "Save 2 manual prices as of 2026-10-17 12:00 UTC for U1 in USD.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save prices and rebuild" }).click();
  await expect(page.getByText("2026-10-17T12:00:00Z · manual")).toBeVisible();
  expect(state.decisions[0]).toMatchObject({
    kind: "lifecycle_valuation",
    payload: {
      account: "U1",
      currency: "USD",
      asOf: "2026-10-17T12:00:00Z",
      marks: [
        { instrumentKey: "stock", price: "95" },
        { instrumentKey: "put", price: "1" },
      ],
    },
  });
});

test("lifecycle dashboard defaults, selector, drill links and export use the same counting unit", async ({
  page,
}) => {
  const base = aggregateAnalytics(performanceFixture(), {
    currency: "USD",
    basis: "broker",
    unit: "strategy",
  });
  const seen: string[] = [];
  await page.route("**/api/analytics?*", (route) => {
    const unit =
      new URL(route.request().url()).searchParams.get("unit") ?? "lifecycle";
    seen.push(unit);
    return route.fulfill({
      json: {
        ...base,
        unit,
        filters: { ...base.filters, unit },
        recent: [
          { ...base.recent[0], id: "cycle-one", description: "ABC cycle" },
        ],
      },
    });
  });
  await page.route("**/api/analytics/export?*", (route) =>
    route.fulfill({
      contentType: "text/csv",
      headers: { "content-disposition": "attachment; filename=lifecycles.csv" },
      body: "id\ncycle-one\n",
    }),
  );
  await page.goto("/dashboard?currency=USD");
  await expect(page.getByLabel("Count by")).toHaveValue("lifecycle");
  await expect(page.getByTestId("metric-closed")).toContainText(
    "Completed lifecycles",
  );
  await expect(
    page.getByRole("link", { name: "ABC cycle", exact: true }),
  ).toHaveAttribute("href", /\/lifecycles\/cycle-one\?expectedBuildId=/);
  await page.getByRole("link", { name: "Analysis", exact: true }).click();
  await page.getByLabel("Count by").selectOption("strategy");
  await expect(page).toHaveURL(/unit=strategy/);
  await expect(page.getByTestId("metric-closed")).toContainText(
    "Closed strategy components",
  );
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page).toHaveURL(/unit=strategy/);
  const exported = page.waitForRequest(
    (r) => new URL(r.url()).pathname === "/api/analytics/export",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  expect(new URL((await exported).url()).searchParams.get("unit")).toBe(
    "strategy",
  );
  await download;
  expect(seen).toContain("lifecycle");
  expect(seen).toContain("strategy");
});

test("campaign coverage keeps missing completed results and missing open marks unavailable", async ({
  page,
}) => {
  const campaign = {
    id: "campaign",
    name: "ABC campaign",
    account: "U1",
    currency: "USD",
    underlyingKey: "ABC",
    lifecycleIds: ["cycle-one", "cycle-two"],
  };
  const basis = {
    eligible: 1,
    missing: 1,
    wins: 1,
    losses: 0,
    breakeven: 0,
    winRatePct: "100",
    pnl: { value: null, knownValue: "800", known: 1, total: 2 },
  };
  await page.route("**/api/campaigns/campaign*", (route) =>
    route.fulfill({
      json: {
        campaign,
        cycles: [{ ...lifecycle, campaignId: campaign.id }, other],
        summary: {
          campaignId: campaign.id,
          completed: 2,
          open: 1,
          unresolved: 0,
          complete: 1,
          missing: 1,
          broker: basis,
          reconstructed: basis,
          openValuation: { value: null, knownValue: null, known: 0, total: 1 },
        },
        buildId: "build-1",
        ledgerId: "ledger",
        stale: false,
        generatedAt: "2026-10-18T00:00:00Z",
      },
    }),
  );
  await page.goto("/campaigns/campaign?expectedBuildId=build-1");
  await expect(
    page.getByRole("heading", { name: "ABC campaign" }),
  ).toBeVisible();
  await expect(
    page
      .getByText("The complete total is unavailable.", { exact: false })
      .first(),
  ).toBeVisible();
  await expect(page.getByText("0 / 1 open cycles valued")).toBeVisible();
  await expect(
    page.getByRole("link", { name: lifecycle.description }),
  ).toHaveAttribute("href", /lifecycles\/cycle-one\?expectedBuildId=build-1/);
});

test("source membership preview conserves the complete source quantity before saving a split", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/lifecycles/cycle-one");
  await page.getByText("Advanced adjustments", { exact: true }).click();
  await page.getByText("Correct source membership", { exact: true }).click();
  await page.getByLabel("Quantity 1", { exact: true }).fill("100");
  await page.getByRole("button", { name: "Preview membership" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "complete source quantity",
  );
  await page.getByRole("button", { name: "Add allocation" }).click();
  await page
    .getByLabel("Lifecycle 2", { exact: true })
    .selectOption("cycle-two");
  await page.getByLabel("Quantity 2", { exact: true }).fill("100");
  await page.getByRole("button", { name: "Preview membership" }).click();
  await expect(
    page.getByText("cycle-two: 100 units; cash -10000"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save membership and rebuild" })
    .click();
  await expect(page.getByTestId("build-id")).toContainText("build-2");
  expect(state.decisions[0]).toMatchObject({
    kind: "lifecycle_membership",
    payload: {
      assignments: [
        {
          lifecycleId: "cycle-one",
          quantity: "100",
          allocation: members[0]?.allocation,
        },
        {
          lifecycleId: "cycle-two",
          quantity: "100",
          allocation: members[0]?.allocation,
        },
      ],
    },
  });
});

test("historical lifecycle analytics offers a rebuild and refreshes the same reporting scope", async ({
  page,
}) => {
  const state = await setup(page);
  const base = aggregateAnalytics(performanceFixture(), {
    currency: "USD",
    basis: "broker",
    unit: "strategy",
  });
  await page.route("**/api/analytics?*", (route) =>
    state.build === 1
      ? route.fulfill({
          status: 409,
          json: {
            code: "LIFECYCLE_REBUILD_REQUIRED",
            message:
              "Rebuild this historical projection to calculate lifecycle analytics.",
          },
        })
      : route.fulfill({
          json: {
            ...base,
            unit: "lifecycle",
            filters: { ...base.filters, unit: "lifecycle" },
            buildId: `build-${state.build}`,
          },
        }),
  );
  await page.goto(
    "/dashboard?unit=lifecycle&currency=USD&basis=broker&preset=all",
  );
  await expect(page.getByRole("alert")).toContainText(
    "Rebuild this historical projection",
  );
  await page
    .getByRole("button", { name: "Rebuild journal", exact: true })
    .click();
  await expect(page.getByTestId("metric-closed")).toContainText(
    "Completed lifecycles",
  );
  await expect(page.getByTestId("build-id")).toContainText("build-2");
  await expect(page).toHaveURL(/unit=lifecycle/);
  await expect(page).toHaveURL(/currency=USD/);
});

test("lifecycle detail keeps its holdings usable on a narrow viewport", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/lifecycles/cycle-one");
  await expect(
    page.getByRole("heading", { name: "Lifecycle holdings" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("a split attachment leaves indivisible closing contracts and their cash for quantity review", async ({
  page,
}) => {
  await setup(page, "1");
  await page.goto("/lifecycles/cycle-one");
  await page.getByText("Advanced adjustments", { exact: true }).click();
  await page.getByRole("button", { name: "Preview attachment" }).click();
  await expect(
    page.getByLabel("Call source allocations to move"),
  ).toContainText("call-close");
  await expect(
    page.getByText(/cycle-one: 2 contracts .* opening cash 400 USD .* 300 USD/),
  ).toBeVisible();
  await page.getByLabel("Contracts 1", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Split contracts" }).click();
  await page.getByLabel("Target lifecycle 2").selectOption("cycle-two");
  await page.getByRole("button", { name: "Preview attachment" }).click();
  const pending = page.getByLabel("Closes requiring quantity review");
  await expect(pending).toContainText("call-close");
  await expect(pending).toContainText("1 contracts");
  await expect(pending).toContainText("cash -100 USD");
  await expect(pending).toContainText("excluded from this preview");
  await expect(
    page.getByLabel("Call source allocations to move"),
  ).not.toContainText("call-close");
  for (const id of ["cycle-one", "cycle-two"]) {
    await expect(
      page.getByText(
        `${id}: 1 contracts · 100 shares reserved · opening cash 200 USD · cash moving now 200 USD`,
      ),
    ).toBeVisible();
  }
});

test("open lifecycle shows known broker realized P&L independently from dated prices", async ({
  page,
}) => {
  const state = await setup(page);
  const realized = page
    .getByText("Broker realized P&L", { exact: true })
    .locator("xpath=following-sibling::dd[1]");
  state.valuation.realizedBrokerPnl = "100";
  await page.goto("/lifecycles/cycle-one");
  await expect(realized).toHaveText("100.00");
  await expect(
    page.getByText("No complete dated prices", { exact: true }),
  ).toBeVisible();
  state.valuation = {
    ...state.valuation,
    asOf: "2026-10-17T12:00:00Z",
    source: "manual",
    totalPnl: "-300",
    unrealizedPnl: "-400",
    reasons: [],
  };
  await page.reload();
  await expect(realized).toHaveText("100.00");
  await expect(page.getByText("Open total P&L", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Residual unrealized P&L", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("2026-10-17T12:00:00Z · manual", { exact: true }),
  ).toBeVisible();
  state.valuation.realizedBrokerPnl = null;
  await page.reload();
  await expect(realized).toHaveText("Unavailable");
  state.lifecycle.status = "closed";
  state.lifecycle.brokerPnl = "75";
  state.valuation.realizedBrokerPnl = "100";
  await page.reload();
  await expect(realized).toHaveText("75.00");
  await expect(page.getByText("Open total P&L", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Residual unrealized P&L", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Price snapshot", { exact: true })).toHaveCount(
    0,
  );
});

test("double-clicking a lifecycle save records exactly one decision", async ({
  page,
}) => {
  const state = await setup(page);
  await page.route("**/api/decisions", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fallback();
  });
  await page.goto("/lifecycles/cycle-one");
  await page.getByLabel("New campaign name").fill("ABC wheel");
  await page
    .getByRole("button", { name: "Create campaign and rebuild" })
    .dblclick();
  await expect(page.getByTestId("build-id")).toContainText("build-2");
  expect(state.decisions.map((d) => d.kind)).toEqual(["wheel_campaign"]);
});

test("retrying after a failed rebuild only rebuilds and does not append the decision again", async ({
  page,
}) => {
  const state = await setup(page);
  let failBuild = true;
  await page.route("**/api/jobs/job", (route) =>
    route.fulfill({
      json: {
        job: {
          id: "job",
          kind: "build",
          status: failBuild ? "failed" : "complete",
          progress: null,
          error: failBuild ? "rebuild exploded" : null,
          input: {},
          createdAt: "2026-10-18T00:00:00Z",
          finishedAt: "2026-10-18T00:00:01Z",
        },
      },
    }),
  );
  let builds = 0;
  await page.route("**/api/builds", (route) => {
    builds++;
    return route.fallback();
  });
  await page.goto("/lifecycles/cycle-one");
  await page.getByLabel("New campaign name").fill("ABC wheel");
  await page
    .getByRole("button", { name: "Create campaign and rebuild" })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "rebuild exploded" }),
  ).toBeVisible();
  expect(state.decisions).toHaveLength(1);
  failBuild = false;
  await page.getByRole("button", { name: "Retry rebuild" }).click();
  await expect(
    page.getByText("Decision saved and journal rebuilt."),
  ).toBeVisible();
  expect(state.decisions).toHaveLength(1);
  expect(builds).toBe(2);
});

test("navigating to another lifecycle resets the unsaved campaign selection", async ({
  page,
}) => {
  const state = await setup(page);
  state.campaigns.push({
    id: "campaign-a",
    name: "ABC wheel",
    account: "U1",
    currency: "USD",
    underlyingKey: "ABC",
    lifecycleIds: [],
  });
  await page.route("**/api/lifecycles/cycle-two*", (route) =>
    route.fulfill({
      json: {
        buildId: "build-1",
        ledgerId: "ledger",
        stale: false,
        generatedAt: "2026-10-18T00:00:00Z",
        watermark: 0,
        rebuildRequired: false,
        lifecycle: other,
        members: [],
        executions,
        suggestions: [],
        valuation: null,
        campaigns: state.campaigns,
      },
    }),
  );
  await page.goto("/lifecycles/cycle-one");
  await page
    .getByLabel("Campaign", { exact: true })
    .selectOption({ label: "ABC wheel" });
  await page.getByLabel("New campaign name").fill("draft name");
  // In-app navigation, as a Link click does.
  await page.evaluate(() => {
    window.history.pushState({}, "", "/lifecycles/cycle-two");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    page.getByRole("heading", { name: other.description }),
  ).toBeVisible();
  await expect(page.getByLabel("Campaign", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("New campaign name")).toHaveValue("");
  await page
    .getByRole("button", { name: "Save campaign membership and rebuild" })
    .click();
  await expect.poll(() => state.decisions.length).toBe(1);
  expect(state.decisions[0]?.payload).toEqual({
    lifecycleId: other.id,
    campaignId: null,
  });
});
