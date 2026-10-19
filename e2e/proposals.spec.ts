import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { expect, test } from "playwright/test";
import { buildEvidenceSnapshot } from "../src/server/ai/evidence.js";
import {
  appendRunProposal,
  insertRun,
  readRun,
} from "../src/server/ai/runs.js";
import { activeProjection } from "../src/server/builds/service.js";
import {
  appendDecision,
  decisionWatermark,
} from "../src/server/decisions/service.js";
import { registerAnalysisRoutes } from "../src/server/http/routes-analysis.js";
import { localProfile, seedLedger } from "../test/helpers/chat.js";
import { createTestStore } from "../test/helpers/store.js";

test("proposal actions work after the evidence watermark has advanced", async ({
  page,
}) => {
  const fixture = await createTestStore();
  const app = Fastify();
  try {
    const { store } = fixture;
    const { buildId } = await seedLedger(store);
    const strategyId = activeProjection(store).projection?.strategies[0]?.id;
    if (!strategyId) throw new Error("No seeded strategy");
    const runId = randomUUID();
    await insertRun(
      store,
      {
        id: runId,
        profileSnapshot: await localProfile(store),
        evidence: buildEvidenceSnapshot(store, { buildId, issueKeys: [] }),
        sessionId: "proposal-regression",
        createdAt: new Date().toISOString(),
      },
      "proposal_ready",
    );
    for (const text of ["First note", "Second note", "Rejected note"]) {
      await appendRunProposal(store, runId, {
        id: randomUUID(),
        proposal: {
          kind: "notes",
          strategyIds: [strategyId],
          sources: [],
          payload: { strategyId, text },
        },
        submittedAt: new Date().toISOString(),
        accepted: false,
      });
    }
    // An unrelated decision makes the run's immutable evidence watermark stale.
    await appendDecision(
      store,
      {
        kind: "notes",
        strategyIds: [strategyId],
        sources: [],
        payload: { strategyId, text: "Unrelated edit" },
        clientRequestId: randomUUID(),
        author: "user",
        supersedesId: null,
      },
      0,
    );
    await registerAnalysisRoutes(app, store);
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    // Exercise the built UI against real analysis routes and a throwaway database.
    await page.route("**/api/analysis**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await fetch(origin + url.pathname + url.search, {
        method: request.method(),
        ...(request.postData()
          ? {
              body: request.postData(),
              headers: { "content-type": "application/json" },
            }
          : {}),
      });
      await route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: await response.text(),
      });
    });
    await page.goto("/review");
    await page.getByTestId("past-analyses").getByRole("button").click();
    const proposals = page.getByTestId("proposal-list");
    await proposals
      .getByRole("button", { name: "Accept", exact: true })
      .first()
      .click();
    await expect(
      proposals.getByText("(accepted)", { exact: true }),
    ).toHaveCount(1);
    await page.reload();
    await page.getByTestId("past-analyses").getByRole("button").click();
    await proposals
      .getByRole("button", { name: "Accept", exact: true })
      .first()
      .click();
    await expect(
      proposals.getByText("(accepted)", { exact: true }),
    ).toHaveCount(2);
    const rejection = page.waitForResponse((response) =>
      response.url().endsWith(`/api/analysis/${runId}/reject`),
    );
    await proposals.getByRole("button", { name: "Reject all pending" }).click();
    const response = await rejection;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      decision: { kind: "rejection", sequence: 4 },
    });
    expect(decisionWatermark(store)).toBe(4);
    expect(readRun(store, runId)?.evidence.watermark).toBe(0);
    expect(readRun(store, runId)?.acceptedDecisionIds).toHaveLength(3);
  } finally {
    // Stop new proxy requests and finish active handlers before closing their origin.
    await page.unrouteAll({ behavior: "wait" });
    await app.close();
    await fixture.dispose();
  }
});
