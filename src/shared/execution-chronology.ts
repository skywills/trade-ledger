import type { Execution } from "./domain.js";
import { normalizeTimestamp } from "./timestamps.js";

const MAX_ZONE_SECONDS = 14 * 60 * 60;
const UTC_ZONES = new Set(["UTC", "Etc/UTC", "GMT"]);

type TimeSource = Pick<Execution, "rawDateTime" | "timezone" | "sources">;

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
  TimeSource,
  { raw: string; zone: string | null; value: TimeEvidence | null }
>();

function parseEvidence(execution: TimeSource): TimeEvidence | null {
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

function evidence(execution: TimeSource): TimeEvidence | null {
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
  a: TimeSource,
  b: TimeSource,
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
    !x.explicitOffset && !y.explicitOffset && sameReportClock(a, b);
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

function sameReportClock(a: TimeSource, b: TimeSource): boolean {
  if (a.timezone !== null || b.timezone !== null)
    return a.timezone === b.timezone;
  return a.sources.some((s) =>
    b.sources.some((t) => t.importId === s.importId),
  );
}

const zonedSeconds = new WeakMap<TimeEvidence, number[]>();

/** Round-trip the offsets on either side of a possible clock change. A gap
 * has no matching instant and a fold can have two. Keep both for lot matching. */
function possibleSeconds(value: TimeEvidence, zone: string | null): number[] {
  if (value.instant) return [value.instant.second];
  if (!zone) return [];
  const cached = zonedSeconds.get(value);
  if (cached) return cached;
  const wall = value.wall.second;
  const expected = new Date(wall * 1000).toISOString().slice(0, 19);
  const candidates = new Set<number>();
  for (const probe of [wall - 86400, wall + 86400]) {
    const local = wallClockIn(probe, zone);
    if (!local) continue;
    const offset = Date.parse(`${local}Z`) / 1000 - probe;
    const candidate = wall - offset;
    if (wallClockIn(candidate, zone) === expected) candidates.add(candidate);
  }
  const result = [...candidates];
  zonedSeconds.set(value, result);
  return result;
}

/** Compare a fill at the precision and in the clock of the broker's reference. */
export function matchesOpeningTime(
  opening: Execution,
  reference: TimeSource,
): boolean {
  const a = evidence(opening);
  const b = evidence(reference);
  if (!a || !b) return false;
  if (!b.dateOnly && (a.dateOnly || a.wall.nano !== b.wall.nano)) return false;
  if (a.instant && b.instant) return comparePoints(a.instant, b.instant) === 0;
  if (
    !a.explicitOffset &&
    !b.explicitOffset &&
    sameReportClock(opening, reference)
  ) {
    return b.dateOnly ? a.date === b.date : a.wall.second === b.wall.second;
  }
  if (a.dateOnly) {
    if (a.date !== b.date || !opening.timezone || !reference.timezone)
      return false;
    const zone = formatterFor(opening.timezone)?.resolvedOptions().timeZone;
    return (
      zone !== undefined &&
      zone === formatterFor(reference.timezone)?.resolvedOptions().timeZone
    );
  }
  if (b.instant && opening.timezone) {
    return (
      wallClockIn(b.instant.second, opening.timezone) ===
      new Date(a.wall.second * 1000).toISOString().slice(0, 19)
    );
  }
  const reportZone = reference.timezone;
  if (!reportZone) return false;
  const expected = new Date(b.wall.second * 1000).toISOString().slice(0, 19);
  return possibleSeconds(a, opening.timezone).some((second) => {
    const local = wallClockIn(second, reportZone);
    return b.dateOnly ? local?.slice(0, 10) === b.date : local === expected;
  });
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(zone: string): Intl.DateTimeFormat | undefined {
  const existing = zoneFormatters.get(zone);
  if (existing) return existing;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    zoneFormatters.set(zone, formatter);
    return formatter;
  } catch {
    return undefined;
  }
}

function wallClockIn(second: number, zone: string): string | undefined {
  const formatter = formatterFor(zone);
  if (!formatter) return undefined;
  const fields = Object.fromEntries(
    formatter.formatToParts(second * 1000).map((p) => [p.type, p.value]),
  );
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}`;
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
