import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { closeStore, openStore } from "../dist/src/server/storage/database.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine an ephemeral port.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

const dataDir = await mkdtemp(join(tmpdir(), "ibkr-journal-built-smoke-"));
let child;
let childOutput = "";
try {
  const store = openStore(dataDir);
  const migrated = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'strategy_views'")
    .get();
  await closeStore(store);
  if (migrated === undefined) throw new Error("Compiled SQLite migration did not create the schema.");

  const port = await freePort();
  child = spawn("npm", ["start"], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ALLOWED_ORIGIN: `http://localhost:${port}`,
      DATA_DIR: dataDir,
      NODE_ENV: "test",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (chunk) => (childOutput += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (childOutput += chunk));

  const url = `http://127.0.0.1:${port}/health/live`;
  const deadline = Date.now() + 10_000;
  let response;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`npm start exited early (${child.exitCode}).`);
    try {
      response = await fetch(url);
      if (response.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!response?.ok) throw new Error("Built server did not become healthy within 10 seconds.");
  const body = await response.json();
  if (body.status !== "ok") throw new Error(`Unexpected liveness response: ${JSON.stringify(body)}`);

  if (process.platform === "win32") child.kill("SIGTERM");
  else process.kill(-child.pid, "SIGTERM");
  const shutdownDeadline = Date.now() + 5000;
  let stopped = false;
  while (Date.now() < shutdownDeadline) {
    try {
      await fetch(url);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      stopped = true;
      break;
    }
  }
  if (!stopped) throw new Error("Server remained healthy after SIGTERM.");
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  child = undefined;
  console.log("Built SQLite migration, npm start health, and SIGTERM shutdown passed.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`${message}${childOutput ? `\n${childOutput}` : ""}`);
} finally {
  if (child && child.exitCode === null) {
    if (process.platform === "win32") child.kill("SIGKILL");
    else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  await rm(dataDir, { recursive: true, force: true });
}
