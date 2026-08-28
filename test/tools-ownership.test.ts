import { afterEach, describe, expect, it, vi } from 'vitest';

import { assessSetup } from '../src/tools/setup.js';
import {
  call,
  connect,
  jsonOf,
  siteEntry,
  SITE,
  stubFetch,
  textOf,
  tokenOf,
  URL_SITE,
  verificationResource,
} from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SITES = '/webmasters/v3/sites';
const RESOURCES = '/webResource';
const TOKEN_PATH = '/token';

describe('translating a property into a verification site', () => {
  it('strips sc-domain: for a domain property', async () => {
    /*
     * The two APIs describe the same thing in incompatible spellings, and
     * nothing in either says so. Passing `sc-domain:example.com` straight
     * through is accepted and verifies a "domain" literally called
     * `sc-domain:example.com`, which no property will ever match — it fails by
     * succeeding.
     */
    const stub = stubFetch({
      [`POST ${TOKEN_PATH}`]: {
        json: { token: 'google-site-verification=abc', method: 'DNS' },
      },
    });
    await call(await connect(), 'get_verification_token', { site_url: SITE });
    expect(stub.calls[0]?.body).toMatchObject({
      site: { type: 'INET_DOMAIN', identifier: 'example.com' },
      verificationMethod: 'DNS',
    });
  });

  it('keeps the full URL for a URL-prefix property', async () => {
    const stub = stubFetch({
      [`POST ${TOKEN_PATH}`]: { json: { token: 'abc', method: 'META' } },
    });
    await call(await connect(), 'get_verification_token', {
      site_url: URL_SITE,
    });
    expect(stub.calls[0]?.body).toMatchObject({
      site: { type: 'SITE', identifier: URL_SITE },
      verificationMethod: 'META',
    });
  });
});

