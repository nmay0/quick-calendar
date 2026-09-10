/**
 * Client-side validation for the review screen.
 *
 * This is a UX gate, not the authority: the download is a real form POST, so
 * anything that slips through would render the server's JSON error instead of
 * opening Calendar. `/api/generate-ics` re-validates everything regardless —
 * this exists so problems surface next to the field that caused them.
 */

import type { Schedule } from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface ValidationResult {
  /** Problems not attached to a specific card. */
  general: string[];
  /** Problems keyed by course id. */
  courses: Record<string, string[]>;
  /** Problems keyed by one-off event id. */
  events: Record<string, string[]>;
  ok: boolean;
}

function minutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function validateSchedule(schedule: Schedule): ValidationResult {
  const general: string[] = [];
  const courses: Record<string, string[]> = {};
  const events: Record<string, string[]> = {};

  if (!DATE_RE.test(schedule.semesterStart)) {
    general.push("Add the date your semester starts.");
  }
  if (!DATE_RE.test(schedule.semesterEnd)) {
    general.push("Add the date your semester ends.");
  }
  if (
    DATE_RE.test(schedule.semesterStart) &&
    DATE_RE.test(schedule.semesterEnd) &&
    schedule.semesterStart > schedule.semesterEnd
  ) {
    general.push("The semester ends before it starts.");
  }

  const hasContent =
    schedule.courses.some((c) => !c.async || c.exam) || schedule.events.length > 0;
  if (!hasContent) {
    general.push("Add at least one course or event before exporting.");
  }

  for (const course of schedule.courses) {
    const problems: string[] = [];
    if (!course.name.trim()) problems.push("Give this course a name.");

    if (!course.async) {
      if (course.days.length === 0) {
        problems.push("Pick at least one meeting day, or mark it async.");
      }
      if (!TIME_RE.test(course.startTime)) problems.push("Add a start time.");
      if (!TIME_RE.test(course.endTime)) problems.push("Add an end time.");
      if (
        TIME_RE.test(course.startTime) &&
        TIME_RE.test(course.endTime) &&
        minutes(course.endTime) <= minutes(course.startTime)
      ) {
        problems.push("The end time is at or before the start time.");
      }
    }

    if (course.exam) {
      problems.push(...eventProblems(course.exam, "exam"));
    }
    if (problems.length) courses[course.id] = problems;
  }

  for (const event of schedule.events) {
    const problems = eventProblems(event, "event");
    if (problems.length) events[event.id] = problems;
  }

  return {
    general,
    courses,
    events,
    ok:
      general.length === 0 &&
      Object.keys(courses).length === 0 &&
      Object.keys(events).length === 0,
  };
}

function eventProblems(
  event: { title: string; date: string; startTime: string; endTime: string },
  label: string,
): string[] {
  const problems: string[] = [];
  if (!event.title.trim()) problems.push(`Give the ${label} a title.`);
  if (!DATE_RE.test(event.date)) problems.push(`Add the ${label} date.`);
  if (!TIME_RE.test(event.startTime)) problems.push(`Add the ${label} start time.`);
  if (!TIME_RE.test(event.endTime)) problems.push(`Add the ${label} end time.`);
  return problems;
}
