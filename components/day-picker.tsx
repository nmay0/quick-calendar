"use client";

import { WEEKDAYS, WEEKDAY_LABELS, type Weekday } from "@/lib/types";
import { Label } from "./ui";

/**
 * Weekday toggles. Rendered as buttons rather than checkboxes so each target is
 * a full 44px square on a phone — a row of native checkboxes is far too small
 * to hit reliably, and this is the field OCR most often gets wrong.
 */
export function DayPicker({
  value,
  onChange,
  disabled,
}: {
  value: Weekday[];
  onChange: (days: Weekday[]) => void;
  disabled?: boolean;
}) {
  const toggle = (day: Weekday) => {
    onChange(
      value.includes(day) ? value.filter((d) => d !== day) : [...value, day],
    );
  };

  return (
    <div>
      <Label>Meeting days</Label>
      <div className="flex flex-wrap gap-2">
        {WEEKDAYS.map((day) => {
          const selected = value.includes(day);
          return (
            <button
              key={day}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => toggle(day)}
              className={[
                "min-h-11 min-w-11 flex-1 rounded-lg border px-2 text-sm font-medium transition",
                "disabled:cursor-not-allowed disabled:opacity-40",
                selected
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-line bg-surface text-muted",
              ].join(" ")}
            >
              {WEEKDAY_LABELS[day]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
