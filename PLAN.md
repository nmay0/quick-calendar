# Schedule-to-Calendar Web App — Plan

## 1. Problem

University students get their course schedule as a screenshot (or PDF/table) from
their school's registration portal. Manually re-entering 4-6 recurring weekly
events into Apple Calendar (with correct days, times, locations, and semester
date range) is tedious and error-prone. This app automates that: upload an
image of your schedule → get a calendar file that adds every class to Apple
Calendar in one tap.

## 2. Core user flow (MVP)

1. User uploads a screenshot (or PDF/photo) of their course schedule.
2. Image is sent to a multimodal LLM for extraction into structured JSON
   (course name, days of week, start/end time, location, instructor if present).
3. User is shown an **editable review table** of the extracted courses —
   this is the trust/accuracy checkpoint, since OCR/LLM misreads happen
   (e.g. "TR" vs "TH", 12-hr vs 24-hr ambiguity).
4. User confirms/edits, then enters (or the app infers) the **semester start
   and end dates** — screenshots rarely include this, so it can't be
   extracted from the image alone.
5. Per course, user can add an **exam date** (date, time, location) — either
   auto-filled by the exam-schedule lookup (§7, if feasible for the
   university) or entered manually. This becomes a single-occurrence event,
   separate from the weekly recurring class sessions.
6. User can add any number of **one-off events** (title, date, time,
   location) for things like club meetings, extracurriculars, or one-time
   deadlines — these export in the same `.ics` as non-recurring `VEVENT`s.
7. App generates a single `.ics` file: one recurring `VEVENT` per course,
   plus one `VEVENT` per exam and per one-off event.
8. User downloads/opens the `.ics` on their iPhone → iOS Safari triggers the
   native "Add Event(s)" sheet in Apple Calendar. No app install needed.

This flow is deliberately calendar-app-agnostic: `.ics` also works for
Google Calendar, Outlook, etc. Apple Calendar is just the flagship use case.

## 3. Why `.ics`, not a live API integration

Apple does not expose a public write API for third-party web apps to inject
events into Calendar. `.ics` import (triggered via a file link) is the
standard, reliable mechanism and requires zero authentication or app
approval. A `webcal://` link (subscription feed) is a possible v2 upgrade if
we want the calendar to stay "live," but a course schedule rarely changes
mid-semester, so static `.ics` covers the real need with much less
complexity.

## 4. Architecture (MVP)

Keep it stateless and simple — no user accounts, no persistent storage of
uploaded images.

- **Frontend**: single-page app. Upload widget → review/edit table →
  download button. Next.js (or plain Vite + React) is a reasonable default
  since one framework can also host the backend route.
- **Backend**: one API route that:
  1. Accepts the image.
  2. Calls a vision-capable LLM (e.g. Claude) with a prompt constrained to
     return structured JSON matching a fixed schema (course, days[],
     start_time, end_time, location, instructor).
  3. Returns that JSON to the frontend for the review step.
- **ICS generation**: can happen client-side (no backend round-trip needed)
  once the reviewed JSON is finalized — use a small library (e.g. the `ics`
  npm package) or hand-roll, since the format is simple for this use case.
- **No database.** Images and extracted data should be discarded after the
  session — this is a privacy-sensitive input (schedules can include names,
  student IDs if the screenshot is cropped generously) and there is no
  product reason to retain it.

## 5. Extraction details worth planning for

- Prompt the LLM to output a **fixed JSON schema**, not free text — enforce
  with structured output / tool-call style constraints so parsing is
  reliable.
- One course can meet multiple days (e.g. "MWF") — represent as a single
  course record with a `days: string[]` field, not multiple records.
- Screenshots vary a lot by university portal (tables, grids, list views,
  even calendar-grid screenshots). The extraction prompt should be generic
  enough to handle "a schedule looks like X" reasoning rather than assuming
  one layout. Test against a few different portal styles if possible.
- Ambiguities to explicitly handle: 12hr vs 24hr time, "TR"/"TTh" for
  Tuesday/Thursday, async/online sections with no meeting time, lab
  sections listed separately from lecture sections.

## 6. ICS generation details worth planning for

- One `VEVENT` per course using `RRULE` with `FREQ=WEEKLY;BYDAY=MO,WE,FR`
  (RFC 5545 supports multiple `BYDAY` values in a single rule — no need for
  one event per weekday).
- `DTSTART`/`DTEND` set to the *first* occurrence date+time; `UNTIL` (or the
  semester end date) bounds the recurrence.
- Timezone handling: include a `VTIMEZONE` block or use `TZID` correctly —
  don't emit naive/UTC-only times, or events will shift when the user's
  device timezone differs from the school's.
- Semester start/end date input: default reasonable values could be guessed
  by academic calendar convention, but should always be user-editable, not
  silently assumed.
- Not handling (MVP scope, explicitly out): holidays/breaks, room changes
  mid-semester. Note this as a known limitation in the UI rather than
  silently getting it wrong.
