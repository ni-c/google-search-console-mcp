import type { McpServer } from '@modelcontextprotocol/server';
import {
  budgetedList,
  budgetedUntrustedResult,
  run,
  structuredResult,
} from '../result.js';
import {
  allowsSite,
  confirmToken,
  resolveSite,
  siteUrlSchema,
} from '../schema.js';
import { z } from 'zod';
import { record, truncationNote, untrustedFields } from '../output-schema.js';

import { pathSegment } from '../api.js';
import { READ_ONLY } from './annotations.js';
import { normalizeSiteUrl } from '../config.js';
import { guarded } from '../guard.js';
import { listField } from '../normalize.js';
import type { ToolContext } from './context.js';

/** Where every Search Console property call lives. */
const SITES = '/webmasters/v3/sites';

/**
 * What each permission level means for the rest of this server.
 *
 * `siteUnverifiedUser` is the one worth explaining every time it appears. It
 * means the property is listed but ownership was never proven, and Search
 * Console answers every data call for it with 403 — so a `list_sites` that shows
 * a property is not a promise that anything else will work on it. This is
 * precisely the state `add_site` leaves a property in.
 */
const PERMISSION_NOTE =
  'permissionLevel is what the credential may do: siteOwner (everything, ' +
  'including the Indexing API), siteFullUser (all data, no user management), ' +
  'siteRestrictedUser (most data), and siteUnverifiedUser — which means the ' +
  'property is listed but ownership was never proven, and every data call for ' +
  'it returns 403 until it is verified.';

