import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { vi } from 'vitest';

import type { TokenSource } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';

export const SITE = 'sc-domain:example.com';
export const URL_SITE = 'https://example.com/';
export const TOKEN = 'ya29.test-access-token';

/** The three hosts, so a test names a route the way the server builds it. */
export const HOSTS = {
  searchConsole: 'https://searchconsole.googleapis.com',
  verification: 'https://www.googleapis.com/siteVerification/v1',
  indexing: 'https://indexing.googleapis.com',
} as const;

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    auth: {
      mode: 'oauth-refresh-token',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      refreshToken: 'test-refresh',
    },
    defaultSiteUrl: undefined,
    allowedSites: undefined,
    readOnly: false,
    // Every field `Config` declares, written out rather than built from a
    // partial. That is what makes `npm run typecheck` fail when a field is
    // added and this literal is not — and it can only do that while the return
    // type really is `Config`. Without it a missing field arrives as
    // `undefined` at runtime, which for `elicitation` reads as *off*: the
    // suites would have believed they were exercising the dialog while every
    // test server took the token fallback.
    elicitation: true,
    allowTools: undefined,
    denyTools: undefined,
    ...overrides,
  };
}

/** A token source that hands out a fixed token and never touches the network. */
export function testTokens(token = TOKEN): TokenSource {
  return {
    getAccessToken: () => Promise.resolve(token),
    describe: () => 'test credentials',
  };
}

export interface Recorded {
  method: string;
  url: string;
  /** The path with the service host stripped, query string included. */
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export type Handler = Reply | ((request: Recorded) => Reply);

/**
 * Routes are keyed `"<METHOD> <path>"`, with the path relative to whichever of
 * the three service hosts the call went to.
 *
 * Stripping the host rather than keying on the full URL keeps the tests
 * readable, and the paths cannot collide: Search Console owns `/webmasters` and
 * `/v1`, verification owns `/webResource` and `/token`, and the Indexing API
 * owns `/v3`.
 */
export type Routes = Record<string, Handler>;

export interface FetchStub {
  calls: Recorded[];
}

/**
 * Replaces global fetch with a router over canned replies.
 *
 * A request with no matching route fails the test loudly rather than returning
 * an empty object: a tool that silently called the wrong path would otherwise
 * pass every assertion about its output.
 */
export function stubFetch(routes: Routes = {}): FetchStub {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      const host = Object.values(HOSTS).find((base) => url.startsWith(base));
      const path = host === undefined ? url : url.slice(host.length);

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>
      )) {
        headers[key.toLowerCase()] = value;
      }

      const recorded: Recorded = {
        method,
        url,
        path,
        headers,
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(recorded);

      const bare = path.split('?')[0] as string;
      const handler =
        routes[`${method} ${path}`] ?? routes[`${method} ${bare}`];
      if (handler === undefined) {
        throw new Error(`no stubbed route for ${method} ${path}`);
      }
      const reply = typeof handler === 'function' ? handler(recorded) : handler;
      const body =
        reply.text !== undefined
          ? reply.text
          : JSON.stringify(reply.json ?? {});
      return Promise.resolve(
        new Response(reply.status === 204 ? null : body, {
          status: reply.status ?? 200,
          headers: {
            'content-type':
              reply.contentType ??
              (reply.text !== undefined ? 'text/plain' : 'application/json'),
            ...reply.headers,
          },
        })
      );
    })
  );
  return { calls };
}

/** How a client that can show a dialog answers it. */
export type ElicitBehaviour = 'accept' | 'decline' | 'cancel';

/**
 * Connects a client to the real server.
 *
 * Without `elicit` the client declares no elicitation capability, which is the
 * case the two-call token exists for and what every other test here drives.
 * With it, the client answers the dialog, and `prompts` records what the server
 * put in front of the user.
 */
export async function connect(
  overrides: Partial<Config> = {},
  elicit?: ElicitBehaviour
): Promise<Client & { prompts: string[] }> {
  const server = createServer(testConfig(overrides), { tokens: testTokens() });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const prompts: string[] = [];
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    elicit === undefined ? {} : { capabilities: { elicitation: {} } }
  );
  if (elicit !== undefined) {
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as { message?: string };
      prompts.push(params.message ?? '');
      if (elicit === 'cancel') return { action: 'cancel' };
      if (elicit === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return Object.assign(client, { prompts });
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** The text of a tool result, joined across content blocks. */
export function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n');
}

/** The first JSON object embedded in a tool result. */
export function jsonOf(result: CallToolResult): Record<string, unknown> {
  const text = textOf(result);
  const start = text.indexOf('{');
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

/** The confirmation token a guarded tool handed back on its first call. */
export function tokenOf(result: CallToolResult): string {
  const match = /confirm_token="([0-9a-f]{32})"/.exec(textOf(result));
  if (!match?.[1]) {
    throw new Error(`no confirmation token in: ${textOf(result)}`);
  }
  return match[1];
}

/*
 * The fixtures below follow the shapes in Google's discovery documents
 * (`searchconsole/v1`, `siteVerification/v1`, `indexing/v3`), fetched on
 * 2026-08-28, rather than being invented. Two things they pin down that a
 * hand-written fixture would have got wrong:
 *
 *   - Google omits an empty array entirely. A credential with no properties
 *     gets `{}` back from sites.list, never `{"siteEntry": []}` — which is why
 *     `listField` treats a missing field as empty rather than reaching for
 *     `.length` on undefined.
 *   - The verification resource nests the site as `{site: {type, identifier}}`
 *     and its `id` is an opaque string that is *not* the Search Console
 *     property spelling.
 */

export function siteEntry(
  siteUrl = SITE,
  permissionLevel = 'siteOwner'
): Record<string, unknown> {
  return { siteUrl, permissionLevel };
}

export function sitemapEntry(
  path = 'https://example.com/sitemap.xml'
): Record<string, unknown> {
  return {
    path,
    lastSubmitted: '2026-08-20T09:12:44.123Z',
    isPending: false,
    isSitemapsIndex: false,
    type: 'sitemap',
    lastDownloaded: '2026-08-21T04:31:02.884Z',
    warnings: '0',
    errors: '0',
    contents: [{ type: 'web', submitted: '412', indexed: '0' }],
  };
}

export function verificationResource(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'dns://example.com',
    site: { type: 'INET_DOMAIN', identifier: 'example.com' },
    owners: ['owner@example.com'],
    ...overrides,
  };
}

export function inspectionResult(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    inspectionResult: {
      inspectionResultLink:
        'https://search.google.com/search-console/inspect?resource_id=sc-domain%3Aexample.com',
      indexStatusResult: {
        verdict: 'PASS',
        coverageState: 'Submitted and indexed',
        robotsTxtState: 'ALLOWED',
        indexingState: 'INDEXING_ALLOWED',
        lastCrawlTime: '2026-08-25T11:02:19Z',
        pageFetchState: 'SUCCESSFUL',
        googleCanonical: 'https://example.com/page',
        userCanonical: 'https://example.com/page',
        sitemap: ['https://example.com/sitemap.xml'],
      },
      mobileUsabilityResult: { verdict: 'PASS' },
      ...overrides,
    },
  };
}
