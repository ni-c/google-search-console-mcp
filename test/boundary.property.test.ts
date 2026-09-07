/**
 * What Google's JSON can be, fed through the whole server.
 *
 * Every tool declares an output schema, and on SDK 2.0 the server checks its
 * own `structuredContent` against it before answering: a violation is an
 * `isError` result with the text "Output validation error" and no cause — and
 * a listing loses every good element because of one bad one. `JSON.parse`
 * turns `1e999` into `Infinity`, a missing field into `undefined`, and
 * whatever answers in Google's place can write a number where a URL belongs.
 * This test feeds each tool both arbitrary JSON and envelopes of the right
 * shape with arbitrary leaves, and asserts the answer is never a crash and
 * never a schema violation.
 *
 * `SHAPE_RUNS=300 npx vitest run test/boundary.property.test.ts` for a deep
 * local run; CI keeps the count small.
 */
import type { CallToolResult } from '@modelcontextprotocol/client';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { call, connect, SITE, stubFetch, textOf } from './harness.js';

const RUNS = { numRuns: Number(process.env.SHAPE_RUNS ?? '20') };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Spliced into the serialised text where JSON.stringify could not write it. */
const INFINITY = '__INFINITY__';

/** A value the backend might put in any field. */
const leaf = fc.oneof(
  { weight: 3, arbitrary: fc.string({ maxLength: 40 }) },
  fc.string({ unit: 'binary', maxLength: 700 }),
  fc.double({ noNaN: true }),
  fc.integer(),
  fc.constant(1e300),
  fc.constant(-(2 ** 53)),
  fc.constant(2 ** 53),
  fc.constant(-0),
  fc.constant(null),
  fc.constant(true),
  fc.constant(INFINITY),
  fc.constant('constructor'),
  fc.constant('__proto__'),
  fc.constant('… (5 more characters omitted)'),
  fc.constant('x'.repeat(30_000)),
  fc.jsonValue({ maxDepth: 2 })
);

/** A leaf, or a value that is right for the field, so the good paths run too. */
function mostly<T>(good: fc.Arbitrary<T>): fc.Arbitrary<unknown> {
  return fc.oneof({ weight: 2, arbitrary: good }, leaf);
}

const siteUrl = mostly(
  fc.oneof(
    fc.constant(SITE),
    fc.constant('https://example.com/'),
    fc.constant('android-app://com.example'),
    fc.domain().map((d) => `sc-domain:${d}`)
  )
);

const loose = (fields: Record<string, fc.Arbitrary<unknown>>) =>
  fc.record({ ...fields, __proto__: leaf }, { requiredKeys: [] });

const siteList = loose({
  siteEntry: mostly(
    fc.array(loose({ siteUrl, permissionLevel: leaf }), { maxLength: 4 })
  ),
});

const sitemap = loose({
  path: leaf,
  lastSubmitted: leaf,
  lastDownloaded: leaf,
  isPending: leaf,
  warnings: leaf,
  errors: leaf,
  contents: mostly(
    fc.array(loose({ type: leaf, submitted: leaf, indexed: leaf }), {
      maxLength: 3,
    })
  ),
});

const sitemapList = loose({
  sitemap: mostly(fc.array(sitemap, { maxLength: 3 })),
});

const analytics = loose({
  rows: mostly(
    fc.array(
      loose({
        keys: mostly(fc.array(leaf, { maxLength: 3 })),
        clicks: leaf,
        impressions: leaf,
        ctr: leaf,
        position: leaf,
      }),
      { maxLength: 5 }
    )
  ),
  responseAggregationType: leaf,
});

const inspection = loose({
  inspectionResult: mostly(
    loose({
      inspectionResultLink: leaf,
      indexStatusResult: mostly(
        loose({
          verdict: leaf,
          coverageState: leaf,
          lastCrawlTime: leaf,
          sitemap: leaf,
          referringUrls: mostly(fc.array(leaf, { maxLength: 3 })),
        })
      ),
      mobileUsabilityResult: leaf,
      richResultsResult: leaf,
    })
  ),
});

const siteBlock = mostly(
  loose({
    type: mostly(fc.constantFrom('INET_DOMAIN', 'SITE', 'ANDROID_APP')),
    identifier: mostly(
      fc.oneof(fc.domain(), fc.constant('https://example.com/'), leaf)
    ),
  })
);

const resource = loose({
  id: leaf,
  site: siteBlock,
  owners: mostly(fc.array(leaf, { maxLength: 3 })),
});

const resourceList = loose({
  items: mostly(fc.array(resource, { maxLength: 3 })),
});

const token = loose({ token: leaf, method: leaf });

const metadata = loose({
  url: leaf,
  latestUpdate: mostly(loose({ type: leaf, notifyTime: leaf, url: leaf })),
  latestRemove: leaf,
});

const publish = loose({ urlNotificationMetadata: mostly(metadata) });

