import { NextResponse } from "next/server";
import { IcsError, buildIcs, icsFilename } from "@/lib/ics";
import { scheduleSchema } from "@/lib/schema";
import type { Schedule } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/generate-ics
 *
 * Takes a reviewed `Schedule` and returns the calendar file itself, served as
 * `text/calendar`.
 *
 * Two body encodings are supported on purpose:
 *
 * - `application/json` — the integration path. Responds with
 *   `Content-Disposition: attachment`, which is what an API consumer wants.
 * - `application/x-www-form-urlencoded` with a `schedule` field holding the
 *   same JSON — the browser path. The page submits a real form so the download
 *   is a top-level navigation rather than a fetch, which is the only shape iOS
 *   Safari reliably hands to Calendar. That path responds with
 *   `Content-Disposition: inline` so iOS opens the Add-to-Calendar sheet
 *   instead of filing it away in Files.
 */
export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const isFormPost = contentType.includes("application/x-www-form-urlencoded");

  let body: unknown;
  try {
    if (isFormPost) {
      const form = await request.formData();
      const raw = form.get("schedule");
      if (typeof raw !== "string") {
        return NextResponse.json(
          { error: "Expected a `schedule` field." },
          { status: 400 },
        );
      }
      body = JSON.parse(raw);
    } else {
      body = await request.json();
    }
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "That schedule isn't valid.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const schedule = parsed.data as Schedule;

  let ics: string;
  try {
    ics = buildIcs(schedule);
  } catch (err) {
    if (err instanceof IcsError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Unexpected ICS failure", err);
    return NextResponse.json(
      { error: "Could not build the calendar file." },
      { status: 500 },
    );
  }

  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `${
        isFormPost ? "inline" : "attachment"
      }; filename="${icsFilename(schedule)}"`,
      "Cache-Control": "no-store",
    },
  });
}
