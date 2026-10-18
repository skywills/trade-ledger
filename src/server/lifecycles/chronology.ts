import type { Execution } from "../../shared/domain.js";
/** Only compare times when retained provenance establishes their order. */
export function compareLifecycleTime(
  a: Execution,
  b: Execution,
): number | null {
  const instant = (e: Execution): number | null => {
    if (!e.rawDateTime.includes("T")) return null;
    const explicit = /(?:Z|[+-]\d{2}:?\d{2})$/.test(e.rawDateTime);
    const utc = ["UTC", "Etc/UTC", "GMT"].includes(e.timezone ?? "");
    if (!explicit && !utc) return null;
    const n = Date.parse(e.rawDateTime + (explicit ? "" : "Z"));
    return Number.isFinite(n) ? n : null;
  };
  const x = instant(a),
    y = instant(b);
  if (x !== null && y !== null) return Math.sign(x - y);
  const sharesReport = a.sources.some((s) =>
    b.sources.some((t) => t.importId === s.importId),
  );
  if (
    (a.timezone !== null && a.timezone === b.timezone) ||
    (a.timezone === null && b.timezone === null && sharesReport)
  ) {
    if (
      a.date === b.date &&
      (!a.rawDateTime.includes("T") || !b.rawDateTime.includes("T"))
    )
      return null;
    return Math.sign(a.rawDateTime.localeCompare(b.rawDateTime));
  }
  if (Math.abs(Date.parse(a.date) - Date.parse(b.date)) > 2 * 86400000)
    return Math.sign(a.date.localeCompare(b.date));
  return null;
}
