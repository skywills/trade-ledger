import { type APIRequestContext, expect, test } from "./fixtures.js";
import { fixtures } from "../test/fixtures/scenarios.js";
import {
  type InferenceServer,
  startInferenceServer,
} from "../test/helpers/inference-server.js";

let inference: InferenceServer | undefined;

test.afterEach(async () => {
  await inference?.close();
  inference = undefined;
});

async function configureModel(
  request: APIRequestContext,
  baseURL: string,
  url: string,
): Promise<void> {
  const headers = { origin: baseURL };
  const created = await request.post("/api/models", {
    headers,
    data: {
      name: `e2e-local-${Date.now()}`,
      endpoint: url,
      mode: "local",
      provider: "openai",
      protocol: "openai-completions",
      modelId: "test-local-a",
      contextWindow: 8192,
      maxTokens: 1024,
      timeoutSeconds: 10,
      supportsTools: true,
      thinkingLevels: ["off"],
      credentialRef: null,
    },
  });
  expect(created.ok()).toBe(true);
  const id = ((await created.json()) as { profile: { id: string } }).profile.id;
  const tested = await request.post(`/api/models/${id}/test`, { headers });
  expect(tested.ok()).toBe(true);
  const selected = await request.post("/api/models/default", {
    headers,
    data: { id },
  });
  expect(selected.ok()).toBe(true);
}

test("the app lands on the agent home and starts a conversation from it", async ({
  page,
  request,
  baseURL,
}) => {
  inference = await startInferenceServer({
    mode: "tool-call",
    planGateTool: "get_pnl_summary",
    plan: [{ kind: "text", text: "Hello from the agent." }],
  });
  await configureModel(request, baseURL ?? "", inference.url);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Ask about your journal" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Agent" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page
    .getByRole("button", { name: "Which positions are still open?" })
    .click();
  await expect(page.getByTestId("composer-input")).toHaveValue(
    "Which positions are still open?",
  );
  await page.getByTestId("composer-send").click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
  await expect(page.getByTestId("message-assistant").last()).toContainText(
    "Hello from the agent.",
  );
  await expect(page.getByTestId("thread-list")).toContainText(
    "Which positions are still open?",
  );
});

test("asks a P&L question and gets a tool-backed answer", async ({
  page,
  request,
  baseURL,
}) => {
  inference = await startInferenceServer({
    mode: "tool-call",
    planGateTool: "get_pnl_summary",
    plan: [
      { kind: "tool-call", toolName: "get_pnl_summary", arguments: {} },
      { kind: "text", text: "No strategies yet, so P&L is empty." },
    ],
  });
  await configureModel(request, baseURL ?? "", inference.url);
  await page.goto("/chat");
  await page.getByTestId("new-thread").click();
  await page.getByTestId("composer-input").fill("What is my P&L by currency?");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("tool-chip").first()).toContainText(
    "get_pnl_summary",
  );
  await expect(page.getByTestId("message-assistant").last()).toContainText(
    "No strategies yet",
  );
});

test("streams thinking and answer text, supports keyboard collapse, and restores thinking after reload", async ({ page, request, baseURL }) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  inference = await startInferenceServer({
    mode: "tool-call",
    planGateTool: "get_pnl_summary",
    plan: [{
      kind: "text",
      thinking: "Checking the open review issues against your trades.",
      textChunks: ["First finding. ", "Second finding."],
      textChunkGate: (index) => index === 0 ? gate : Promise.resolve(),
    }],
  });
  const block = page.locator(".thinking-block").last();
  const thinking = block.locator(".thinking-text");
  const toggle = block.locator(":scope > summary");
  const answer = page.getByTestId("message-assistant").last().locator(":scope > .md");
  try {
    await configureModel(request, baseURL ?? "", inference.url);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByTestId("composer-input").fill("Review the open issues");
    await page.getByTestId("composer-send").click();
    await expect(thinking).toContainText("Checking the open review issues against your trades.");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(thinking).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(thinking).toBeVisible();
    await expect(answer).toHaveText("First finding. ");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload();
    await expect(thinking).toContainText("Checking the open review issues against your trades.");
    await expect(answer).toHaveText("First finding. ");
  } finally {
    release();
  }
  await expect(answer).toHaveText("First finding. Second finding.");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  await expect(block).not.toHaveAttribute("open");
  await toggle.click();
  await expect(thinking).toBeVisible();
  await page.reload();
  await expect(block).not.toHaveAttribute("open");
  await toggle.click();
  await expect(thinking).toHaveText("Checking the open review issues against your trades.");
});

