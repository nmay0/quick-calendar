"use client";

import type { SingleEvent } from "@/lib/types";
import { TextField } from "./ui";

/**
 * The date/time/location block shared by exams and one-off events.
 *
 * Uses native `date` and `time` inputs rather than a custom picker: on a phone
 * these get the OS wheel/keypad for free, and `time` always yields 24-hour
 * HH:MM regardless of how the locale displays it.
 */
export function EventFields({
  value,
  onChange,
  titleLabel = "Title",
  titlePlaceholder,
}: {
  value: SingleEvent;
  onChange: (next: SingleEvent) => void;
  titleLabel?: string;
  titlePlaceholder?: string;
}) {
  const set = <K extends keyof SingleEvent>(key: K, next: SingleEvent[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <>
      <TextField
        label={titleLabel}
        value={value.title}
        placeholder={titlePlaceholder}
        onChange={(v) => set("title", v)}
      />
      <TextField
        label="Date"
        type="date"
        value={value.date}
        onChange={(v) => set("date", v)}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Starts"
          type="time"
          value={value.startTime}
          onChange={(v) => set("startTime", v)}
        />
        <TextField
          label="Ends"
          type="time"
          value={value.endTime}
          onChange={(v) => set("endTime", v)}
        />
      </div>
      <TextField
        label="Location"
        value={value.location ?? ""}
        placeholder="Optional"
        onChange={(v) => set("location", v)}
      />
    </>
  );
}
