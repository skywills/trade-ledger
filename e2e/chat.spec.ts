import { type APIRequestContext, expect, test } from "playwright/test";
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
