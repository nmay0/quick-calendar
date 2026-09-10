/**
 * RFC 5545 calendar generation.
 *
 * Hand-rolled rather than library-driven because the format we need is small
 * and the parts that matter (TZID + a real VTIMEZONE block, one RRULE with
 * multiple BYDAY values, a UTC UNTIL) are exactly the parts most `ics`
 * libraries get wrong or omit.
 */

import { getVtimezoneComponent } from "@touch4it/ical-timezones";
import type { Course, Schedule, SingleEvent, Weekday } from "./types";
import { isValidTimeZone, zonedWallTimeToUtc } from "./tz";

const PRODID = "-//schedule-to-calendar//EN";

/** BYDAY code -> JS day-of-week index (0 = Sunday). */
const BYDAY_TO_JS: Record<Weekday, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class IcsError extends Error {}

interface CalDate {
  year: number;
  month: number;
  day: number;
}

interface CalTime {
  hour: number;
  minute: number;
}

function parseDate(value: string, field: string): CalDate {
  if (!DATE_RE.test(value)) {
    throw new IcsError(`${field} must be a YYYY-MM-DD date (got "${value}")`);
  }
  const [year, month, day] = value.split("-").map(Number);
  // Round-trip through UTC to reject 2026-02-31 and friends.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new IcsError(`${field} is not a real date (got "${value}")`);
  }
  return { year, month, day };
}