- Exam and one-off events are single-occurrence `VEVENT`s (no `RRULE`) with
  their own `DTSTART`/`DTEND` — kept structurally separate from the
  recurring course events so editing/removing one doesn't touch the other.

## 7. Exam date automation (scraper) — conditional

Manual per-course exam-date entry (§2 step 5) is the baseline and should
ship regardless. Auto-filling it via a scraper is worth adding **only if**
the university publishes exam dates on a public page:

- **If the final exam schedule is a public registrar page/PDF** (common —
  usually static per term, keyed by course code + section): a scraper that
  matches parsed courses (from §5) against that listing and pre-fills the
  exam `VEVENT` is a reasonable, low-risk addition. User can still edit/
  override the auto-filled value.
- **If exam dates only live behind the authenticated student portal
  (SSO)**: don't build this. It would require handling other students'
  university credentials, likely violates the portal's terms of service,
  and breaks the "no accounts, nothing retained" privacy posture the rest
  of the app relies on. Manual entry stays the only path in that case.
- Either way, treat scraped data as a *suggestion*, not authoritative —
  registrar pages change format between terms and scrapers silently break;
  don't let a stale scrape overwrite a user's manual correction.
- First step before building this: check whether your university's
  registrar actually publishes a public final-exam schedule, and in what
  format (HTML table vs PDF — PDF parsing is meaningfully more work).

## 8. Integration path with the existing university schedule-planner app

Since the plan is to potentially pitch this as an add-on to an existing
app built by someone else for your university, design the backend as a
**decoupled API** from day one:

- `POST /api/extract` — image in, structured JSON out (the review-table
  data).
- `POST /api/generate-ics` — reviewed JSON in, `.ics` file out.

This lets the existing app call either endpoint directly (e.g. "export to
Apple Calendar" button inside their UI) without needing to embed your
frontend at all, while your own site remains a fully working standalone
tool. Worth keeping the API request/response shape stable and documented
early, since that's the actual integration surface.

## 9. Mobile-first design

Most users will do this entirely on their phone, from screenshot to Add-to-
Calendar, so mobile is the primary target, not a responsive afterthought:

- **Upload**: use a file input that also exposes the camera
  (`<input type="file" accept="image/*" capture>`) so users can snap a photo
  of a printed/projected schedule, not just pick an existing screenshot.
- **Review table**: a wide multi-column table doesn't work on a phone
  screen — use a stacked card layout per course (one card = one course,
  editable fields stacked vertically) instead of a horizontally-scrolling
  table.
- **Touch targets**: edit fields, add-event buttons, and the final download
  button need to be comfortably tappable (44px+ targets), not
  desktop-density form controls.
- **iOS Safari download behavior**: verify the actual tap behavior — on
  iOS, tapping a link to an `.ics` file should open the native "Add to
  Calendar" sheet directly; confirm this works when the file is served with
  the correct `text/calendar` MIME type and doesn't just download to Files
  instead. Test on a real iPhone before considering this done, not just a
  simulator.
- **One-off/exam event entry on mobile**: use native `<input type="date">`
  and `<input type="time">` pickers rather than custom date-pickers — they
  get the OS-native picker UI for free and are far more usable on a phone
  than a custom widget.

## 10. Tech stack recommendation

- Next.js (App Router) — one deploy target for frontend + API routes,
  easy to host on Vercel.
- Claude API (vision) for extraction — multimodal, supports structured/tool
  output.
- `ics` (npm) or a small hand-rolled generator for the `.ics` output.
- No database for MVP. No auth for MVP.

## 11. MVP scope vs. later

**MVP:**
- Single image upload (mobile-first, camera-capable)
- Editable extraction review table (card layout on mobile)
- Manual semester start/end date entry
- Manual per-course exam date entry
- One-off/extracurricular event entry
- Download `.ics` (all courses + exams + one-offs in one file)

**V1.5 (conditional on §7 feasibility check):**
- Scraper-based exam date auto-fill, from a public registrar page only

**V2 ideas (not now):**
- `webcal://` subscription link instead of static download, for schedules
  that change
- Multi-image upload (stitch multiple screenshots, e.g. lecture + lab views)
- Direct push to Google Calendar via their write API (Apple still needs
  `.ics`, but Google/Outlook could skip the download step)
- Public API + docs for other schedule-planner apps to integrate (formalize
  what's sketched in §8)
- Support recurring exceptions (skip a specific date for a holiday)

## 12. Open questions before build

- Should semester date range be inferred (e.g. ask which university/term
  and look up an academic calendar) or always manual entry? Manual is
  simpler and more reliable for MVP.
- Does the university publish a public final-exam schedule, and in what
  format? Determines whether §7 is worth building at all.
- Hosting/cost: vision LLM calls cost money per upload — fine for a
  personal tool, worth a rough usage cap or rate limit if this becomes
  public-facing.
- If pursuing the integration with the existing university app, reach out
  early to confirm what shape of API response would actually be useful to
  them, before over-building a specific contract.
