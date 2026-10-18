import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { analyticsApp } from "../helpers/analytics-app.js";

describe("analytics export HTTP", () => {
  it("exports full matching rows instead of the visible page and checks expected build", async () => {
    const t = await analyticsApp();
    try {
      const page = await t.app.inject(
        "/api/analytics/details?unit=strategy&kind=strategies&currency=USD&page=2",
      );
      expect(page.json().items).toHaveLength(25);
      const r = await t.app.inject(
        "/api/analytics/export?unit=strategy&dataset=strategies&currency=USD",
      );
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toContain("text/csv");
      expect(r.headers["content-disposition"]).toContain(
        "trade-ledger-strategies-USD",
      );
      expect(parse(r.body, { columns: true })).toHaveLength(679);
      expect(
        (
          await t.app.inject(
            "/api/analytics/export?unit=strategy&dataset=summary&expectedBuildId=old",
          )
        ).statusCode,
      ).toBe(409);
      const opens = await t.app.inject(
        "/api/analytics/export?unit=strategy&dataset=strategies&scope=current-open&currency=USD&to=2000-01-01",
      );
      expect(parse(opens.body, { columns: true })).toHaveLength(19);
    } finally {
      await t.close();
    }
  });
});
