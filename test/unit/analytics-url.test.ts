import { describe, expect, it } from "vitest";
import {
  changeDashboard,
  dashboardHref,
  readDashboardQuery,
} from "../../src/web/dashboard/query.js";

describe("dashboard URL state", () => {
  it("uses calendar boundaries and leap-year month presets", () => {
    expect(
      readDashboardQuery("?preset=last-month", "overview", "2024-03-01").query,
    ).toMatchObject({ from: "2024-02-01", to: "2024-02-29" });
    expect(
      readDashboardQuery("?preset=last-month", "overview", "2026-01-10").query,
    ).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("defaults reports to current month but preserves explicit all time", () => {
    expect(readDashboardQuery("", "reports", "2026-10-16").query).toMatchObject(
      { from: "2026-10-01", to: "2026-10-31" },
    );
    expect(
      readDashboardQuery("?preset=all", "reports", "2026-10-16").query.from,
    ).toBeUndefined();
  });
  it("preserves filters in view links and clears incompatible drill-down on changes", () => {
    const s = readDashboardQuery(
      "?preset=custom&from=2026-09-01&to=2026-09-30&currency=USD&basis=reconstructed&symbol=A&kind=strategies&page=2&outcome=win",
      "overview",
      "2026-10-16",
    );
    expect(dashboardHref("analysis", s)).toContain("basis=reconstructed");
    expect(dashboardHref("reports", s)).toContain("from=2026-09-01");
    const next = changeDashboard(s, { currency: "EUR" });
    expect(next.detail).toEqual({});
    expect(next.query.currency).toBe("EUR");
  });
  it("keeps invalid entered bounds and produces a validation error", () => {
    const s = readDashboardQuery(
      "?preset=custom&from=2026-10-20&to=2026-10-01",
      "overview",
      "2026-10-16",
    );
    expect(s.error).toBeTruthy();
    expect(s.query.from).toBe("2026-10-20");
  });
});

it("clears detail-only scopes when leaving Analysis while retaining membership filters", () => {
  const state = readDashboardQuery(
    "?currency=USD&symbol=A&kind=strategies&outcome=win&expectedBuildId=old",
    "analysis",
    "2026-10-16",
  );
  for (const view of ["overview", "reports"] as const) {
    const href = dashboardHref(view, state);
    expect(href).toContain("symbol=A");
    expect(href).not.toContain("outcome=");
    expect(href).not.toContain("kind=");
    expect(
      readDashboardQuery(
        "?currency=USD&kind=strategies&outcome=win",
        view,
        "2026-10-16",
      ).detail,
    ).toEqual({});
  }
});

it.each(["BRK B", "BRK.B", "BRK-B"])(
  "normalizes saved %s filters and drill-down groups for canonical dashboard controls",
  (alias) => {
    const params = new URLSearchParams({
      symbol: alias,
      underlying: `value:${alias}`,
      kind: "transactions",
      groupBy: "underlying",
      group: `value:${alias}`,
    });
    const state = readDashboardQuery(`?${params}`, "analysis", "2026-10-16");
    expect(state.query).toMatchObject({
      symbol: "BRK.B",
      underlying: "value:BRK.B",
    });
    expect(state.detail.group).toBe("value:BRK.B");
    const nextUrl = new URL(
      dashboardHref("analysis", state),
      "http://localhost",
    );
    expect(nextUrl.searchParams.get("symbol")).toBe("BRK.B");
    expect(nextUrl.searchParams.get("underlying")).toBe("value:BRK.B");
    expect(nextUrl.searchParams.get("group")).toBe("value:BRK.B");
  },
);
