import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  call,
  connect,
  inspectionResult,
  siteEntry,
  SITE,
  sitemapEntry,
  stubFetch,
  textOf,
  URL_SITE,
  verificationResource,
} from './harness.js';

/**
 * The optional arguments, which are where the branches live.
 *
 * Most tool bodies are a run of `if (value !== undefined)` over arguments the
 * caller may or may not pass, and a suite that only ever calls the happy path
 * exercises one side of every one of them. This file is the other side — and it
 * is not busywork: two real bugs would have hidden here, a filter operator that
 * defaulted to nothing and a `type` that was sent as the string "undefined".
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const SITES = '/webmasters/v3/sites';
const QUERY = `${SITES}/sc-domain%3Aexample.com/searchAnalytics/query`;
const RESOURCES = '/webResource';

describe('verify_site', () => {
  it('sends the method as a query parameter and the site as the body', async () => {
    const stub = stubFetch({
      [`POST ${RESOURCES}`]: { json: verificationResource() },
    });
    const result = await call(await connect(), 'verify_site', {
      site_url: SITE,
    });

    expect(stub.calls[0]?.path).toContain('verificationMethod=DNS');
    expect(stub.calls[0]?.body).toEqual({
      site: { type: 'INET_DOMAIN', identifier: 'example.com' },
    });
    expect(result.structuredContent).toMatchObject({ verified: true });
    expect(textOf(result)).toContain('owner@example.com');
  });

  it('defaults to META for a URL-prefix property', async () => {
    const stub = stubFetch({
      [`POST ${RESOURCES}`]: { json: verificationResource({ id: URL_SITE }) },
    });
    await call(await connect(), 'verify_site', { site_url: URL_SITE });
    expect(stub.calls[0]?.path).toContain('verificationMethod=META');
  });

  it('accepts ANALYTICS, which has no token to fetch', async () => {
    // ANALYTICS and TAG_MANAGER prove ownership through an existing Google
    // product instead of a token, so they are valid here and not in
    // get_verification_token.
    const stub = stubFetch({
      [`POST ${RESOURCES}`]: { json: verificationResource({ id: URL_SITE }) },
    });
    await call(await connect(), 'verify_site', {
      site_url: URL_SITE,
      method: 'ANALYTICS',
    });
    expect(stub.calls[0]?.path).toContain('verificationMethod=ANALYTICS');
  });

  it('refuses a method the site kind cannot use', async () => {
    stubFetch({});
    const result = await call(await connect(), 'verify_site', {
      site_url: SITE,
      method: 'META',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not available for a INET_DOMAIN site');
  });

  it('reports a verified site that returned no owners', async () => {
    stubFetch({
      [`POST ${RESOURCES}`]: { json: { id: 'dns://example.com', site: {} } },
    });
    const result = await call(await connect(), 'verify_site', {
      site_url: SITE,
    });
    expect(textOf(result)).toContain('(none listed)');
  });
});

describe('get_verified_site', () => {
  it('encodes the opaque resource id', async () => {
    const stub = stubFetch({
      [`GET ${RESOURCES}/dns%3A%2F%2Fexample.com`]: {
        json: verificationResource(),
      },
    });
    await call(await connect(), 'get_verified_site', {
      id: 'dns://example.com',
    });
    expect(stub.calls[0]?.path).toBe(`${RESOURCES}/dns%3A%2F%2Fexample.com`);
  });
});

describe('query_search_analytics, the optional half', () => {
  const rows = { rows: [{ clicks: 1, impressions: 2, ctr: 0.5, position: 1 }] };

  it('omits type, dataState and aggregationType when not given', async () => {
    // Sending them as undefined would serialise to nothing useful; sending the
    // string "undefined" would be a 400 from Google.
    const stub = stubFetch({ [`POST ${QUERY}`]: { json: rows } });
    await call(
      await connect({ defaultSiteUrl: SITE }),
      'query_search_analytics',
      {
        period: 'last7days',
      }
    );
    const body = stub.calls[0]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('dataState');
    expect(body).not.toHaveProperty('aggregationType');
    expect(body).not.toHaveProperty('dimensionFilterGroups');
  });

  it('passes each optional through when given', async () => {
    const stub = stubFetch({ [`POST ${QUERY}`]: { json: rows } });
    await call(
      await connect({ defaultSiteUrl: SITE }),
      'query_search_analytics',
      {
        start_date: '2026-08-01',
        end_date: '2026-08-07',
        type: 'IMAGE',
        data_state: 'ALL',
        aggregation_type: 'BY_PAGE',
        row_limit: 5,
        start_row: 10,
      }
    );
    expect(stub.calls[0]?.body).toMatchObject({
      startDate: '2026-08-01',
      endDate: '2026-08-07',
      type: 'IMAGE',
      dataState: 'ALL',
      aggregationType: 'BY_PAGE',
      rowLimit: 5,
      startRow: 10,
    });
  });

  it('accepts the hour dimension with HOURLY_ALL', async () => {
    const stub = stubFetch({ [`POST ${QUERY}`]: { json: rows } });
    await call(
      await connect({ defaultSiteUrl: SITE }),
      'query_search_analytics',
      {
        period: 'today',
        dimensions: ['hour'],
        data_state: 'HOURLY_ALL',
      }
    );
    expect(stub.calls[0]?.body).toMatchObject({ dimensions: ['hour'] });
  });

  it('ignores an empty filter list rather than sending an empty group', async () => {
    // An empty `dimensionFilterGroups` is not the same as none, and Google
    // treats it as a filter that matches nothing.
    const stub = stubFetch({ [`POST ${QUERY}`]: { json: rows } });
    await call(
      await connect({ defaultSiteUrl: SITE }),
      'query_search_analytics',
      {
        period: 'last7days',
        filters: [],
      }
    );
    expect(stub.calls[0]?.body).not.toHaveProperty('dimensionFilterGroups');
  });
});

describe('inspect_url, the optional half', () => {
  it('omits languageCode when not given and sends it when it is', async () => {
    const stub = stubFetch({
      'POST /v1/urlInspection/index:inspect': { json: inspectionResult() },
    });
    const client = await connect({ defaultSiteUrl: SITE });

    await call(client, 'inspect_url', {
      inspection_url: 'https://example.com/a',
    });
    expect(stub.calls[0]?.body).not.toHaveProperty('languageCode');

    await call(client, 'inspect_url', {
      inspection_url: 'https://example.com/a',
      language_code: 'de-CH',
    });
    expect(stub.calls[1]?.body).toMatchObject({ languageCode: 'de-CH' });
  });

  it('reports a non-fatal per-URL failure inside a batch', async () => {
    let call403 = true;
    stubFetch({
      'POST /v1/urlInspection/index:inspect': () => {
        const reply = call403
          ? { status: 404, json: { error: 'no such URL' } }
          : { json: inspectionResult() };
        call403 = false;
        return reply;
      },
    });
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'inspect_urls',
      { inspection_urls: ['https://example.com/a', 'https://example.com/b'] }
    );
    expect(textOf(result)).toContain('HTTP 404');
    expect(textOf(result)).toContain('PASS');
  });

  it('condenses an inspection whose result block is missing', async () => {
    // Defensive: every field of the summary is optional in the schema, so a
    // partial response must not throw on the way to being condensed.
    stubFetch({ 'POST /v1/urlInspection/index:inspect': { json: {} } });
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'inspect_urls',
      { inspection_urls: ['https://example.com/a'] }
    );
    expect(result.isError).toBeFalsy();
  });
});

describe('setup_site, the remaining stages', () => {
  it('tells an owner with no property to add it', async () => {
    stubFetch({
      [`GET ${SITES}`]: { json: {} },
      [`GET ${RESOURCES}`]: { json: { items: [verificationResource()] } },
    });
    const result = await call(await connect(), 'setup_site', {
      site_url: SITE,
    });
    expect(textOf(result)).toContain('Ownership is already verified');
    expect(textOf(result)).toContain('add_site');
  });

  it('tells an unverified but existing property to verify only', async () => {
    stubFetch({
      [`GET ${SITES}`]: {
        json: { siteEntry: [siteEntry(SITE, 'siteUnverifiedUser')] },
      },
      [`GET ${RESOURCES}`]: { json: {} },
      'POST /token': { json: { token: 'google-site-verification=q' } },
    });
    const result = await call(await connect(), 'setup_site', {
      site_url: SITE,
    });
    expect(textOf(result)).toContain('never proven');
    expect(textOf(result)).toContain('nothing else is needed');
  });

  it('says what a restricted user cannot do', async () => {
    stubFetch({
      [`GET ${SITES}`]: {
        json: { siteEntry: [siteEntry(SITE, 'siteRestrictedUser')] },
      },
      [`GET ${RESOURCES}`]: { json: {} },
    });
    const result = await call(await connect(), 'setup_site', {
      site_url: SITE,
    });
    expect(textOf(result)).toContain('cannot manage sitemaps');
  });

  it('ignores a verification resource that is no property at all', async () => {
    // An Android app has no Search Console property; comparing it as one would
    // be nonsense.
    stubFetch({
      [`GET ${SITES}`]: { json: {} },
      [`GET ${RESOURCES}`]: {
        json: {
          items: [
            {
              id: 'app://com.example',
              site: { type: 'ANDROID_APP', identifier: 'com.example' },
            },
          ],
        },
      },
      'POST /token': { json: { token: 'x' } },
    });
    const result = await call(await connect(), 'setup_site', {
      site_url: SITE,
    });
    expect(textOf(result)).toContain('Ownership verified: no');
  });

  it('handles a property entry with no siteUrl', async () => {
    stubFetch({
      [`GET ${SITES}`]: {
        json: { siteEntry: [{ permissionLevel: 'siteOwner' }] },
      },
      [`GET ${RESOURCES}`]: { json: {} },
      'POST /token': { json: { token: 'x' } },
    });
    const result = await call(await connect(), 'setup_site', {
      site_url: SITE,
    });
    expect(result.isError).toBeFalsy();
  });
});

describe('get_sitemap', () => {
  it('returns the record that says whether a submission worked', async () => {
    // Errors never appear in the response to submit_sitemap — only here.
    stubFetch({
      [`GET ${SITES}/sc-domain%3Aexample.com/sitemaps/${encodeURIComponent('https://example.com/sitemap.xml')}`]:
        { json: sitemapEntry() },
    });
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'get_sitemap',
      { feedpath: 'https://example.com/sitemap.xml' }
    );
    expect(textOf(result)).toContain('lastDownloaded');
  });
});

describe('an error that is not a Google error at all', () => {
  it('is still reported as a tool error, not a protocol failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')))
    );
    const result = await call(await connect(), 'list_sites');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('ENOTFOUND');
  });
});
