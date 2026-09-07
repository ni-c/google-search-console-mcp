import type { Service, TokenSource } from './auth.js';
import { quoted } from './clean.js';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Ceiling on the largest upstream response this server ever reads.
 *
 * `searchanalytics.query` is the one that can get large: 25 000 rows with a page
 * and a query dimension is tens of megabytes of JSON, and `rowLimit` is chosen
 * by the caller. This bounds the bytes before they are ever a string in memory;
 * `MAX_RESULT_BYTES` in `result.ts` separately bounds what reaches the model.
 *
 * It is the ceiling for that one endpoint, not the default. The default is
 * {@link MAX_RECORD_BYTES}: a property, a sitemap, a verification resource or a
 * notification is a record of a few hundred bytes, and reading sixty-four
 * megabytes of one — from whatever answered in Google's place — is a minute of
 * the shortener's time on the thread that serves every request.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** The ceiling for every endpoint that answers with one record or a short list. */
export const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * The ceiling for a URL inspection: one result, but with a referring-URL list,
 * a sitemap list and a rich-results breakdown that Google does not bound.
 */
export const MAX_INSPECTION_BYTES = 8 * 1024 * 1024;

/**
 * How much of an error body is kept.
 *
 * Google's error bodies are a few hundred bytes of JSON; the body of a 5xx from
 * a proxy is whatever the proxy felt like sending. It is read under its own
 * ceiling, and *cut* rather than refused — the status is the answer, and the
 * body only decorates it.
 */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** How much of a request path an error message repeats. */
const MAX_PATH_IN_MESSAGE = 200;

/** Where each service lives. Fixed — none of this is configurable. */
const BASE_URL: Record<Service, string> = {
  'search-console': 'https://searchconsole.googleapis.com',
  'site-verification': 'https://www.googleapis.com/siteVerification/v1',
  indexing: 'https://indexing.googleapis.com',
};

/**
 * Human names for the three services, for error messages that have to say which
 * API refused — the three fail for entirely different reasons.
 */
const SERVICE_NAME: Record<Service, string> = {
  'search-console': 'Search Console API',
  'site-verification': 'Site Verification API',
  indexing: 'Indexing API',
};

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly service: Service,
    method: string,
    public readonly path: string
  ) {
    // The path carries the property and the feedpath the caller named, so it
    // is cut: a hundred-kilobyte argument must not become a hundred-kilobyte
    // error message.
    super(
      `${SERVICE_NAME[service]} ${method} ${quoted(path, MAX_PATH_IN_MESSAGE)} failed with HTTP ${status}`
    );
    this.name = 'GoogleApiError';
  }
}

