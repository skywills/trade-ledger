import type { AddressInfo } from "node:net";
import type { Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { expect, test } from "playwright/test";

let server: ViteDevServer;
let page: Page;
let polls = 0;
let finishAfter = Infinity;
let hold = false;
let buildPending = false;
let releaseBuild: () => void = () => {
  throw new Error("No build request is pending.");
};
let errorBody = "upstream unavailable";
const paths: string[] = [];
const reservedId = "id/with?query&fragment#value%";
test.beforeAll(async ({ browser }) => {
  server = await createServer({
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "silent",
    plugins: [
      {
        name: "api-regression-server",
        resolveId(id) {
          if (id === "/browser-api-harness.tsx") return "\0browser-api-harness";
        },
        load(id) {
          if (id === "\0browser-api-harness")
            return `
    import { createElement, useEffect } from "react";
    import { createRoot } from "react-dom/client";
    import { useJobSignal } from "/src/web/api.ts";
    import { rebuildLifecycles } from "/src/web/lifecycles/api.ts";
    export { createElement, createRoot };
    function Owner({ resource }) {
      const jobSignal = useJobSignal(resource);
      useEffect(() => {
        window.ownerReady = resource;
        window.startBuild = () => {
          const signal = jobSignal();
          window.buildOutcome = rebuildLifecycles(signal).then(() => "complete", error => error.name);
        };
      }, [resource]);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    export function render(resource) { root.render(createElement(Owner, { resource })); }
    export function unmount() { root.unmount(); }
  `;
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url === "/api/builds") {
              buildPending = true;
              releaseBuild = () => {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ jobId: "held-build" }));
              };
            } else if (
              req.url?.startsWith("/api/strategies/") ||
              req.url?.startsWith("/api/imports/")
            ) {
              paths.push(req.url);
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  items: [],
                  page: 1,
                  pageSize: 100,
                  total: 0,
                  buildId: null,
                  stale: false,
                }),
              );
            } else if (req.url === "/api/analytics/export?dataset=strategies") {
              res.statusCode = 502;
              res.end(errorBody);
            } else if (req.url?.startsWith("/api/jobs/")) {
              paths.push(req.url);
              polls++;
              if (hold) return;
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  job: {
                    id: "job",
                    kind: "build",
                    status: polls >= finishAfter ? "complete" : "running",
                    progress: null,
                    error: null,
                    input: null,
                    createdAt: "today",
                    finishedAt: null,
                  },
                }),
              );
            } else next();
          });
        },
      },
    ],
  });
  await server.listen();
  page = await browser.newPage();
  await page.goto(
    `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo).port}`,
  );
});
test.afterEach(async () => {
  hold = false;
  await page.reload();
});
test.afterAll(async () => {
  await page?.close();
  await server?.close();
});

declare global {
  interface Window {
    pollController: AbortController;
    pollResult: Promise<string>;
    ownerReady: string;
    startBuild: () => void;
    buildOutcome: Promise<string>;
  }
}

test("aborts an in-flight polling request without cancelling the persisted job", async () => {
  polls = 0;
  hold = true;
  await page.evaluate(async () => {
    const { pollJob } = await new Function(
      'return import("/src/web/api.ts")',
    )();
    window.pollController = new AbortController();
    window.pollResult = pollJob("job", undefined, {
      signal: window.pollController.signal,
    }).then(
      () => "resolved",
      (error: Error) => error.name,
    );
  });
  await expect.poll(() => polls).toBe(1);
  const result = await page.evaluate(() => {
    window.pollController.abort();
    return window.pollResult;
  });
  expect(result).toBe("AbortError");
  expect(polls).toBe(1);
  expect(paths.some((path) => path.endsWith("/cancel"))).toBe(false);
});

test("cleans up the polling delay when cancelled", async () => {
  polls = 0;
  await page.evaluate(async () => {
    const { pollJob } = await new Function(
      'return import("/src/web/api.ts")',
    )();
    window.pollController = new AbortController();
    window.pollResult = pollJob("job", undefined, {
      signal: window.pollController.signal,
      intervalMs: 60_000,
    }).then(
      () => "resolved",
      (error: Error) => error.name,
    );
  });
  await expect.poll(() => polls).toBe(1);
  const result = await page.evaluate(() => {
    window.pollController.abort();
    return window.pollResult;
  });
  expect(result).toBe("AbortError");
  expect(polls).toBe(1);
});

