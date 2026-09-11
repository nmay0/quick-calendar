import { describe, expect, test } from "vitest";
import { parseModelOutput } from "../extract";

/** Wrap a single course so only the time fields are under test. */
function timesOf(startTime: unknown, endTime: unknown) {
  const [course] = parseModelOutput(
    JSON.stringify({ courses: [{ name: "CS 101", days: ["MO"], startTime, endTime }] }),
  ).courses;
  return [course?.startTime, course?.endTime];
}

describe("time normalization", () => {
  test("keeps 24-hour times", () => {
    expect(timesOf("09:30", "10:45")).toEqual(["09:30", "10:45"]);
  });

  test("zero-pads a single-digit 24-hour time", () => {
    expect(timesOf("9:30", "10:45")).toEqual(["09:30", "10:45"]);
  });

  // gemini-2.5-flash-lite really returns this shape despite the JSON Schema.
  test("accepts the 12-hour clock", () => {
    expect(timesOf("9:30 AM", "10:45 AM")).toEqual(["09:30", "10:45"]);
    expect(timesOf("2:00 PM", "3:15 PM")).toEqual(["14:00", "15:15"]);
  });

  test("accepts 12-hour spelling variants", () => {
    expect(timesOf("9:30am", "1:00p.m.")).toEqual(["09:30", "13:00"]);
  });

  test("maps noon and midnight correctly", () => {
    expect(timesOf("12:00 AM", "12:30 PM")).toEqual(["00:00", "12:30"]);
  });

  test("rejects nonsense rather than guessing", () => {
    expect(timesOf("25:00", "13:00 PM")).toEqual([null, null]);
    expect(timesOf("noon", 930)).toEqual([null, null]);
  });
});

describe("parseModelOutput", () => {
  test("unwraps a ```json fence", () => {
    const out = parseModelOutput('```json\n{"courses":[],"warnings":["w"]}\n```');
    expect(out.warnings).toEqual(["w"]);
  });

  test("a course with no days and no times is async", () => {
    const [course] = parseModelOutput(
      JSON.stringify({ courses: [{ name: "ONLINE 200", days: [], startTime: null, endTime: null }] }),
    ).courses;
    expect(course.async).toBe(true);
  });

  test("a timed course is not async", () => {
    const [course] = parseModelOutput(
      JSON.stringify({ courses: [{ name: "CS 101", days: ["MO"], startTime: "9:00 AM", endTime: "9:50 AM" }] }),
    ).courses;
    expect(course.async).toBe(false);
    expect(course.startTime).toBe("09:00");
  });

  test("drops unnamed courses", () => {
    expect(parseModelOutput(JSON.stringify({ courses: [{ name: "  " }] })).courses).toEqual([]);
  });
});
