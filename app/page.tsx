import { ScheduleBuilder } from "@/components/schedule-builder";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">
          Schedule to Calendar
        </h1>
        <p className="mt-1 text-sm text-muted">
          Upload your course schedule, check what we read, and add the whole
          semester to your calendar in one tap.
        </p>
      </header>
      <ScheduleBuilder />
    </main>
  );
}
