/**
 * Runtime validation for the two API endpoints.
 *
 * The zod schemas here mirror `lib/types.ts` exactly — that file is the
 * compile-time contract, this one is the runtime gate for untrusted input.
 */

import { z } from "zod";
import { WEEKDAYS } from "./types";

const weekday = z.enum(WEEKDAYS);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const time24 = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "expected 24-hour HH:MM");

/** Trim, then collapse empty strings to null so the generator can skip them. */
const optionalText = z
  .string()
  .max(500)
  .nullish()
  .transform((v) => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : null;
  });

export const singleEventSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  date: isoDate,
  startTime: time24,
  endTime: time24,
  location: optionalText,
  notes: optionalText,
});

export const courseSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  section: optionalText,
  days: z.array(weekday).max(7),
  // Async courses have no meeting window, so these are only checked below.
  startTime: z.string().max(5),
  endTime: z.string().max(5),
  location: optionalText,
  instructor: optionalText,
  async: z.boolean().optional(),
  exam: singleEventSchema.nullish().transform((v) => v ?? null),
});

export const scheduleSchema = z
  .object({
    timezone: z.string().min(1).max(100),
    semesterStart: isoDate,
    semesterEnd: isoDate,
    courses: z.array(courseSchema).max(50),
    events: z.array(singleEventSchema).max(200),
    calendarName: z.string().max(120).optional(),
  })
  .superRefine((value, ctx) => {
    value.courses.forEach((course, index) => {
      if (course.async) return;
      for (const field of ["startTime", "endTime"] as const) {
        if (!time24.safeParse(course[field]).success) {
          ctx.addIssue({
            code: "custom",
            path: ["courses", index, field],
            message: "expected 24-hour HH:MM on a course with meeting times",
          });
        }
      }
    });
  });

export type ScheduleInput = z.infer<typeof scheduleSchema>;

/**
 * JSON Schema handed to the model for structured extraction.
 *
 * Structured outputs require `additionalProperties: false` and an explicit
 * `required` list on every object, and express nullability with `anyOf` rather
 * than a type array.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    courses: {
      type: "array",
      description: "One entry per course. A course that meets several days is ONE entry.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Course code and title as printed, e.g. 'CS 2150 Program & Data Representation'.",
          },
          section: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Section or CRN if shown, otherwise null.",
          },
          days: {
            type: "array",
            description:
              "Weekdays the course meets, as RFC 5545 codes. Empty for async sections.",
            items: { type: "string", enum: [...WEEKDAYS] },
          },
          startTime: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Start time as 24-hour HH:MM, or null if none is shown.",
          },
          endTime: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "End time as 24-hour HH:MM, or null if none is shown.",
          },
          location: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Building and room, or null.",
          },
          instructor: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Instructor name, or null.",
          },
          async: {
            type: "boolean",
            description: "True for async/online sections with no fixed meeting time.",
          },
        },
        required: [
          "name",
          "section",
          "days",
          "startTime",
          "endTime",
          "location",
          "instructor",
          "async",
        ],
        additionalProperties: false,
      },
    },
    warnings: {
      type: "array",
      description:
        "Short notes about anything ambiguous or unreadable, so the student knows what to double-check. Empty if the schedule was unambiguous.",
      items: { type: "string" },
    },
  },
  required: ["courses", "warnings"],
  additionalProperties: false,
} as const;
