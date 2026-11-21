import { expect, test } from "./fixtures.js";

const usage = {
  rounds: 1,
  inputTokens: 10,
  outputTokens: 5,
  generatedTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const thread = {
  id: "sample",
  title: "Journal question",
  profileId: null,
  modelRef: "model",
  cloudConfirmed: false,
  status: "idle",
  pending: null,
  seed: null,
  usage,
  cost: "0",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

test("distinguishes a failed model lookup from a profile that needs setup", async ({
  page,
}) => {
  await page.route(
    "**/api/models",
    (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: { code: "OFFLINE", message: "Model service unavailable" },
        },
      }),
    { times: 1 },
  );
  await page.goto("/chat");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText("Set up a model to start.")).toBeHidden();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Set up a model to start.")).toBeVisible();
});

test("reaches conversations older than the first hundred", async ({ page }) => {
  await page.route("**/api/chat/threads?*", (route) => {
    const query = new URL(route.request().url()).searchParams;
    const pageSize = Number(query.get("pageSize") || 100);
    const current = Number(query.get("page") || 1);
    const items = Array.from({ length: 101 }, (_, i) => ({
      ...thread,
      id: String(i + 1),
      title: "Thread " + (i + 1),
    })).slice((current - 1) * pageSize, current * pageSize);
    return route.fulfill({
      json: {
        items,
        page: current,
        pageSize,
        total: 101,
        buildId: null,
        stale: false,
      },
    });
  });
  await page.goto("/chat");
  await expect(page.locator(".thread-drawer summary")).toContainText("101");
  await page.getByRole("button", { name: "Older conversations" }).click();
  await expect(page.getByRole("link", { name: /Thread 101/ })).toHaveAttribute(
    "href",
    "/chat/101",
  );
});

test("displays known and missing cost coverage after reopening a conversation", async ({
  page,
}) => {
  for (const [coverage, cost, expected] of [
    ["unpriced", "0", "Cost unavailable"],
    ["partial", "1.25", "Known cost $1.25"],
    ["priced", "0", "$0"],
  ]) {
    await page.route("**/api/chat/threads/sample", (route) =>
      route.fulfill({
        json: {
          thread: {
            ...thread,
            usage: { ...usage, costCoverage: coverage },
            cost,
          },
          messages: [],
          runs: [],
        },
      }),
    );
    await page.goto("/chat/sample");
    await expect(page.locator(".thread-heading")).toContainText(expected!);
    await page.unroute("**/api/chat/threads/sample");
  }
});

test("recovers an archive download after navigation", async ({ page }) => {
  await page.goto("/maintenance");
  await page.getByRole("button", { name: "Create backup" }).click();
  const archive = page.getByRole("link", { name: /Download archive/ }).first();
  await expect(archive).toBeVisible();
  const href = await archive.getAttribute("href");
  await page.goto("/journal");
  await page.goto("/maintenance");
  await expect(page.locator('a[href="' + href + '"]')).toBeVisible();
});

test("keeps model rates and table actions reachable on a phone", async ({
  page,
  request,
  baseURL,
}) => {
  const pricing = { input: 2, output: 5, cacheRead: 0, cacheWrite: 0 };
  const payload = {
    name: "Priced model",
    endpoint: "http://127.0.0.1:11434/v1",
    modelId: "mytest-local",
    mode: "local",
    provider: "openai",
    protocol: "openai-completions",
    supportsTools: true,
    thinkingLevels: ["off"],
    credentialRef: null,
    timeoutSeconds: 10,
    contextWindow: 8192,
    maxTokens: 1024,
    pricing,
  };
  const response = await request.post("/api/models/configuration", {
    headers: { origin: baseURL! },
    data: { version: 1, profiles: [payload] },
  });
  expect(response.ok()).toBe(true);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/maintenance#model-profiles");
  const row = page.getByTestId("model-row-Priced model");
  await row.getByRole("button", { name: "Disable" }).click();
  await expect(row.getByRole("button", { name: "Enable" })).toBeVisible();
  await row.getByRole("button", { name: "Enable" }).click();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Renamed priced model");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(
    page.getByTestId("model-row-Renamed priced model"),
  ).toBeVisible();
  const exported = await (
    await request.get("/api/models/configuration")
  ).json();
  expect(
    exported.profiles.find(
      (p: { name: string }) => p.name === "Renamed priced model",
    ).pricing,
  ).toEqual(pricing);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
});

test("announces a timed approval while preserving a typed draft and focus", async ({
  page,
}) => {
  await page.route("**/api/chat/threads/sample", (route) =>
    route.fulfill({ json: { thread, messages: [], runs: [] } }),
  );
  await page.addInitScript(() => {
    class TestEvents extends EventTarget {
      constructor() {
        super();
        window.addEventListener("test-approval", () =>
          this.dispatchEvent(
            new MessageEvent("approval", {
              data: JSON.stringify({
                requestId: "ask",
                tool: "create_backup",
                summary: "Create an archive",
                expiresAt: new Date(Date.now() + 2000).toISOString(),
              }),
            }),
          ),
        );
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: TestEvents });
  });
  await page.goto("/chat/sample");
  const composer = page.getByTestId("composer-input");
  await composer.fill("Draft response");
  await page.evaluate(() => window.dispatchEvent(new Event("test-approval")));
  await expect(composer).toBeFocused();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /approval needed.*create_backup.*expires/i }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Go to pending request" }).click();
  await expect(page.getByTestId("approval-card")).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: /request expired/i }),
  ).toHaveCount(1);
  await expect(page.getByTestId("approval-allow")).toBeDisabled();
  await expect(composer).toHaveValue("Draft response");
});
