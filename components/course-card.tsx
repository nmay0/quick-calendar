"use client";

import { newId } from "@/lib/id";
import type { Course, SingleEvent, Weekday } from "@/lib/types";
import { DayPicker } from "./day-picker";
import { EventFields } from "./event-fields";
import { Button, Card, Label, TextField } from "./ui";

/**
 * One course = one card. A wide multi-column table is unusable on a phone, so
 * fields stack vertically and the exam lives in a collapsed sub-section that
 * only expands once the student adds one.
 */
export function CourseCard({
  course,
  index,
  problems,
  onChange,
  onRemove,
}: {
  course: Course;
  index: number;
  problems?: string[];
  onChange: (next: Course) => void;
  onRemove: () => void;
}) {
  const set = <K extends keyof Course>(key: K, value: Course[K]) =>
    onChange({ ...course, [key]: value });

  const addExam = () => {
    const exam: SingleEvent = {
      id: newId("exam"),
      title: `${course.name.trim() || "Course"} — Final Exam`,
      date: "",
      startTime: "",
      endTime: "",
      location: course.location ?? null,
      notes: null,
    };
    set("exam", exam);
  };

  return (
    <Card
      id={`card-${course.id}`}
      title={course.name.trim() || `Course ${index + 1}`}
      onRemove={onRemove}
      problems={problems}
    >
      <TextField
        label="Course name"
        value={course.name}
        placeholder="CS 101 Lecture"
        onChange={(v) => set("name", v)}
      />

      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          className="size-5 accent-[var(--accent)]"
          checked={course.async === true}
          onChange={(event) => set("async", event.target.checked)}
        />
        <span className="text-sm">
          Asynchronous / online — no fixed meeting time
        </span>
      </label>

      {course.async ? (
        <p className="text-sm text-muted">
          No weekly event will be created for this course. You can still add an
          exam below.
        </p>
      ) : (
        <>
          <DayPicker
            value={course.days}
            onChange={(days: Weekday[]) => set("days", days)}
          />
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Starts"
              type="time"
              value={course.startTime}
              onChange={(v) => set("startTime", v)}
            />
            <TextField
              label="Ends"
              type="time"
              value={course.endTime}
              onChange={(v) => set("endTime", v)}
            />
          </div>
          <TextField
            label="Location"
            value={course.location ?? ""}
            placeholder="Optional"
            onChange={(v) => set("location", v)}
          />
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Section"
          value={course.section ?? ""}
          placeholder="Optional"
          onChange={(v) => set("section", v)}
        />
        <TextField
          label="Instructor"
          value={course.instructor ?? ""}
          placeholder="Optional"
          onChange={(v) => set("instructor", v)}
        />
      </div>

      <div className="rounded-lg border border-dashed border-line p-3">
        {course.exam ? (
          <>
            <div className="mb-3 flex items-center justify-between gap-3">
              <Label>Final exam</Label>
              <button
                type="button"
                onClick={() => set("exam", null)}
                className="min-h-11 px-2 text-sm font-medium text-danger"
              >
                Remove exam
              </button>
            </div>
            <div className="space-y-3">
              <EventFields
                value={course.exam}
                onChange={(next) => set("exam", next)}
                titleLabel="Exam title"
              />
            </div>
          </>
        ) : (
          <Button onClick={addExam} variant="ghost">
            + Add a final exam
          </Button>
        )}
      </div>
    </Card>
  );
}
