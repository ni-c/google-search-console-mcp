export type Json = Record<string, unknown>;

/**
 * Reads an array out of a Google list response.
 *
 * Google omits an empty array entirely rather than sending `[]`. `sites.list`
 * for a credential with no properties answers `{}`, not `{"siteEntry": []}`, and
 * the same is true of `sitemaps.list` and Site Verification's `items`. Code that
 * reaches for `body.siteEntry.length` therefore throws on the one case it most
 * needs to handle gracefully — a fresh service account nobody has granted
 * anything to yet, which is every first run.
 *
 * A missing field is an empty list. A field that is present but not an array is
 * an error, because that means the response shape changed.
 */
export function listField(body: unknown, field: string): Json[] {
  if (body === undefined || body === null) return [];
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(
      `expected an object from Google but got ${Array.isArray(body) ? 'an array' : typeof body}`
    );
  }
  const value = (body as Json)[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `expected "${field}" to be a list in Google's response but got ${typeof value}`
    );
  }
  return value as Json[];
}

/** Reads an object out of a response that should be one. */
export function objectOf(body: unknown, what: string): Json {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`expected a ${what} object from Google`);
  }
  return body as Json;
}
