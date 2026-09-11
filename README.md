# Schedule to Calendar

Upload a screenshot of a university course schedule, check what was read off it,
and get a `.ics` that adds the whole semester — classes, exams, and one-off
events — to Apple Calendar (or Google, or Outlook) in one tap.

## Running it

```bash
cp .env.example .env.local   # add one provider API key
npm install
npm run dev
```

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server on :3000 |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Vitest — ICS generation plus `ical.js` round-trip parsing |
| `npm run lint` | ESLint |

One vision provider key is required — Anthropic, OpenAI, Gemini, or OpenRouter
(see [Providers](#providers)). The rest of `.env.example` is optional tuning.

## How it works

```
image ──► POST /api/extract ──► editable review cards ──► POST /api/generate-ics ──► .ics
            (a vision model)      (you fix the misreads)      (RFC 5545)
```

There is **no database and no storage**. The uploaded image lives in memory for
the length of one request and is never written anywhere; extracted data lives in
React state until you close the tab. Schedules routinely carry names, student
IDs, and advisor notes, and nothing here needs to keep them.

## Providers

Extraction runs against whichever of these the server has a key for:

| Provider | Key | Model env | Default |
| --- | --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | `claude-opus-5` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` | `gpt-5` |
| `gemini` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `GEMINI_MODEL` | `gemini-2.5-pro` |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` | `google/gemini-2.5-pro` |

With several keys present the table order decides; `EXTRACTION_PROVIDER` pins one
outright, and a request can override per call. **A provider you asked for but
have no key for is a `503`, never a silent switch to another vendor.** The
default model ids are a starting point — every account has a different model
list, so set the provider's own env var to something you can reach. OpenRouter
ids are always `vendor/model`.

**The model you pick must accept image input and support structured outputs.** A
text-only model fails at request time, and the provider having a key says
nothing about the model being able to see. On OpenRouter both are checkable
before you pin anything:

```sh
curl -s https://openrouter.ai/api/v1/models | jq -r '.data[]
  | select(.architecture.input_modalities | index("image"))
  | select(.supported_parameters | index("structured_outputs")) | .id'
```

Prefer a non-reasoning vision model. Reasoning tokens bill and stall against the
same ceiling as the answer, and a reasoning model that is fast on a tidy
schedule can exceed the request timeout on a dense one. `EXTRACT_TIMEOUT_MS`
(default `55000`) sets that ceiling; keep it under the route's `maxDuration` so
a timeout returns a `504` rather than the platform killing the function.

Each provider is asked for the same JSON schema through its own structured-output
mechanism (`output_config.format`, `response_format.json_schema`,
`generationConfig.responseSchema`), so the response shape below does not change
with the provider. `*_BASE_URL` points any of the last three at a gateway or
proxy.

`GET /api/extract` reports what a deployment can actually do, without spending a
vision call:

```jsonc
{
  "providers": ["anthropic", "openai"],   // keys present, in preference order
  "supported": ["anthropic", "openai", "gemini", "openrouter"],
  "default": "anthropic",                 // what an unqualified POST will use
  "model": "claude-opus-5"
}
```

## API contract

Both endpoints are usable on their own, so an existing schedule-planner app can
call either one without embedding this UI. The request/response shapes mirror
[`lib/types.ts`](./lib/types.ts) — treat changes there as breaking.

### `POST /api/extract`

Image in, structured courses out.

Accepts `multipart/form-data` with an `image` file (what the browser sends), or
`application/json` with `{ imageBase64, mediaType }` for server-to-server use.
JPEG, PNG, GIF, and WebP; 3.5MB max.

An optional `provider` — form field, JSON key, or `?provider=` query string —
picks the vendor for that one call. Omit it to use the server's default.

```jsonc
// 200
{
  "courses": [
    {
      "name": "CS 2150 Lecture",
      "section": "001",
      "days": ["MO", "WE", "FR"],   // RFC 5545 codes
      "startTime": "09:30",          // 24-hour, or null
      "endTime": "10:45",
      "location": "Thornton Hall 102",
      "instructor": "Dr. Ada Lovelace",
      "async": false
    }
  ],
  "warnings": ["Tuesday times were inferred as PM from surrounding rows."],
  "provider": "anthropic",         // which vendor read the image
  "model": "claude-opus-5"
}
```

`provider` and `model` are informational — useful when a read goes wrong and you
need to know who produced it. Everything else is stable across providers.

Errors are `{ "error": string }` with a meaningful status: `400` unknown
provider, `413` too large, `415` wrong type, `422` unreadable or declined, `429`
rate limited, `503` no key for the requested provider.

### `POST /api/generate-ics`

Reviewed schedule in, calendar file out.

`application/json` with a `Schedule` returns `text/calendar` with
`Content-Disposition: attachment`. The browser posts the same JSON as a
form-urlencoded `schedule` field instead, and gets `inline` back — see
[iOS behaviour](#the-ios-download-path) below.

```jsonc
{
  "timezone": "America/New_York",   // IANA
  "semesterStart": "2026-01-12",
  "semesterEnd": "2026-05-08",
  "calendarName": "Spring 2026",
  "courses": [
    {
      "id": "c1",                    // becomes the VEVENT UID
      "name": "CS 2150 Lecture",
      "days": ["MO", "WE", "FR"],
      "startTime": "09:30",
      "endTime": "10:45",
      "location": "Thornton Hall 102",
      "exam": {                      // optional, single occurrence
        "id": "x1",
        "title": "CS 2150 Final",
        "date": "2026-05-12",
        "startTime": "09:00",
        "endTime": "11:00"
      }
    }
  ],
  "events": [ /* same shape as `exam` — club meetings, deadlines */ ]
}
```

Validation failures return `400` with a per-field `issues` array.

## Calendar-format decisions

- **One `VEVENT` per course.** A single `RRULE` carries every weekday
  (`FREQ=WEEKLY;BYDAY=MO,WE,FR`), so a MWF class is one series, not three.
- **`DTSTART` is the first real meeting**, not the semester's first day: a
  Thursday-only class in a semester starting Monday anchors to that Thursday.
- **Real timezones.** Events use `DTSTART;TZID=…` with a full `VTIMEZONE` block,
  and `UNTIL` is converted to UTC as RFC 5545 requires. Classes hold their wall
  clock across the March DST change — a test expands all 51 occurrences of a MWF
  class through the transition to prove it.
- **Exams and one-off events are separate non-recurring events**, so deleting an
  exam never disturbs the class series.
- **Async sections produce no weekly event** (there is nothing to schedule) but
  can still carry an exam.

## The iOS download path

The browser submits a real `<form method="POST">` rather than `fetch`-ing and
building a blob. A top-level navigation returning `text/calendar` is what hands
the file to Calendar on iOS; a blob URL with a `download` attribute is
unreliable there. That path responds `Content-Disposition: inline`, which favours
the Add-to-Calendar sheet over silently filing it in Files.

> **Not yet verified on a real iPhone.** This is the shape most likely to work,
> but iOS Safari's handling of `text/calendar` is version-sensitive and the plan
> is explicit that it needs a device test. If it lands in Files instead of
> opening Calendar, try flipping the form path to `attachment` in
> [`app/api/generate-ics/route.ts`](./app/api/generate-ics/route.ts).

## Known limitations

- **Holidays and breaks are not handled.** Classes appear every week between the
  two semester dates. The UI says so; delete stray occurrences after importing.
- **Mid-semester room changes are not handled.**
- **The rate limiter is per-process.** Fine for one long-lived server; swap in a
  shared store before deploying this multi-instance or serverless.
- **Exam auto-fill (`PLAN.md` §7) is not built.** Manual entry works today.

## Notes for whoever works on this next

- `@touch4it/ical-timezones` reads its zone data off disk with `__dirname`, and
  bundling breaks that *silently* — it returns `null` and every calendar loses
  its timezone. It is pinned in `serverExternalPackages`; see the comment in
  [`next.config.ts`](./next.config.ts) before changing that.
- The upload input deliberately omits the `capture` attribute. On iOS,
  `accept="image/*"` alone opens the full Photo Library / Take Photo / Choose
  File sheet, while adding `capture` forces the camera and removes the library —
  the wrong default when most people upload a screenshot. A second, separate
  input carries `capture="environment"` for the camera.
- Camera photos are downscaled to a 2000px long edge in the browser
  ([`lib/image.ts`](./lib/image.ts)); phone photos otherwise blow past the upload
  limit.
- Client-side validation ([`lib/validate.ts`](./lib/validate.ts)) is a UX gate
  only. `/api/generate-ics` re-validates everything.
