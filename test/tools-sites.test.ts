import { afterEach, describe, expect, it, vi } from 'vitest';

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
} from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SITES = '/webmasters/v3/sites';

describe('list_sites', () => {
  it('lists properties and explains the permission levels', async () => {
    stubFetch({
      [`GET ${SITES}`]: {
        json: {
          siteEntry: [
            siteEntry(SITE, 'siteOwner'),
            siteEntry(URL_SITE, 'siteUnverifiedUser'),
          ],
        },
      },
    });
    const result = await call(await connect(), 'list_sites');
    const body = jsonOf(result);
    expect(body.sites).toHaveLength(2);
    expect(String(body.note)).toContain('siteUnverifiedUser');
  });

  it('treats a response with no siteEntry as an empty list', async () => {
    /*
     * Google omits an empty array entirely: a credential with no properties gets
     * `{}`, not `{"siteEntry": []}`. This is the state of every fresh service
     * account, so the one case that must not throw.
     */
    stubFetch({ [`GET ${SITES}`]: { json: {} } });
    const result = await call(await connect(), 'list_sites');
    expect(result.isError).toBeFalsy();
    expect(jsonOf(result).sites).toEqual([]);
    expect(textOf(result)).toContain('can see no properties at all');
  });

  it('sends the access token as a bearer credential', async () => {
    const stub = stubFetch({ [`GET ${SITES}`]: { json: {} } });
    await call(await connect(), 'list_sites');
    expect(stub.calls[0]?.headers.authorization).toBe(
      'Bearer ya29.test-access-token'
    );
  });
});

describe('get_site', () => {
  it('encodes a domain property as one path segment', async () => {
    /*
     * The colon in `sc-domain:example.com` and the slashes in
     * `https://example.com/` both structure a URL. Unencoded, the request
     * addresses an entirely different path — and Google answers 404, which reads
     * as "no such property" rather than "your client is broken".
     */
    const stub = stubFetch({
      [`GET ${SITES}/sc-domain%3Aexample.com`]: { json: siteEntry() },
    });
    await call(await connect(), 'get_site', { site_url: SITE });
    expect(stub.calls[0]?.path).toBe(`${SITES}/sc-domain%3Aexample.com`);
  });

  it('encodes a URL-prefix property, slashes and all', async () => {
    const stub = stubFetch({
      [`GET ${SITES}/https%3A%2F%2Fexample.com%2F`]: {
        json: siteEntry(URL_SITE),
      },
    });
    await call(await connect(), 'get_site', { site_url: URL_SITE });
    expect(stub.calls[0]?.path).toBe(`${SITES}/https%3A%2F%2Fexample.com%2F`);
  });

  it('adds the trailing slash a URL-prefix property needs', async () => {
    // Passing `https://example.com` — which is what anyone would type — must
    // reach Google as `https://example.com/`, or it is a 403.
    const stub = stubFetch({
      [`GET ${SITES}/https%3A%2F%2Fexample.com%2F`]: {
        json: siteEntry(URL_SITE),
      },
    });
    await call(await connect(), 'get_site', {
      site_url: 'https://example.com',
    });
    expect(stub.calls[0]?.path).toContain('https%3A%2F%2Fexample.com%2F');
  });

  it('uses GSC_SITE_URL when no property is given', async () => {
    const stub = stubFetch({
      [`GET ${SITES}/sc-domain%3Aexample.com`]: { json: siteEntry() },
    });
    await call(await connect({ defaultSiteUrl: SITE }), 'get_site');
    expect(stub.calls[0]?.path).toContain('sc-domain%3Aexample.com');
  });

  it('refuses a property outside GSC_ALLOWED_SITES', async () => {
    stubFetch({});
    const result = await call(
      await connect({ allowedSites: [SITE] }),
      'get_site',
      { site_url: 'sc-domain:other.test' }
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not in GSC_ALLOWED_SITES');
  });
});

describe('add_site', () => {
  it('creates the property and warns that it is not verified', async () => {
    stubFetch({ [`PUT ${SITES}/sc-domain%3Anew.test`]: { status: 204 } });
    const result = await call(await connect(), 'add_site', {
      site_url: 'sc-domain:new.test',
    });
    expect(textOf(result)).toContain('was added to Search Console');
    expect(textOf(result)).toContain('not verified yet');
  });

  it('does not fall back to GSC_SITE_URL', async () => {
    /*
     * The one call where defaulting would be actively wrong: the default names
     * the property you already work with, and this argument names one that does
     * not exist yet. Silently re-adding the default is never what was meant.
     */
    stubFetch({});
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'add_site'
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('is not defaulted from');
  });
});

describe('delete_site', () => {
  it('refuses the first call and performs the second', async () => {
    const stub = stubFetch({
      [`DELETE ${SITES}/sc-domain%3Aexample.com`]: { status: 204 },
    });
    const client = await connect();

    const first = await call(client, 'delete_site', { site_url: SITE });
    expect(stub.calls).toHaveLength(0);
    expect(textOf(first)).toContain('16 months');

    const second = await call(client, 'delete_site', {
      site_url: SITE,
      confirm_token: tokenOf(first),
    });
    expect(stub.calls).toHaveLength(1);
    expect(textOf(second)).toContain('was removed');
  });

  it('will not accept a token issued for a different property', async () => {
    // The token is bound to its target, so a confirmation for one property
    // cannot be replayed to delete another.
    stubFetch({
      [`DELETE ${SITES}/https%3A%2F%2Fexample.com%2F`]: { status: 204 },
    });
    const client = await connect();

    const first = await call(client, 'delete_site', { site_url: SITE });
    const replayed = await call(client, 'delete_site', {
      site_url: URL_SITE,
      confirm_token: tokenOf(first),
    });
    expect(replayed.isError).toBe(true);
    expect(textOf(replayed)).toContain('issued for different arguments');
  });

  it('consumes the token, so it cannot be used twice', async () => {
    stubFetch({ [`DELETE ${SITES}/sc-domain%3Aexample.com`]: { status: 204 } });
    const client = await connect();

    const first = await call(client, 'delete_site', { site_url: SITE });
    const token = tokenOf(first);
    await call(client, 'delete_site', { site_url: SITE, confirm_token: token });

    const replay = await call(client, 'delete_site', {
      site_url: SITE,
      confirm_token: token,
    });
    expect(replay.isError).toBe(true);
  });
});
