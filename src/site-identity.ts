/**
 * How the Site Verification API names a site.
 *
 * `INET_DOMAIN` is a bare domain and covers every scheme, subdomain and port of
 * it; `SITE` is one exact URL prefix.
 */
export interface VerificationSite {
  type: 'INET_DOMAIN' | 'SITE';
  identifier: string;
}

/**
 * Translates a Search Console property into the site the verification API
 * expects.
 *
 * The two APIs describe the same thing in incompatible spellings, and nothing in
 * either one says so:
 *
 * | Search Console          | Site Verification                          |
 * | ----------------------- | ------------------------------------------ |
 * | `sc-domain:example.com` | `{type: INET_DOMAIN, identifier: example.com}` |
 * | `https://example.com/`  | `{type: SITE, identifier: https://example.com/}` |
 *
 * Passing `sc-domain:example.com` through as an identifier — the obvious thing
 * to try — is accepted by the API and verifies a "domain" literally called
 * `sc-domain:example.com`, which no property will ever match. It fails by
 * succeeding, which is the expensive kind.
 */
export function toVerificationSite(siteUrl: string): VerificationSite {
  if (siteUrl.startsWith('sc-domain:')) {
    return {
      type: 'INET_DOMAIN',
      identifier: siteUrl.slice('sc-domain:'.length),
    };
  }
  return { type: 'SITE', identifier: siteUrl };
}

/**
 * The reverse, so an owned resource can be matched against a property.
 *
 * Returns null for anything neither kind — the verification API also handles
 * Android apps, which have no Search Console property at all and would otherwise
 * be compared as if they did.
 */
export function toSiteUrl(site: VerificationSite): string | null {
  if (site.type === 'INET_DOMAIN') return `sc-domain:${site.identifier}`;
  if (site.type === 'SITE') return site.identifier;
  return null;
}

/**
 * The verification methods each kind of site accepts.
 *
 * A domain can only be proven by DNS — there is no file to place, because the
 * claim covers every host under the name. A URL prefix can be proven four ways,
 * and the first two are the only ones this server can hand you a token for:
 * `ANALYTICS` and `TAG_MANAGER` prove ownership through an existing Google
 * Analytics or Tag Manager container instead of a token, so `get_verification_token`
 * has nothing to return for them.
 */
export const METHODS = {
  INET_DOMAIN: ['DNS'],
  SITE: ['FILE', 'META', 'ANALYTICS', 'TAG_MANAGER'],
} as const;

/** The methods `get_verification_token` can actually produce a token for. */
export const TOKEN_METHODS = {
  INET_DOMAIN: ['DNS'],
  SITE: ['FILE', 'META'],
} as const;

/**
 * Turns a token into the instruction that places it.
 *
 * The token on its own is not actionable — `google-site-verification=abc123` is
 * a string, and what a person needs is "put this in a TXT record on this exact
 * name". Writing the record name out is the part that saves a round trip: for a
 * domain property it is the apex, not `_google-site-verification`, which is the
 * name people reach for by analogy with DMARC and SPF.
 */
export function placementInstructions(
  site: VerificationSite,
  method: string,
  token: string
): string {
  switch (method) {
    case 'DNS':
      return (
        `Create a TXT record on ${site.identifier} itself — the apex name, not ` +
        'a subdomain, and not `_google-site-verification`:\n\n' +
        `  ${site.identifier}.  IN  TXT  "${token}"\n\n` +
        'Then wait for it to propagate and call verify_site. DNS caches mean ' +
        'this can take minutes to an hour; verify_site failing immediately after ' +
        'the record is created is normal and worth one retry later.'
      );
    case 'FILE':
      return (
        `Upload a file named ${token} to the top level of the site, containing:\n\n` +
        '  google-site-verification: ' +
        `${token}\n\n` +
        `It must be reachable at ${site.identifier}${token} and must not ` +
        'redirect. Then call verify_site.'
      );
    case 'META':
      return (
        'Add this tag to the <head> of the home page:\n\n' +
        `  <meta name="google-site-verification" content="${token}" />\n\n` +
        `It must be present at ${site.identifier} for anonymous visitors — a ` +
        'page behind a login or a cookie banner that blocks rendering will not ' +
        'verify. Then call verify_site.'
      );
    default:
      return `Place the token according to the ${method} method, then call verify_site.`;
  }
}
