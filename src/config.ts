/**
 * How the server was told to authenticate.
 *
 * Resolved once at startup and never re-derived, so that a later `delete
 * env.GSC_...` cannot change the answer halfway through a session.
 */
export type AuthMode = 'service-account' | 'oauth-refresh-token' | 'adc';

export interface ServiceAccountAuth {
  mode: 'service-account';
  /** Raw JSON of the key, already decoded from base64 if it arrived that way. */
  key: string | undefined;
  /** Path to a key file, read lazily by google-auth-library. */
  keyFile: string | undefined;
}

export interface OAuthRefreshTokenAuth {
  mode: 'oauth-refresh-token';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface AdcAuth {
  mode: 'adc';
}

export type Auth = ServiceAccountAuth | OAuthRefreshTokenAuth | AdcAuth;

export interface Config {
  /**
   * How to obtain an access token, or undefined when nothing was configured.
   *
   * Undefined is a normal startup state, not a failure: the server still
   * completes the MCP handshake and answers `tools/list`, so that registries and
   * sandbox inspectors can enumerate the tools. Every call then fails with
   * {@link missingConfigMessage} instead of reaching Google.
   */
  auth: Auth | undefined;
  /**
   * Default property for every tool that takes a `site_url`, from
   * `GSC_SITE_URL`. Already normalised — see {@link normalizeSiteUrl}.
   */
  defaultSiteUrl: string | undefined;
  /**
   * Properties this server may touch at all, from `GSC_ALLOWED_SITES`.
   *
   * Undefined means no restriction. Empty is impossible: a variable that is set
   * but names nothing is rejected at startup rather than silently locking the
   * server out of everything.
   */
  allowedSites: readonly string[] | undefined;
  /** When true, only the read tools are registered at all. */
  readOnly: boolean;
  /**
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   */
  elicitation: boolean;

