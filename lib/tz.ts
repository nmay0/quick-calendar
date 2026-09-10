/**
 * Minimal timezone math built on Intl, so the app carries no tz-data dependency
 * of its own. Everything here works in wall-clock terms: the user enters local
 * times, and we only convert to UTC where RFC 5545 demands it (RRULE UNTIL).
 */

const PARTS_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = PARTS_FMT_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    PARTS_FMT_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

/** Offset of `timeZone` from UTC, in minutes, at the given instant. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  // Sub-second precision is irrelevant here; round to whole minutes.
  return Math.round((asIfUtc - instant.getTime()) / 60000);
}

/**
 * Convert a wall-clock time in `timeZone` to the UTC instant it names.
 *
 * The offset depends on the instant we're solving for, so we guess with the
 * offset at the naive UTC reading and correct once. One correction is enough
 * for every real-world zone; ambiguous times in a DST fall-back hour resolve to
 * the first (pre-transition) occurrence, and times skipped by a spring-forward
 * resolve to the instant just after the gap.
 */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = naive - offsetMinutes(new Date(naive), timeZone) * 60000;
  const refined = naive - offsetMinutes(new Date(firstGuess), timeZone) * 60000;
  return new Date(refined);
}

/** True if `timeZone` is an identifier this runtime can resolve. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The browser's (or server's) current IANA timezone, with a safe fallback. */
export function detectTimeZone(): string {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return detected && isValidTimeZone(detected) ? detected : "America/New_York";
}
