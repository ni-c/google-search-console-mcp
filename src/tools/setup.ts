import type { McpServer } from '@modelcontextprotocol/server';
import {
  placementInstructions,
  toSiteUrl,
  toVerificationSite,
  type VerificationSite,
} from '../site-identity.js';
import { z } from 'zod';
import { untrustedFields } from '../output-schema.js';

import { GoogleApiError } from '../api.js';
import { READ_ONLY } from './annotations.js';
import { listField, objectOf } from '../normalize.js';
import { run, untrustedTextResult } from '../result.js';
import { resolveSite, siteUrlSchema } from '../schema.js';
import type { ToolContext } from './context.js';
import { listSiteUrls } from './sites.js';

/**
 * Which step of the four a property is currently at.
 *
 * The order is not obvious and nothing in either API enforces it: `add_site`
 * happily creates a property for a domain nobody owns, and the result is a
 * property that exists, appears in `list_sites`, and answers every data call
 * with 403. That state looks like a permissions bug and is actually step two of
 * four, never taken.
 */
export type SetupStage =
  'ready' | 'needs-property' | 'needs-verification' | 'needs-both';

export interface SetupState {
  stage: SetupStage;
  /** The permission level Search Console reports, if the property exists. */
  permissionLevel: string | undefined;
  owned: boolean;
  exists: boolean;
}

/**
 * Works out where a property stands from the two lists.
 *
 * Deliberately a pure function over the two lists rather than something that
 * makes its own calls: this is the one piece of real reasoning in the tool, and
 * it is the piece worth testing without a network.
 *
 * "Working" is `siteOwner` or `siteFullUser`. `siteRestrictedUser` is listed as
 * a fourth state and treated as ready, because it can read performance data —
 * which is what most callers want — but the message says what it cannot do.
 */
export function assessSetup(input: {
  site: string;
  properties: { siteUrl: string; permissionLevel: string }[];
  ownedSiteUrls: string[];
}): SetupState {
  const property = input.properties.find(
    (entry) => entry.siteUrl === input.site
  );
  const owned = input.ownedSiteUrls.includes(input.site);
  const exists = property !== undefined;
  const usable =
    property !== undefined &&
    property.permissionLevel !== 'siteUnverifiedUser' &&
    property.permissionLevel !== 'unknown';

  const stage: SetupStage = usable
    ? 'ready'
    : owned
      ? 'needs-property'
      : exists
        ? 'needs-verification'
        : 'needs-both';

  return {
    stage,
    permissionLevel: property?.permissionLevel,
    owned,
    exists,
  };
}

