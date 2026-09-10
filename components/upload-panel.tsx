"use client";

import { useRef, useState } from "react";
import { prepareImage } from "@/lib/image";
import type { ExtractionResult } from "@/lib/types";
import { Button, Notice } from "./ui";

/**
 * Step one: get a schedule image in.
 *
 * Two separate inputs on purpose. `accept="image/*"` with no `capture` is what
 * gives iOS the full "Photo Library / Take Photo / Choose File" sheet — adding
 * `capture` would force the camera and take the photo library away, which is
 * the wrong default when most people are uploading a screenshot. The second
 * input carries `capture="environment"` for people who do want to go straight
 * to the camera to shoot a printed or projected schedule.
 */
export function UploadPanel({
  onExtracted,
  onSkip,
}: {
  onExtracted: (result: ExtractionResult) => void;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);

    let previewUrl: string | null = null;
    try {
      const prepared = await prepareImage(file);
      previewUrl = prepared.previewUrl;
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return prepared.previewUrl;
      });

      const body = new FormData();
      body.append(
        "image",
        new File([prepared.blob], "schedule.jpg", { type: prepared.type }),
      );

      const response = await fetch("/api/extract", { method: "POST", body });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload?.error ?? "Could not read that image.");
        return;
      }

      const result = payload as ExtractionResult;
      if (result.courses.length === 0) {
        setError(
          "No courses were found in that image. Try a clearer or less cropped screenshot, or enter your courses by hand.",
        );
        return;
      }
      onExtracted(result);
    } catch {
      setError("Something went wrong uploading that image. Try again.");
    } finally {
      setBusy(false);
      if (previewUrl === null && preview) URL.revokeObjectURL(preview);
      // Reset both inputs so picking the same file twice still fires onChange.
      if (pickRef.current) pickRef.current.value = "";
      if (cameraRef.current) cameraRef.current.value = "";
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-surface p-5 text-center">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob: preview of a user file, not an optimizable asset
          <img
            src={preview}
            alt="Your uploaded schedule"
            className="mx-auto mb-4 max-h-56 rounded-lg border border-line object-contain"
          />
        ) : (
          <p className="mb-4 text-sm text-muted">
            Upload a screenshot of your course schedule, or take a photo of a
            printed one.
          </p>
        )}

        <input
          ref={pickRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => handleFile(event.target.files?.[0])}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(event) => handleFile(event.target.files?.[0])}
        />

        <div className="space-y-3">
          <Button
            variant="primary"
            full
            disabled={busy}
            onClick={() => pickRef.current?.click()}
          >
            {busy ? "Reading your schedule…" : "Choose a screenshot"}
          </Button>
          <Button
            full
            disabled={busy}
            onClick={() => cameraRef.current?.click()}
          >
            Take a photo
          </Button>
        </div>

        {busy ? (
          <p className="mt-3 text-sm text-muted">
            This usually takes a few seconds.
          </p>
        ) : null}
      </div>

      {error ? (
        <Notice tone="error" title="Couldn't read that">
          {error}
        </Notice>
      ) : null}

      <div className="text-center">
        <Button variant="ghost" onClick={onSkip} disabled={busy}>
          Skip and enter courses by hand
        </Button>
      </div>

      <p className="text-center text-xs text-muted">
        Your image is read once and never stored. Nothing is saved on the server.
      </p>
    </div>
  );
}
