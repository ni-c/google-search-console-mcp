import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  call,
  connect,
  jsonOf,
  siteEntry,
  SITE,
  stubFetch,
  textOf,
  URL_SITE,
  verificationResource,
} from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SITES = '/webmasters/v3/sites';
const RESOURCES = '/webResource';

/*
 * `GSC_ALLOWED_SITES` exists for one Google account that can see both private
 * and work properties, so a guard some tool can walk around is not worth having.
 * Most tools name a property and go through `resolveSite`, which is where it is
 * enforced — these are the ones that do not, and every one of them was a real
 * hole.
 */
const ALLOWED = { allowedSites: [SITE] } as const;

describe('the allowlist on tools that take a URL instead of a property', () => {
  it('refuses request_indexing for a URL outside it', async () => {
    // The write tool with a finite daily quota. Without this the allowlist
    // simply did not apply to it: nothing in the Indexing API names a property.
    const stub = stubFetch({});
    const result = await call(await connect(ALLOWED), 'request_indexing', {
      url: 'https://private.test/page',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('GSC_ALLOWED_SITES');
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses get_indexing_status for a URL outside it', async () => {
    const stub = stubFetch({});
    const result = await call(await connect(ALLOWED), 'get_indexing_status', {
      url: 'https://private.test/page',
    });
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('allows a subdomain of a domain property', async () => {
    // sc-domain: covers every host under the name, at any scheme — matching it
    // by string equality against the URL would refuse the whole property.
    const stub = stubFetch({
      'POST /v3/urlNotifications:publish': { json: {} },
    });
    const result = await call(await connect(ALLOWED), 'request_indexing', {
      url: 'https://shop.example.com/job',
    });
    expect(result.isError).toBeFalsy();
    expect(stub.calls).toHaveLength(1);
  });

  it('does not let a URL-prefix property leak into a sibling path', async () => {
    // https://example.com/shop must not cover https://example.com/shopping —
    // they are different properties holding different data.
    const stub = stubFetch({});
    const result = await call(
      await connect({ allowedSites: ['https://example.com/shop'] }),
      'request_indexing',
      { url: 'https://example.com/shopping/page' }
    );
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('the allowlist on tools that take an opaque resource id', () => {
  const OTHER = `${RESOURCES}/dns%3A%2F%2Fprivate.test`;
  const otherSite = {
    json: verificationResource({
      id: 'dns://private.test',
      site: { type: 'INET_DOMAIN', identifier: 'private.test' },
    }),
  };

  it('refuses unverify_site for a resource outside it', async () => {
    /*
     * The most damaging operation this server has, and an id says nothing about
     * which property it belongs to — so the only way to check it is to fetch the
     * resource and map its own site block back to a property.
     */
    const stub = stubFetch({ [`GET ${OTHER}`]: otherSite });
    const result = await call(await connect(ALLOWED), 'unverify_site', {
      id: 'dns://private.test',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('GSC_ALLOWED_SITES');
    expect(stub.calls.some((entry) => entry.method === 'DELETE')).toBe(false);
  });

  it('refuses update_site_owners for a resource outside it', async () => {
    const stub = stubFetch({ [`GET ${OTHER}`]: otherSite });
    const result = await call(await connect(ALLOWED), 'update_site_owners', {
      id: 'dns://private.test',
      owners: ['attacker@evil.test'],
    });
    expect(result.isError).toBe(true);
    expect(stub.calls.some((entry) => entry.method === 'PUT')).toBe(false);
  });

  it('refuses get_verified_site for a resource outside it', async () => {
    stubFetch({ [`GET ${OTHER}`]: otherSite });
    const result = await call(await connect(ALLOWED), 'get_verified_site', {
      id: 'dns://private.test',
    });
    expect(result.isError).toBe(true);
  });

  it('still works for a resource inside it', async () => {
    stubFetch({
      [`GET ${RESOURCES}/dns%3A%2F%2Fexample.com`]: {
        json: verificationResource(),
      },
    });
    const result = await call(await connect(ALLOWED), 'get_verified_site', {
      id: 'dns://example.com',
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('owner@example.com');
  });
});

describe('the allowlist on the two listings', () => {
  it('withholds properties it would refuse anyway, and says so', async () => {
    /*
     * Filtered rather than merely refused later. Listing a property that every
     * other tool declines discloses a name the operator fenced off and invites a
     * call that cannot succeed.
     */
    stubFetch({
      [`GET ${SITES}`]: {
        json: {
          siteEntry: [
            siteEntry(SITE, 'siteOwner'),
            siteEntry(URL_SITE, 'siteOwner'),
          ],
        },
      },
    });
    const result = await call(await connect(ALLOWED), 'list_sites', {});
    const body = jsonOf(result);
    expect(body.sites).toHaveLength(1);
    expect(JSON.stringify(body.sites)).toContain(SITE);
    expect(JSON.stringify(body.sites)).not.toContain(URL_SITE);
    expect(String(body.withheld_by_configuration)).toContain(
      'GSC_ALLOWED_SITES'
    );
  });

  it('withholds owned sites, whose ids would otherwise be actionable', async () => {
    // list_verified_sites hands back the ids unverify_site acts on, so an
    // unfiltered listing is half of the bypass above.
    stubFetch({
      [`GET ${RESOURCES}`]: {
        json: {
          items: [
            verificationResource(),
            verificationResource({
              id: 'dns://private.test',
              site: { type: 'INET_DOMAIN', identifier: 'private.test' },
            }),
          ],
        },
      },
    });
    const body = jsonOf(
      await call(await connect(ALLOWED), 'list_verified_sites', {})
    );
    expect(body.verified_sites).toHaveLength(1);
    expect(JSON.stringify(body.verified_sites)).not.toContain('private.test');
  });

  it('lists everything when no allowlist is configured', async () => {
    stubFetch({
      [`GET ${SITES}`]: {
        json: { siteEntry: [siteEntry(SITE), siteEntry(URL_SITE)] },
      },
    });
    const body = jsonOf(await call(await connect(), 'list_sites', {}));
    expect(body.sites).toHaveLength(2);
    expect(body.withheld_by_configuration).toBeUndefined();
  });
});
