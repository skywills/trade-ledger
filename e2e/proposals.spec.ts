import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { expect, test } from "./fixtures.js";
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
import { listImports } from "../src/server/imports/service.js";
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
    const importId = listImports(store)[0]?.id;
    if (!importId) throw new Error("No seeded import");
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
    for (const kind of ["import_exclusion", "import_inclusion"] as const) {
      await appendRunProposal(store, runId, {
        id: randomUUID(),
        proposal: { kind, payload: { importId }, strategyIds: [], sources: [] },
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
    const changes = proposals.getByRole("list", { name: "Proposed changes" });
    const exclusion = changes.filter({ hasText: `Exclude import ${importId}` });
    await expect(exclusion).toHaveText(`Exclude import ${importId} from the next rebuild.`);
    // The card exposes the retained import before its individual Accept action.
    await exclusion.locator("../..").getByRole("button", { name: "Accept", exact: true }).click();
    await expect(proposals.getByText("(accepted)", { exact: true })).toHaveCount(3);
    expect(decisionWatermark(store)).toBe(4);
    const rejection = page.waitForResponse((response) =>
      response.url().endsWith(`/api/analysis/${runId}/reject`),
    );
    await proposals.getByRole("button", { name: "Reject all pending" }).click();
    const response = await rejection;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      decision: { kind: "rejection", sequence: 5 },
    });
    expect(decisionWatermark(store)).toBe(5);
    expect(store.db.prepare("SELECT kind FROM decisions ORDER BY sequence").all()).toEqual([
      { kind: "notes" }, { kind: "notes" }, { kind: "notes" },
      { kind: "import_exclusion" }, { kind: "rejection" },
    ]);
    expect(readRun(store, runId)?.evidence.watermark).toBe(0);
    expect(readRun(store, runId)?.acceptedDecisionIds).toHaveLength(4);
  } finally {
    // Stop new proxy requests and finish active handlers before closing their origin.
    await page.unrouteAll({ behavior: "wait" });
    await app.close();
    await fixture.dispose();
  }
});
