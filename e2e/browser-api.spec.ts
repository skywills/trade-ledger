import { createGate } from "./gate.js";
import { strategy } from "../test/fixtures/analytics.js";
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
const committedImports: string[] = [];
let commitGate = createGate();
let decisionGate = createGate();
let decisionPending = false;
const lifecycle = {
  ...strategy({ id: "cycle-one", description: "Confirmed lifecycle" }),
  account: "SIM",
  underlyingKey: "A",
  originStrategyType: "stock",
  stage: "closed",
  campaignId: null,
  coveredShares: "0",
  uncoveredShares: "0",
  componentIds: [],
};
const provenance = {
  buildId: "build-one",
  ledgerId: "ledger-one",
  stale: false,
  generatedAt: "2026-10-19",
  watermark: 0,
  rebuildRequired: false,
};

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
            } else if (req.url === "/api/imports/preview") {
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  previews: ["first", "second"].map((id) => ({
                    id,
                    hash: id,
                    capabilities: [],
                    issues: [],
                    committable: true,
                    counts: {
                      total: 1,
                      executions: 1,
                      lots: 0,
                      summaries: 0,
                      markers: 0,
                      quarantined: 0,
                    },
                  })),
                }),
              );
            } else if (req.url?.endsWith("/commit")) {
              const id = req.url.split("/")[3] ?? "";
              committedImports.push(id);
              const finish = () => {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ importId: id, duplicate: false }));
              };
              if (id === "first") void commitGate.wait.then(finish);
              else finish();
            } else if (req.url === "/api/decisions" && req.method === "POST") {
              decisionPending = true;
              void decisionGate.wait.then(() => {
                res.setHeader("content-type", "application/json");
                res.end(
                  JSON.stringify({
                    decision: {
                      id: "decision-one",
                      sequence: 1,
                      kind: "wheel_campaign_membership",
                      payload: {},
                    },
                  }),
                );
              });
            } else if (req.url?.startsWith("/api/lifecycles/")) {
              paths.push(req.url);
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  ...provenance,
                  lifecycle,
                  members: [],
                  executions: [],
                  suggestions: [],
                  valuation: null,
                  campaigns: [],
                }),
              );
            } else if (req.url === "/api/lifecycles") {
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ ...provenance, lifecycles: null }));
            } else if (req.url?.startsWith("/api/campaigns/")) {
              paths.push(req.url);
              res.statusCode = 404;
              res.end("unknown campaign");
            } else if (req.url?.startsWith("/api/strategies/")) {
              paths.push(req.url);
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  strategy: strategy({ id: reservedId }),
                  allocations: [],
                  links: [],
                  metadata: { notes: null, stopLoss: null },
                  buildId: null,
                  stale: false,
                }),
              );
            } else if (
              req.url?.startsWith("/api/imports") ||
              req.url?.startsWith("/api/journal")
            ) {
              paths.push(req.url);
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  items: req.url.startsWith("/api/journal")
                    ? [strategy({ id: reservedId })]
                    : [],
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

async function navigate(path: string) {
  await page.evaluate(async (path) => {
    const { navigate } = await new Function(
      'return import("/src/web/navigation.tsx")',
    )();
    navigate(path);
  }, path);
}

for (const route of ["strategies", "lifecycles", "campaigns"]) {
  test(`decodes ${route} route IDs exactly once before requesting the resource`, async () => {
    await page.goto(`${new URL(page.url()).origin}/imports`);
    for (const id of [reservedId, "literal%2Fvalue"]) {
      paths.length = 0;
      await navigate(`/${route}/${encodeURIComponent(id)}`);
      await expect
        .poll(() => paths)
        .toContain(`/api/${route}/${encodeURIComponent(id)}`);
    }
  });
  test(`rejects malformed percent escapes in ${route} route IDs`, async () => {
    await page.goto(`${new URL(page.url()).origin}/imports`);
    paths.length = 0;
    await navigate(`/${route}/bad%escape`);
    await expect(
      page.getByRole("heading", { name: "Not found", exact: true }),
    ).toBeVisible();
    expect(paths.some((path) => path.startsWith(`/api/${route}/`))).toBe(false);
  });
}

test("journal links encode IDs before navigating through App", async () => {
  await page.goto(`${new URL(page.url()).origin}/journal`);
  const link = page.getByRole("link", { name: "Synthetic trade", exact: true });
  await expect(link).toHaveAttribute(
    "href",
    `/strategies/${encodeURIComponent(reservedId)}`,
  );
  paths.length = 0;
  await link.click();
  await expect
    .poll(() => paths)
    .toContain(`/api/strategies/${encodeURIComponent(reservedId)}`);
});

test("imports query IDs remain decoded exactly once", async () => {
  paths.length = 0;
  await page.goto(
    `${new URL(page.url()).origin}/imports?import=${encodeURIComponent(reservedId)}&row=1`,
  );
  await expect
    .poll(() => paths)
    .toContain(
      `/api/imports/${encodeURIComponent(reservedId)}/rows?pageSize=100`,
    );
});

test("confirmed imports finish every commit and submit the build after navigation", async () => {
  polls = 0;
  committedImports.length = 0;
  commitGate = createGate();
  buildPending = false;
  await page.goto(`${new URL(page.url()).origin}/imports`);
  await page.getByLabel("CSV files").setInputFiles([
    { name: "first.csv", mimeType: "text/csv", buffer: Buffer.from("one") },
    { name: "second.csv", mimeType: "text/csv", buffer: Buffer.from("two") },
  ]);
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  await expect.poll(() => committedImports).toEqual(["first"]);
  await page.getByRole("link", { name: "Journal", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Journal", exact: true }),
  ).toBeVisible();
  commitGate.open();
  await expect.poll(() => committedImports).toEqual(["first", "second"]);
  await expect.poll(() => buildPending).toBe(true);
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/builds"),
  );
  releaseBuild();
  await (await response).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(polls).toBe(0);
});

test("an accepted lifecycle decision submits its rebuild after navigation", async () => {
  polls = 0;
  decisionGate = createGate();
  decisionPending = false;
  buildPending = false;
  await page.goto(`${new URL(page.url()).origin}/lifecycles/cycle-one`);
  await page
    .getByRole("button", {
      name: "Save campaign membership and rebuild",
      exact: true,
    })
    .click();
  await expect.poll(() => decisionPending).toBe(true);
  await page.getByRole("link", { name: "Journal", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Journal", exact: true }),
  ).toBeVisible();
  decisionGate.open();
  await expect.poll(() => buildPending).toBe(true);
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/builds"),
  );
  releaseBuild();
  await (await response).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(polls).toBe(0);
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
