import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { pathSegment } from '../api.js';
import { guarded } from '../guard.js';
import { listField, objectOf } from '../normalize.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
import { confirmToken, resolveSite, siteUrlSchema } from '../schema.js';
import {
  METHODS,
  TOKEN_METHODS,
  placementInstructions,
  toVerificationSite,
  type VerificationSite,
} from '../site-identity.js';
import type { ToolContext } from './context.js';

const WEB_RESOURCE = '/webResource';

export function registerVerificationTools(
  server: McpServer,
  { api, config, confirmations, readOnly }: ToolContext
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
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const items = listField(
          await api.get('site-verification', WEB_RESOURCE),
          'items'
        );
        return budgetedList('verified_sites', items, {
          extra: {
            note:
              items.length === 0
                ? 'This credential owns nothing. That is the normal state of a ' +
                  'fresh service account — get_verification_token starts the ' +
                  'process of changing it.'
                : 'The "id" of each entry is what get_verified_site, ' +
                  'update_site_owners and unverify_site take.',
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
      inputSchema: { id: idSchema() },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      run(async () =>
        jsonResult(
          await api.get(
            'site-verification',
            `${WEB_RESOURCE}/${pathSegment(id)}`
          )
        )
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
      inputSchema: {
        site_url: siteUrlSchema(config),
        method: z
          .enum(['DNS', 'FILE', 'META'])
          .optional()
          .describe(
            'Defaults to the only sensible one for the property kind: DNS for a ' +
              'domain property, META for a URL-prefix property.'
          ),
      },
      annotations: { readOnlyHint: true },
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
      inputSchema: {
        site_url: siteUrlSchema(config),
        method: z
          .enum(['DNS', 'FILE', 'META', 'ANALYTICS', 'TAG_MANAGER'])
          .optional()
          .describe(
            'Must match the method the token was obtained for. Defaults to DNS ' +
              'for a domain property and META for a URL-prefix property.'
          ),
      },
      annotations: { idempotentHint: true },
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

        return textResult(
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
      inputSchema: { id: idSchema(), confirm_token: confirmToken },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    ({ id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'unverify_site',
            targets: [id],
            what: `give up verified ownership of ${id}`,
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
            return textResult(`Ownership of ${id} was given up.`);
          }
        )
      )
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
        'that is the shape of an accidental wipe.',
      inputSchema: {
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
      },
      annotations: { idempotentHint: true },
    },
    ({ id, owners, method }) =>
      run(async () => {
        const current = objectOf(
          await api.get(
            'site-verification',
            `${WEB_RESOURCE}/${pathSegment(id)}`
          ),
          'verified site'
        );
        // The site block has to be sent back unchanged — this is a full
        // replacement, and omitting it makes Google reject the request rather
        // than keep what was there.
        const result = await api.request(
          'site-verification',
          method === 'patch' ? 'PATCH' : 'PUT',
          `${WEB_RESOURCE}/${pathSegment(id)}`,
          { id, site: current.site, owners }
        );
        return textResult(
          `Owners of ${id} are now: ${owners.join(', ')}\n\n` +
            `Previously: ${listOwners(current)}\n` +
            `${JSON.stringify(result, null, 2)}`
        );
      })
  );
}

function idSchema(): z.ZodString {
  return z
    .string()
    .min(1)
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
