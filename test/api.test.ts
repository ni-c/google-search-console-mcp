import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoogleApi, GoogleApiError, pathSegment } from '../src/api.js';
import { statusHint } from '../src/result.js';
import { testTokens } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function api(): GoogleApi {
  return new GoogleApi(testTokens());
}

/** Replies in order, so a test can describe a sequence of attempts. */
function replies(...responses: (() => Response)[]): { count: () => number } {
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      const make = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return Promise.resolve((make as () => Response)());
    })
  );
  return { count: () => index };
}

const ok =
  (body: unknown = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

const fail =
  (status: number, body: unknown = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

describe('retrying', () => {
  it('retries a 429 and succeeds', async () => {
    vi.useFakeTimers();
    const stub = replies(fail(429), ok({ done: true }));
    const call = api().get('search-console', '/webmasters/v3/sites');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(call).resolves.toEqual({ done: true });
    expect(stub.count()).toBe(2);
  });

  it('gives up after three attempts', async () => {
    vi.useFakeTimers();
    const stub = replies(fail(503));
    const call = api().get('search-console', '/webmasters/v3/sites');
    const assertion = expect(call).rejects.toBeInstanceOf(GoogleApiError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(stub.count()).toBe(3);
  });

  it('does not retry a 403', async () => {
    /*
     * Search Console uses 403 for some quota conditions, so retrying it looks
     * defensible — but it is far more often a permission problem, and retrying
     * that only delays the message that would have explained it.
     */
    const stub = replies(fail(403));
    await expect(
      api().get('search-console', '/webmasters/v3/sites')
    ).rejects.toBeInstanceOf(GoogleApiError);
    expect(stub.count()).toBe(1);
  });

  it('does not retry a write by default', async () => {
    // A retry after a timeout could delete a property a concurrent call had just
    // re-added. Only the genuinely idempotent calls opt back in.
    const stub = replies(fail(503));
    await expect(
      api().delete('search-console', '/webmasters/v3/sites/x')
    ).rejects.toBeInstanceOf(GoogleApiError);
    expect(stub.count()).toBe(1);
  });

  it('retries a write that declared itself idempotent', async () => {
    vi.useFakeTimers();
    // submit_sitemap is a PUT of an address — doing it twice is doing it once.
    const stub = replies(fail(503), () => new Response(null, { status: 204 }));
    const call = api().put('search-console', '/x', undefined, {
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(2000);
    await call;
    expect(stub.count()).toBe(2);
  });

  it('honours the retryDelay Google embeds in the error body', async () => {
    vi.useFakeTimers();
    const stub = replies(
      fail(429, { error: { details: [{ retryDelay: '5s' }] } }),
      ok()
    );
    const call = api().get('search-console', '/x');
    // Not yet: the backoff was told to wait five seconds, not the default half.
    await vi.advanceTimersByTimeAsync(1000);
    expect(stub.count()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await call;
    expect(stub.count()).toBe(2);
  });
});

describe('the response contract', () => {
  it('never follows a redirect', async () => {
    // A redirect away from Google would take the access token with it.
    let seen: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        seen = init;
        return Promise.resolve(ok()());
      })
    );
    await api().get('search-console', '/x');
    expect(seen?.redirect).toBe('error');
  });

  it('reads a 204 as "nothing to parse", not as an error', async () => {
    // sites.add, sites.delete, sitemaps.submit and sitemaps.delete all answer
    // 204 with no body.
    replies(() => new Response(null, { status: 204 }));
    await expect(api().put('search-console', '/x')).resolves.toBeUndefined();
  });

  it('names an HTML answer rather than letting JSON.parse fail', async () => {
    /*
     * A captive portal or a TLS-inspecting proxy answers with a login page and
     * HTTP 200. `JSON.parse` on that produces a syntax error nobody can act on.
     */
    replies(
      () =>
        new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
    );
    await expect(api().get('search-console', '/x')).rejects.toThrow(
      /intercepted the call/
    );
  });

  it('refuses a response larger than the ceiling before reading it', async () => {
    replies(
      () =>
        new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(1024 ** 4),
          },
        })
    );
    await expect(api().get('search-console', '/x')).rejects.toThrow(
      /exceeds the .* ceiling/
    );
  });

  it('drops undefined query parameters instead of sending "undefined"', async () => {
    let url = '';
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        url = input;
        return Promise.resolve(ok()());
      })
    );
    await api().get('search-console', '/x', {
      query: { a: 'set', b: undefined },
    });
    expect(url).toContain('?a=set');
    expect(url).not.toContain('b=');
  });
});

describe('pathSegment', () => {
  it('encodes the characters that would otherwise restructure the URL', () => {
    expect(pathSegment('sc-domain:example.com')).toBe(
      'sc-domain%3Aexample.com'
    );
    expect(pathSegment('https://example.com/sitemap.xml')).toBe(
      'https%3A%2F%2Fexample.com%2Fsitemap.xml'
    );
  });
});

describe('statusHint', () => {
  it('distinguishes a disabled API from a permission problem', () => {
    /*
     * The 403 that costs an afternoon. "Permission denied" sends people to
     * Search Console's user list when the real problem is an API they never
     * enabled in a Cloud project they did not know they had.
     */
    const disabled = statusHint(
      403,
      'search-console',
      '{"error":{"status":"SERVICE_DISABLED","message":"has not been used in project 123"}}'
    );
    expect(disabled).toContain('not enabled in the Cloud project');

    const denied = statusHint(403, 'search-console', '{"error":"forbidden"}');
    expect(denied).toContain('Users and permissions');
    expect(denied).not.toContain('Cloud project');
  });

  it('explains the Indexing API 403 as an ownership requirement', () => {
    // Full user access is not enough for that API, and Google does not say so.
    expect(statusHint(403, 'indexing', '{}')).toContain('owner');
  });

  it('names the scope problem when that is what it is', () => {
    expect(
      statusHint(
        403,
        'search-console',
        '{"error":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}'
      )
    ).toContain('scope');
  });

  it('explains a 404 as a spelling problem, because it usually is', () => {
    expect(statusHint(404, 'search-console')).toContain('trailing slash');
  });

  it('has nothing to add for an unremarkable status', () => {
    expect(statusHint(418, 'search-console')).toBe('');
  });
});
