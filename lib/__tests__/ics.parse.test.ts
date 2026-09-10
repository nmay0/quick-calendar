/**
 * Round-trip verification: everything here parses the generated file with a
 * real iCalendar implementation (ical.js) rather than matching strings, so a
 * document that looks right but doesn't actually import correctly still fails.
 */

import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { buildIcs } from "../ics";
import type { Schedule } from "../types";

const NOW = new Date("2026-01-01T00:00:00Z");

const schedule: Schedule = {
  timezone: "America/New_York",
  semesterStart: "2026-01-12", // Monday
  semesterEnd: "2026-05-08", // Friday
  calendarName: "Spring 2026",
  courses: [
    {
      id: "cs101",
      name: "CS 101 Lecture",
      section: "001",
      days: ["MO", "WE", "FR"],
      startTime: "09:30",
      endTime: "10:45",
      location: "Thornton Hall 102",
      instructor: "Dr. Ada Lovelace",
      exam: {
        id: "cs101-exam",
        title: "CS 101 Final",
        date: "2026-05-12",
        startTime: "09:00",
        endTime: "11:00",
        location: "Gym",
      },
    },
    {
      id: "chem-lab",
      name: "CHEM 1410 Lab",
      days: ["TU"],
      startTime: "13:00",
      endTime: "15:50",
      location: "Chem 305",
    },
  ],
  events: [
    {
      id: "club",
      title: "Robotics Club",
      date: "2026-02-03",
      startTime: "18:00",
      endTime: "19:30",
      location: null,
      notes: "Bring the prototype",
    },
  ],
};

function parse(ics: string) {
  const component = new ICAL.Component(ICAL.parse(ics));
  return {
    component,
    events: component
      .getAllSubcomponents("vevent")
      .map((v) => new ICAL.Event(v)),
  };
}

describe("generated calendars parse with ical.js", () => {
  const ics = buildIcs(schedule, { now: NOW });

  it("produces a well-formed VCALENDAR", () => {
    const { component } = parse(ics);
    expect(component.name).toBe("vcalendar");
    expect(component.getFirstPropertyValue("version")).toBe("2.0");
    expect(component.getAllSubcomponents("vtimezone")).toHaveLength(1);
    expect(component.getAllSubcomponents("vevent")).toHaveLength(4);
  });

  it("registers a VTIMEZONE the parser can resolve", () => {
    const { component } = parse(ics);
    const vtimezone = component.getFirstSubcomponent("vtimezone")!;
    const timezone = new ICAL.Timezone(vtimezone);
    expect(timezone.tzid).toBe("America/New_York");
    // -5h in January (EST), -4h in July (EDT): the DST rules survived the trip.
    expect(
      timezone.utcOffset(ICAL.Time.fromDateTimeString("2026-01-15T12:00:00")),
    ).toBe(-5 * 3600);
    expect(
      timezone.utcOffset(ICAL.Time.fromDateTimeString("2026-07-15T12:00:00")),
    ).toBe(-4 * 3600);
  });

  it("expands the MWF class to every meeting in the semester", () => {
    const { component, events } = parse(ics);
    ICAL.TimezoneService.register(
      component.getFirstSubcomponent("vtimezone")!,
    );

    const lecture = events.find((e) => e.summary === "CS 101 Lecture")!;
    expect(lecture.isRecurring()).toBe(true);

    const iterator = lecture.iterator();
    const occurrences: ICAL.Time[] = [];
    for (let next = iterator.next(); next; next = iterator.next()) {
      occurrences.push(next);
      if (occurrences.length > 500) break;
    }

    // 17 weeks of Mon/Wed/Fri from Jan 12 through May 8 inclusive.
    expect(occurrences).toHaveLength(51);
    expect(occurrences[0].toString()).toContain("2026-01-12T09:30:00");
    expect(occurrences.at(-1)!.toString()).toContain("2026-05-08T09:30:00");

    // Every occurrence lands on a Mon/Wed/Fri and keeps 09:30 local time
    // across the March DST transition.
    for (const occurrence of occurrences) {
      expect([2, 4, 6]).toContain(occurrence.dayOfWeek());
      expect(occurrence.hour).toBe(9);
      expect(occurrence.minute).toBe(30);
    }
  });

  it("keeps the same wall-clock time on both sides of a DST change", () => {
    const { component, events } = parse(ics);
    const timezone = new ICAL.Timezone(
      component.getFirstSubcomponent("vtimezone")!,
    );
    ICAL.TimezoneService.register(component.getFirstSubcomponent("vtimezone")!);

    const lecture = events.find((e) => e.summary === "CS 101 Lecture")!;
    const iterator = lecture.iterator();
    let beforeDst: ICAL.Time | null = null;
    let afterDst: ICAL.Time | null = null;
    for (let next = iterator.next(); next; next = iterator.next()) {
      // US DST starts 2026-03-08.
      if (!beforeDst && next.toString() >= "2026-03-06") beforeDst = next;
      if (!afterDst && next.toString() >= "2026-03-09") afterDst = next;
      if (beforeDst && afterDst) break;
    }

    expect(beforeDst!.hour).toBe(9);
    expect(afterDst!.hour).toBe(9);
    // Same wall clock, different UTC offset — this is the shift the plan warns about.
    expect(timezone.utcOffset(beforeDst!)).toBe(-5 * 3600);
    expect(timezone.utcOffset(afterDst!)).toBe(-4 * 3600);
  });

  it("leaves exams and one-off events non-recurring", () => {
    const { events } = parse(ics);
    const single = events.filter((e) => !e.isRecurring());
    expect(single.map((e) => e.summary).sort()).toEqual([
      "CS 101 Final",
      "Robotics Club",
    ]);
    const exam = single.find((e) => e.summary === "CS 101 Final")!;
    expect(exam.startDate.toString()).toContain("2026-05-12T09:00:00");
    expect(exam.endDate.toString()).toContain("2026-05-12T11:00:00");
    expect(exam.location).toBe("Gym");
  });

  it("round-trips escaped text unchanged", () => {
    const tricky = buildIcs(
      {
        ...schedule,
        courses: [],
        events: [
          {
            id: "e",
            title: "Review; Q&A, part 2",
            date: "2026-03-06",
            startTime: "10:00",
            endTime: "11:00",
            location: "Room 1, Bldg 2",
            notes: "Bring:\nlaptop",
          },
        ],
      },
      { now: NOW },
    );
    const { events } = parse(tricky);
    expect(events[0].summary).toBe("Review; Q&A, part 2");
    expect(events[0].location).toBe("Room 1, Bldg 2");
    expect(events[0].description).toBe("Bring:\nlaptop");
  });

  it("round-trips a folded multi-byte summary", () => {
    const folded = buildIcs(
      {
        ...schedule,
        courses: [],
        events: [
          {
            id: "e",
            title: `Café ${"x".repeat(120)}`,
            date: "2026-03-06",
            startTime: "10:00",
            endTime: "11:00",
            location: null,
            notes: null,
          },
        ],
      },
      { now: NOW },
    );
    const { events } = parse(folded);
    expect(events[0].summary).toBe(`Café ${"x".repeat(120)}`);
  });
});