describe('get_verification_token', () => {
  it('returns the record to create, not just the token', async () => {
    // A token on its own is not actionable. Naming the apex explicitly is the
    // part that saves a round trip — people reach for
    // `_google-site-verification` by analogy with DMARC and SPF, and that is wrong.
    stubFetch({
      [`POST ${TOKEN_PATH}`]: {
        json: { token: 'google-site-verification=abc', method: 'DNS' },
      },
    });
    const result = await call(await connect(), 'get_verification_token', {
      site_url: SITE,
    });
    const text = textOf(result);
    expect(text).toContain('google-site-verification=abc');
    expect(text).toContain('example.com.  IN  TXT');
    expect(text).toContain('not `_google-site-verification`');
  });

  it('refuses DNS for a URL-prefix property and says why', async () => {
    stubFetch({});
    const result = await call(await connect(), 'get_verification_token', {
      site_url: URL_SITE,
      method: 'DNS',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not available for a SITE site');
  });

  it('is a read tool, because it claims nothing', async () => {
    // It computes the token a record would have to contain. Running it against
    // a domain you do not own achieves exactly nothing.
    const client = await connect({ readOnly: true });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('get_verification_token');
    expect(names).not.toContain('verify_site');
  });
});

describe('update_site_owners', () => {
  it('sends the whole owner list back, with the site block intact', async () => {
    /*
     * This replaces rather than adds, and Google rejects a body without the
     * site block rather than keeping what was there — so the current resource
     * has to be read first.
     */
    const stub = stubFetch({
      [`GET ${RESOURCES}/dns%3A%2F%2Fexample.com`]: {
        json: verificationResource(),
      },
      [`PUT ${RESOURCES}/dns%3A%2F%2Fexample.com`]: {
        json: verificationResource({
          owners: ['a@example.com', 'b@example.com'],
        }),
      },
    });
    await call(await connect(), 'update_site_owners', {
      id: 'dns://example.com',
      owners: ['a@example.com', 'b@example.com'],
    });
    expect(stub.calls[1]?.body).toMatchObject({
      site: { type: 'INET_DOMAIN', identifier: 'example.com' },
      owners: ['a@example.com', 'b@example.com'],
    });
  });

  it('uses PATCH when asked', async () => {
    // The API offers both and they behave identically; the choice exists only
    // so the server covers what the API exposes.
    const stub = stubFetch({
      [`GET ${RESOURCES}/dns%3A%2F%2Fexample.com`]: {
        json: verificationResource(),
      },
      [`PATCH ${RESOURCES}/dns%3A%2F%2Fexample.com`]: {
        json: verificationResource(),
      },
    });
    await call(await connect(), 'update_site_owners', {
      id: 'dns://example.com',
      owners: ['a@example.com'],
      method: 'patch',
    });
    expect(stub.calls[1]?.method).toBe('PATCH');
  });

  it('refuses an empty owner list', async () => {
    // That is the shape of an accidental wipe, and Google would refuse it too —
    // but only after the request went out.
    stubFetch({});
    const result = await call(await connect(), 'update_site_owners', {
      id: 'dns://example.com',
      owners: [],
    });
    expect(result.isError).toBe(true);
  });
});

describe('unverify_site', () => {
  it('is two-step and spells out what ownership loss costs', async () => {
    const stub = stubFetch({
      [`DELETE ${RESOURCES}/dns%3A%2F%2Fexample.com`]: { status: 204 },
    });
    const client = await connect();

    const first = await call(client, 'unverify_site', {
      id: 'dns://example.com',
    });
    expect(stub.calls).toHaveLength(0);
    expect(textOf(first)).toContain('siteUnverifiedUser');
    expect(textOf(first)).toContain('Indexing API');

    await call(client, 'unverify_site', {
      id: 'dns://example.com',
      confirm_token: tokenOf(first),
    });
    expect(stub.calls).toHaveLength(1);
  });
});

describe('the Indexing API tools', () => {
  it('warns that Google only acts on JobPosting and BroadcastEvent', async () => {
    /*
     * The API returns 200 with a timestamp for any owned URL and does nothing
     * for an ordinary page. A tool reporting plain success would be claiming an
     * effect that does not exist — which is exactly what most SEO tooling does
     * with this endpoint.
     */
    stubFetch({
      'POST /v3/urlNotifications:publish': {
        json: { urlNotificationMetadata: { url: 'https://example.com/job' } },
      },
    });
    const result = await call(await connect(), 'request_indexing', {
      url: 'https://example.com/job',
    });
    expect(textOf(result)).toContain('JobPosting');
    expect(textOf(result)).toContain('Accepted is not acted upon');
  });

  it('reads notification history without claiming it means indexed', async () => {
    stubFetch({
      'GET /v3/urlNotifications/metadata': {
        json: { url: 'https://example.com/job', latestUpdate: {} },
      },
    });
    const result = await call(await connect(), 'get_indexing_status', {
      url: 'https://example.com/job',
    });
    expect(result.isError).toBeFalsy();
  });
});

describe('assessSetup', () => {
  /*
   * The one piece of real reasoning in setup_site, tested without a network.
   * The state that matters is "property exists but was never verified": it looks
   * like a permissions bug and is actually step two of four, never taken.
   */
  const owned = ['sc-domain:example.com'];

  it('calls it ready when the property exists with real permission', () => {
    expect(
      assessSetup({
        site: SITE,
        properties: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }],
        ownedSiteUrls: owned,
      }).stage
    ).toBe('ready');
  });

  it('calls an unverified property needs-verification, not ready', () => {
    expect(
      assessSetup({
        site: SITE,
        properties: [{ siteUrl: SITE, permissionLevel: 'siteUnverifiedUser' }],
        ownedSiteUrls: [],
      }).stage
    ).toBe('needs-verification');
  });

  it('calls it needs-property when ownership is proven but nothing was added', () => {
    expect(
      assessSetup({ site: SITE, properties: [], ownedSiteUrls: owned }).stage
    ).toBe('needs-property');
  });

  it('calls it needs-both when neither exists', () => {
    expect(
      assessSetup({ site: SITE, properties: [], ownedSiteUrls: [] }).stage
    ).toBe('needs-both');
  });

  it('does not confuse the two spellings of one site', () => {
    // A domain property and a URL-prefix property for the same name are
    // different properties. Ownership of one says nothing about the other.
    expect(
      assessSetup({
        site: URL_SITE,
        properties: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }],
        ownedSiteUrls: owned,
      }).stage
    ).toBe('needs-both');
  });
});

