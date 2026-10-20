import Fastify from "fastify";
import { expect, it } from "vitest";
import { ALGORITHM_VERSION, rebuild } from "../../src/server/builds/service.js";
import { registerLifecycleRoutes } from "../../src/server/http/routes-lifecycles.js";
import { registerReviewRoutes } from "../../src/server/http/routes-review.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import type { AppError } from "../../src/shared/errors.js";
import {
  buildExecutionTable,
  executionRow,
  fixtures,
} from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

it.each(["lifecycle_attachment", "lifecycle_attachment_rejection"])(
  "exposes pending call confirmations in Review and clears them after %s",
  async (kind) => {
    const t = await createTestStore();
    const app = Fastify();
    try {
      await registerLifecycleRoutes(app, t.store);
      await registerReviewRoutes(app, t.store);
      const preview = await previewImport(t.store, {
        filename: "covered-call.csv",
        timezone: "UTC",
        bytes: buildExecutionTable([
          executionRow({
            ClientAccountID: "A",
            AssetClass: "STK",
            Symbol: "XYZ",
            Conid: "1",
            CurrencyPrimary: "USD",
            TradeDate: "2026-10-01",
            DateTime: "2026-10-01 12:00:00",
            Quantity: "100",
            TradePrice: "100",
            NetCash: "-10000",
            Multiplier: "1",
            "Notes/Codes": "O",
            IBExecID: "stock-open",
            IBOrderID: "stock-order",
          }),
          executionRow({
            ClientAccountID: "A",
            AssetClass: "OPT",
            Symbol: "XYZ CALL",
            UnderlyingSymbol: "XYZ",
            Conid: "2",
            CurrencyPrimary: "USD",
            TradeDate: "2026-10-03",
            DateTime: "2026-10-03 12:00:00",
            Quantity: "-1",
            TradePrice: "1",
            NetCash: "100",
            Multiplier: "100",
            Expiry: "2026-11-20",
            Strike: "105",
            "Put/Call": "C",
            "Notes/Codes": "O",
            IBExecID: "call-open",
            IBOrderID: "call-order",
          }),
        ]),
      });
      const { importId } = await commitImport(t.store, preview.id);
      const build = () =>
        rebuild(t.store, {
          mode: "full",
          parserVersion: "flex-v1",
          algorithmVersion: ALGORITHM_VERSION,
          signal: new AbortController().signal,
        });
      await build();
      const list = (await app.inject("/api/lifecycles")).json();
      expect(
        list.lifecycles.lifecycles.map((l: { status: string }) => l.status),
      ).toEqual(["unresolved", "unresolved"]);
      const review = await app.inject("/api/review");
      expect(review.statusCode).toBe(200);
      expect(review.json().items).toEqual([
        expect.objectContaining({
          code: "PENDING_CALL_ATTACHMENT",
          severity: "warning",
          sources: [{ importId, rowNumber: 3 }],
        }),
      ]);
      const suggestion = list.lifecycles.suggestions[0];
      const decision = await app.inject({
        method: "POST",
        url: "/api/decisions",
        payload: {
          kind,
          clientRequestId: kind,
          author: "user",
          expectedWatermark: list.watermark,
          payload:
            kind === "lifecycle_attachment"
              ? {
                  opening: suggestion.callOpening,
                  targets: [
                    {
                      lifecycleId: suggestion.candidateLifecycleIds[0],
                      quantity: "-1",
                    },
                  ],
                }
              : {
                  callOpening: suggestion.callOpening,
                  candidateLifecycleIds: suggestion.candidateLifecycleIds,
                  reason: "Independent call trade",
                },
        },
      });
      expect(decision.statusCode).toBe(201);
      await build();
      expect((await app.inject("/api/review")).json().items).toEqual([]);
      const resolved = (await app.inject("/api/lifecycles")).json();
      expect(resolved.lifecycles.suggestions).toEqual([]);
      expect(
        resolved.lifecycles.lifecycles.every(
          (l: { status: string }) => l.status === "open",
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await t.dispose();
    }
  },
);

it("exposes consistent lifecycle provenance and refuses stale build drilldowns", async () => {
  const t = await createTestStore();
  const app = Fastify();
  app.setErrorHandler((e, _r, reply) => {
    const error = e as AppError;
    reply
      .code(error.statusCode ?? 500)
      .send({ code: error.code, message: error.message });
  });
  try {
    await registerLifecycleRoutes(app, t.store);
    await registerReviewRoutes(app, t.store);
    const preview = await previewImport(t.store, {
      filename: "assignment.csv",
      bytes: fixtures.assignment,
      timezone: "UTC",
    });
    await commitImport(t.store, preview.id);
    await rebuild(t.store, {
      mode: "full",
      parserVersion: "flex-v1",
      algorithmVersion: ALGORITHM_VERSION,
      signal: new AbortController().signal,
    });
    const list = await app.inject("/api/lifecycles");
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.rebuildRequired).toBe(false);
    expect(body.lifecycles.lifecycles.length).toBeGreaterThan(0);
    const id = body.lifecycles.lifecycles[0].id;
    const detail = await app.inject(
      `/api/lifecycles/${id}?expectedBuildId=${body.buildId}`,
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.json().members.length).toBeGreaterThan(0);
    expect(detail.json().executions.length).toBeGreaterThan(0);
    expect(
      (await app.inject(`/api/lifecycles/${id}?expectedBuildId=old`))
        .statusCode,
    ).toBe(409);
    expect((await app.inject("/api/lifecycles/missing")).statusCode).toBe(404);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/decisions",
      payload: {
        kind: "wheel_campaign_membership",
        clientRequestId: "bad",
        author: "user",
        expectedWatermark: body.watermark,
        payload: { lifecycleId: id, campaignId: "missing" },
      },
    });
    expect(invalid.statusCode).toBe(409);
  } finally {
    await app.close();
    await t.dispose();
  }
});
