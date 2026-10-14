// Boots the real compiled server for Playwright with a throwaway data dir and
// the freshly built web bundle, so every browser request shares the single
// allowed origin and same-origin mutations are accepted. Cleans the temp data
// dir on SIGTERM/SIGINT (Playwright's webServer shutdown signal).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../dist/src/server/app.js";
import { readConfig } from "../dist/src/server/config.js";

const port = process.env.E2E_PORT ?? "3210";
const dataDir = await mkdtemp(join(tmpdir(), "ibkr-journal-e2e-"));

const config = readConfig({
  ...process.env,
  DATA_DIR: dataDir,
  PORT: port,
  ALLOWED_ORIGIN: `http://localhost:${port}`,
  STATIC_DIR: "dist/web",
  NODE_ENV: "test",
});

const app = await createApp(config);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown();
  });
}

try {
  await app.listen({ host: "127.0.0.1", port: config.port });
} catch (error) {
  process.stderr.write(`e2e server failed to start: ${String(error)}\n`);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}