describe('setup_site', () => {
  it('names the next step and hands over the DNS record', async () => {
    stubFetch({
      [`GET ${SITES}`]: { json: {} },
      [`GET ${RESOURCES}`]: { json: {} },
      [`POST ${TOKEN_PATH}`]: {
        json: { token: 'google-site-verification=xyz' },
      },
    });
    const result = await call(await connect(), 'setup_site', {
      site_url: SITE,
    });
    const text = textOf(result);
    expect(text).toContain('Neither the property nor the ownership exists');
    expect(text).toContain('google-site-verification=xyz');
    expect(text).toContain('call verify_site, then add_site');
  });

  it('reports a working property as done', async () => {
    stubFetch({
      [`GET ${SITES}`]: { json: { siteEntry: [siteEntry(SITE, 'siteOwner')] } },
      [`GET ${RESOURCES}`]: { json: { items: [verificationResource()] } },
    });
    const result = await call(await connect(), 'setup_site', {
      site_url: SITE,
    });
    expect(textOf(result)).toContain('Nothing to do');
    expect(textOf(result)).toContain('submit_sitemap');
  });

  it('still reports the state when the token cannot be fetched', async () => {
    /*
     * The Site Verification API may not be enabled in the Cloud project even
     * though Search Console is. Losing the whole diagnosis to that would be the
     * wrong trade — the state is still the useful half.
     */
    stubFetch({
      [`GET ${SITES}`]: { json: {} },
      [`GET ${RESOURCES}`]: { json: {} },
      [`POST ${TOKEN_PATH}`]: {
        status: 403,
        json: { error: 'SERVICE_DISABLED' },
      },
    });
    const result = await call(await connect(), 'setup_site', {
      site_url: SITE,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Ownership verified: no');
    expect(textOf(result)).toContain('answered HTTP 403');
  });

  it('says which tool read-only is hiding, instead of naming an absent one', async () => {
    stubFetch({
      [`GET ${SITES}`]: { json: {} },
      [`GET ${RESOURCES}`]: { json: { items: [verificationResource()] } },
    });
    const result = await call(await connect({ readOnly: true }), 'setup_site', {
      site_url: SITE,
    });
    expect(textOf(result)).toContain('GSC_READ_ONLY is set');
  });

  it('changes nothing', async () => {
    const stub = stubFetch({
      [`GET ${SITES}`]: { json: {} },
      [`GET ${RESOURCES}`]: { json: {} },
      [`POST ${TOKEN_PATH}`]: { json: { token: 'x' } },
    });
    await call(await connect(), 'setup_site', { site_url: SITE });
    // The token POST is the only non-GET, and it creates nothing.
    expect(stub.calls.filter((entry) => entry.method !== 'GET')).toHaveLength(
      1
    );
    expect(stub.calls.map((entry) => entry.method)).not.toContain('PUT');
    expect(stub.calls.map((entry) => entry.method)).not.toContain('DELETE');
  });
});

describe('list_verified_sites', () => {
  it('reports an empty ownership list as normal, not as an error', async () => {
    stubFetch({ [`GET ${RESOURCES}`]: { json: {} } });
    const result = await call(await connect(), 'list_verified_sites');
    expect(jsonOf(result).verified_sites).toEqual([]);
    expect(textOf(result)).toContain('normal state of a');
  });
});