function parseTime(value: string, field: string): CalTime {
  const match = TIME_RE.exec(value);
  if (!match) {
    throw new IcsError(`${field} must be a 24-hour HH:MM time (got "${value}")`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function addDays(date: CalDate, days: number): CalDate {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function dayOfWeek(date: CalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function compareDates(a: CalDate, b: CalDate): number {
  return (
    Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)
  );
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Local date-time with no trailing Z — paired with a TZID parameter. */
function formatLocal(date: CalDate, time: CalTime): string {
  return (
    `${pad(date.year, 4)}${pad(date.month)}${pad(date.day)}` +
    `T${pad(time.hour)}${pad(time.minute)}00`
  );
}

function formatUtc(instant: Date): string {
  return (
    `${pad(instant.getUTCFullYear(), 4)}${pad(instant.getUTCMonth() + 1)}` +
    `${pad(instant.getUTCDate())}T${pad(instant.getUTCHours())}` +
    `${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`
  );
}

/** Escape a TEXT-typed property value per RFC 5545 §3.3.11. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold a content line to 75 octets per RFC 5545 §3.1. Folding is byte-based,
 * so a naive character split would corrupt multi-byte UTF-8 (course names with
 * accents are common). We measure in bytes and never split a code point.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  // First line gets 75 octets; continuations get 74 plus the leading space.
  let limit = 75;

  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    if (currentBytes + charBytes > limit) {
      out.push(current);
      current = "";
      currentBytes = 0;
      limit = 74;
    }
    current += char;
    currentBytes += charBytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** The first date on or after `from` whose weekday is in `days`. */
function firstOccurrence(from: CalDate, days: Weekday[]): CalDate {
  const wanted = new Set(days.map((d) => BYDAY_TO_JS[d]));
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = addDays(from, offset);
    if (wanted.has(dayOfWeek(candidate))) return candidate;
  }
  // Unreachable: any non-empty day set matches within a 7-day window.
  throw new IcsError("Could not find a first meeting date");
}

interface VEventFields {
  uid: string;
  dtstamp: string;
  summary: string;
  start: string;
  end: string;
  tzid: string;
  location?: string | null;
  description?: string | null;
  rrule?: string;
}

function renderVEvent(fields: VEventFields): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${fields.uid}`,
    `DTSTAMP:${fields.dtstamp}`,
    `DTSTART;TZID=${fields.tzid}:${fields.start}`,
    `DTEND;TZID=${fields.tzid}:${fields.end}`,
    `SUMMARY:${escapeText(fields.summary)}`,
  ];
  if (fields.rrule) lines.push(`RRULE:${fields.rrule}`);
  if (fields.location) lines.push(`LOCATION:${escapeText(fields.location)}`);
  if (fields.description) {
    lines.push(`DESCRIPTION:${escapeText(fields.description)}`);
  }
  lines.push("END:VEVENT");
  return lines;
}

function describeCourse(course: Course): string | null {
  const parts: string[] = [];
  if (course.section) parts.push(`Section: ${course.section}`);
  if (course.instructor) parts.push(`Instructor: ${course.instructor}`);
  return parts.length ? parts.join("\n") : null;
}

function describeEvent(event: SingleEvent): string | null {
  return event.notes?.trim() ? event.notes.trim() : null;
}

/** Resolve a single-occurrence event's start/end wall times. */
function singleEventWindow(
  event: SingleEvent,
  label: string,
): { start: string; end: string } {
  const date = parseDate(event.date, `${label} date`);
  const start = parseTime(event.startTime, `${label} start time`);
  const end = parseTime(event.endTime, `${label} end time`);
  const startsAt = start.hour * 60 + start.minute;
  const endsAt = end.hour * 60 + end.minute;
  // An end at or before the start means the event runs past midnight.
  const endDate = endsAt <= startsAt ? addDays(date, 1) : date;
  return {
    start: formatLocal(date, start),
    end: formatLocal(endDate, end),
  };
}

export interface BuildIcsOptions {
  /** Overrides the DTSTAMP used for every event. Tests pass a fixed instant. */
  now?: Date;
}

/**
 * Render a `Schedule` as a complete iCalendar document.
 *
 * One recurring VEVENT per meeting course (a single RRULE carries every
 * weekday), plus one non-recurring VEVENT per exam and per one-off event, so
 * editing or deleting an exam never touches the class series.
 */
export function buildIcs(schedule: Schedule, options: BuildIcsOptions = {}): string {
  const tzid = schedule.timezone;
  if (!isValidTimeZone(tzid)) {
    throw new IcsError(`Unknown timezone "${tzid}"`);
  }

  // Intl knowing a zone doesn't guarantee the tz-data bundle has a VTIMEZONE
  // for it (newly added zones and some aliases are missing), and the library
  // signals that with null rather than by throwing.
  const vtimezone = getVtimezoneComponent(tzid)?.trim();
  if (!vtimezone) {
    throw new IcsError(
      `No calendar timezone data available for "${tzid}". Pick a nearby major-city zone instead.`,
    );
  }

  const semesterStart = parseDate(schedule.semesterStart, "Semester start");
  const semesterEnd = parseDate(schedule.semesterEnd, "Semester end");
  if (compareDates(semesterStart, semesterEnd) > 0) {
    throw new IcsError("Semester start must be on or before semester end");
  }

  // RFC 5545 §3.3.10: when DTSTART carries a TZID, UNTIL must be UTC. Take the
  // last local instant of the end date so a class meeting that day is included.
  const untilInstant = zonedWallTimeToUtc(
    semesterEnd.year,
    semesterEnd.month,
    semesterEnd.day,
    23,
    59,
    tzid,
  );
  untilInstant.setUTCSeconds(untilInstant.getUTCSeconds() + 59);
  const until = formatUtc(untilInstant);

  const dtstamp = formatUtc(options.now ?? new Date());
  const seenUids = new Set<string>();
  const uid = (raw: string) => {
    let candidate = `${raw}@schedule-to-calendar`;
    let suffix = 2;
    while (seenUids.has(candidate)) {
      candidate = `${raw}-${suffix}@schedule-to-calendar`;
      suffix += 1;
    }
    seenUids.add(candidate);
    return candidate;
  };

  const body: string[] = [];

  for (const course of schedule.courses) {
    const label = course.name?.trim() || "Untitled course";

    if (!course.async) {
      if (course.days.length === 0) {
        throw new IcsError(
          `"${label}" has no meeting days. Pick at least one day, or mark it async.`,
        );
      }
      const start = parseTime(course.startTime, `"${label}" start time`);
      const end = parseTime(course.endTime, `"${label}" end time`);
      const startsAt = start.hour * 60 + start.minute;
      const endsAt = end.hour * 60 + end.minute;
      if (endsAt <= startsAt) {
        throw new IcsError(`"${label}" ends at or before it starts`);
      }

      const firstDay = firstOccurrence(semesterStart, course.days);
      if (compareDates(firstDay, semesterEnd) > 0) {
        throw new IcsError(
          `"${label}" never meets inside the semester date range`,
        );
      }

      // Deduplicate and emit BYDAY in calendar order for readable output.
      const byday = (Object.keys(BYDAY_TO_JS) as Weekday[])
        .filter((d) => course.days.includes(d))
        .sort((a, b) => BYDAY_TO_JS[a] - BYDAY_TO_JS[b]);

      body.push(
        ...renderVEvent({
          uid: uid(course.id),
          dtstamp,
          tzid,
          summary: label,
          start: formatLocal(firstDay, start),
          end: formatLocal(firstDay, end),
          rrule: `FREQ=WEEKLY;BYDAY=${byday.join(",")};UNTIL=${until}`,
          location: course.location,
          description: describeCourse(course),
        }),
      );
    }

    if (course.exam) {
      const exam = course.exam;
      const window = singleEventWindow(exam, `"${label}" exam`);
      body.push(
        ...renderVEvent({
          uid: uid(exam.id),
          dtstamp,
          tzid,
          summary: exam.title?.trim() || `${label} — Final Exam`,
          start: window.start,
          end: window.end,
          location: exam.location,
          description: describeEvent(exam),
        }),
      );
    }
  }

  for (const event of schedule.events) {
    const title = event.title?.trim() || "Untitled event";
    const window = singleEventWindow(event, `"${title}"`);
    body.push(
      ...renderVEvent({
        uid: uid(event.id),
        dtstamp,
        tzid,
        summary: title,
        start: window.start,
        end: window.end,
        location: event.location,
        description: describeEvent(event),
      }),
    );
  }

  if (body.length === 0) {
    throw new IcsError("Nothing to export — add at least one course or event");
  }

  const calendarName = schedule.calendarName?.trim() || "Class Schedule";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:${tzid}`,
    ...vtimezone.split(/\r?\n/),
    ...body,
    "END:VCALENDAR",
  ];

  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** A filesystem-safe .ics filename derived from the calendar name. */
export function icsFilename(schedule: Schedule): string {
  const base = (schedule.calendarName?.trim() || "class-schedule")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "class-schedule"}.ics`;
}
