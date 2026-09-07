export type Json = Record<string, unknown>;

/**
 * The boundary between Google's JSON and this server's promises.
 *
 * Every tool declares an `outputSchema`, and the SDK validates the structured
 * half of every answer against it before the answer goes out: a value that
 * breaks the promise is not a wrong field, it is a whole call answered with
 * `Output validation error` and nothing else. A row that is not an object, a
 * `keys` entry that is a number, a `site` block that is `null`, a body that is
 * empty — each of those is legal JSON that a proxy, a captive portal or a
 * changed API can produce, and each used to take the entire listing down.
 *
 * These readers decide, per field, what to do with a value of the wrong
 * shape: skip the element, drop the field, or stringify the primitive. Never
 * throw on one entry, and never let the schema be the thing that refuses.
 */

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
 * an error, because that means the response shape changed. Entries that are not
 * objects are dropped: a listing is a list of records, and a stray number in it
 * is not one.
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
  return value.filter(isRecord);
}

/** Reads an object out of a response that should be one. */
export function objectOf(body: unknown, what: string): Json {
  if (!isRecord(body)) {
    throw new Error(`expected a ${what} object from Google`);
  }
  return body;
}

/** An object, or an empty one where Google sent nothing or something else. */
export function recordOr(body: unknown): Json {
  return isRecord(body) ? body : {};
}

/** The array a field holds, or an empty one where it holds anything else. */
export function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A string, or undefined where Google sent anything else. */
export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * A finite number, or undefined.
 *
 * `JSON.parse` turns `1e999` into `Infinity`, which `typeof` calls a number and
 * an output schema refuses. `-0` is folded into `0`: it serialises as `0`, so
 * the text block and the structured half would otherwise disagree.
 */
export function finiteNumberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value + 0
    : undefined;
}

/**
 * The `site` block of a verification resource, or null where it is not one.
 *
 * The block is `{type, identifier}`; a resource with `site: null`, a string, or
 * an identifier that is not a string is not a site this server can name, and
 * one such entry must not fail the listing the rest are in.
 */
export function siteBlockOf(
  value: unknown
): { type: string; identifier: string } | null {
  if (!isRecord(value)) return null;
  const { type, identifier } = value;
  if (typeof type !== 'string' || typeof identifier !== 'string') return null;
  return { type, identifier };
}

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