test("recovers thinking beyond the replay tail on a delayed first stream connection", async ({ page, request, baseURL }) => {
  let startReply = () => {};
  let finishReply = () => {};
  let connectStream = () => {};
  const replyGate = new Promise<void>((resolve) => { startReply = resolve; });
  const finishGate = new Promise<void>((resolve) => { finishReply = resolve; });
  const connectionGate = new Promise<void>((resolve) => { connectStream = resolve; });
  // Larger than the SSE replay byte budget: recovery requires a new snapshot.
  const thought = `${"Checking trades. ".repeat(17000)}Recovered thinking.`;
  inference = await startInferenceServer({
    mode: "tool-call", planGateTool: "get_pnl_summary",
    plan: [{ kind: "text", thinking: thought, text: "Ready.", beforeReply: () => replyGate, textChunkGate: () => finishGate }],
  });
  try {
    await configureModel(request, baseURL ?? "", inference.url);
    await page.route("**/api/chat/threads/*/events", async (route) => {
      await connectionGate;
      await route.continue();
    });
    await page.goto("/");
    await page.getByTestId("composer-input").fill("Review with a delayed connection");
    const initialDetail = page.waitForResponse((response) => response.request().method() === "GET" && /\/api\/chat\/threads\/[^/]+$/.test(new URL(response.url()).pathname));
    await page.getByTestId("composer-send").click();
    const initial = await (await initialDetail).json();
    expect(initial.messages[1].thinking).toBe("");
    startReply();
    await expect.poll(async () => {
      const detail = await request.get(`/api/chat/threads/${initial.thread.id}`);
      return (await detail.json()).messages[1].thinking.length;
    }).toBe(thought.length);
    connectStream();
    await expect(page.locator(".thinking-text")).toContainText("Recovered thinking.");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  } finally {
    startReply();
    connectStream();
    finishReply();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
});

test("attaching a CSV shows a preview chip", async ({
  page,
  request,
  baseURL,
}) => {
  inference = await startInferenceServer({
    mode: "tool-call",
    planGateTool: "get_pnl_summary",
    plan: [{ kind: "text", text: "ok" }],
  });
  await configureModel(request, baseURL ?? "", inference.url);
  await page.goto("/chat");
  await page.getByTestId("new-thread").click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "spread.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(fixtures.spread),
  });
  await expect(page.getByTestId("attachment-chip")).toContainText("spread.csv");
});

test("stops an active reply from the composer", async ({
  page,
  request,
  baseURL,
}) => {
  inference = await startInferenceServer({
    mode: "tool-call",
    planGateTool: "get_pnl_summary",
    planDelayMs: 2500,
    plan: [{ kind: "text", text: "Should be cancelled" }],
  });
  await configureModel(request, baseURL ?? "", inference.url);
  await page.goto("/");
  await page.getByTestId("composer-input").fill("Run until I stop you");
  await page.getByTestId("composer-send").click();
  const stop = page
    .locator(".composer-dock")
    .getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(stop).toBeHidden();
  await expect(page.getByTestId("composer-input")).toHaveAttribute(
    "placeholder",
    "Ask a follow-up…",
  );
  await expect(page.getByTestId("message-assistant").last()).toContainText(
    "Stopped.",
  );
});


test("renames and deletes a conversation from its header", async ({ page, request, baseURL }) => {
  inference = await startInferenceServer({ mode: "tool-call", planGateTool: "get_pnl_summary", plan: [{ kind: "text", text: "Ready." }] });
  await configureModel(request, baseURL ?? "", inference.url);
  await page.goto("/chat");
  await page.getByTestId("composer-input").fill("Conversation to manage");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("Ready.");
  const threadUrl = page.url();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Rename conversation", exact: true }).click();
  await page.getByRole("textbox", { name: "Conversation title" }).fill("My renamed conversation");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Save title", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rename conversation", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "My renamed conversation" })).toBeVisible();
  await expect(page.getByTestId("thread-list")).toContainText("My renamed conversation");
  await page.reload();
  await expect(page.getByRole("heading", { name: "My renamed conversation" })).toBeVisible();
  await page.getByRole("button", { name: "Delete conversation", exact: true }).click();
  await page.getByRole("button", { name: "Keep conversation", exact: true }).click();
  await expect(page).toHaveURL(threadUrl);
  await page.getByRole("button", { name: "Delete conversation", exact: true }).click();
  await page.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId("thread-list")).not.toContainText("My renamed conversation");
  await page.goto(threadUrl);
  await expect(page.getByRole("alert")).toContainText("No chat thread exists");
});


test("scrolls to the latest thinking delta while streaming", async ({ page, request, baseURL }) => {
  let append = () => {};
  let finish = () => {};
  const appendGate = new Promise<void>((resolve) => { append = resolve; });
  const finishGate = new Promise<void>((resolve) => { finish = resolve; });
  inference = await startInferenceServer({
    mode: "tool-call",
    planGateTool: "get_pnl_summary",
    plan: [{
      kind: "text",
      thinkingChunks: [
        "First thought.\n\n".repeat(50),
        "More analysis.\n\n".repeat(50) + "Latest thought.",
      ],
      thinkingChunkGate: (index) => index === 0 ? appendGate : finishGate,
      text: "Done.",
    }],
  });
  try {
    await configureModel(request, baseURL ?? "", inference.url);
    await page.goto("/");
    await page.getByTestId("composer-input").fill("Think through the trades");
    await page.getByTestId("composer-send").click();
    const thinking = page.locator(".thinking-text");
    await expect(thinking).toContainText("First thought.");
    await expect.poll(() => thinking.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect.poll(() => thinking.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
    const previousHeight = await thinking.evaluate((el) => el.scrollHeight);
    append();
    await expect(thinking).toContainText("Latest thought.");
    await expect.poll(() => thinking.evaluate((el) => el.scrollHeight)).toBeGreaterThan(previousHeight);
    await expect.poll(() => thinking.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
  } finally {
    append();
    finish();
  }
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
});
