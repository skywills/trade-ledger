import { Decimal } from "decimal.js";
export interface ChartPoint {
  key: string;
  label: string;
  value: string | null;
}
export interface ChartModel {
  points: {
    index: number;
    x: number;
    y: number | null;
    breakBefore: boolean;
  }[];
  zeroY: number;
  min: string;
  max: string;
}
export function buildChartModel(
  points: readonly ChartPoint[],
  maxPoints = 1000,
): ChartModel {
  const D = Decimal.clone({ precision: 80 });
  const values = points.flatMap((p) =>
    p.value === null ? [] : [new D(p.value)],
  );
  const min = D.min(0, ...values),
    max = D.max(0, ...values);
  const range = max.minus(min).isZero() ? new D(1) : max.minus(min);
  const y = (value: Decimal) =>
    200 - value.minus(min).div(range).times(180).toNumber();
  const indices = new Set<number>();
  const step = Math.max(
    1,
    Math.ceil(points.length / Math.max(1, Math.floor(maxPoints / 5))),
  );
  for (let i = 0; i < points.length; i += step) {
    const end = Math.min(i + step, points.length);
    indices.add(i);
    indices.add(end - 1);
    let low = i,
      high = i;
    let gap = false;
    for (let j = i; j < end; j++) {
      const point = points[j];
      if (!point) continue;
      if (point.value === null) {
        if (!gap) {
          indices.add(j);
          gap = true;
        }
        continue;
      }
      const lowValue = points[low]?.value,
        highValue = points[high]?.value;
      if (
        lowValue === null ||
        lowValue === undefined ||
        new D(point.value).lt(lowValue)
      )
        low = j;
      if (
        highValue === null ||
        highValue === undefined ||
        new D(point.value).gt(highValue)
      )
        high = j;
    }
    indices.add(low);
    indices.add(high);
  }
  const selectedIndices = [...indices].sort((a, b) => a - b);
  const missingPrefix = [0];
  for (const point of points)
    missingPrefix.push(
      (missingPrefix.at(-1) ?? 0) + (point.value === null ? 1 : 0),
    );
  return {
    points: selectedIndices.map((index, selectedIndex) => ({
      breakBefore:
        (missingPrefix[index] ?? 0) >
        (missingPrefix[(selectedIndices[selectedIndex - 1] ?? -1) + 1] ?? 0),
      index,
      x: 40 + (points.length <= 1 ? 280 : (index / (points.length - 1)) * 560),
      y: points[index]?.value == null ? null : y(new D(points[index].value)),
    })),
    zeroY: y(new D(0)),
    min: min.toFixed(),
    max: max.toFixed(),
  };
}