export function registerSetupTools(
  server: McpServer,
  { api, config, readOnly }: ToolContext
): void {
  server.registerTool(
    'setup_site',
    {
      title: 'Check what a property still needs',
      description:
        'Works out where a property stands and says exactly what to do next.\n\n' +
        'Getting a working Search Console property takes four steps in one ' +
        'order — obtain a verification token, place it in DNS or on the page ' +
        '(a human step), verify ownership, add the property — and nothing in the ' +
        'API enforces that order. Calling add_site first succeeds and leaves a ' +
        'property that returns 403 for every piece of data, which looks like a ' +
        'permissions problem and is not.\n\n' +
        'This reads the current state and reports the next step, including the ' +
        'DNS record or meta tag to copy when that is what is missing. It changes ' +
        'nothing.',
      inputSchema: z.object({ site_url: siteUrlSchema(config) }),
      annotations: READ_ONLY,
      // The numbered steps stay in the text block; the verdicts go here.
      outputSchema: z.object({
        ...untrustedFields,
        site: z.string(),
        stage: z.string().describe('Where this property is in the setup.'),
        exists: z.boolean(),
        owned: z.boolean(),
        permissionLevel: z.union([
          z.string().describe('What the credential may do on this property.'),
          z.null(),
        ]),
        steps: z.array(z.string()),
      }),
    },
    ({ site_url }) =>
      run(async () => {
        const site = resolveSite(config, site_url);
        const verification = toVerificationSite(site);

        const properties = await listSiteUrls(api);
        const ownedSiteUrls = await listOwned(api);
        const state = assessSetup({ site, properties, ownedSiteUrls });

        const lines = [
          `Property: ${site}`,
          `Exists in Search Console: ${state.exists ? `yes (${state.permissionLevel ?? 'unknown'})` : 'no'}`,
          `Ownership verified: ${state.owned ? 'yes' : 'no'}`,
          '',
        ];

        switch (state.stage) {
          case 'ready':
            lines.push(
              'Nothing to do — this property is set up and returning data.',
              '',
              state.permissionLevel === 'siteRestrictedUser'
                ? 'Note: siteRestrictedUser can read performance data but cannot ' +
                    'manage sitemaps or use the Indexing API. Ask an owner for ' +
                    'full access, or verify ownership with this credential.'
                : 'Next, if you have not already: submit_sitemap with the ' +
                    'sitemap URL, then get_sitemap a few minutes later to see ' +
                    'what Google made of it.'
            );
            break;

          case 'needs-property':
            lines.push(
              'Ownership is already verified — only the Search Console property ' +
                'is missing.',
              '',
              readOnly
                ? 'Step: add the property. GSC_READ_ONLY is set, so add_site is ' +
                    'not registered — unset it to continue.'
                : `Step: call add_site with site_url="${site}". It will land as ` +
                    'siteOwner, because ownership is already proven.'
            );
            break;

          case 'needs-verification':
          case 'needs-both': {
            lines.push(
              state.exists
                ? 'The property exists but ownership was never proven, which is ' +
                    'why its data calls return 403.'
                : 'Neither the property nor the ownership exists yet.',
              ''
            );
            const instructions = await tokenInstructions(api, verification);
            lines.push(instructions, '');
            lines.push(
              readOnly
                ? 'After placing it: verify_site — but GSC_READ_ONLY is set, so ' +
                    'that tool is not registered. Unset it to continue.'
                : state.exists
                  ? 'After placing it, call verify_site. The property is already ' +
                    'there, so nothing else is needed.'
                  : `After placing it, call verify_site, then add_site with ` +
                    `site_url="${site}".`
            );
            break;
          }
        }

        // Marked untrusted: the report carries the permission level Google
        // stored and, when ownership is missing, a token Google generated. The
        // steps around them are this server's own text, but the marker covers
        // the whole block rather than pretending the two can be told apart by
        // eye.
        return untrustedTextResult(lines.join('\n'), {
          site,
          stage: state.stage,
          exists: state.exists,
          owned: state.owned,
          permissionLevel: state.permissionLevel ?? null,
          steps: lines,
        });
      })
  );
}

/**
 * Fetches a token and renders the placement instructions.
 *
 * Wrapped in its own error handling because this is the one part that can fail
 * for a reason unrelated to the diagnosis: the Site Verification API may not be
 * enabled in the Cloud project even though Search Console is. Reporting the
 * state without the token is still useful, so a failure here degrades to a
 * sentence rather than losing the whole answer.
 */
async function tokenInstructions(
  api: ToolContext['api'],
  site: VerificationSite
): Promise<string> {
  const method = site.type === 'INET_DOMAIN' ? 'DNS' : 'META';
  try {
    const response = objectOf(
      await api.post('site-verification', '/token', {
        site,
        verificationMethod: method,
      }),
      'verification token'
    );
    const token = response.token;
    if (typeof token !== 'string') {
      return 'Step: get_verification_token — Google returned no token for this site.';
    }
    return `Step: place this verification token.\n\n${placementInstructions(site, method, token)}`;
  } catch (error) {
    const reason =
      error instanceof GoogleApiError
        ? `the Site Verification API answered HTTP ${error.status}`
        : error instanceof Error
          ? error.message
          : String(error);
    return (
      `Step: call get_verification_token to obtain the token — it could not be ` +
      `fetched here because ${reason}.`
    );
  }
}

/** The properties this credential owns, as Search Console would spell them. */
async function listOwned(api: ToolContext['api']): Promise<string[]> {
  const items = listField(
    await api.get('site-verification', '/webResource'),
    'items'
  );
  return items.flatMap((item) => {
    const site = item.site as VerificationSite | undefined;
    if (site === undefined || typeof site.identifier !== 'string') return [];
    const siteUrl = toSiteUrl(site);
    return siteUrl === null ? [] : [siteUrl];
  });
}
