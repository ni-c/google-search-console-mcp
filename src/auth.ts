import { GoogleAuth, UserRefreshClient } from 'google-auth-library';

import { missingConfigMessage, type Auth } from './config.js';

/**
 * The OAuth scopes this server can ask for.
 *
 * Three separate Google services stand behind the tools, and each has its own
 * scope. They are named here rather than inline because which ones are requested
 * is decided per startup — see {@link scopesFor}.
 */
export const SCOPES = {
  /** Read and write in Search Console: properties, sitemaps, analytics. */
  webmasters: 'https://www.googleapis.com/auth/webmasters',
  /** The same, minus every write. Requested instead of the above in read-only mode. */
  webmastersReadonly: 'https://www.googleapis.com/auth/webmasters.readonly',
  /** Site Verification: prove ownership, list and change owners. */
  siteVerification: 'https://www.googleapis.com/auth/siteverification',
  /** Indexing API: notify Google that a URL changed. */
  indexing: 'https://www.googleapis.com/auth/indexing',
} as const;

/** Which service a tool talks to, and therefore which scope it needs. */
export type Service = 'search-console' | 'site-verification' | 'indexing';

/**
 * The scopes needed for a given set of registered tools.
 *
 * Least privilege, and not a cosmetic kind. For a service account under
 * domain-wide delegation the scopes are allowlisted by a Workspace
 * administrator, and asking for one that was not delegated fails the whole token
 * request with `unauthorized_client` — so a server that always asked for all
 * three would be unusable for someone who was only granted Search Console. With
 * this, `GSC_DENY_TOOLS=verify_site,unverify_site,…` genuinely narrows what the
 * credential is used for.
 *
 * The read-only swap is the other half: `webmasters.readonly` cannot write even
 * if a tool tried. Note what it does *not* cover — Site Verification has no
 * read-only scope of its own (`verify_only` is write-only and cannot list), so
 * the verification read tools still need the full one. That is a limit of
 * Google's scope design, not an oversight here.
 */
export function scopesFor(
  services: ReadonlySet<Service>,
  readOnly: boolean
): string[] {
  const scopes: string[] = [];
  if (services.has('search-console')) {
    scopes.push(readOnly ? SCOPES.webmastersReadonly : SCOPES.webmasters);
  }
  if (services.has('site-verification')) scopes.push(SCOPES.siteVerification);
  if (services.has('indexing')) scopes.push(SCOPES.indexing);
  return scopes;
}

/** Something that can hand out a bearer token for the Google APIs. */
export interface TokenSource {
  getAccessToken(): Promise<string>;
  /** For messages that need to say which identity is in use. Never a secret. */
  describe(): string;
}

/**
 * Builds the token source for the configured credential.
 *
 * The library caches and refreshes tokens internally, so this is called once and
 * the result is reused for the process lifetime.
 */
export function createTokenSource(
  auth: Auth | undefined,
  scopes: string[]
): TokenSource {
  if (auth === undefined) return unconfigured();
  switch (auth.mode) {
    case 'service-account':
      return fromGoogleAuth(
        new GoogleAuth(
          auth.key !== undefined
            ? { credentials: JSON.parse(auth.key) as object, scopes }
            : { keyFile: auth.keyFile as string, scopes }
        ),
        auth.key !== undefined
          ? `service account (key from GSC_SERVICE_ACCOUNT_KEY)`
          : `service account (key file ${auth.keyFile as string})`
      );

    case 'oauth-refresh-token': {
      // The scopes are deliberately not passed: an OAuth2 refresh token already
      // carries the scopes it was granted, and asking for more here would not
      // widen them — it would just produce a confusing error. What the token can
      // do was decided when the user consented.
      const client = new UserRefreshClient({
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        refreshToken: auth.refreshToken,
      });
      return {
        async getAccessToken() {
          const { token } = await client.getAccessToken();
          if (!token) throw new Error(NO_TOKEN);
          return token;
        },
        describe: () => 'OAuth2 user credentials (GSC_REFRESH_TOKEN)',
      };
    }

    case 'adc':
      return fromGoogleAuth(
        new GoogleAuth({ scopes }),
        'application default credentials'
      );
  }
}

const NO_TOKEN =
  'Google returned no access token. The credential was accepted but produced ' +
  'nothing usable — check that the key has not been disabled and that the ' +
  'required APIs are enabled in the Cloud project.';

function fromGoogleAuth(auth: GoogleAuth, description: string): TokenSource {
  return {
    async getAccessToken() {
      const client = await auth.getClient();
      const { token } = await client.getAccessToken();
      if (!token) throw new Error(NO_TOKEN);
      return token;
    },
    describe: () => description,
  };
}

/**
 * The token source used when nothing was configured.
 *
 * It exists so the server can start, complete the handshake and list its tools
 * without credentials — a hard requirement for registry and sandbox inspectors,
 * which cannot enumerate a server that refuses to boot. Every call then fails
 * here, with the setup instructions rather than a Google error.
 */
function unconfigured(): TokenSource {
  return {
    getAccessToken() {
      return Promise.reject(new Error(missingConfigMessage()));
    },
    describe: () => 'nothing configured',
  };
}
