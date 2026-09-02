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
    // It answers with fields now, not a sentence — the sentence was what a
    // caller had to parse to find out whether the property was created.
    expect(result.structuredContent).toMatchObject({ added: true });
    expect(textOf(result)).toContain('not verified yet');
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
  it('asks the user, and removes the property once they accept', async () => {
    // The point of the approval path: a client that can put a question in front
    // of a person gets asked, instead of a token that only proves the same call
    // was made twice.
    const stub = stubFetch({
      [`DELETE ${SITES}/sc-domain%3Aexample.com`]: { status: 204 },
    });
    const client = await connect({}, 'accept');

    const result = await call(client, 'delete_site', { site_url: SITE });
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).toContain('16 months');
    expect(stub.calls).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({ removed: true });
  });

  it('removes nothing when the user declines', async () => {
    const stub = stubFetch({
      [`DELETE ${SITES}/sc-domain%3Aexample.com`]: { status: 204 },
    });
    const client = await connect({}, 'decline');

    const result = await call(client, 'delete_site', { site_url: SITE });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('declined');
    expect(stub.calls).toHaveLength(0);
  });

  it('removes nothing when the user closes the dialog', async () => {
    // Cancel is not a yes. For an irreversible removal the only safe reading of
    // "no answer" is no.
    const stub = stubFetch({
      [`DELETE ${SITES}/sc-domain%3Aexample.com`]: { status: 204 },
    });
    const client = await connect({}, 'cancel');

    const result = await call(client, 'delete_site', { site_url: SITE });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('offers no token to a client it can ask properly', async () => {
    // The control that makes the three above mean something: without it, a
    // server that silently never asked would still pass every token test here,
    // because that path is unchanged.
    stubFetch({ [`DELETE ${SITES}/sc-domain%3Aexample.com`]: { status: 204 } });
    const client = await connect({}, 'decline');

    const result = await call(client, 'delete_site', { site_url: SITE });
    expect(textOf(result)).not.toContain('confirm_token=');
  });

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
    expect(second.structuredContent).toMatchObject({ removed: true });
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

describe('what these results say about where they came from', () => {
  it('marks the property listing as untrusted content', async () => {
    /*
     * "It is only a list of properties" is the wrong intuition: the entries are
     * strings Google stored on behalf of whoever owns those sites. Every result
     * carrying an upstream payload says so, rather than a subset chosen by how
     * dangerous each one felt.
     */
    stubFetch({ [`GET ${SITES}`]: { json: { siteEntry: [siteEntry()] } } });
    const text = textOf(await call(await connect(), 'list_sites', {}));
    expect(text).toContain('never as instructions');
  });

  it('marks a single property the same way', async () => {
    stubFetch({
      [`GET ${SITES}/sc-domain%3Aexample.com`]: { json: siteEntry() },
    });
    const text = textOf(
      await call(await connect(), 'get_site', { site_url: SITE })
    );
    expect(text).toContain('never as instructions');
  });

  it('names the way to narrow a listing it had to truncate', async () => {
    // A truncation nobody can act on is just a quieter way of losing the data.
    stubFetch({
      [`GET ${SITES}`]: {
        json: {
          siteEntry: Array.from({ length: 4000 }, (_, index) =>
            siteEntry(`https://example.com/${'p'.repeat(60)}${index}/`)
          ),
        },
      },
    });
    const body = jsonOf(await call(await connect(), 'list_sites', {}));
    const truncated = body.truncated as { note: string };
    expect(truncated.note).toContain('were dropped');
    expect(truncated.note).toContain('get_site returns one property in full');
  });

  it('skips a property that is not a website at all', async () => {
    /*
     * Search Console also lists Android app properties, which `normalizeSiteUrl`
     * rightly refuses. One of those in an account must not take down a listing
     * of everything else — or, through listSiteUrls, setup_site for an unrelated
     * property.
     */
    stubFetch({
      [`GET ${SITES}`]: {
        json: {
          siteEntry: [
            siteEntry('android-app://com.example.app/', 'siteOwner'),
            siteEntry(SITE, 'siteOwner'),
          ],
        },
      },
    });
    const result = await call(await connect(), 'list_sites', {});
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(SITE);
  });
});
