import { randomUUID } from "node:crypto";
import { createThread } from "../src/server/chat/threads.js";
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
import { listImports } from "../src/server/imports/service.js";
import { localProfile, seedLedger } from "../test/helpers/chat.js";
import { openStore, closeStore } from "../src/server/storage/database.js";

test("proposal actions work after the evidence watermark has advanced", async ({
  page,
  serverScope,
}, testInfo) => {
  const server = await serverScope.forFile(testInfo.file);
  const store = openStore(server.dataDir);
  try {
    const { buildId } = await seedLedger(store);
    const strategyId = activeProjection(store).projection?.strategies[0]?.id;
    if (!strategyId) throw new Error("No seeded strategy");
    const runId = randomUUID();
    const profile = await localProfile(store);
    const thread = await createThread(store, {
      title: "Proposal regression",
      sessionId: "proposal-regression",
      profileId: profile.id,
      modelRef: profile.modelId,
      cloudConfirmed: false,
      seed: null,
      now: new Date(),
    });

    await insertRun(
      store,
      {
        id: runId,
        profileSnapshot: profile,
        threadId: thread.id,
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
    await expect(exclusion).toHaveText(
      `Exclude import ${importId} from the next rebuild.`,
    );
    // The card exposes the retained import before its individual Accept action.
    await exclusion
      .locator("../..")
      .getByRole("button", { name: "Accept", exact: true })
      .click();
    await expect(
      proposals.getByText("(accepted)", { exact: true }),
    ).toHaveCount(3);
    await expect(page.getByTestId("revision-history")).toContainText(
      "First note",
    );
    expect(decisionWatermark(store)).toBe(4);
    const rejection = page.waitForResponse((response) =>
      response.url().endsWith(`/api/analysis/${runId}/reject`),
    );
    await proposals.getByRole("button", { name: "Reject all pending" }).click();
    await proposals
      .getByRole("button", { name: "Reject 2 proposals" })
      .click({ timeout: 3000 });
    const response = await rejection;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      decision: { kind: "rejection", sequence: 5 },
    });
    expect(decisionWatermark(store)).toBe(5);
    expect(
      store.db.prepare("SELECT kind FROM decisions ORDER BY sequence").all(),
    ).toEqual([
      { kind: "notes" },
      { kind: "notes" },
      { kind: "notes" },
      { kind: "import_exclusion" },
      { kind: "rejection" },
    ]);
    await page.reload();
    await expect(page.getByTestId("revision-history")).toContainText(
      "Rejected evidence",
    );
    await page
      .getByTestId("past-analyses")
      .getByRole("button", { name: /0 pending/ })
      .click();
    await expect(
      proposals.getByText("(rejected)", { exact: true }),
    ).toHaveCount(2);
    await expect(
      proposals.getByRole("button", { name: "Accept", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "conversation", exact: true }).click();
    await expect(
      proposals.getByText("(accepted)", { exact: true }),
    ).toHaveCount(3);
    await expect(
      proposals.getByText("(rejected)", { exact: true }),
    ).toHaveCount(2);
    await page.reload();
    await expect(
      proposals.getByRole("button", { name: "Reject all pending" }),
    ).toHaveCount(0);
    await expect(
      proposals.getByText("(rejected)", { exact: true }),
    ).toHaveCount(2);
    expect(readRun(store, runId)?.evidence.watermark).toBe(0);
    expect(readRun(store, runId)?.acceptedDecisionIds).toHaveLength(4);
    const firstId = readRun(store, runId)?.acceptedDecisionIds[0];
    if (!firstId) throw new Error("Expected the retained first decision");
    await page.goto("/review?decisionId=" + encodeURIComponent(firstId));
    await expect(
      page.getByRole("heading", { name: "Retained decision", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toContainText("First note");
    await expect(page.getByRole("main")).not.toContainText("Second note");
  } finally {
    await closeStore(store);
  }
});
