export type TimestampParse =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "ok"; date: string; timestamp: string };

const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|, ?)(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/;
const TWS_DATETIME = /^(\d{4})(\d{2})(\d{2});(\d{2})(\d{2})(\d{2})?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isoDate(
  year: string,
  month: string,
  day: string,
): { date: string } | null {
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const yearNumber = Number(year);
  if (monthNumber < 1 || monthNumber > 12) return null;
  let maxDay = DAYS_IN_MONTH[monthNumber - 1] ?? 31;
  if (monthNumber === 2 && isLeapYear(yearNumber)) maxDay = 29;
  if (dayNumber < 1 || dayNumber > maxDay) return null;
  return { date: `${year}-${pad2(monthNumber)}-${pad2(dayNumber)}` };
}

function isoTime(
  hour: string,
  minute: string,
  second: string | undefined,
  fraction: string | undefined,
): string | null {
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second ?? "0");
  if (hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) return null;
  return `${hour}:${minute}:${pad2(secondNumber)}${fraction ?? ""}`;
}

/**
 * Normalizes source timestamps to ISO calendar values. The wall-clock time is
 * never shifted: source times stay exactly as recorded, so an unknown source
 * timezone can never be silently replaced by the server timezone.
 */
export function normalizeTimestamp(raw: string | undefined): TimestampParse {
  const text = raw?.trim() ?? "";
  if (text === "") return { status: "absent" };

  const isoMatch = ISO_DATETIME.exec(text);
  if (isoMatch) {
    const date = isoDate(
      isoMatch[1] ?? "",
      isoMatch[2] ?? "",
      isoMatch[3] ?? "",
    );
    const time = isoTime(
      isoMatch[4] ?? "",
      isoMatch[5] ?? "",
      isoMatch[6],
      isoMatch[7],
    );
    if (date === null || time === null) return { status: "invalid" };
    return { status: "ok", date: date.date, timestamp: `${date.date}T${time}` };
  }

  const twsMatch = TWS_DATETIME.exec(text);
  if (twsMatch) {
    const date = isoDate(
      twsMatch[1] ?? "",
      twsMatch[2] ?? "",
      twsMatch[3] ?? "",
    );
    const time = isoTime(
      twsMatch[4] ?? "",
      twsMatch[5] ?? "",
      twsMatch[6],
      undefined,
    );
    if (date === null || time === null) return { status: "invalid" };
    return { status: "ok", date: date.date, timestamp: `${date.date}T${time}` };
  }

  const dateMatch = ISO_DATE.exec(text) ?? COMPACT_DATE.exec(text);
  if (dateMatch) {
    const date = isoDate(
      dateMatch[1] ?? "",
      dateMatch[2] ?? "",
      dateMatch[3] ?? "",
    );
    if (date === null) return { status: "invalid" };
    return { status: "ok", date: date.date, timestamp: date.date };
  }

  return { status: "invalid" };
}

export function normalizeDate(raw: string | undefined): string | null {
  const parsed = normalizeTimestamp(raw);
  return parsed.status === "ok" ? parsed.date : null;
}
