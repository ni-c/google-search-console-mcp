import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  budgetedJson,
  budgetedList,
  budgetedUntrustedResult,
  run,
  textResult,
  untrustedResult,
} from '../result.js';
import {
  allowsSite,
  confirmToken,
  resolveSite,
  siteUrlSchema,
} from '../schema.js';
import {
  METHODS,
  TOKEN_METHODS,
  placementInstructions,
  toSiteUrl,
  toVerificationSite,
  type VerificationSite,
} from '../site-identity.js';

import { pathSegment } from '../api.js';
import { READ_ONLY } from './annotations.js';
import { normalizeSiteUrl, type Config } from '../config.js';
import { guarded } from '../guard.js';
import { listField, objectOf } from '../normalize.js';
import type { ToolContext } from './context.js';

const WEB_RESOURCE = '/webResource';

export function registerVerificationTools(
  server: McpServer,
  { api, approval, config, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_verified_sites',
    {
      title: 'List owned sites',
      description:
        'Lists every site this credential has *verified ownership* of, with the ' +
        'full owner list for each. This is a different list from list_sites: ' +
        'that one is Search Console properties, this one is proven ownership, ' +
        'and a site can be in either without being in the other. setup_site ' +
        'compares the two.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        const all = listField(
          await api.get('site-verification', WEB_RESOURCE),
          'items'
        );
        // Filtered, not just refused later. The ids in this list are exactly
        // what unverify_site and update_site_owners act on, so handing back an
        // id for a property the operator fenced off both discloses it and
        // invites a call that has to be refused.
        const items = all.filter((item) =>
          allowsSite(config, resourceSiteUrl(item) ?? '')
        );
        const withheld = all.length - items.length;
        return budgetedList('verified_sites', items, {
          untrusted: true,
          narrowWith:
            'get_verified_site returns one entry in full by its "id".',
          extra: {
            note:
              items.length === 0
                ? 'This credential owns nothing. That is the normal state of a ' +
                  'fresh service account — get_verification_token starts the ' +
                  'process of changing it.'
                : 'The "id" of each entry is what get_verified_site, ' +
                  'update_site_owners and unverify_site take.',
            ...(withheld > 0
              ? {
                  withheld_by_configuration:
                    `${withheld} owned site(s) are not shown because they are ` +
                    'not listed in GSC_ALLOWED_SITES.',
                }
              : {}),
          },
        });
      })
  );

  server.registerTool(
    'get_verified_site',
    {
      title: 'Get one owned site',
      description:
        'Returns one verified site and the email addresses of all its owners.',
      inputSchema: z.object({ id: idSchema() }),
      annotations: READ_ONLY,
    },
    ({ id }) =>
      run(async () =>
        budgetedUntrustedResult(await allowedResource(api, config, id))
      )
  );

  server.registerTool(
    'get_verification_token',
    {
      title: 'Get a verification token',
      description:
        'Returns the token that proves ownership of a site, and says exactly ' +
        'where to put it. Nothing is created and nothing is claimed by this ' +
        'call — it is safe to run against a domain you do not own, it just ' +
        'achieves nothing.\n\n' +
        'A domain property can only be proven by DNS. A URL-prefix property can ' +
        'use FILE or META here; ANALYTICS and TAG_MANAGER prove ownership ' +
        'through an existing Google product rather than a token, so they have no ' +
        'token to fetch and are only usable with verify_site directly.\n\n' +
        'Placing the token is a human step. Once it is in place, call verify_site.',
      inputSchema: z.object({
        site_url: siteUrlSchema(config),
        method: z
          .enum(['DNS', 'FILE', 'META'])
          .optional()
          .describe(
            'Defaults to the only sensible one for the property kind: DNS for a ' +
              'domain property, META for a URL-prefix property.'
          ),
      }),
      annotations: READ_ONLY,
    },
    ({ site_url, method }) =>
      run(async () => {
        const site = toVerificationSite(resolveSite(config, site_url));
        const chosen = method ?? defaultMethod(site);
        assertMethod(site, chosen, TOKEN_METHODS[site.type]);

        const response = objectOf(
          await api.post('site-verification', '/token', {
            site,
            verificationMethod: chosen,
          }),
          'verification token'
        );

        const token = response.token;
        if (typeof token !== 'string') {
          throw new Error('Google returned no token for this site');
        }

        return textResult(
          `Verification token for ${site.identifier} (${site.type}), method ${chosen}:\n\n` +
            `${token}\n\n` +
            placementInstructions(site, chosen, token)
        );
      })
  );

  if (readOnly) return;

  server.registerTool(
    'verify_site',
    {
      title: 'Verify ownership',
      description:
        'Tells Google to check for the verification token and, if it finds it, ' +
        'records this credential as an owner. Run get_verification_token first ' +
        'and place the token — this call only checks, it does not place ' +
        'anything.\n\n' +
        'A failure here is almost always "not there yet" rather than "wrong": ' +
        'DNS records take minutes to an hour to propagate, and a freshly ' +
        'uploaded file may still be behind a CDN cache. Retrying later is the ' +
        'normal response.',
      inputSchema: z.object({
        site_url: siteUrlSchema(config),
        method: z
          .enum(['DNS', 'FILE', 'META', 'ANALYTICS', 'TAG_MANAGER'])
          .optional()
          .describe(
            'Must match the method the token was obtained for. Defaults to DNS ' +
              'for a domain property and META for a URL-prefix property.'
          ),
      }),
      annotations: {
        // Additive: it claims ownership. Verifying an already verified site
        // leaves it verified.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ site_url, method }) =>
      run(async () => {
        const site = toVerificationSite(resolveSite(config, site_url));
        const chosen = method ?? defaultMethod(site);
        assertMethod(site, chosen, METHODS[site.type]);

        const result = objectOf(
          await api.post(
            'site-verification',
            WEB_RESOURCE,
            { site },
            { query: { verificationMethod: chosen } }
          ),
          'verified site'
        );

        // Marked untrusted: the owner list is other people's email addresses as
        // Google stored them, and the resource id is a string this server did
        // not choose.
        return untrustedResult(
          `Ownership of ${site.identifier} is verified.\n\n` +
            `Resource id: ${String(result.id ?? '(none returned)')}\n` +
            `Owners: ${listOwners(result)}\n\n` +
            'This is ownership, not a Search Console property. If the property ' +
            'does not exist yet, add_site creates it — and it will now land as ' +
            'siteOwner rather than unverified.'
        );
      })
  );

  server.registerTool(
    'unverify_site',
    {
      title: 'Remove ownership',
      description:
        'Removes this credential from the owners of a site. Two-step: the first ' +
        'call returns a confirmation token, the second performs the removal.',
      inputSchema: z.object({ id: idSchema(), confirm_token: confirmToken }),
      annotations: {
        // Gives up ownership: every data call for the property starts
        // returning 403 and the Indexing API stops working. Regaining it
        // means placing the token again.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id, confirm_token }, mcp) =>
      run(async () => {
        // Fetched before the guard rather than inside it, for two reasons: the
        // allowlist can only be checked against the resource's own site block,
        // and the confirmation sentence then names the property this server
        // derived instead of the opaque id the model was handed by an earlier
        // result.
        const property = siteUrlOf(await allowedResource(api, config, id));
        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'unverify_site',
            targets: [id],
            what: `give up verified ownership of ${property}`,
            consequence:
              'This credential loses owner access to the site. Any Search ' +
              'Console property for it keeps existing but drops to ' +
              'siteUnverifiedUser, so every data call for it starts returning ' +
              '403 — and the Indexing API, which requires ownership, stops ' +
              'working entirely. Regaining it means placing the token again. ' +
              'Google also refuses to remove the last owner of a site.',
            confirmToken: confirm_token,
          },
          async () => {
            await api.delete(
              'site-verification',
              `${WEB_RESOURCE}/${pathSegment(id)}`
            );
            return textResult(`Ownership of ${property} was given up.`);
          }
        );
      })
  );

  server.registerTool(
    'update_site_owners',
    {
      title: 'Change the owner list',
      description:
        'Replaces the list of verified owners of a site. This is how a second ' +
        'person or a service account is granted ownership without placing a ' +
        'token of their own.\n\n' +
        'It REPLACES rather than adds: the list you pass becomes the complete ' +
        'owner list. Call get_verified_site first and send back the existing ' +
        'addresses plus the new one, or the others are removed. This server ' +
        'refuses a list that does not contain at least one address, because ' +
        'that is the shape of an accidental wipe.\n\n' +
        'Two-step: the first call returns a confirmation token, the second ' +
        'performs the change.',
      inputSchema: z.object({
        id: idSchema(),
        owners: z
          .array(z.string().min(3))
          .min(1)
          .describe(
            'The complete list of owner email addresses after the change. ' +
              'Everyone not in it loses ownership.'
          ),
        method: z
          .enum(['update', 'patch'])
          .optional()
          .describe(
            'The HTTP method. The API offers both PUT ("update", the default) ' +
              'and PATCH ("patch") for this, and they behave identically — ' +
              'both replace the owner list. Exposed only for completeness.'
          ),
        confirm_token: confirmToken,
      }),
      // Destructive, despite reading like an update. `owners` is the whole list
      // after the call, so a single well-formed argument removes every existing
      // owner — and this server cannot put them back.
      annotations: {
        // Replaces the owner list wholesale. Everyone not named loses access
        // immediately, and this server cannot put them back — a removed owner
        // has to verify again.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id, owners, method, confirm_token }, mcp) =>
      run(async () => {
        const current = await allowedResource(api, config, id);
        const property = siteUrlOf(current);
        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'update_site_owners',
            // The id is positional and the owners are a set, so the set half is
            // sorted and the id is not: a token must survive the same list in a
            // different order, and must not survive a different id.
            targets: [id, ...[...owners].sort()],
            what: `replace the entire owner list of ${property}`,
            consequence:
              'Everyone not in the new list loses ownership immediately, and ' +
              'this server has no way to restore them — a removed owner has to ' +
              'place a verification token again. Google refuses a change that ' +
              'would leave the site with no owner at all, which is the only ' +
              'safety net underneath this.',
            target: owners.join(', '),
            confirmToken: confirm_token,
          },
          async () => {
            // The site block has to be sent back unchanged — this is a full
            // replacement, and omitting it makes Google reject the request
            // rather than keep what was there.
            const result = await api.request(
              'site-verification',
              method === 'patch' ? 'PATCH' : 'PUT',
              `${WEB_RESOURCE}/${pathSegment(id)}`,
              { id, site: current.site, owners }
            );
            return untrustedResult(
              `Owners of ${property} are now: ${owners.join(', ')}\n\n` +
                `Previously: ${listOwners(current)}\n` +
                `${budgetedJson(result)}`
            );
          }
        );
      })
  );
}

/**
 * The property a verification resource stands for, or null when it is not one.
 *
 * The two APIs spell the same site differently — see {@link toSiteUrl} — and the
 * verification API also owns Android apps, which have no Search Console property
 * at all. Anything unparseable comes back as null rather than throwing, because
 * one odd entry in an account must not fail a listing of the rest.
 */
function resourceSiteUrl(resource: Record<string, unknown>): string | null {
  const site = resource.site as VerificationSite | undefined;
  if (site === undefined || typeof site.identifier !== 'string') return null;
  const siteUrl = toSiteUrl(site);
  if (siteUrl === null) return null;
  try {
    return normalizeSiteUrl(siteUrl);
  } catch {
    return null;
  }
}

/** {@link resourceSiteUrl}, for messages, where "not a property" is still a fact. */
function siteUrlOf(resource: Record<string, unknown>): string {
  return resourceSiteUrl(resource) ?? 'this site';
}

/**
 * Fetches a verification resource, refusing one outside the allowlist.
 *
 * The id-based tools are the hole `resolveSite` cannot cover: an id is opaque,
 * so nothing about it says which property it belongs to, and `GSC_ALLOWED_SITES`
 * would silently not apply to the most damaging operation this server has.
 * Mapping the resource's own site block back to a property is the only way to
 * close it, and it costs a GET that `update_site_owners` was making anyway.
 */
async function allowedResource(
  api: ToolContext['api'],
  config: Config,
  id: string
): Promise<Record<string, unknown>> {
  const resource = objectOf(
    await api.get('site-verification', `${WEB_RESOURCE}/${pathSegment(id)}`),
    'verified site'
  );
  if (config.allowedSites === undefined) return resource;

  const siteUrl = resourceSiteUrl(resource);
  if (siteUrl === null || !allowsSite(config, siteUrl)) {
    throw new Error(
      'That verification resource is not one of the properties in ' +
        `GSC_ALLOWED_SITES. This server may only touch: ${config.allowedSites.join(', ')}.`
    );
  }
  return resource;
}

/**
 * The verification resource id, with the guard `encodeURIComponent` does not
 * give.
 *
 * The id goes into a URL path through {@link pathSegment}, which percent-encodes
 * a slash but leaves a dot alone — so `".."` survives encoding and the URL
 * parser then resolves `/webResource/..` to `/webResource/`, turning a call
 * about one resource into a `DELETE` or `PUT` against the collection. Google
 * answers that with a 404 or 405 rather than doing anything, which is luck
 * rather than a guarantee.
 */
function idSchema(): z.ZodType<string> {
  return z
    .string()
    .min(1)
    .refine((value) => !/^\.+$/.test(value.replaceAll('/', '')), {
      message: 'is not a resource id — a path of dots addresses the collection',
    })
    .describe(
      'The verification resource id, as returned by list_verified_sites. It is ' +
        'not the property URL — it is an opaque string such as ' +
        '"dns://example.com" or "https://example.com/".'
    );
}

/**
 * The method to use when the caller did not choose.
 *
 * DNS is the only option for a domain, and META is the right default for a URL
 * prefix: it needs a template edit rather than a file upload, and it survives a
 * static site generator that would not otherwise serve a file with no extension.
 */
function defaultMethod(site: VerificationSite): string {
  return site.type === 'INET_DOMAIN' ? 'DNS' : 'META';
}

function assertMethod(
  site: VerificationSite,
  method: string,
  allowed: readonly string[]
): void {
  if (!allowed.includes(method)) {
    throw new Error(
      `method "${method}" is not available for a ${site.type} site. ` +
        `Allowed here: ${allowed.join(', ')}. A domain property can only be ` +
        'proven by DNS, because the claim covers every host under the name and ' +
        'there is no single page to put a tag on.'
    );
  }
}

function listOwners(resource: Record<string, unknown>): string {
  const owners = resource.owners;
  return Array.isArray(owners) && owners.length > 0
    ? owners.map(String).join(', ')
    : '(none listed)';
}
