// One real compiled application for one browser spec. The fixture owns DATA_DIR
// and removes it even when startup fails or a child must be forcibly stopped.
import { createServer } from "node:net";
import { createApp } from "../dist/src/server/app.js";
import { readConfig } from "../dist/src/server/config.js";

if (!process.env.E2E_DATA_DIR || !process.send) {
  throw new Error("Start the browser server through e2e/fixtures.ts.");
}

// Production config requires a nonzero port and captures the allowed origin
// before listen. Reserve an OS-assigned port, then hand it to the real app.
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const address = reservation.address();
if (!address || typeof address === "string")
  throw new Error("No browser port.");
const origin = `http://127.0.0.1:${address.port}`;
let app;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app?.close();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown();
  });
}
process.once("disconnect", () => {
  void shutdown();
});

try {
  const config = readConfig({
    ...process.env,
    DATA_DIR: process.env.E2E_DATA_DIR,
    PORT: String(address.port),
    HOST: "127.0.0.1",
    ALLOWED_ORIGIN: origin,
    ALLOWED_HOSTS: new URL(origin).host,
    STATIC_DIR: "dist/web",
    NODE_ENV: "test",
  });
  app = await createApp(config);
  await new Promise((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  await app.listen({ host: config.host, port: config.port });
  process.send({ origin });
} catch (error) {
  process.stderr.write(`Browser server failed to start: ${String(error)}\n`);
  if (reservation.listening) reservation.close();
  await app?.close();
  process.exit(1);
}
