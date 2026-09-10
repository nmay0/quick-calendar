/**
 * Shared error type for the extraction path.
 *
 * It lives in its own module because both `lib/providers.ts` and
 * `lib/extract.ts` throw it, and putting it in either one would make the two
 * import each other.
 */

export class ExtractionError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}
