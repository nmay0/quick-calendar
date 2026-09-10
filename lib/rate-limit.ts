/**
 * A small fixed-window rate limiter for the vision endpoint, which costs real
 * money per call.
 *
 * This is per-process state. It is enough for a single long-lived server or a
 * personal deployment, and it is NOT a substitute for a shared store if you run
 * multiple instances or deploy to a scale-to-zero serverless platform — each
 * instance would keep its own counter. Swap in Redis/Upstash before making this
 * public-facing at any scale.
 */

interface Window {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.EXTRACT_RATE_LIMIT ?? 10);

const windows = new Map<string, Window>();

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry. Only meaningful when blocked. */
  retryAfter: number;
}

export function checkRateLimit(key: string, now = Date.now()): RateLimitResult {
  // Opportunistic sweep so the map can't grow without bound.
  if (windows.size > 5000) {
    for (const [k, w] of windows) {
      if (w.resetAt <= now) windows.delete(k);
    }
  }

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }

  if (existing.count >= MAX_PER_WINDOW) {
    return {
      allowed: false,
      retryAfter: Math.ceil((existing.resetAt - now) / 1000),
    };
  }

  existing.count += 1;
  return { allowed: true, retryAfter: 0 };
}

/** Best-effort client identity from proxy headers, falling back to a shared bucket. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
