import type { Execution } from "./domain.js";
import { normalizeTimestamp } from "./timestamps.js";

const MAX_ZONE_SECONDS = 14 * 60 * 60;
const UTC_ZONES = new Set(["UTC", "Etc/UTC", "GMT"]);

interface Point {
  second: number;
  nano: number;
}
interface TimeEvidence {
  wall: Point;
  date: string;
  day: number;
  dateOnly: boolean;
  explicitOffset: boolean;
  instant: Point | null;
  latest: Point;
}

// Parsing is shared by the quadratic grouping comparisons. Executions can be
// edited, so reuse evidence only while its input values remain unchanged.
const evidenceCache = new WeakMap<
  Execution,
  { raw: string; zone: string | null; value: TimeEvidence | null }
>();

function parseEvidence(execution: Execution): TimeEvidence | null {
  const raw = execution.rawDateTime.trim();
  const suffix = /(?:Z|([+-])(\d{2}):?(\d{2}))$/.exec(raw);
  const explicitOffset = suffix !== null;
  const parsed = normalizeTimestamp(
    explicitOffset ? raw.slice(0, suffix.index) : raw,
  );
  if (parsed.status !== "ok") return null;
  const dateOnly = !parsed.timestamp.includes("T");
  if (dateOnly && explicitOffset) return null;
  let offset = 0;
  if (suffix?.[1]) {
    const hours = Number(suffix[2]);
    const minutes = Number(suffix[3]);
    if (hours > 23 || minutes > 59) return null;
    offset = (hours * 60 + minutes) * 60 * (suffix[1] === "+" ? 1 : -1);
  }
  const [whole = "", fraction = ""] = parsed.timestamp.split(".");
  // normalizeTimestamp validates calendar days and clock fields first; Date
  // parsing here cannot normalize impossible dates or use the host timezone.
  const wall: Point = {
    second:
      Date.parse(`${dateOnly ? `${parsed.date}T00:00:00` : whole}Z`) / 1000,
    nano: Number(fraction.padEnd(9, "0")),
  };
  if (!Number.isFinite(wall.second)) return null;
  const utc = UTC_ZONES.has(execution.timezone ?? "");
  const instant =
    !dateOnly && (explicitOffset || utc)
      ? { second: wall.second - offset, nano: wall.nano }
      : null;
  const uncertainty = utc ? 0 : MAX_ZONE_SECONDS;
  return {
    wall,
    date: parsed.date,
    day: Date.parse(`${parsed.date}T00:00:00Z`),
    dateOnly,
    explicitOffset,
    instant,
    latest: instant ?? {
      second: wall.second + uncertainty + (dateOnly ? 86399 : 0),
      nano: dateOnly ? 999999999 : wall.nano,
    },
  };
}

function evidence(execution: Execution): TimeEvidence | null {
  const cached = evidenceCache.get(execution);
  if (
    cached?.raw === execution.rawDateTime &&
    cached.zone === execution.timezone
  )
    return cached.value;
  const value = parseEvidence(execution);
  evidenceCache.set(execution, {
    raw: execution.rawDateTime,
    zone: execution.timezone,
    value,
  });
  return value;
}

function comparePoints(a: Point, b: Point): number {
  return Math.sign(a.second - b.second) || Math.sign(a.nano - b.nano);
}

function compareUtcDayToInstant(
  day: TimeEvidence,
  instant: Point,
): number | null {
  if (comparePoints(day.latest, instant) < 0) return -1;
  if (comparePoints(day.wall, instant) > 0) return 1;
  return null;
}

/** Only compare times when retained provenance establishes their order. */
export function compareExecutionTime(
  a: Execution,
  b: Execution,
): number | null {
  const x = evidence(a);
  const y = evidence(b);
  if (x === null || y === null) return null;
  if (x.instant !== null && y.instant !== null)
    return comparePoints(x.instant, y.instant);

  // A UTC calendar day is an interval in the same absolute clock as an
  // explicit instant. Compare its bounds, preserving uncertainty within the
  // day even when the instant's written offset places it on another date.
  if (x.dateOnly && UTC_ZONES.has(a.timezone ?? "") && y.instant !== null)
    return compareUtcDayToInstant(x, y.instant);
  if (y.dateOnly && UTC_ZONES.has(b.timezone ?? "") && x.instant !== null) {
    const order = compareUtcDayToInstant(y, x.instant);
    return order === null ? null : -order;
  }

  // Named zones retain wall-clock comparability without guessing an IANA
  // offset. An explicit offset belongs to its own clock frame, however.
  const sameClock =
    !x.explicitOffset &&
    !y.explicitOffset &&
    ((a.timezone !== null && a.timezone === b.timezone) ||
      (a.timezone === null &&
        b.timezone === null &&
        a.sources.some((s) =>
          b.sources.some((t) => t.importId === s.importId),
        )));
  if (sameClock) {
    if (x.date === y.date && (x.dateOnly || y.dateOnly)) return null;
    return comparePoints(x.wall, y.wall);
  }
  // Preserve the established uncertainty envelope for different clock frames:
  // only a gap of more than two calendar days establishes their order. Exact
  // UTC/offset instants were handled above; valuation uses the latest bound.
  return Math.abs(x.day - y.day) > 2 * 86400000
    ? Math.sign(x.day - y.day)
    : null;
}

/** Latest possible instant, without interpreting a wall time in the host zone. */
export function latestExecutionBound(execution: Execution): number {
  const value = evidence(execution);
  if (value === null) return Number.NaN;
  // Date-only values use the final millisecond of the day. For timed values,
  // round sub-millisecond evidence upward so a snapshot cannot predate a fill.
  const milliseconds = value.dateOnly
    ? 999
    : Math.ceil(value.latest.nano / 1000000);
  return value.latest.second * 1000 + milliseconds;
}
