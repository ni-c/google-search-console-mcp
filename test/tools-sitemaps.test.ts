import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  call,
  connect,
  jsonOf,
  SITE,
  sitemapEntry,
  stubFetch,
  textOf,
  tokenOf,
} from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = '/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps';
const FEED = 'https://example.com/sitemap.xml';
const FEED_ENCODED = 'https%3A%2F%2Fexample.com%2Fsitemap.xml';

describe('list_sitemaps', () => {
  it('lists the submitted sitemaps', async () => {
    stubFetch({ [`GET ${BASE}`]: { json: { sitemap: [sitemapEntry()] } } });
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'list_sitemaps'
    );
    expect(jsonOf(result).sitemaps).toHaveLength(1);
  });

  it('passes sitemap_index through as a query parameter', async () => {
    /*
     * Without it Google returns only directly submitted sitemaps — the children
     * of a submitted index are invisible. A site that submitted one index and
     * nothing else therefore looks like it has no sitemaps at all.
     */
    const stub = stubFetch({ [`GET ${BASE}`]: { json: {} } });
    await call(await connect({ defaultSiteUrl: SITE }), 'list_sitemaps', {
      sitemap_index: FEED,
    });
    expect(stub.calls[0]?.path).toContain(
      `sitemapIndex=${encodeURIComponent(FEED)}`
    );
  });

  it('explains the index caveat when the list comes back empty', async () => {
    stubFetch({ [`GET ${BASE}`]: { json: {} } });
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'list_sitemaps'
    );
    expect(textOf(result)).toContain('pass its URL as sitemap_index');
  });
});

describe('submit_sitemap', () => {
  it('PUTs the encoded feedpath under the encoded property', async () => {
    const stub = stubFetch({
      [`PUT ${BASE}/${FEED_ENCODED}`]: { status: 204 },
    });
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'submit_sitemap',
      { feedpath: FEED }
    );
    expect(stub.calls[0]?.method).toBe('PUT');
    expect(stub.calls[0]?.path).toBe(`${BASE}/${FEED_ENCODED}`);
    expect(textOf(result)).toContain('Submitted');
  });

  it('says acceptance is not validation', async () => {
    // Google returns 204 for a sitemap it has not fetched yet. A tool that
    // reported plain success would be claiming something it does not know.
    stubFetch({ [`PUT ${BASE}/${FEED_ENCODED}`]: { status: 204 } });
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'submit_sitemap',
      { feedpath: FEED }
    );
    expect(textOf(result)).toContain('has not fetched the file yet');
  });

  it('refuses a feedpath that is not an http URL', async () => {
    /*
     * Nothing here fetches the URL, so this is not an SSRF guard — it is that
     * `file:///etc/passwd` is never a sitemap Google can read, and a schema
     * accepting it turns an obvious mistake into a puzzling 400 three layers
     * down. zod's own `.url()` would let it through.
     */
    stubFetch({});
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'submit_sitemap',
      { feedpath: 'file:///etc/passwd' }
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/absolute http/);
  });
});

describe('submit_sitemaps', () => {
  it('submits each one and reports per-entry results', async () => {
    const stub = stubFetch({
      [`PUT ${BASE}/${FEED_ENCODED}`]: { status: 204 },
      [`PUT ${BASE}/${encodeURIComponent('https://example.com/news.xml')}`]: {
        status: 204,
      },
    });
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'submit_sitemaps',
      { feedpaths: [FEED, 'https://example.com/news.xml'] }
    );
    expect(stub.calls).toHaveLength(2);
    expect(jsonOf(result).submitted).toBe(2);
    expect(jsonOf(result).failed).toBe(0);
  });

  it('keeps going after one failure and reports which', async () => {
    // A batch that stopped at the first error would leave the caller unable to
    // tell what did land without repeating the whole thing.
    stubFetch({
      [`PUT ${BASE}/${FEED_ENCODED}`]: {
        status: 403,
        json: { error: 'denied' },
      },
      [`PUT ${BASE}/${encodeURIComponent('https://example.com/news.xml')}`]: {
        status: 204,
      },
    });
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'submit_sitemaps',
      { feedpaths: [FEED, 'https://example.com/news.xml'] }
    );
    const body = jsonOf(result);
    expect(body.submitted).toBe(1);
    expect(body.failed).toBe(1);
    expect(JSON.stringify(body.results)).toContain('HTTP 403');
  });

  it('refuses an empty list', async () => {
    stubFetch({});
    const result = await call(
      await connect({ defaultSiteUrl: SITE }),
      'submit_sitemaps',
      { feedpaths: [] }
    );
    expect(result.isError).toBe(true);
  });
});

describe('delete_sitemap', () => {
  it('is two-step and binds the token to the feedpath', async () => {
    /*
     * Both the property and the feedpath go into the resource key. A token for
     * one sitemap must not authorise removing a different one from the same
     * property — which a key built from the property alone would.
     */
    const stub = stubFetch({
      [`DELETE ${BASE}/${FEED_ENCODED}`]: { status: 204 },
    });
    const client = await connect({ defaultSiteUrl: SITE });

    const first = await call(client, 'delete_sitemap', { feedpath: FEED });
    expect(stub.calls).toHaveLength(0);

    const wrongTarget = await call(client, 'delete_sitemap', {
      feedpath: 'https://example.com/other.xml',
      confirm_token: tokenOf(first),
    });
    expect(wrongTarget.isError).toBe(true);

    const second = await call(client, 'delete_sitemap', {
      feedpath: FEED,
      confirm_token: tokenOf(first),
    });
    expect(stub.calls).toHaveLength(1);
    expect(textOf(second)).toContain('Removed');
  });
});

describe('read-only mode', () => {
  it('registers no sitemap write tool at all', async () => {
    const client = await connect({ readOnly: true });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('list_sitemaps');
    expect(names).not.toContain('submit_sitemap');
    expect(names).not.toContain('delete_sitemap');
  });

  it('answers a call to a suppressed tool with "not found", never "disabled"', async () => {
    // The tool is removed from the SDK's map outright, so this is the same
    // answer a genuinely unknown name gets — the server never advertises a
    // refusal it could have avoided listing.
    const client = await connect({ readOnly: true });
    // SDK v2 answers an unknown tool with a JSON-RPC error rather than a result
    // carrying isError, so both calls reject. The equivalence below is what
    // this test is about and is unaffected by that.
    const refusal = (name: string, args?: Record<string, unknown>) =>
      call(client, name, args).then(
        () => {
          throw new Error(`${name} answered instead of being refused`);
        },
        (error: Error) => error.message
      );

    const suppressed = await refusal('submit_sitemap', { feedpath: FEED });
    expect(suppressed).toContain('not found');
    expect(suppressed).not.toContain('disabled');

    // And the same answer a name that never existed gets, letter for letter
    // apart from the name — that equivalence is the point.
    const unknown = await refusal('no_such_tool');
    expect(unknown.replace('no_such_tool', 'submit_sitemap')).toBe(suppressed);
  });
});