  /**
   * Raw value of `GSC_ALLOW_TOOLS` — comma-separated tool names, `list_*`
   * prefixes, or `essential`. Kept unparsed on purpose: this file is a mirror of
   * the environment, and the names can only be checked against the tool
   * catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `GSC_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

/** Shown when no credentials were configured — at startup and on every call. */
export function missingConfigMessage(): string {
  return (
    'no Google credentials configured.\n' +
    'Set exactly one of:\n' +
    '  GSC_SERVICE_ACCOUNT_KEY      the service account key as JSON, or base64-encoded JSON\n' +
    '  GSC_SERVICE_ACCOUNT_KEY_FILE path to the service account key file\n' +
    '  GSC_CLIENT_ID + GSC_CLIENT_SECRET + GSC_REFRESH_TOKEN   an OAuth2 installed-app credential\n' +
    '  GOOGLE_APPLICATION_CREDENTIALS or a gcloud login   (application default credentials)\n' +
    'Whichever identity you use must be added to the Search Console property, ' +
    'or own it through the Site Verification API.\n' +
    'Optional: GSC_SITE_URL to default the site_url argument, ' +
    'GSC_ALLOWED_SITES to restrict which properties may be touched, ' +
    'GSC_READ_ONLY=true to expose only read tools, ' +
    'GSC_ALLOW_TOOLS / GSC_DENY_TOOLS to narrow the tool list ' +
    '(comma-separated names, "list_*" prefixes, or "essential")'
  );
}

/**
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, which is why a
 * server started with it off says so on its startup line.
 *
 * Fatal: this is the first variable of the family that defaults to *on*. The
 * others fail open on a typo, which is the safe direction for them. Here a typo
 * would leave the dialog running while the operator believes it is off — and an
 * operator who believes that has no way to find out. It goes through `fail`
 * like every other refusal in this file, so there is one exit rather than two.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  return fail(
    `ELICITATION must be "true" or "false" — got "${raw}". ` +
      'Refusing to start rather than guess.'
  );
}

/**
 * Reads the configuration from environment variables.
 *
 * Missing credentials are only a warning. A *malformed* configuration still
 * exits — a half-filled OAuth triple or an unparseable site URL would otherwise
 * fail later, once per call, with an error that says nothing about the cause.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const readOnly = env.GSC_READ_ONLY === 'true';
  const allowTools = env.GSC_ALLOW_TOOLS;
  const denyTools = env.GSC_DENY_TOOLS;

  const auth = loadAuth(env);
  // After loadAuth, deliberately: that is where the credentials are wiped from
  // the environment, and this one can exit the process.
  const elicitation = parseElicitation(env.ELICITATION);
  const defaultSiteUrl = loadDefaultSite(env);
  const allowedSites = loadAllowedSites(env);

  if (
    defaultSiteUrl !== undefined &&
    allowedSites !== undefined &&
    !allowedSites.includes(defaultSiteUrl)
  ) {
    fail(
      `GSC_SITE_URL (${defaultSiteUrl}) is not listed in GSC_ALLOWED_SITES — ` +
        'every call that relied on the default would be refused. Add it to ' +
        'GSC_ALLOWED_SITES, or unset one of the two.'
    );
  }

  if (auth === undefined) console.error(`${NAME}: ${missingConfigMessage()}`);

  return {
    auth,
    defaultSiteUrl,
    allowedSites,
    readOnly,
    elicitation,
    allowTools,
    denyTools,
  };
}

const NAME = 'google-search-console-mcp';

/**
 * Picks the credential to use, in a fixed order.
 *
 * Explicit beats ambient: a service account key names an identity, an OAuth
 * triple names one, and application default credentials are whatever the machine
 * happens to be logged into. Falling back to ADC *silently* would be the
 * dangerous order — a typo'd `GSC_CLIENT_ID` would then quietly act as the
 * developer's own Google account — so a partial OAuth triple is fatal rather
 * than a reason to fall through.
 */
function loadAuth(env: NodeJS.ProcessEnv): Auth | undefined {
  const rawKey = env.GSC_SERVICE_ACCOUNT_KEY;
  const keyFile = env.GSC_SERVICE_ACCOUNT_KEY_FILE;
  const clientId = env.GSC_CLIENT_ID;
  const clientSecret = env.GSC_CLIENT_SECRET;
  const refreshToken = env.GSC_REFRESH_TOKEN;

  // Don't keep credentials in the environment for the process lifetime — they
  // are visible to child processes and in /proc/<pid>/environ. The key *file*
  // goes too: it is not a secret itself, but it points straight at one, and the
  // path is captured into the config above, so nothing later needs to read it
  // back. GOOGLE_APPLICATION_CREDENTIALS has to stay — google-auth-library
  // re-reads it on every token request.
  delete env.GSC_SERVICE_ACCOUNT_KEY;
  delete env.GSC_SERVICE_ACCOUNT_KEY_FILE;
  delete env.GSC_CLIENT_SECRET;
  delete env.GSC_REFRESH_TOKEN;

  if (rawKey !== undefined || keyFile !== undefined) {
    if (rawKey !== undefined && keyFile !== undefined) {
      fail(
        'GSC_SERVICE_ACCOUNT_KEY and GSC_SERVICE_ACCOUNT_KEY_FILE are both set — ' +
          'set exactly one, so it is unambiguous which key is in use.'
      );
    }
    return {
      mode: 'service-account',
      key: rawKey === undefined ? undefined : decodeKey(rawKey),
      keyFile,
    };
  }

  const oauthParts = [clientId, clientSecret, refreshToken];
  if (oauthParts.some((part) => part !== undefined)) {
    if (!oauthParts.every((part) => part !== undefined && part.length > 0)) {
      const missing = [
        clientId ? undefined : 'GSC_CLIENT_ID',
        clientSecret ? undefined : 'GSC_CLIENT_SECRET',
        refreshToken ? undefined : 'GSC_REFRESH_TOKEN',
      ].filter((name): name is string => name !== undefined);
      fail(
        `incomplete OAuth2 configuration — missing ${missing.join(', ')}. ` +
          'All three are required together. Leaving them all unset falls back to ' +
          'application default credentials.'
      );
    }
    return {
      mode: 'oauth-refresh-token',
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      refreshToken: refreshToken as string,
    };
  }

  // ADC is only claimed when the environment actually points at something.
  // google-auth-library would otherwise search the gcloud config directory and
  // the metadata server on every single call, and a 30-second metadata timeout
  // is a far worse answer than "you configured nothing".
  if (env.GOOGLE_APPLICATION_CREDENTIALS || env.GOOGLE_CLOUD_PROJECT) {
    return { mode: 'adc' };
  }

  return undefined;
}

/**
 * Accepts a service account key as raw JSON or base64-encoded JSON.
 *
 * Both spellings are needed in practice: a key pasted into a shell profile or a
 * compose file keeps its newlines and its `{`, while anything that travels
 * through a CI secret store or a Kubernetes secret arrives base64-encoded. The
 * value is never echoed — it holds a private key.
 */
function decodeKey(raw: string): string {
  const trimmed = raw.trim();
  const text = trimmed.startsWith('{')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(
      'GSC_SERVICE_ACCOUNT_KEY is neither JSON nor base64-encoded JSON. ' +
        '(The value is not shown here — it holds a private key.)'
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { client_email?: unknown }).client_email !== 'string' ||
    typeof (parsed as { private_key?: unknown }).private_key !== 'string'
  ) {
    fail(
      'GSC_SERVICE_ACCOUNT_KEY parsed as JSON but has no client_email and ' +
        'private_key — that is an OAuth client secrets file, not a service ' +
        'account key. Download the key from the service account itself.'
    );
  }
  return text;
}

function loadDefaultSite(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.GSC_SITE_URL?.trim();
  if (!raw) return undefined;
  try {
    return normalizeSiteUrl(raw);
  } catch (error) {
    fail(`GSC_SITE_URL: ${(error as Error).message}`);
  }
}

function loadAllowedSites(
  env: NodeJS.ProcessEnv
): readonly string[] | undefined {
  const raw = env.GSC_ALLOWED_SITES;
  if (raw === undefined) return undefined;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    fail(
      'GSC_ALLOWED_SITES is set but names no property. An empty allowlist would ' +
        'refuse every call; unset the variable to allow all properties.'
    );
  }
  try {
    return entries.map((entry) => normalizeSiteUrl(entry));
  } catch (error) {
    fail(`GSC_ALLOWED_SITES: ${(error as Error).message}`);
  }
}

