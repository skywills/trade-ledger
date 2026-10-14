import { defineConfig, devices } from "playwright/test";

const PORT = 3210;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * One browser origin: the compiled Fastify server serves both the API and the
 * built web bundle from `dist/web` at the same `ALLOWED_ORIGIN`, so same-origin
 * mutations pass the server's cross-origin guard without any test-only bypass.
 * A throwaway `DATA_DIR` is created by the launcher and removed on shutdown.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && node scripts/e2e-server.mjs",
    url: `${BASE_URL}/health/live`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
