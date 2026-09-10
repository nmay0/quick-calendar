import { describe, expect, it } from "vitest";
import { buildIcs, IcsError, icsFilename } from "../ics";
import type { Schedule } from "../types";
import { zonedWallTimeToUtc } from "../tz";

const NOW = new Date("2026-01-01T00:00:00Z");

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    timezone: "America/New_York",
    // 2026-01-12 is a Monday.
    semesterStart: "2026-01-12",
    semesterEnd: "2026-05-08",
    courses: [],
    events: [],
    ...overrides,
  };
}

/** Unfold RFC 5545 continuation lines so assertions can match whole values. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n /g, "").split("\r\n");
}

describe("buildIcs", () => {
  const mwf: Schedule = schedule({
    courses: [
      {
        id: "course-1",
        name: "CS 101 Lecture",
        section: "001",
        days: ["MO", "WE", "FR"],
        startTime: "09:30",
        endTime: "10:45",
        location: "Thornton Hall 102",
        instructor: "Dr. Ada Lovelace",
      },
    ],
  });

  it("emits one recurring VEVENT carrying every weekday in a single RRULE", () => {
    const lines = unfold(buildIcs(mwf, { now: NOW }));
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain(
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260509T035959Z",
    );
  });

  it("anchors DTSTART to the first meeting on or after the semester start", () => {
    const lines = unfold(buildIcs(mwf, { now: NOW }));
    expect(lines).toContain("DTSTART;TZID=America/New_York:20260112T093000");
    expect(lines).toContain("DTEND;TZID=America/New_York:20260112T104500");
  });

  it("skips forward when the semester starts before the first meeting day", () => {
    // 2026-01-12 is a Monday, so a Thursday-only class first meets on the 15th.
    const lines = unfold(
      buildIcs(
        schedule({
          courses: [
            {
              id: "c",
              name: "Lab",
              days: ["TH"],
              startTime: "14:00",
              endTime: "16:50",
            },
          ],
        }),
        { now: NOW },
      ),
    );
    expect(lines).toContain("DTSTART;TZID=America/New_York:20260115T140000");
  });

  it("puts UNTIL in UTC at the end of the final local day", () => {
    // 2026-05-08 23:59:59 EDT (UTC-4) is 2026-05-09 03:59:59 UTC.
    const expected = zonedWallTimeToUtc(2026, 5, 8, 23, 59, "America/New_York");
    expect(expected.toISOString()).toBe("2026-05-09T03:59:00.000Z");
    expect(buildIcs(mwf, { now: NOW })).toContain("UNTIL=20260509T035959Z");
  });

  it("includes a real VTIMEZONE block for the schedule's zone", () => {
    const ics = buildIcs(mwf, { now: NOW });
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("TZID:America/New_York");
    expect(ics).toContain("BEGIN:DAYLIGHT");
    expect(ics).toContain("END:VTIMEZONE");
  });

  it("keeps exams and one-off events as separate non-recurring VEVENTs", () => {
    const ics = buildIcs(
      schedule({
        courses: [
          {
            ...mwf.courses[0],
            exam: {
              id: "exam-1",
              title: "CS 101 Final",
              date: "2026-05-12",
              startTime: "09:00",
              endTime: "11:00",
              location: "Gym",
            },
          },
        ],
        events: [
          {
            id: "event-1",
            title: "Robotics Club",
            date: "2026-02-03",
            startTime: "18:00",
            endTime: "19:30",
          },
        ],
      }),
      { now: NOW },
    );
    const lines = unfold(ics);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(3);
    expect(
      lines.filter((l) => l.startsWith("RRULE:FREQ=WEEKLY;BYDAY=")),
    ).toHaveLength(1);
    expect(lines).toContain("DTSTART;TZID=America/New_York:20260512T090000");
    expect(lines).toContain("SUMMARY:Robotics Club");
  });

  it("emits no recurring event for an async course but still exports its exam", () => {
    const lines = unfold(
      buildIcs(
        schedule({
          courses: [
            {
              id: "c",
              name: "Online Stats",
              days: [],
              startTime: "",
              endTime: "",
              async: true,
              exam: {
                id: "e",
                title: "Stats Final",
                date: "2026-05-11",
                startTime: "13:00",
                endTime: "15:00",
              },
            },
          ],
        }),
        { now: NOW },
      ),
    );
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain("SUMMARY:Stats Final");
  });

  it("rolls an overnight event's end onto the next day", () => {
    const lines = unfold(
      buildIcs(
        schedule({
          events: [
            {
              id: "e",
              title: "Hackathon",
              date: "2026-03-06",
              startTime: "20:00",
              endTime: "02:00",
            },
          ],
        }),
        { now: NOW },
      ),
    );
    expect(lines).toContain("DTSTART;TZID=America/New_York:20260306T200000");
    expect(lines).toContain("DTEND;TZID=America/New_York:20260307T020000");
  });

  it("escapes reserved characters in TEXT values", () => {
    const lines = unfold(
      buildIcs(
        schedule({
          events: [
            {
              id: "e",
              title: "Review; Q&A, part 2",
              date: "2026-03-06",
              startTime: "10:00",
              endTime: "11:00",
              notes: "Bring:\nlaptop",
            },
          ],
        }),
        { now: NOW },
      ),
    );
    expect(lines).toContain("SUMMARY:Review\\; Q&A\\, part 2");
    expect(lines).toContain("DESCRIPTION:Bring:\\nlaptop");
  });

  it("folds long lines to 75 octets without splitting a code point", () => {
    const ics = buildIcs(
      schedule({
        events: [
          {
            id: "e",
            title: `Café ${"x".repeat(120)}`,
            date: "2026-03-06",
            startTime: "10:00",
            endTime: "11:00",
          },
        ],
      }),
      { now: NOW },
    );
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(unfold(ics).some((l) => l.includes("Café"))).toBe(true);
  });

  it("gives colliding ids distinct UIDs", () => {
    const lines = unfold(
      buildIcs(
        schedule({
          events: [
            { id: "dup", title: "A", date: "2026-03-06", startTime: "10:00", endTime: "11:00" },
            { id: "dup", title: "B", date: "2026-03-07", startTime: "10:00", endTime: "11:00" },
          ],
        }),
        { now: NOW },
      ),
    );
    const uids = lines.filter((l) => l.startsWith("UID:"));
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("rejects schedules it cannot represent", () => {
    expect(() => buildIcs(schedule(), { now: NOW })).toThrow(IcsError);
    expect(() =>
      buildIcs(schedule({ timezone: "Mars/Olympus_Mons" }), { now: NOW }),
    ).toThrow(IcsError);
    expect(() =>
      buildIcs(
        schedule({
          semesterStart: "2026-05-08",
          semesterEnd: "2026-01-12",
          courses: [mwf.courses[0]],
        }),
        { now: NOW },
      ),
    ).toThrow(/on or before/);
    expect(() =>
      buildIcs(
        schedule({
          courses: [{ ...mwf.courses[0], startTime: "10:45", endTime: "09:30" }],
        }),
        { now: NOW },
      ),
    ).toThrow(/ends at or before/);
    expect(() =>
      buildIcs(schedule({ courses: [{ ...mwf.courses[0], days: [] }] }), {
        now: NOW,
      }),
    ).toThrow(/no meeting days/);
  });
});

describe("icsFilename", () => {
  it("slugifies the calendar name", () => {
    expect(icsFilename(schedule({ calendarName: "Spring 2026 — Classes" }))).toBe(
      "spring-2026-classes.ics",
    );
    expect(icsFilename(schedule())).toBe("class-schedule.ics");
  });
});

describe("zonedWallTimeToUtc", () => {
  it("resolves offsets on both sides of a DST transition", () => {
    // EST (UTC-5) before the March transition, EDT (UTC-4) after.
    expect(
      zonedWallTimeToUtc(2026, 1, 15, 12, 0, "America/New_York").toISOString(),
    ).toBe("2026-01-15T17:00:00.000Z");
    expect(
      zonedWallTimeToUtc(2026, 7, 15, 12, 0, "America/New_York").toISOString(),
    ).toBe("2026-07-15T16:00:00.000Z");
  });

  it("handles zones with no DST", () => {
    expect(
      zonedWallTimeToUtc(2026, 7, 15, 12, 0, "America/Phoenix").toISOString(),
    ).toBe("2026-07-15T19:00:00.000Z");
  });
});
