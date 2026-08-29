import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { GoogleApiError, pathSegment } from '../api.js';
import { guarded } from '../guard.js';
import { listField } from '../normalize.js';
import {
  budgetedList,
  budgetedUntrustedResult,
  run,
  textResult,
} from '../result.js';
import { confirmToken, resolveSite, siteUrlSchema, webUrl } from '../schema.js';
import type { ToolContext } from './context.js';

const SITES = '/webmasters/v3/sites';

function sitemapsPath(site: string, feedpath?: string): string {
  const base = `${SITES}/${pathSegment(site)}/sitemaps`;
  return feedpath === undefined ? base : `${base}/${pathSegment(feedpath)}`;
}

/**
 * The one thing everybody asks about sitemaps, answered in the tool description
 * rather than in a FAQ nobody reads at the moment they need it.
 *
 * There is no "update" method, and its absence is not an oversight: submitting
 * is a `PUT` of an address, so submitting the same sitemap again is exactly what
 * updating means. Google then re-fetches it on its own schedule. The old
 * `google.com/ping?sitemap=` endpoint that used to nudge that along was
 * switched off in June 2023 and has no replacement.
 */
const RESUBMIT_NOTE =
  'To refresh a sitemap Google already knows, submit the same URL again — there ' +
  'is no separate update call, and submitting is idempotent. Google re-crawls ' +
  'on its own schedule; nothing can force it, and the ping endpoint that used ' +
  'to exist was removed in 2023.';

/** Bounded so a batch cannot become a quota-burning loop by accident. */
const MAX_BATCH = 50;

