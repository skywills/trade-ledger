import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as base } from "playwright/test";

export { expect } from "playwright/test";
export type { APIRequestContext, Page } from "playwright/test";

type AppServer = { origin: string; close(): Promise<void> };
type ServerScope = { forFile(file: string): Promise<AppServer> };

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function startServer(): Promise<AppServer> {
  const dataDir = await mkdtemp(join(tmpdir(), "trade-ledger-browser-"));
  const child = fork(resolve("scripts/e2e-server.mjs"), [], {
    env: { ...process.env, E2E_DATA_DIR: dataDir },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const close = async () => {
    try {
      await stop(child);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  };
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Browser server startup timed out: ${stderr}`));
      }, 30_000);
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`Browser server exited (${code}): ${stderr}`));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onMessage = (message: unknown) => {
        if (
          typeof message !== "object" ||
          message === null ||
          !("origin" in message) ||
          typeof message.origin !== "string"
        )
          return;
        cleanup();
        resolve(message.origin);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("exit", onExit);
        child.off("error", onError);
        child.off("message", onMessage);
      };
      child.once("exit", onExit);
      child.once("error", onError);
      child.on("message", onMessage);
    });
    return { origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export const test = base.extend<
  { baseURL: string },
  { serverScope: ServerScope }
>({
  serverScope: [
    async ({}, use) => {
      let current: { file: string; server: AppServer } | undefined;
      try {
        await use({
          async forFile(file) {
            if (current?.file !== file) {
              await current?.server.close();
              current = undefined;
              current = { file, server: await startServer() };
            }
            return current.server;
          },
        });
      } finally {
        await current?.server.close();
      }
    },
    { scope: "worker" },
  ],
  // Both the browser context and Playwright's API request fixture consume this
  // origin. Within-file scenarios share data; another spec always starts fresh.
  baseURL: async ({ serverScope }, use, testInfo) => {
    await use((await serverScope.forFile(testInfo.file)).origin);
  },
});
