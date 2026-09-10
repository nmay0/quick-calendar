import { NextResponse } from "next/server";
import {
  ExtractionError,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
  type SupportedImageType,
  extractSchedule,
} from "@/lib/extract";
import { checkRateLimit, clientKey } from "@/lib/rate-limit";

export const runtime = "nodejs";
/** Vision calls take a while; give the route room beyond the platform default. */
export const maxDuration = 60;

function isSupported(type: string): type is SupportedImageType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(type);
}

function error(message: string, status: number, extraHeaders?: HeadersInit) {
  return NextResponse.json({ error: message }, { status, headers: extraHeaders });
}

/**
 * POST /api/extract
 *
 * Accepts either `multipart/form-data` with an `image` file (what the browser
 * sends) or `application/json` with `{ imageBase64, mediaType }` (convenient
 * for server-to-server integration).
 *
 * Responds with `{ courses, warnings }`. Nothing is persisted.
 */
export async function POST(request: Request) {
  const limit = checkRateLimit(clientKey(request));
  if (!limit.allowed) {
    return error(
      `Too many uploads. Try again in ${limit.retryAfter}s.`,
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  let base64: string;
  let mediaType: SupportedImageType;

  const contentType = request.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("image");
      if (!(file instanceof File)) {
        return error("Attach an image as the `image` field.", 400);
      }
      if (!isSupported(file.type)) {
        return error(
          `Unsupported image type "${file.type || "unknown"}". Use JPEG, PNG, GIF, or WebP.`,
          415,
        );
      }
      if (file.size > MAX_IMAGE_BYTES) {
        return error("That image is too large. Keep it under 3.5MB.", 413);
      }
      base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      mediaType = file.type;
    } else if (contentType.includes("application/json")) {
      const body = (await request.json()) as {
        imageBase64?: unknown;
        mediaType?: unknown;
      };
      if (typeof body.imageBase64 !== "string" || !body.imageBase64) {
        return error("Provide `imageBase64` as a base64-encoded string.", 400);
      }
      if (typeof body.mediaType !== "string" || !isSupported(body.mediaType)) {
        return error(
          "Provide `mediaType` as one of image/jpeg, image/png, image/gif, image/webp.",
          415,
        );
      }
      // base64 inflates by ~4/3; compare against the decoded size.
      if ((body.imageBase64.length * 3) / 4 > MAX_IMAGE_BYTES) {
        return error("That image is too large. Keep it under 3.5MB.", 413);
      }
      base64 = body.imageBase64;
      mediaType = body.mediaType;
    } else {
      return error(
        "Send multipart/form-data with an `image` file, or JSON with `imageBase64` and `mediaType`.",
        415,
      );
    }
  } catch {
    return error("Could not read the request body.", 400);
  }

  try {
    const result = await extractSchedule(base64, mediaType);
    return NextResponse.json(result, {
      // Extraction output is per-user and never reusable.
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof ExtractionError) {
      return error(err.message, err.status);
    }
    console.error("Unexpected extraction failure", err);
    return error("Something went wrong reading that image.", 500);
  }
}