test("an already-aborted signal issues no polling request", async () => {
  polls = 0;
  const result = await page.evaluate(async () => {
    const { pollJob } = await new Function(
      'return import("/src/web/api.ts")',
    )();
    const controller = new AbortController();
    controller.abort();
    try {
      await pollJob("job", undefined, { signal: controller.signal });
      return "resolved";
    } catch (error) {
      return (error as Error).name;
    }
  });
  expect(result).toBe("AbortError");
  expect(polls).toBe(0);
});

test("continues observing long-running jobs beyond 600 responses and encodes the job ID", async () => {
  polls = 0;
  finishAfter = 601;
  const result = await page.evaluate(async () => {
    const { pollJob } = await new Function(
      'return import("/src/web/api.ts")',
    )();
    return (
      await pollJob("job/with?reserved#chars", undefined, { intervalMs: 0 })
    ).status;
  });
  finishAfter = Infinity;
  expect(result).toBe("complete");
  expect(paths.at(-1)).toBe("/api/jobs/job%2Fwith%3Freserved%23chars");
});

for (const body of ["upstream unavailable", "{bad json", "null"]) {
  test(`retains HTTP status for analytics export errors: ${body}`, async () => {
    errorBody = body;
    const result = await page.evaluate(async () => {
      const { downloadAnalyticsCsv } = await new Function(
        'return import("/src/web/dashboard/api.ts")',
      )();
      try {
        await downloadAnalyticsCsv({ dataset: "strategies" });
        return {};
      } catch (error) {
        const failure = error as {
          code: string;
          status: number;
          message: string;
        };
        return {
          code: failure.code,
          status: failure.status,
          message: failure.message,
        };
      }
    });
    expect(result).toMatchObject({ code: "REQUEST_FAILED", status: 502 });
    expect(result.message).toContain("502");
  });
}

test("encodes reserved characters in strategy and import detail resource paths", async () => {
  paths.length = 0;
  await page.evaluate(async (id) => {
    const [{ createElement, createRoot }, { StrategyDetail }] =
      await Promise.all([
        new Function('return import("/browser-api-harness.tsx")')(),
        new Function('return import("/src/web/journal/StrategyDetail.tsx")')(),
      ]);
    createRoot(document.createElement("div")).render(
      createElement(StrategyDetail, { id }),
    );
  }, reservedId);
  await expect
    .poll(() => paths)
    .toContain(`/api/strategies/${encodeURIComponent(reservedId)}`);
  await page.goto(
    `${new URL(page.url()).origin}/imports?import=${encodeURIComponent(reservedId)}&row=1`,
  );
  await page.evaluate(async () => {
    const [{ createElement, createRoot }, { ImportsPage }] = await Promise.all([
      new Function('return import("/browser-api-harness.tsx")')(),
      new Function('return import("/src/web/imports/ImportsPage.tsx")')(),
    ]);
    createRoot(document.createElement("div")).render(
      createElement(ImportsPage),
    );
  });
  await expect
    .poll(() => paths)
    .toContain(
      `/api/imports/${encodeURIComponent(reservedId)}/rows?pageSize=100`,
    );
});

for (const cleanup of ["unmount", "resource change"]) {
  test(`stops observing a build started before owner ${cleanup}`, async () => {
    polls = 0;
    buildPending = false;
    await page.evaluate(async () => {
      const harness = await new Function(
        'return import("/browser-api-harness.tsx")',
      )();
      harness.render("first");
    });
    await page.waitForFunction(() => window.ownerReady === "first");
    await page.evaluate(() => window.startBuild());
    await expect.poll(() => buildPending).toBe(true);
    await page.evaluate(async (cleanup) => {
      const harness = await new Function(
        'return import("/browser-api-harness.tsx")',
      )();
      if (cleanup === "unmount") harness.unmount();
      else harness.render("second");
    }, cleanup);
    if (cleanup === "resource change")
      await page.waitForFunction(() => window.ownerReady === "second");
    releaseBuild();
    expect(await page.evaluate(() => window.buildOutcome)).toBe("AbortError");
    expect(polls).toBe(0);
  });
}