/** Any of the shapes above, or plain arbitrary JSON. */
function bodies(...shapes: fc.Arbitrary<unknown>[]): fc.Arbitrary<unknown> {
  return fc.oneof(
    { weight: 4, arbitrary: fc.oneof(...shapes) },
    fc.jsonValue({ maxDepth: 3 })
  );
}

function serialise(value: unknown): string {
  return JSON.stringify(value).replaceAll(`"${INFINITY}"`, '1e999');
}

const SITE_PATH = `/webmasters/v3/sites/${encodeURIComponent(SITE)}`;

/** Every read tool, the arguments it takes and the bodies it may meet. */
const TOOLS: {
  name: string;
  args: Record<string, unknown>;
  body: fc.Arbitrary<unknown>;
  /** Whether the text block is the JSON of the structured half. */
  json: boolean;
}[] = [
  { name: 'list_sites', args: {}, body: bodies(siteList), json: true },
  {
    name: 'get_site',
    args: { site_url: SITE },
    body: bodies(loose({ siteUrl, permissionLevel: leaf })),
    json: true,
  },
  {
    name: 'list_sitemaps',
    args: { site_url: SITE },
    body: bodies(sitemapList),
    json: true,
  },
  {
    name: 'get_sitemap',
    args: { site_url: SITE, feedpath: 'https://example.com/sitemap.xml' },
    body: bodies(sitemap),
    json: true,
  },
  {
    name: 'query_search_analytics',
    args: { site_url: SITE, period: 'last7days', dimensions: ['query'] },
    body: bodies(analytics),
    json: false,
  },
  {
    name: 'inspect_url',
    args: { site_url: SITE, inspection_url: 'https://example.com/a' },
    body: bodies(inspection),
    json: true,
  },
  {
    name: 'inspect_urls',
    args: {
      site_url: SITE,
      inspection_urls: ['https://example.com/a', 'https://example.com/b'],
    },
    body: bodies(inspection),
    json: true,
  },
  {
    name: 'list_verified_sites',
    args: {},
    body: bodies(resourceList),
    json: true,
  },
  {
    name: 'get_verified_site',
    args: { id: 'dns://example.com' },
    body: bodies(resource),
    json: true,
  },
  {
    name: 'get_verification_token',
    args: { site_url: SITE },
    body: bodies(token),
    json: false,
  },
  {
    name: 'verify_site',
    args: { site_url: SITE },
    body: bodies(resource),
    json: true,
  },
  {
    name: 'get_indexing_status',
    args: { url: 'https://example.com/a' },
    body: bodies(metadata),
    json: true,
  },
  {
    name: 'request_indexing',
    args: { url: 'https://example.com/a' },
    body: bodies(publish),
    json: true,
  },
  {
    name: 'setup_site',
    args: { site_url: SITE },
    body: bodies(siteList, resourceList, token),
    json: false,
  },
];

const CRASHES = [
  'Output validation error',
  'Cannot read properties',
  'is not a function',
  'must be of type',
  'Invalid time value',
  'ERR_INVALID_ARG_TYPE',
];

function jsonOfText(result: CallToolResult): unknown {
  const text = textOf(result);
  return JSON.parse(text.slice(text.indexOf('{')));
}

describe('every tool answers a sentence or a result, never a crash', () => {
  for (const tool of TOOLS) {
    it(tool.name, async () => {
      const client = await connect();
      await fc.assert(
        fc.asyncProperty(tool.body, async (body) => {
          const reply = {
            text: serialise(body),
            contentType: 'application/json',
          };
          stubFetch({
            'GET /webmasters/v3/sites': reply,
            [`GET ${SITE_PATH}`]: reply,
            [`GET ${SITE_PATH}/sitemaps`]: reply,
            [`GET ${SITE_PATH}/sitemaps/${encodeURIComponent('https://example.com/sitemap.xml')}`]:
              reply,
            [`POST ${SITE_PATH}/searchAnalytics/query`]: reply,
            'POST /v1/urlInspection/index:inspect': reply,
            'GET /webResource': reply,
            'GET /webResource/dns%3A%2F%2Fexample.com': reply,
            'POST /webResource': reply,
            'POST /token': reply,
            'GET /v3/urlNotifications/metadata': reply,
            'POST /v3/urlNotifications:publish': reply,
          });
          const result = await call(client, tool.name, tool.args);
          const text = textOf(result);
          for (const crash of CRASHES) expect(text).not.toContain(crash);
          // Every string that leaves is well-formed and free of control
          // characters, in both channels.
          expect(text.isWellFormed()).toBe(true);
          const structured = JSON.stringify(result.structuredContent ?? {});
          expect(structured.isWellFormed()).toBe(true);
          expect(structured).not.toMatch(/\\u00[01][0-9a-f]/);
          if (tool.json && !result.isError) {
            expect(jsonOfText(result)).toEqual(
              JSON.parse(JSON.stringify(result.structuredContent))
            );
          }
        }),
        RUNS
      );
    });
  }
});
