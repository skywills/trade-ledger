import { describe, expect, it } from "vitest";
import { buildChartModel } from "../../src/web/dashboard/chartModel.js";

describe("chart normalization", () => {
  it.each(
    [
      [],
      ["0"],
      ["0", "0"],
      [null, null],
      ["-5", "-1"],
      ["100000000000000000000000000000000000000", "-0.00000001"],
    ].map((values) => ({ values })),
  )("keeps coordinates finite for %j", ({ values }) => {
    const m = buildChartModel(
      values.map((value, i) => ({ key: String(i), label: String(i), value })),
    );
    expect(
      m.points.every(
        (p) => Number.isFinite(p.x) && (p.y === null || Number.isFinite(p.y)),
      ),
    ).toBe(true);
    expect(Number.isFinite(m.zeroY)).toBe(true);
  });
  it("bounds long series while retaining endpoints, extrema and gaps", () => {
    const source = Array.from({ length: 6000 }, (_, i) => ({
      key: String(i),
      label: String(i),
      value: i === 3000 ? "9999" : i === 2000 ? null : String(i % 10),
    }));
    const m = buildChartModel(source, 1000);
    expect(m.points.length).toBeLessThanOrEqual(1002);
    expect(m.points[0]?.index).toBe(0);
    expect(m.points.at(-1)?.index).toBe(5999);
    expect(m.points.some((p) => p.index === 3000)).toBe(true);
    expect(m.points.some((p) => p.y === null)).toBe(true);
    expect(source[3000]?.value).toBe("9999");
  });
});

it("retains a break for every omitted missing bucket between sampled extrema", () => {
  const source = Array.from({ length: 6000 }, (_, i) => ({
    key: String(i),
    label: String(i),
    value:
      i === 2 || i === 8 ? null : i === 5 ? "-100" : i === 10 ? "100" : "0",
  }));
  const model = buildChartModel(source, 1000);
  expect(model.points.find((p) => p.index === 5)).toBeDefined();
  expect(model.points.find((p) => p.index === 10)?.breakBefore).toBe(true);
  expect(model.points.length).toBeLessThanOrEqual(1002);
});
