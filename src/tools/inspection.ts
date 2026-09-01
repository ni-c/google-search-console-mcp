import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { GoogleApiError } from '../api.js';
import { READ_ONLY } from './annotations.js';
import { objectOf } from '../normalize.js';
import { budgetedList, budgetedUntrustedResult, run } from '../result.js';
import { resolveSite, siteUrlSchema, webUrl } from '../schema.js';
import type { ToolContext } from './context.js';

const INSPECT = '/v1/urlInspection/index:inspect';

/**
 * Kept low on purpose, unlike the sitemap batch.
 *
 * The URL Inspection API allows 2 000 queries per property per day and 600 per
 * minute — a hard daily budget rather than a rate limit you can wait out. A
 * batch of 200 would spend a tenth of a day's allowance in one tool call, and
 * the caller would find out when something else stopped working hours later.
 * Twenty is enough to check a release's worth of pages and small enough that
 * spending the day's quota takes deliberate effort.
 */
const MAX_BATCH = 20;

const QUOTA_NOTE =
  'The URL Inspection API allows 2 000 calls per property per day and 600 per ' +
  'minute. That is a daily budget, not a rate limit — spending it blocks ' +
  'inspection for the rest of the day.';

export function registerInspectionTools(
  server: McpServer,
  { api, config }: ToolContext
): void {
  server.registerTool(
    'inspect_url',
    {
      title: 'Inspect a URL',
      description:
        'Asks Google what it knows about one URL: whether it is indexed, when it ' +
        'was last crawled, which sitemaps reference it, the canonical Google ' +
        'chose versus the one declared, robots.txt and mobile-usability verdicts, ' +
        'and any rich-result problems. This is the API behind the URL Inspection ' +
        'tool in the Search Console interface.\n\n' +
        'It reports the *indexed* state, not a live fetch — a page changed an ' +
        'hour ago still shows what Google last saw. ' +
        QUOTA_NOTE,
      inputSchema: z.object({
        site_url: siteUrlSchema(config),
        inspection_url: webUrl.describe(
          'The URL to inspect. It must be inside the property.'
        ),
        language_code: z
          .string()
          .optional()
          .describe(
            'BCP-47 code for the language of the issue messages, e.g. "de-CH". ' +
              'Defaults to en-US. It affects the wording only, never the verdicts.'
          ),
      }),
      annotations: READ_ONLY,
    },
    ({ site_url, inspection_url, language_code }) =>
      run(async () => {
        const site = resolveSite(config, site_url);
        const result = await inspect(api, site, inspection_url, language_code);
        return budgetedUntrustedResult(result);
      })
  );

  server.registerTool(
    'inspect_urls',
    {
      title: 'Inspect several URLs',
      description:
        `Inspects up to ${MAX_BATCH} URLs of one property in a single call, ` +
        'reporting a per-URL verdict. The API has no batch method — this makes ' +
        'the calls one after another — but it saves a round trip per URL. One ' +
        'failure does not stop the rest.\n\n' +
        'The result is condensed to the verdict fields; use inspect_url for the ' +
        'full report on a single URL. ' +
        QUOTA_NOTE,
      inputSchema: z.object({
        site_url: siteUrlSchema(config),
        inspection_urls: z
          .array(webUrl)
          .min(1)
          .max(MAX_BATCH)
          .describe('The URLs to inspect, all inside the same property'),
        language_code: z
          .string()
          .optional()
          .describe('BCP-47 code for the language of the issue messages'),
      }),
      annotations: READ_ONLY,
    },
    ({ site_url, inspection_urls, language_code }) =>
      run(async () => {
        const site = resolveSite(config, site_url);
        const results: Record<string, unknown>[] = [];

        for (const url of inspection_urls) {
          try {
            const result = await inspect(api, site, url, language_code);
            results.push({ url, ...summariseInspection(result) });
          } catch (error) {
            results.push({
              url,
              error:
                error instanceof GoogleApiError
                  ? `HTTP ${error.status}`
                  : error instanceof Error
                    ? error.message
                    : String(error),
            });
            // A 429 means the quota is gone; every remaining call would fail the
            // same way, so stopping is both faster and more honest than
            // returning nineteen identical errors.
            if (error instanceof GoogleApiError && error.status === 429) {
              results.push({
                note:
                  'Stopped early: the quota is exhausted, so the remaining URLs ' +
                  'were not attempted.',
              });
              break;
            }
          }
        }

        return budgetedList('results', results, {
          untrusted: true,
          narrowWith:
            'Split the list and call inspect_urls again with fewer URLs.',
          extra: { site, note: QUOTA_NOTE },
        });
      })
  );
}

async function inspect(
  api: ToolContext['api'],
  site: string,
  url: string,
  languageCode: string | undefined
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    inspectionUrl: url,
    siteUrl: site,
  };
  if (languageCode !== undefined) body.languageCode = languageCode;
  // Inspection changes nothing, so retrying a 503 is safe. A 429 is retried too
  // — the backoff may be enough if the minute limit rather than the day limit
  // was hit.
  const response = await api.post('search-console', INSPECT, body, {
    retryable: true,
  });
  return objectOf(response, 'inspection result');
}

/**
 * Reduces a full inspection to the fields a batch is actually asked for.
 *
 * A single inspection result runs to several kilobytes — referring URLs, the
 * whole rich-results breakdown, the AMP verdict — and twenty of them would be
 * most of a context window spent on the parts nobody read. What survives is the
 * verdict, the reason it was reached and the crawl date, which is the answer to
 * "did this page make it in".
 */
export function summariseInspection(
  result: Record<string, unknown>
): Record<string, unknown> {
  const status = (result.inspectionResult ?? {}) as Record<string, unknown>;
  const index = (status.indexStatusResult ?? {}) as Record<string, unknown>;
  const mobile = (status.mobileUsabilityResult ?? {}) as Record<
    string,
    unknown
  >;

  return {
    verdict: index.verdict,
    coverageState: index.coverageState,
    lastCrawlTime: index.lastCrawlTime,
    robotsTxtState: index.robotsTxtState,
    indexingState: index.indexingState,
    googleCanonical: index.googleCanonical,
    userCanonical: index.userCanonical,
    mobileVerdict: mobile.verdict,
    inspectionResultLink: status.inspectionResultLink,
  };
}