/** Thrown when a response is larger than the ceiling that applied to it. */
export class ResponseTooLargeError extends Error {
  constructor(path: string, limit: number) {
    super(
      `the Google response for ${quoted(path, MAX_PATH_IN_MESSAGE)} exceeds the ${Math.round(
        limit / 1024 / 1024
      )} MB ceiling and was not read. Narrow the request — for an analytics ` +
        'query, lower row_limit and page through the result with start_row.'
    );
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Thrown when a response that has to be JSON is not.
 *
 * Rare against Google itself, and the usual cause is the network in between: a
 * captive portal, a corporate TLS-inspecting proxy or an outbound filter answers
 * with an HTML login page and HTTP 200. Handing that to `JSON.parse` produces a
 * syntax error nobody can act on, so it is named here instead.
 */
export class UnexpectedContentTypeError extends Error {
  constructor(path: string, contentType: string) {
    // The header is the answerer's text, so it is shortened like any other.
    super(
      `Google answered ${quoted(path, MAX_PATH_IN_MESSAGE)} with "${
        contentType ? quoted(contentType, 80) : 'no content type'
      }" ` +
        'instead of JSON. Something between this server and Google intercepted ' +
        'the call — a proxy, a captive portal or an outbound filter.'
    );
    this.name = 'UnexpectedContentTypeError';
  }
}

export interface RequestOptions {
  /** Query string parameters, undefined entries dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * The response ceiling for this call. Defaults to {@link MAX_RECORD_BYTES};
   * the two endpoints whose answers grow with the request opt up.
   */
  maxBytes?: number;
  /**
   * Whether the call may be retried after a 429 or a 5xx.
   *
   * Defaults to true for GET and to **false** for everything else. `sitemaps.submit`
   * is a PUT and genuinely idempotent, so it opts back in; `sites.delete` does
   * not, because a retry after a timeout could delete a property that a
   * concurrent call had just re-added.
   */
  retryable?: boolean;
}

/** How many times a retryable request is attempted in total. */
const MAX_ATTEMPTS = 3;
/** First backoff step; doubled per attempt. */
const BACKOFF_BASE_MS = 500;
/** Never wait longer than this for a single backoff, whatever Retry-After says. */
const MAX_BACKOFF_MS = 20_000;

/**
 * Client for the three Google APIs behind this server.
 *
 * There is no configurable host, so there is no SSRF surface and no host guard:
 * every request goes to one of the three constants in {@link BASE_URL}. That is
 * worth stating, because the sibling servers in this family all carry a
 * `hosts.ts` and its absence here should read as a decision rather than an
 * oversight. Redirects are still refused — a redirect away from Google would
 * take the access token with it.
 */
export class GoogleApi {
  constructor(private readonly tokens: TokenSource) {}

  /** Which identity is in use, for the startup line. Never a secret. */
  get identity(): string {
    return this.tokens.describe();
  }

  async request(
    service: Service,
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<unknown> {
    const retryable = options.retryable ?? method === 'GET';
    let lastError: unknown;

    for (
      let attempt = 1;
      attempt <= (retryable ? MAX_ATTEMPTS : 1);
      attempt++
    ) {
      try {
        return await this.attempt(service, method, path, body, options);
      } catch (error) {
        lastError = error;
        if (!retryable || attempt === MAX_ATTEMPTS || !isTransient(error)) {
          throw error;
        }
        await sleep(backoffMs(error, attempt));
      }
    }
    throw lastError;
  }

  private async attempt(
    service: Service,
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions
  ): Promise<unknown> {
    // The token is fetched per attempt, not per client: it expires, and the
    // library refreshes it transparently when it has to.
    const token = await this.tokens.getAccessToken();
    // Checked before it becomes a header. The runtime refuses a header value
    // with a control character in it, and its refusal quotes the whole value
    // — `Headers.append: "Bearer …" is an invalid header value` — which would
    // travel through the generic error path into the tool result. A token
    // that fails the check is reported as no token, never as itself.
    if (!HEADER_VALUE.test(token)) throw new Error(UNUSABLE_TOKEN);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };
    const init: RequestInit = {
      method,
      headers,
      // Never follow a redirect: it would resend the access token to whatever
      // host the response points at.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const url = `${BASE_URL[service]}${path}${queryString(options.query)}`;
    const response = await fetch(url, init);

    // The status is decided before a byte of the body is read. Read the other
    // way round, a 429 or a 503 with a large enough body was refused for its
    // size — `ResponseTooLargeError`, which names no status — so the retry
    // keyed on the status never ran and the hint for the status was never
    // shown. An error body is read under its own small ceiling and cut, never
    // refused: the status is the answer, the body decorates it.
    if (!response.ok) {
      const errorBody = await readErrorBody(response);
      throw new GoogleApiError(
        response.status,
        errorBody,
        service,
        method,
        path
      );
    }

    const limit = options.maxBytes ?? MAX_RECORD_BYTES;
    const text = await readCapped(response, limit, path);

    // Several methods answer 204 with no body: sites.add, sites.delete,
    // sitemaps.submit, sitemaps.delete and siteVerification's delete. There is
    // nothing to parse and nothing wrong.
    if (response.status === 204 || text.length === 0) return undefined;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new UnexpectedContentTypeError(path, contentType);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UnexpectedContentTypeError(
        path,
        `${contentType} (unparseable)`
      );
    }
  }

  get(
    service: Service,
    path: string,
    options?: RequestOptions
  ): Promise<unknown> {
    return this.request(service, 'GET', path, undefined, options);
  }

  post(
    service: Service,
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<unknown> {
    return this.request(service, 'POST', path, body, options);
  }

  put(
    service: Service,
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<unknown> {
    return this.request(service, 'PUT', path, body, options);
  }

  delete(
    service: Service,
    path: string,
    options?: RequestOptions
  ): Promise<unknown> {
    return this.request(service, 'DELETE', path, undefined, options);
  }
}

/**
 * Whether an error is worth trying again.
 *
 * 429 is the quota limiter, 500/503 are Google's own transient failures, and an
 * `AbortError` is this server's own 30-second timeout. A 403 is *not* in here
 * even though Search Console uses it for some quota conditions: it is far more
 * often a permission problem, and retrying that just delays the real message.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof GoogleApiError) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof Error && error.name === 'TimeoutError';
}

/**
 * How long to wait before the next attempt.
 *
 * Google sends `Retry-After` on some 429s, and it is authoritative when present
 * — but it is capped, because the server would otherwise be told to sit still
 * for longer than any client will wait for a tool call.
 */
function backoffMs(error: unknown, attempt: number): number {
  if (error instanceof GoogleApiError) {
    const retryAfter = retryAfterSeconds(error.body);
    if (retryAfter !== undefined) {
      return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
    }
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/**
 * Reads a retry delay out of a Google error body.
 *
 * The header is not available here — the body is what {@link GoogleApiError}
 * carries — but Google's JSON errors embed a `RetryInfo` detail with a duration
 * like `"30s"`, which is the same number.
 */
function retryAfterSeconds(body: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (match?.[1] === undefined) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * What a bearer token may look like: visible ASCII, bounded.
 *
 * Google's access tokens are `ya29.` plus a couple of hundred characters; the
 * band is generous so a future format still passes, and strict about the one
 * thing that matters — nothing outside 0x21–0x7e, so no control character can
 * reach the header.
 */
const HEADER_VALUE = /^[!-~]{1,4096}$/;

const UNUSABLE_TOKEN =
  'the credential produced no usable access token. The token endpoint answered, ' +
  'but what it returned is not something that can be sent as a header — check ' +
  'the credential rather than the network.';

/**
 * Reads an error body under its own ceiling, cutting rather than refusing.
 *
 * Never throws for the size or the encoding: whatever goes wrong here, the
 * status that was already read is the answer and the caller gets it.
 */
async function readErrorBody(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cut = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const room = MAX_ERROR_BODY_BYTES - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        total += room;
        cut = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // A body that fails mid-read is still an error with a status.
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return cut
    ? `${text}… (error body cut at ${MAX_ERROR_BODY_BYTES} bytes)`
    : text;
}

/**
 * Reads a response body with a hard byte ceiling.
 *
 * Both halves matter: `content-length` catches an oversized answer before a
 * single byte is read, and the streaming count catches a chunked response, which
 * declares no length at all.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  path: string
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ResponseTooLargeError(path, maxBytes);
  }

  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(path, maxBytes);
    }
    chunks.push(value);
    total += value.byteLength;
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Encodes a property or sitemap URL as a single path segment.
 *
 * This is load-bearing rather than defensive. Both go into the path whole —
 * `/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}` — and both contain the
 * characters that structure a URL: `sc-domain:example.com` has a colon, and
 * `https://example.com/sitemap.xml` has two slashes and a colon. Unencoded, the
 * request addresses an entirely different path.
 */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function queryString(
  params: Record<string, string | number | boolean | undefined> | undefined
): string {
  if (params === undefined) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.append(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}
