/**
 * Vision extraction: schedule screenshot in, structured course list out.
 *
 * This file owns the prompt, the JSON schema hand-off, and the normalization of
 * whatever comes back. Which vendor actually looks at the image is
 * `lib/providers.ts`'s problem — Anthropic, OpenAI, Gemini, and OpenRouter are
 * all supported and interchangeable here.
 *
 * Deliberately stateless — the image is held in memory for the length of one
 * request and never written anywhere. Schedules can carry names, IDs, and
 * advisor notes, and there is no product reason to retain any of it.
 */

import { ExtractionError } from "./errors";
import { callVisionModel, resolveProvider, type SupportedImageType } from "./providers";
import { EXTRACTION_JSON_SCHEMA } from "./schema";
import { WEEKDAYS, type ExtractedCourse, type ExtractionResult, type Weekday } from "./types";

export { ExtractionError };
export {
  MAX_IMAGE_BYTES,
  PROVIDERS,
  SUPPORTED_IMAGE_TYPES,
  configuredProviders,
  isProvider,
  type Provider,
  type SupportedImageType,
} from "./providers";

const SYSTEM_PROMPT = `You read university course schedules out of images and return structured data.

The image is a screenshot, photo, or export from a student registration portal. Layouts vary widely: list views, grid/calendar views, printed tables, and mobile app screenshots all appear. Read whatever is actually on the page rather than assuming one layout.

Rules:
- One course meeting several days is a SINGLE entry with several day codes, not one entry per day. "MWF" is one course with days MO, WE, FR.
- Day abbreviations differ by school. "R" and "TH" both mean Thursday. "T" means Tuesday. "TR" and "TTh" mean Tuesday and Thursday. "S" is Saturday, "U" or "Su" is Sunday. In a calendar grid, read the column headers.
- Convert every time to 24-hour HH:MM. Where a schedule prints times without am/pm, use the surrounding rows to infer the period: a class listed between a 9:00 and a 2:00 class is 1:00 PM, not 1:00 AM. University classes essentially never start before 07:00 or after 22:00.
- Lecture, lab, discussion, and recitation sections are separate entries even when they share a course code. Name them so they are distinguishable, e.g. "CHEM 1410 Lab".
- Asynchronous or online sections with no meeting time get async: true, an empty days list, and null times.
- Copy the location as printed, including the building abbreviation. Do not expand abbreviations.
- Do not invent a value. Anything not visible in the image is null.

Use the warnings list for anything a student should double-check: a time you inferred rather than read, a cropped or blurred row, an ambiguous day code, a course you were unsure whether to split. Keep each warning to one short sentence. Return an empty warnings list when the schedule was unambiguous.

Never include semester start or end dates — schedules rarely show them and the student supplies them separately.`;

const USER_PROMPT =
  "Extract every course from this schedule image.";

const WEEKDAY_SET = new Set<string>(WEEKDAYS);

/**
 * The schema constrains shape, not semantics. Normalize what comes back so the
 * review UI always receives well-formed rows: valid day codes, HH:MM times, and
 * no stray whitespace.
 */
function normalizeCourse(raw: unknown): ExtractedCourse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;

  const days = Array.isArray(value.days)
    ? Array.from(
        new Set(
          value.days
            .filter((d): d is string => typeof d === "string")
            .map((d) => d.trim().toUpperCase())
            .filter((d): d is Weekday => WEEKDAY_SET.has(d)),
        ),
      )
    : [];

  const time = (input: unknown): string | null => {
    if (typeof input !== "string") return null;
    const match = /^(\d{1,2}):([0-5]\d)$/.exec(input.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    if (hour > 23) return null;
    return `${String(hour).padStart(2, "0")}:${match[2]}`;
  };

  const text = (input: unknown): string | null => {
    if (typeof input !== "string") return null;
    const trimmed = input.trim();
    return trimmed && trimmed.toLowerCase() !== "null" ? trimmed : null;
  };

  const startTime = time(value.startTime);
  const endTime = time(value.endTime);

  return {
    name,
    section: text(value.section),
    days,
    startTime,
    endTime,
    location: text(value.location),
    instructor: text(value.instructor),
    // Trust the flag, but also treat "no days and no times" as async.
    async: value.async === true || (days.length === 0 && !startTime && !endTime),
  };
}

/**
 * Strip a ```json fence if one is present. Structured-output modes are supposed
 * to make this impossible, but support varies by vendor and — on OpenRouter —
 * by whichever model the slug points at, so unwrap rather than fail.
 */
function unwrapJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

export function parseModelOutput(text: string): ExtractionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJson(text));
  } catch {
    throw new ExtractionError("The model returned output we could not parse.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ExtractionError("The model returned output we could not parse.");
  }

  const value = parsed as Record<string, unknown>;
  const courses = Array.isArray(value.courses)
    ? value.courses
        .map(normalizeCourse)
        .filter((c): c is ExtractedCourse => c !== null)
    : [];
  const warnings = Array.isArray(value.warnings)
    ? value.warnings
        .filter((w): w is string => typeof w === "string")
        .map((w) => w.trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];

  return { courses, warnings };
}

export interface ExtractOptions {
  /** Force a specific vendor for this call; defaults to the server's choice. */
  provider?: string | null;
}

export async function extractSchedule(
  imageBase64: string,
  mediaType: SupportedImageType,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const provider = resolveProvider(options.provider);

  const response = await callVisionModel({
    provider,
    imageBase64,
    mediaType,
    system: SYSTEM_PROMPT,
    user: USER_PROMPT,
    schema: EXTRACTION_JSON_SCHEMA,
  });

  return {
    ...parseModelOutput(response.text),
    provider: response.provider,
    model: response.model,
  };
}
