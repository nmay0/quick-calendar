/**
 * Shared data contract for the schedule-to-calendar app.
 *
 * These shapes are the public API surface (see README "API contract"): the
 * `/api/extract` response and the `/api/generate-ics` request body are built
 * from them, so treat changes here as breaking changes for any integrator.
 */

/** RFC 5545 BYDAY codes, in Monday-first order. */
export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};

/** A single-occurrence event: a final exam, a club meeting, a deadline. */
export interface SingleEvent {
  id: string;
  title: string;
  /** YYYY-MM-DD, local to the schedule's timezone. */
  date: string;
  /** HH:MM, 24-hour, local to the schedule's timezone. */
  startTime: string;
  /** HH:MM, 24-hour. If earlier than startTime the event is treated as overnight. */
  endTime: string;
  location?: string | null;
  notes?: string | null;
}

/** One course, meeting on zero or more weekdays at the same time each day. */
export interface Course {
  id: string;
  /** Course name as it should appear in the calendar, e.g. "CS 101 Lecture". */
  name: string;
  /** Section identifier if the schedule showed one. */
  section?: string | null;
  days: Weekday[];
  startTime: string;
  endTime: string;
  location?: string | null;
  instructor?: string | null;
  /**
   * True for async/online sections with no fixed meeting time. These produce no
   * recurring event (there is nothing to schedule) but can still carry an exam.
   */
  async?: boolean;
  /** Optional single-occurrence exam for this course. */
  exam?: SingleEvent | null;
}

/** Everything needed to render a calendar file. */
export interface Schedule {
  /** IANA timezone identifier, e.g. "America/New_York". */
  timezone: string;
  /** YYYY-MM-DD — recurrence starts on the first matching day on or after this. */
  semesterStart: string;
  /** YYYY-MM-DD — recurrence stops at the end of this day. */
  semesterEnd: string;
  courses: Course[];
  /** One-off events unrelated to a specific course. */
  events: SingleEvent[];
  /** Optional calendar display name. */
  calendarName?: string;
}

/** What the vision model returns per course, before the user reviews it. */
export interface ExtractedCourse {
  name: string;
  section: string | null;
  days: Weekday[];
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  instructor: string | null;
  async: boolean;
}

export interface ExtractionResult {
  courses: ExtractedCourse[];
  /** Things the model was unsure about, surfaced above the review table. */
  warnings: string[];
  /**
   * Which vendor and model read the image. Informational — several providers
   * are supported and a caller debugging a bad read needs to know which one
   * produced it. Optional so older clients and fixtures stay valid.
   */
  provider?: string;
  model?: string;
}
