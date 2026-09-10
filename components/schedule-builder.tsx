"use client";

import { useMemo, useRef, useState } from "react";
import { newId } from "@/lib/id";
import { detectTimeZone } from "@/lib/tz";
import type {
  Course,
  ExtractedCourse,
  ExtractionResult,
  Schedule,
  SingleEvent,
} from "@/lib/types";
import { validateSchedule } from "@/lib/validate";
import { CourseCard } from "./course-card";
import { EventCard } from "./event-card";
import { TimezoneSelect } from "./timezone-select";
import { UploadPanel } from "./upload-panel";
import { Button, Notice, TextField } from "./ui";

type Stage = "upload" | "review";

function toCourse(extracted: ExtractedCourse): Course {
  return {
    id: newId("course"),
    name: extracted.name,
    section: extracted.section,
    days: extracted.days,
    startTime: extracted.startTime ?? "",
    endTime: extracted.endTime ?? "",
    location: extracted.location,
    instructor: extracted.instructor,
    async: extracted.async,
    exam: null,
  };
}

function blankCourse(): Course {
  return {
    id: newId("course"),
    name: "",
    section: null,
    days: [],
    startTime: "",
    endTime: "",
    location: null,
    instructor: null,
    async: false,
    exam: null,
  };
}

function blankEvent(): SingleEvent {
  return {
    id: newId("event"),
    title: "",
    date: "",
    startTime: "",
    endTime: "",
    location: null,
    notes: null,
  };
}

export function ScheduleBuilder() {
  const [stage, setStage] = useState<Stage>("upload");
  const [timezone, setTimezone] = useState(detectTimeZone);
  const [semesterStart, setSemesterStart] = useState("");
  const [semesterEnd, setSemesterEnd] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);
  const [events, setEvents] = useState<SingleEvent[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const schedule: Schedule = useMemo(
    () => ({
      timezone,
      semesterStart,
      semesterEnd,
      courses,
      events,
      calendarName: "Class Schedule",
    }),
    [timezone, semesterStart, semesterEnd, courses, events],
  );

  const validation = useMemo(() => validateSchedule(schedule), [schedule]);

  function handleExtracted(result: ExtractionResult) {
    setCourses(result.courses.map(toCourse));
    setWarnings(result.warnings);
    setStage("review");
  }

  function startBlank() {
    setCourses([blankCourse()]);
    setWarnings([]);
    setStage("review");
  }

  function updateCourse(next: Course) {
    setCourses((prev) => prev.map((c) => (c.id === next.id ? next : c)));
  }

  function updateEvent(next: SingleEvent) {
    setEvents((prev) => prev.map((e) => (e.id === next.id ? next : e)));
  }

  function download() {
    if (!validation.ok) {
      setShowErrors(true);
      // The page is long on a phone. Without this, tapping the button when the
      // only problem is three cards down looks like nothing happened.
      const target =
        validation.general.length > 0
          ? "schedule-problems"
          : `card-${
              Object.keys(validation.courses)[0] ??
              Object.keys(validation.events)[0]
            }`;
      // The banner only mounts once showErrors flips, so wait a frame.
      requestAnimationFrame(() => {
        document
          .getElementById(target)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return;
    }
    setShowErrors(false);
    // A real form POST, not fetch: iOS Safari only hands a .ics to Calendar
    // when the response comes from a top-level navigation.
    formRef.current?.submit();
  }

  if (stage === "upload") {
    return (
      <UploadPanel onExtracted={handleExtracted} onSkip={startBlank} />
    );
  }

  return (
    <div className="space-y-6 pb-28">
      {warnings.length > 0 ? (
        <Notice title="Double-check these">
          <ul className="list-disc space-y-1 pl-5">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {showErrors && validation.general.length > 0 ? (
        <div id="schedule-problems">
          <Notice tone="error" title="Fix these before exporting">
            <ul className="list-disc space-y-1 pl-5">
              {validation.general.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}

      <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-base font-semibold">Semester dates</h2>
        <p className="text-sm text-muted">
          Schedules almost never show these — check your registrar&apos;s
          academic calendar. Classes repeat weekly between these two dates.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="First day"
            type="date"
            value={semesterStart}
            onChange={setSemesterStart}
          />
          <TextField
            label="Last day"
            type="date"
            value={semesterEnd}
            onChange={setSemesterEnd}
          />
        </div>
        <TimezoneSelect value={timezone} onChange={setTimezone} />
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">
            Courses{courses.length ? ` (${courses.length})` : ""}
          </h2>
          <Button variant="ghost" onClick={() => setCourses((p) => [...p, blankCourse()])}>
            + Add course
          </Button>
        </div>
        {courses.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
            No courses yet.
          </p>
        ) : (
          courses.map((course, index) => (
            <CourseCard
              key={course.id}
              course={course}
              index={index}
              problems={showErrors ? validation.courses[course.id] : undefined}
              onChange={updateCourse}
              onRemove={() =>
                setCourses((prev) => prev.filter((c) => c.id !== course.id))
              }
            />
          ))
        )}
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Other events</h2>
          <Button variant="ghost" onClick={() => setEvents((p) => [...p, blankEvent()])}>
            + Add event
          </Button>
        </div>
        <p className="text-sm text-muted">
          Club meetings, one-time deadlines, anything else that belongs on the
          same calendar.
        </p>
        {events.map((event, index) => (
          <EventCard
            key={event.id}
            event={event}
            index={index}
            problems={showErrors ? validation.events[event.id] : undefined}
            onChange={updateEvent}
            onRemove={() =>
              setEvents((prev) => prev.filter((e) => e.id !== event.id))
            }
          />
        ))}
      </section>

      <Notice>
        Holidays, breaks, and mid-semester room changes are not handled — your
        classes will show up on every week between the two dates above. Delete
        the occurrences you don&apos;t need after importing.
      </Notice>

      <form
        ref={formRef}
        method="POST"
        action="/api/generate-ics"
        className="hidden"
      >
        <input type="hidden" name="schedule" value={JSON.stringify(schedule)} />
      </form>

      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-background/95 p-4 backdrop-blur">
        <div className="mx-auto max-w-2xl">
          <Button variant="primary" full onClick={download}>
            Add to calendar
          </Button>
          <p className="mt-2 text-center text-xs text-muted">
            Opens your calendar app with every class, exam, and event.
          </p>
        </div>
      </div>
    </div>
  );
}
