"use client";

import type { ReactNode } from "react";

/**
 * Form primitives shared across the review screen.
 *
 * Everything tappable is at least 44px tall, and inputs inherit the 16px base
 * font from globals.css so focusing one never zooms mobile Safari.
 */

const CONTROL =
  "min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-foreground " +
  "outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30 " +
  "placeholder:text-muted/70";

export function Label({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: string;
}) {
  return (
    <span className="mb-1 block text-sm font-medium text-muted">
      {children}
      {hint ? <span className="ml-1 font-normal opacity-80">{hint}</span> : null}
    </span>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  autoComplete = "off",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "date" | "time";
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <Label>{label}</Label>
      <input
        className={CONTROL}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  type = "button",
  disabled,
  full,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  full?: boolean;
}) {
  const styles: Record<string, string> = {
    primary: "bg-accent text-accent-foreground hover:opacity-90",
    secondary: "border border-line bg-surface text-foreground hover:border-accent",
    ghost: "text-accent hover:underline",
    danger: "text-danger hover:underline",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={[
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4",
        "text-base font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        styles[variant],
        full ? "w-full" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  title,
  onRemove,
  removeLabel = "Remove",
  problems,
  id,
}: {
  children: ReactNode;
  title: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  problems?: string[];
  /** Anchor for scrolling a failed card into view on submit. */
  id?: string;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-4 rounded-xl border border-line bg-surface p-4 shadow-sm"
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold leading-tight">{title}</h3>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="-mr-2 -mt-2 min-h-11 shrink-0 px-2 text-sm font-medium text-danger"
          >
            {removeLabel}
          </button>
        ) : null}
      </header>
      {problems?.length ? (
        <ul className="mb-3 space-y-1 rounded-lg bg-danger/10 p-3 text-sm text-danger">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function Notice({
  tone = "warning",
  title,
  children,
}: {
  tone?: "warning" | "error";
  title?: string;
  children: ReactNode;
}) {
  const styles =
    tone === "error"
      ? "border-danger/40 bg-danger/10 text-danger"
      : "border-warning-border bg-warning-bg text-warning-foreground";
  return (
    <div className={`rounded-xl border p-4 text-sm ${styles}`} role="status">
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      {children}
    </div>
  );
}
