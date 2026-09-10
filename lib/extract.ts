/**
 * Vision extraction: schedule screenshot in, structured course list out.
 *
 * Deliberately stateless — the image is held in memory for the length of one
 * request and never written anywhere. Schedules can carry names, IDs, and
 * advisor notes, and there is no product reason to retain any of it.
 */

import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTION_JSON_SCHEMA } from "./schema";
import { WEEKDAYS, type ExtractedCourse, type ExtractionResult, type Weekday } from "./types";

export const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/** Claude's per-image limit is 5MB base64-encoded; leave room for the overhead. */
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

const MODEL = process.env.EXTRACTION_MODEL ?? "claude-opus-5";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * `medium` is the default because extraction is a read-and-transcribe task, not
 * a reasoning-heavy one, and this runs once per upload at real cost. Raise it
 * via EXTRACTION_EFFORT if your portal's layouts are genuinely hard to read.
 */
const EFFORT: Effort = (EFFORT_LEVELS as readonly string[]).includes(
  process.env.EXTRACTION_EFFORT ?? "",
)
  ? (process.env.EXTRACTION_EFFORT as Effort)
  : "medium";

/**
 * Server-side refusal fallbacks are opt-in. They cost nothing when unused and
 * turn a hard failure into a served response, so they're on unless disabled.
 */
const FALLBACKS_ENABLED = process.env.DISABLE_REFUSAL_FALLBACKS !== "1";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

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

export class ExtractionError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

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

function parseModelOutput(text: string): ExtractionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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

/** True when a request failed specifically because of the beta fallback opt-in. */
function isFallbackOptInRejection(error: unknown): boolean {
  if (!(error instanceof Anthropic.BadRequestError)) return false;
  return /fallback/i.test(error.message);
}

export async function extractSchedule(
  imageBase64: string,
  mediaType: SupportedImageType,
): Promise<ExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ExtractionError(
      "The server is missing ANTHROPIC_API_KEY, so extraction is unavailable.",
      503,
    );
  }

  const client = new Anthropic({ apiKey });

  const request = {
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema" as const, schema: EXTRACTION_JSON_SCHEMA },
    },
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: mediaType,
              data: imageBase64,
            },
          },
          { type: "text" as const, text: USER_PROMPT },
        ],
      },
    ],
  };

  /**
   * The beta and non-beta message types differ only in ways we don't touch, so
   * both branches are read through this minimal shape.
   */
  interface ModelResponse {
    stop_reason: string | null;
    content: Array<{ type: string; text?: string }>;
  }

  let response: ModelResponse;
  try {
    response = FALLBACKS_ENABLED
      ? ((await client.beta.messages.create({
          ...request,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          // `fallbacks` is a beta parameter the SDK types don't carry yet.
        } as Parameters<typeof client.beta.messages.create>[0])) as ModelResponse)
      : ((await client.messages.create(request)) as ModelResponse);
  } catch (error) {
    // The fallback opt-in is a beta surface; if this deployment's account or
    // API version rejects it, fall through to a plain request rather than
    // failing the upload.
    if (FALLBACKS_ENABLED && isFallbackOptInRejection(error)) {
      response = (await client.messages.create(request)) as ModelResponse;
    } else if (error instanceof Anthropic.RateLimitError) {
      throw new ExtractionError(
        "The extraction service is busy right now. Try again in a moment.",
        429,
      );
    } else if (error instanceof Anthropic.APIError) {
      throw new ExtractionError(
        "The extraction service rejected the request.",
        502,
      );
    } else {
      throw new ExtractionError("Could not reach the extraction service.", 502);
    }
  }

  // Check the stop reason before touching content: a refusal returns HTTP 200
  // with an empty or partial content array.
  if (response.stop_reason === "refusal") {
    throw new ExtractionError(
      "The model declined to read this image. Try a screenshot that shows only your class schedule.",
      422,
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new ExtractionError(
      "That schedule was too long to read in one pass. Try uploading it in sections.",
      422,
    );
  }

  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new ExtractionError("The model returned an empty response.");
  }

  return parseModelOutput(text);
}
