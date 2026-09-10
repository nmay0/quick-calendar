"use client";

import { useMemo } from "react";
import { Label } from "./ui";

/** Fallback list for runtimes without `Intl.supportedValuesOf`. */
const COMMON_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/**
 * The timezone is pre-filled from the device and shown rather than hidden:
 * getting it wrong silently shifts every class by hours, and a student
 * registering from home over break would otherwise never notice.
 */
export function TimezoneSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const zones = useMemo(() => {
    const supported =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : COMMON_ZONES;
    // Guarantee the current value is selectable even if it's not in the list.
    return supported.includes(value) ? supported : [value, ...supported];
  }, [value]);

  return (
    <label className="block">
      <Label hint="(your school's local time)">Timezone</Label>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
      >
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zone.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    </label>
  );
}
