import { defineConfig, devices } from "playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // Preserve each file's scenario order; files have isolated app processes and
  // temporary data directories through e2e/fixtures.ts.
  fullyParallel: false,
  workers: 2,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    headless: true,
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
