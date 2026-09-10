"use client";

import type { SingleEvent } from "@/lib/types";
import { EventFields } from "./event-fields";
import { Card } from "./ui";

/** A one-off event: club meeting, extracurricular, one-time deadline. */
export function EventCard({
  event,
  index,
  problems,
  onChange,
  onRemove,
}: {
  event: SingleEvent;
  index: number;
  problems?: string[];
  onChange: (next: SingleEvent) => void;
  onRemove: () => void;
}) {
  return (
    <Card
      id={`card-${event.id}`}
      title={event.title.trim() || `Event ${index + 1}`}
      onRemove={onRemove}
      problems={problems}
    >
      <EventFields
        value={event}
        onChange={onChange}
        titlePlaceholder="Robotics club meeting"
      />
    </Card>
  );
}