/**
 * Brings a property identifier into the exact spelling the API expects.
 *
 * Search Console has two kinds of property and they are *not* interchangeable —
 * `sc-domain:example.com` and `https://example.com/` are different properties
 * with different data, and the API answers the wrong one with a bare 403 that
 * says nothing about spelling.
 *
 * Two things are normalised, because both are mistakes everybody makes once:
 *
 * - **The trailing slash on a URL-prefix property is mandatory.** Search Console
 *   registers `https://example.com/`, and `https://example.com` — the same URL
 *   to every other tool on earth — is 403 Forbidden. `URL` restores it.
 * - **A domain property must not carry a scheme.** `sc-domain:https://example.com`
 *   is the shape people reach for, and it is never a property.
 *
 * A bare hostname is refused rather than guessed at. `example.com` could mean
 * either kind, and picking one would send analytics queries at a property that
 * exists and holds different numbers — a wrong answer rather than an error.
 */
export function normalizeSiteUrl(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) throw new Error('the property must not be empty');

  if (value.toLowerCase().startsWith('sc-domain:')) {
    const domain = value.slice('sc-domain:'.length).trim().toLowerCase();
    if (domain.length === 0) {
      throw new Error('"sc-domain:" needs a domain after the colon');
    }
    if (domain.includes('://') || domain.includes('/')) {
      throw new Error(
        `a domain property is the bare domain — write "sc-domain:${
          domain.replace(/^[a-z]+:\/\//, '').split('/')[0]
        }" rather than "${value}"`
      );
    }
    return `sc-domain:${domain}`;
  }

  if (/^https?:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`"${value}" is not a valid URL`);
    }
    if (parsed.search || parsed.hash) {
      throw new Error(
        'a URL-prefix property is an origin and path only — it carries no query ' +
          'string and no fragment'
      );
    }
    // `URL` already guarantees a path of at least "/", which is exactly the
    // trailing slash Search Console requires.
    return `${parsed.origin}${parsed.pathname}`;
  }

  throw new Error(
    `"${value}" is not a Search Console property. Use "sc-domain:example.com" ` +
      'for a domain property, or "https://example.com/" for a URL-prefix ' +
      'property — they are different properties with different data, so this is ' +
      'not guessed for you.'
  );
}

/**
 * Reports a fatal configuration problem and stops.
 *
 * The `throw` after `process.exit` is not dead code. `process.exit` is typed
 * `never` and behaves that way in production, but the tests stub it — and
 * without the throw, execution would fall through the guard that just failed and
 * carry on with the very value that was rejected.
 */
function fail(message: string): never {
  console.error(`${NAME}: ${message}`);
  process.exit(1);
  throw new Error(message);
}