export function registerSiteTools(
  server: McpServer,
  { api, approval, config, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_sites',
    {
      title: 'List properties',
      description:
        'Lists every Search Console property this credential can see, with the ' +
        'permission level it has on each. This is the first call to make when ' +
        'anything returns 403: an empty list means the identity was never added ' +
        'to any property, which is the usual state of a fresh service account. ' +
        PERMISSION_NOTE,
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      outputSchema: z
        .object({
          ...untrustedFields,
          truncated: truncationNote,
          sites: z.array(record),
        })
        .catchall(z.unknown()),
    },
    () =>
      run(async () => {
        const all = listField(
          await api.get('search-console', SITES),
          'siteEntry'
        );
        // Filtered rather than merely refused afterwards: showing a property
        // that every other tool will decline both discloses a name the operator
        // fenced off and invites a call that cannot succeed.
        const sites = all.filter((entry) =>
          allowsSite(config, entryUrl(entry))
        );
        const withheld = all.length - sites.length;
        return budgetedList('sites', sites, {
          untrusted: true,
          narrowWith: 'get_site returns one property in full.',
          extra: {
            note:
              sites.length === 0
                ? 'This credential can see no properties at all. Add it as a ' +
                  'user in Search Console under Settings → Users and ' +
                  'permissions, or give it ownership with verify_site. ' +
                  'setup_site walks through that.'
                : PERMISSION_NOTE,
            ...(withheld > 0
              ? {
                  withheld_by_configuration:
                    `${withheld} propert${withheld === 1 ? 'y is' : 'ies are'} ` +
                    'not shown because they are not listed in GSC_ALLOWED_SITES.',
                }
              : {}),
          },
        });
      })
  );

  server.registerTool(
    'get_site',
    {
      title: 'Get one property',
      description:
        'Returns one property and the permission level this credential has on ' +
        'it. Useful for settling which of the two spellings exists — ' +
        '"sc-domain:example.com" and "https://example.com/" are separate ' +
        'properties holding separate data.',
      inputSchema: z.object({ site_url: siteUrlSchema(config) }),
      annotations: READ_ONLY,
      outputSchema: record.extend(untrustedFields),
    },
    ({ site_url }) =>
      run(async () => {
        const site = resolveSite(config, site_url);
        return budgetedUntrustedResult(
          await api.get('search-console', `${SITES}/${pathSegment(site)}`)
        );
      })
  );

  if (readOnly) return;

  server.registerTool(
    'add_site',
    {
      title: 'Add a property',
      description:
        'Adds a property to Search Console. This does NOT verify ownership: ' +
        'unless the credential already owns the domain, the property lands as ' +
        'siteUnverifiedUser and every data call for it returns 403. To actually ' +
        'get a working property, use setup_site, which does this in the right ' +
        'order — get_verification_token, then the DNS record or HTML file, then ' +
        'verify_site, then this.',
      inputSchema: z.object({
        // Not `siteUrlSchema`: adding a property is the one call where
        // defaulting to GSC_SITE_URL would be actively wrong. The default names
        // the property you work with; this argument names one that does not
        // exist yet, and silently re-adding the default is never what was meant.
        site_url: siteUrlSchema(config).describe(
          'The property to create: "sc-domain:example.com" or ' +
            '"https://example.com/". Required — this one does not fall back to ' +
            'GSC_SITE_URL, because the property being created is by definition ' +
            'not the one you are already working with.'
        ),
      }),
      annotations: {
        // Additive: it brings a property into Search Console. Adding one
        // that exists returns the existing property.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({
        site: z.string(),
        added: z.literal(true),
        note: z.string(),
      }),
    },
    ({ site_url }) =>
      run(async () => {
        if (site_url === undefined) {
          throw new Error(
            'site_url is required for add_site and is not defaulted from ' +
              'GSC_SITE_URL — name the property to create explicitly.'
          );
        }
        const site = resolveSite(config, site_url);
        await api.put('search-console', `${SITES}/${pathSegment(site)}`);
        return structuredResult({
          site,
          added: true,
          note:
            'It is not verified yet unless this credential already owned the ' +
            'domain. Run get_site to see the permission level: anything other ' +
            'than siteOwner or siteFullUser means data calls will return 403. ' +
            'setup_site says what is still missing.',
        });
      })
  );

  server.registerTool(
    'delete_site',
    {
      title: 'Remove a property',
      description:
        'Removes a property from Search Console. Two-step: the first call ' +
        'returns a confirmation token, the second performs the removal.',
      inputSchema: z.object({
        site_url: siteUrlSchema(config),
        confirm_token: confirmToken,
      }),
      annotations: {
        // Discards roughly sixteen months of performance data. Re-adding the
        // property starts an empty history — that is what is destroyed here,
        // not the entry in a list.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({ site: z.string(), removed: z.literal(true) }),
    },
    ({ site_url, confirm_token }, mcp) =>
      run(async () => {
        const site = resolveSite(config, site_url);
        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'delete_site',
            targets: [site],
            what: `remove the property ${site} from Search Console`,
            consequence:
              'Search Console keeps roughly 16 months of performance data per ' +
              'property, and removing it discards all of it. Re-adding the ' +
              'property later starts an empty history — the old data does not ' +
              'come back. Ownership verification is unaffected and stays in ' +
              'place; unverify_site is what removes that.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete('search-console', `${SITES}/${pathSegment(site)}`);
            return structuredResult({ site, removed: true });
          }
        );
      })
  );
}

/**
 * A property entry's identifier, normalised, or '' when it is neither kind.
 *
 * Never throws. Search Console also lists Android app properties
 * (`android-app://…`), which `normalizeSiteUrl` rightly refuses — but one of
 * those in an account must not take down a listing of everything else, or
 * `setup_site` for an unrelated property.
 */
function entryUrl(entry: Record<string, unknown>): string {
  const siteUrl = entry.siteUrl;
  if (typeof siteUrl !== 'string') return '';
  try {
    return normalizeSiteUrl(siteUrl);
  } catch {
    return '';
  }
}

/** Property identifiers this credential can see, for `setup_site` to compare. */
export async function listSiteUrls(
  api: ToolContext['api']
): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  const entries = listField(
    await api.get('search-console', SITES),
    'siteEntry'
  );
  return entries.flatMap((entry) => {
    // Normalised so that a comparison against a caller's spelling is a
    // comparison of properties, not of strings. Google returns what it stored,
    // which for a URL-prefix property always carries the trailing slash — but
    // the caller's does not have to.
    const siteUrl = entryUrl(entry);
    if (siteUrl === '') return [];
    return [
      {
        siteUrl,
        permissionLevel:
          typeof entry.permissionLevel === 'string'
            ? entry.permissionLevel
            : 'unknown',
      },
    ];
  });
}
