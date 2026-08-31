import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  budgetedJson,
  budgetedUntrustedResult,
  run,
  untrustedResult,
} from '../result.js';

import { assertUrlAllowed, webUrl } from '../schema.js';
import type { ToolContext } from './context.js';

/**
 * What the Indexing API is actually for, said in every description that touches
 * it.
 *
 * Google's documentation is unambiguous and widely ignored: the API accepts a
 * notification for any URL the credential owns, and only *acts* on pages
 * carrying JobPosting or BroadcastEvent structured data. For an ordinary page it
 * returns 200 with a timestamp and does nothing at all. That success is the
 * problem — an SEO tool that reports "submitted for indexing" and produced no
 * effect is worse than one that refuses, so this says so up front rather than
 * letting a green result imply something it does not mean.
 */
const SCOPE_WARNING =
  'Google only acts on this for pages with JobPosting or BroadcastEvent ' +
  'structured data. For any other page the call succeeds, returns a timestamp, ' +
  'and changes nothing — it is not a way to get a normal page crawled sooner. ' +
  'Submit a sitemap for that.';

const OWNERSHIP_NOTE =
  'The credential must be a verified *owner* of the property — Search Console ' +
  'user access is not enough, and the API answers 403 without saying which of ' +
  'the two is missing.';

/**
 * These two tools are the reason {@link assertUrlAllowed} exists.
 *
 * Every other tool names a property and goes through `resolveSite`, which is
 * where `GSC_ALLOWED_SITES` is enforced. The Indexing API names a page instead,
 * so there is no property to check and the allowlist would silently not apply —
 * on the one write tool that spends a finite daily quota and puts a URL in front
 * of Google.
 */
export function registerIndexingTools(
  server: McpServer,
  { api, config, readOnly }: ToolContext
): void {
  server.registerTool(
    'get_indexing_status',
    {
      title: 'Get Indexing API status for a URL',
      description:
        'Returns when this credential last notified Google about a URL through ' +
        'the Indexing API, and what kind of notification it was. This reports ' +
        'the notification history only — it says nothing about whether the page ' +
        'is indexed. inspect_url answers that. ' +
        OWNERSHIP_NOTE,
      inputSchema: z.object({
        url: webUrl.describe('The URL to look up the notification history for'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ url }) =>
      run(async () => {
        assertUrlAllowed(config, url);
        return budgetedUntrustedResult(
          await api.get('indexing', '/v3/urlNotifications/metadata', {
            query: { url },
          })
        );
      })
  );

  if (readOnly) return;

  server.registerTool(
    'request_indexing',
    {
      title: 'Notify Google that a URL changed',
      description:
        'Tells Google through the Indexing API that a URL was updated or ' +
        'removed.\n\n' +
        SCOPE_WARNING +
        '\n\n' +
        OWNERSHIP_NOTE +
        ' The default quota is 200 URLs per day per project.',
      inputSchema: z.object({
        url: webUrl.describe('The URL that changed'),
        type: z
          .enum(['URL_UPDATED', 'URL_DELETED'])
          .optional()
          .describe(
            'URL_UPDATED (default) for a new or changed page, URL_DELETED for ' +
              'one that has been removed. URL_DELETED requires that the page ' +
              'actually returns 404 or 410 — Google checks.'
          ),
      }),
      annotations: { idempotentHint: true },
    },
    ({ url, type }) =>
      run(async () => {
        assertUrlAllowed(config, url);
        const result = await api.post(
          'indexing',
          '/v3/urlNotifications:publish',
          {
            url,
            type: type ?? 'URL_UPDATED',
          }
        );
        return untrustedResult(
          `Notification accepted for ${url} (${type ?? 'URL_UPDATED'}).\n\n` +
            `${budgetedJson(result)}\n\n` +
            'Accepted is not acted upon. ' +
            SCOPE_WARNING
        );
      })
  );
}
