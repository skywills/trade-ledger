import { describe, expect, it } from "vitest";
import { compareLifecycleTime } from "../../src/server/lifecycles/chronology.js";
import { latestExecutionBound } from "../../src/server/lifecycles/valuation.js";
import type { Execution } from "../../src/shared/domain.js";
import { execution, stock } from "../fixtures/lifecycles.js";

function timed(
  raw: string,
  zone: string | null = null,
  report = "report",
): Execution {
  return {
    ...execution("row", stock, "1", "-100", 2, "open"),
    date: raw.slice(0, 10),
    rawDateTime: raw,
    timezone: zone,
    sources: [{ importId: report, rowNumber: 1 }],
  };
}

describe("execution chronology", () => {
  it.each([
    ["2026-10-02T12:00:00+08:00", null, "2026-10-02T05:00:00Z", null, -1],
    ["2026-10-02 12:00:00+0800", null, "2026-10-02T04:00:00Z", null, 0],
    ["2026-10-02T12:00:00", "Etc/UTC", "2026-10-02T12:00:00Z", null, 0],
    ["2026-10-02T12:00:00.000000001Z", null, "2026-10-02T12:00:00Z", null, 1],
    ["2026-10-02T12:00:00.1", null, "2026-10-02T12:00:00.100", null, 0],
    ["2026-10-02 12:00:00", null, "2026-10-02T11:00:00", null, 1],
  ] as const)(
    "compares normalized time evidence: %s and %s",
    (a, az, b, bz, want) => {
      expect(compareLifecycleTime(timed(a, az), timed(b, bz))).toBe(want);
    },
  );

  it.each([
    "2026-02-30T12:00:00Z",
    "2026-10-02T25:00:00",
    "2026-10-02T12:00:00+25:00",
    "2026-10-02Tgarbage",
  ])("does not order malformed timestamp %s", (raw) => {
    expect(
      compareLifecycleTime(
        timed(raw, "UTC"),
        timed("2026-10-02T13:00:00", "UTC"),
      ),
    ).toBeNull();
    expect(latestExecutionBound(timed(raw, "UTC"))).toBeNaN();
  });

  it("does not compare unzoned wall time from unrelated reports", () => {
    expect(
      compareLifecycleTime(
        timed("2026-10-02T10:00:00", null, "a"),
        timed("2026-10-02T11:00:00", null, "b"),
      ),
    ).toBeNull();
  });

  it("compares a retained known zone without inferring its UTC offset", () => {
    const a = timed("2026-10-02T10:00:00", "America/New_York", "a");
    const b = timed("2026-10-02T11:00:00", "America/New_York", "b");
    expect(compareLifecycleTime(a, b)).toBe(-1);
    expect(compareLifecycleTime(a, timed("2026-10-02T14:00:00Z"))).toBeNull();
  });

  it("does not equate an explicit offset with the same wall clock in an unknown-offset zone", () => {
    expect(
      compareLifecycleTime(
        timed("2026-10-02T12:00:00+08:00", "America/New_York"),
        timed("2026-10-02T12:00:00", "America/New_York"),
      ),
    ).toBeNull();
  });

  it.each([
    ["2026-10-01", "UTC", "2026-10-02T12:00:00Z", "UTC", -1],
    ["2026-10-02", "Etc/UTC", "2026-10-01T23:59:59.999999999Z", null, 1],
    ["2026-10-01", "GMT", "2026-10-01T23:30:00-02:00", null, -1],
    ["2026-10-02", "UTC", "2026-10-03T01:00:00+02:00", null, null],
    ["2026-10-01", null, "2026-10-02T12:00:00Z", "UTC", null],
  ] as const)(
    "compares a UTC calendar day with an exact instant: %s and %s",
    (day, zone, instant, instantZone, want) => {
      const a = timed(day, zone);
      const b = timed(instant, instantZone);
      expect(compareLifecycleTime(a, b)).toBe(want);
      expect(compareLifecycleTime(b, a)).toBe(want === null ? null : -want);
    },
  );

  it("keeps date-only evidence uncertain within its day", () => {
    expect(
      compareLifecycleTime(
        timed("2026-10-02", "UTC"),
        timed("2026-10-02T12:00:00Z", "UTC"),
      ),
    ).toBeNull();
  });

  it("proves distant order using conservative bounds across unrelated zones", () => {
    expect(
      compareLifecycleTime(
        timed("2026-10-01", null, "a"),
        timed("2026-10-04", null, "b"),
      ),
    ).toBe(-1);
    expect(
      compareLifecycleTime(
        timed("2026-10-01T23:30:00", null, "a"),
        timed("2026-10-02T00:30:00", null, "b"),
      ),
    ).toBeNull();
  });

  it.each([
    ["2026-10-02T12:00:00+08:00", null, "2026-10-02T04:00:00.000Z"],
    ["2026-10-02T12:00:00", "GMT", "2026-10-02T12:00:00.000Z"],
    ["2026-10-02T12:00:00", null, "2026-10-03T02:00:00.000Z"],
    ["2026-10-02", "UTC", "2026-10-02T23:59:59.999Z"],
    ["2026-10-02", null, "2026-10-03T13:59:59.999Z"],
    ["2026-10-02T12:00:00.000000001Z", null, "2026-10-02T12:00:00.001Z"],
  ] as const)(
    "uses a conservative latest instant for %s (%s)",
    (raw, zone, want) => {
      expect(
        new Date(latestExecutionBound(timed(raw, zone))).toISOString(),
      ).toBe(want);
    },
  );

  it.each(["2026-10-03T12:00:00", "2026-10-04T12:00:00"])(
    "retains conservative uncertainty across different clock frames through two calendar days: %s",
    (later) => {
      const unzoned = timed("2026-10-02T12:00:00", null, "unzoned");
      const utc = timed(later, "UTC", "known");
      expect(compareLifecycleTime(unzoned, utc)).toBeNull();
      expect(compareLifecycleTime(utc, unzoned)).toBeNull();
    },
  );

  it("observes timestamp and provenance changes on existing execution objects", () => {
    const a = timed("2026-10-02T10:00:00");
    const b = timed("2026-10-02T11:00:00");
    expect(compareLifecycleTime(a, b)).toBe(-1);
    a.rawDateTime = "2026-10-02T12:00:00";
    expect(compareLifecycleTime(a, b)).toBe(1);
    const source = a.sources[0];
    if (!source) throw Error("Missing source fixture");
    source.importId = "other";
    expect(compareLifecycleTime(a, b)).toBeNull();
    a.timezone = "UTC";
    expect(new Date(latestExecutionBound(a)).toISOString()).toBe(
      "2026-10-02T12:00:00.000Z",
    );
  });
});
