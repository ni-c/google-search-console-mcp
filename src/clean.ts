/**
 * What is done to text before it leaves this server.
 *
 * Everything Google hands back was written by somebody else — a search query
 * typed by a member of the public, a page title from a crawled site, an owner's
 * address, a verification token — and it goes into a model's context. Two
 * things are removed on the way, and only two:
 *
 * - **C0 and C1 control characters and DEL**, except tab, line feed and
 *   carriage return. A terminal escape in a page title can repaint the client's
 *   log; a NUL can end a string early for whatever reads it next. None of them
 *   carries meaning in any field Search Console returns.
 * - **Lone surrogates.** `"\ud800"` is legal JSON and parses to half a
 *   character; `JSON.stringify` writes it back as an escape so the wire stays
 *   valid, and a Python client encoding the text to UTF-8 then raises
 *   `UnicodeEncodeError: surrogates not allowed`. `toWellFormed()` replaces the
 *   half with U+FFFD — and it runs after every cut, because a cut can split a
 *   pair.
 *
 * Bidi marks, joiners and every other format character stay: they are content
 * in a query typed in Arabic or Hindi, and stripping them would change what the
 * person searched for.
 *
 * The character classes are decided by code point in a loop rather than spelled
 * as a regular expression, so that no escape sequence has to be written into
 * this file — a backslash-u escape in a source file is one editing tool away from
 * becoming the byte itself.
 */

function isControl(code: number): boolean {
  if (code < 0x20) return code !== 0x09 && code !== 0x0a && code !== 0x0d;
  return code >= 0x7f && code <= 0x9f;
}

/** Whether a string carries anything {@link cleanText} would remove. */
export function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isControl(value.charCodeAt(i))) return true;
  }
  return false;
}

/**
 * Strips control characters and repairs lone surrogates.
 *
 * Linear, and cheap on the common case: a string with nothing to remove is
 * returned as it came, after the well-formedness check that costs one pass.
 */
export function cleanText(value: string): string {
  let out: string | undefined;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (isControl(value.charCodeAt(i))) {
      out = (out ?? '') + value.slice(start, i);
      start = i + 1;
    }
  }
  const stripped = out === undefined ? value : out + value.slice(start);
  return stripped.isWellFormed() ? stripped : stripped.toWellFormed();
}

/**
 * {@link cleanText} over a whole structure.
 *
 * Rebuilds every object with `Object.fromEntries`, so a key of `__proto__` —
 * an own property after `JSON.parse`, and legal JSON from any backend — stays
 * an own property in the copy instead of becoming its prototype. Keys are
 * cleaned as well as values: a key is text a model reads too.
 *
 * Numbers, booleans and null pass through; `undefined` and functions cannot
 * come out of JSON and are dropped from objects, where `JSON.stringify` would
 * drop them anyway, and written as `null` in arrays, which is also what it
 * would do.
 */
export function cleanValue(value: unknown): unknown {
  if (typeof value === 'string') return cleanText(value);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry === undefined || typeof entry === 'function'
        ? null
        : cleanValue(entry)
    );
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(
        ([key, entry]) =>
          entry === undefined || typeof entry === 'function'
            ? []
            : [[cleanText(key), cleanValue(entry)]]
      )
    );
  }
  return value;
}

/** How much of a backend's text an error message may carry. */
const MAX_UPSTREAM_TEXT = 2000;

/**
 * Text written by whatever answered a request, made safe to quote.
 *
 * Google's error bodies are JSON, and the sentence that matters — which API is
 * disabled, which scope is missing — is in them. But the thing that answers is
 * not always Google: a corporate proxy, a captive portal or an outbound filter
 * writes its own body, and a typo in nothing (there is no configurable host
 * here) still leaves the network in between. So the text is trimmed, stripped
 * of control characters, cut, and labelled as what it is.
 */
export function upstreamText(text: string, max = MAX_UPSTREAM_TEXT): string {
  const trimmed = cleanText(text).trim();
  if (trimmed.length === 0) return '(empty body)';
  // Anything markup-shaped: a reverse proxy's error page or a WAF block page.
  // The check is deliberately loose — an XML declaration, a leading comment or
  // a doctype followed by a newline are all the same thing here.
  if (/^(<!doctype|<html[\s>]|<\?xml|<!--)/i.test(trimmed)) {
    return '(HTML error page omitted)';
  }
  const cut =
    trimmed.length > max
      ? `${trimmed.slice(0, max).toWellFormed()}… (truncated)`
      : trimmed;
  return `(untrusted text from Google, or from whatever answered in its place): ${cut}`;
}

/**
 * A caller-supplied or backend-supplied value, shortened for a sentence.
 *
 * For the messages that have to name what was rejected — a property spelling,
 * a URL — without letting a hundred kilobytes of it into the model's context.
 */
export function quoted(value: string, max = 120): string {
  const clean = cleanText(value);
  return clean.length > max
    ? `${clean.slice(0, max).toWellFormed()}… (${clean.length - max} more characters)`
    : clean;
}
