import { expect, test } from "playwright/test";

test("imports and exports model configuration in Maintenance", async ({ page, request }) => {
  await page.goto("/maintenance");
  await expect(page.getByRole("link", { name: "Export model configuration", exact: true })).toBeVisible();
  const profile = { name: `portable-ui-${Date.now()}`, mode: "local", provider: "openai", protocol: "openai-completions", endpoint: "http://localhost:11434/v1", modelId: "local", contextWindow: 8192, maxTokens: 1024, timeoutSeconds: 10, supportsTools: true, thinkingLevels: ["off"], credentialRef: "env:PORTABLE_API_KEY" };
  await page.getByLabel("Import model configuration").setInputFiles({ name: "models.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ version: 1, profiles: [profile] })) });
  await expect(page.getByRole("status")).toContainText("Imported 1 model profile");
  await expect(page.getByTestId(`model-row-${profile.name}`)).toContainText("Not verified");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export model configuration", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("model-configuration.json");
  const exported = await request.get("/api/models/configuration");
  expect((await exported.json()).profiles).toContainEqual(expect.objectContaining({ name: profile.name, credentialRef: "env:PORTABLE_API_KEY" }));
});

test("shows reset scope and requires typed confirmation", async ({ page, request }) => {
  await page.goto("/maintenance");
  await expect(page.getByRole("button", { name: "Reset journal data", exact: true })).toBeVisible();
  const modelsBefore = await (await request.get("/api/models")).json();
  await page.getByRole("button", { name: "Reset journal data", exact: true }).click();
  await expect(page.getByText("Uploaded CSVs and transcripts will also be removed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm reset", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Keep journal data", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reset journal data", exact: true })).toBeFocused();
  await expect(page.getByLabel("Type RESET to confirm")).toBeHidden();
  await page.getByRole("button", { name: "Reset journal data", exact: true }).click();
  await page.getByLabel("Type RESET to confirm").fill("RESET");
  await page.getByRole("button", { name: "Confirm reset", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Journal data reset");
  await expect(page.getByRole("button", { name: "Reset journal data", exact: true })).toBeFocused();
  const modelsAfter = await (await request.get("/api/models")).json();
  expect(modelsAfter).toEqual(modelsBefore);
  expect((await (await request.get("/api/imports")).json()).total).toBe(0);
  expect((await (await request.get("/api/chat/threads")).json()).total).toBe(0);
  const evil = await request.post("/api/maintenance/reset", { headers: { origin: "https://evil.test" }, data: { confirmation: "RESET" } });
  expect(evil.status()).toBe(403);
});