export function registerSitemapTools(
  server: McpServer,
  { api, config, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_sitemaps',
    {
      title: 'List sitemaps',
      description:
        'Lists the sitemaps submitted for a property, each with when Google last ' +
        'downloaded it, how many URLs it holds per content type, and whether ' +
        'processing produced warnings or errors. ' +
        RESUBMIT_NOTE,
      inputSchema: {
        site_url: siteUrlSchema(config),
        sitemap_index: webUrl
          .optional()
          .describe(
            'Restrict the result to the sitemaps listed inside this sitemap ' +
              'index. Without it, only sitemaps submitted directly are returned — ' +
              'the children of an index are not.'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ site_url, sitemap_index }) =>
      run(async () => {
        const site = resolveSite(config, site_url);
        const body = await api.get('search-console', sitemapsPath(site), {
          query: { sitemapIndex: sitemap_index },
        });
        const sitemaps = listField(body, 'sitemap');
        return budgetedList('sitemaps', sitemaps, {
          untrusted: true,
          narrowWith:
            'Pass sitemap_index to list the children of one index, or call ' +
            'get_sitemap for a single sitemap in full.',
          extra: {
            site,
            note:
              sitemaps.length === 0 && sitemap_index === undefined
                ? 'No sitemaps are submitted for this property. Note that this ' +
                  'lists only directly submitted sitemaps — if an index was ' +
                  'submitted, pass its URL as sitemap_index to see its children.'
                : RESUBMIT_NOTE,
          },
        });
      })
  );

  server.registerTool(
    'get_sitemap',
    {
      title: 'Get one sitemap',
      description:
        'Returns the full record for a single submitted sitemap: last submitted, ' +
        'last downloaded, warnings, errors, and the URL counts per content type. ' +
        'This is how to check whether a submission actually worked — errors ' +
        'appear here, never in the response to submit_sitemap.',
      inputSchema: {
        site_url: siteUrlSchema(config),
        feedpath: webUrl.describe(
          'The full URL of the sitemap, e.g. https://example.com/sitemap.xml'
        ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ site_url, feedpath }) =>
      run(async () => {
        const site = resolveSite(config, site_url);
        return budgetedUntrustedResult(
          await api.get('search-console', sitemapsPath(site, feedpath))
        );
      })
  );

  if (readOnly) return;

  server.registerTool(
    'submit_sitemap',
    {
      title: 'Submit a sitemap',
      description:
        'Submits a sitemap URL, or resubmits one Google already knows. ' +
        RESUBMIT_NOTE +
        ' The call succeeding means Google accepted the address, not that the ' +
        'sitemap is valid — it is fetched later, and any parse error shows up in ' +
        'get_sitemap minutes to hours afterwards.',
      inputSchema: {
        site_url: siteUrlSchema(config),
        feedpath: webUrl.describe(
          'The full URL of the sitemap. It must be inside the property — ' +
            'https://example.com/sitemap.xml for https://example.com/'
        ),
      },
      annotations: { idempotentHint: true },
    },
    ({ site_url, feedpath }) =>
      run(async () => {
        const site = resolveSite(config, site_url);
        // Idempotent by construction — a PUT of an address — so a retry after a
        // timeout cannot do anything twice.
        await api.put(
          'search-console',
          sitemapsPath(site, feedpath),
          undefined,
          { retryable: true }
        );
        return textResult(
          `Submitted ${feedpath} for ${site}.\n\n` +
            'Google has accepted the address; it has not fetched the file yet. ' +
            'Call get_sitemap in a few minutes to see lastDownloaded, the URL ' +
            'counts, and any warnings or errors.'
        );
      })
  );

  server.registerTool(
    'submit_sitemaps',
    {
      title: 'Submit several sitemaps',
      description:
        'Submits up to ' +
        `${MAX_BATCH} sitemaps for one property in a single call, reporting ` +
        'success or failure per entry. The API has no batch method — this makes ' +
        'the calls one after another — but it saves a round trip per sitemap, ' +
        'which is what makes a large site practical. One failure does not stop ' +
        'the rest.',
      inputSchema: {
        site_url: siteUrlSchema(config),
        feedpaths: z
          .array(webUrl)
          .min(1)
          .max(MAX_BATCH)
          .describe('The full URLs of the sitemaps to submit'),
      },
      annotations: { idempotentHint: true },
    },
    ({ site_url, feedpaths }) =>
      run(async () => {
        const site = resolveSite(config, site_url);
        const results: { feedpath: string; ok: boolean; error?: string }[] = [];
        for (const feedpath of feedpaths) {
          try {
            await api.put(
              'search-console',
              sitemapsPath(site, feedpath),
              undefined,
              { retryable: true }
            );
            results.push({ feedpath, ok: true });
          } catch (error) {
            results.push({
              feedpath,
              ok: false,
              error:
                error instanceof GoogleApiError
                  ? `HTTP ${error.status}`
                  : error instanceof Error
                    ? error.message
                    : String(error),
            });
          }
        }

        const failed = results.filter((entry) => !entry.ok);
        return budgetedList('results', results, {
          narrowWith:
            'Split the list and call submit_sitemaps again with fewer URLs.',
          extra: {
            site,
            submitted: results.length - failed.length,
            failed: failed.length,
            note:
              'Acceptance is not validation — Google fetches each file later. ' +
              'Use list_sitemaps to see what it made of them.',
          },
        });
      })
  );

  server.registerTool(
    'delete_sitemap',
    {
      title: 'Remove a sitemap',
      description:
        'Removes a sitemap from the property. Two-step: the first call returns a ' +
        'confirmation token, the second performs the removal.',
      inputSchema: {
        site_url: siteUrlSchema(config),
        feedpath: webUrl.describe('The full URL of the sitemap to remove'),
        confirm_token: confirmToken,
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    ({ site_url, feedpath, confirm_token }) =>
      run(async () => {
        const site = resolveSite(config, site_url);
        return guarded(
          confirmations,
          {
            // Both the property and the feedpath: a token for one sitemap must
            // not authorise removing a different one from the same property.
            tool: 'delete_sitemap',
            targets: [site, feedpath],
            // The property is server-derived and safe in the sentence; the
            // feedpath is the value a model most naturally copies out of
            // list_sitemaps, so it is quoted as data underneath instead.
            what: `remove a sitemap from ${site}`,
            target: feedpath,
            consequence:
              'Google stops using it to discover URLs, and the submission ' +
              'history and error report for it are discarded. The file itself ' +
              'is untouched, and submit_sitemap puts it back — this is the ' +
              'least destructive of the three guarded operations.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete('search-console', sitemapsPath(site, feedpath));
            return textResult(`Removed ${feedpath} from ${site}.`);
          }
        );
      })
  );
}
