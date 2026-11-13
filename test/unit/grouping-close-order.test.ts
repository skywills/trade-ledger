import { describe, expect, it } from "vitest";
import {
  orderByKnownChronology,
  orderByPairwiseScan,
} from "../../src/server/strategies/grouping-close-order.js";
import type { Execution } from "../../src/shared/domain.js";
import { call, execution } from "../fixtures/lifecycles.js";

/** Small deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) >>> 0;
    return s / 2 ** 32;
  };
}

const ZONES = [null, "UTC", "America/New_York", "Asia/Singapore"];

function randomExecution(i: number, next: () => number): Execution {
  const day = 1 + Math.floor(next() * 6);
  const hour = String(9 + Math.floor(next() * 3)).padStart(2, "0");
  const date = `2026-10-${String(day).padStart(2, "0")}`;
  const shape = Math.floor(next() * 5);
  const rawDateTime =
    shape === 0
      ? date
      : shape === 1
        ? `${date}T${hour}:00:00-04:00`
        : shape === 2
          ? "not a time"
          : `${date}T${hour}:00:00`;
  const base = execution(
    `k${Math.floor(next() * 1000)}-${i}`,
    call,
    "1",
    "0",
    day,
    "close",
  );
  return {
    ...base,
    rawDateTime,
    timezone: ZONES[Math.floor(next() * ZONES.length)] ?? null,
    sources: [{ importId: `imp${Math.floor(next() * 2)}`, rowNumber: i + 1 }],
  };
}

describe("orderByKnownChronology", () => {
  it("orders by time, breaking exact ties by key", () => {
    const a = execution("b", call, "1", "0", 2, "close");
    const b = execution("a", call, "1", "0", 2, "close");
    const c = execution("c", call, "1", "0", 1, "close");
    expect(orderByKnownChronology([a, b, c]).map((e) => e.key)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("matches the pairwise scan on mixed, partly uncomparable times", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = rng(seed);
      const rows = Array.from({ length: 1 + Math.floor(next() * 40) }, (_, i) =>
        randomExecution(i, next),
      );
      expect(
        orderByKnownChronology(rows).map((e) => e.key),
        `seed ${seed}`,
      ).toEqual(orderByPairwiseScan(rows).map((e) => e.key));
    }
  });
});
