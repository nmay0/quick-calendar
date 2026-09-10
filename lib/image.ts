/**
 * Client-side image preparation.
 *
 * A photo straight off a modern phone camera is routinely 5–12MB, well past
 * what the vision endpoint accepts, so resizing in the browser is what makes
 * "snap a photo of the projected schedule" actually work. Downscaling here also
 * cuts upload time on cell data and image tokens on the API call.
 */

/** Long-edge cap. Comfortably inside the model's high-res tier for legible text. */
const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.92;

export interface PreparedImage {
  blob: Blob;
  type: string;
  /** A blob: URL for the preview thumbnail. Caller revokes it. */
  previewUrl: string;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file).catch(() => null);

  // If the browser can't decode it (HEIC on a non-Apple browser, say), send the
  // original and let the server's type check produce the error message.
  if (!bitmap) {
    return {
      blob: file,
      type: file.type,
      previewUrl: URL.createObjectURL(file),
    };
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return {
      blob: file,
      type: file.type,
      previewUrl: URL.createObjectURL(file),
    };
  }

  // White backdrop so a transparent PNG doesn't flatten to black text on black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );

  if (!blob) {
    return {
      blob: file,
      type: file.type,
      previewUrl: URL.createObjectURL(file),
    };
  }

  return {
    blob,
    type: "image/jpeg",
    previewUrl: URL.createObjectURL(blob),
  };
}
