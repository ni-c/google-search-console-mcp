import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, normalizeSiteUrl } from '../src/config.js';

/**
 * `loadConfig` reports fatal problems with `process.exit`, which the tests stub.
 *
 * The stub is why `fail()` throws after exiting: without that throw, execution
 * would fall through the guard that just failed and carry on with the very value
 * it rejected — so a test asserting on the message would pass while the
 * production path did something else entirely.
 */
function expectExit(env: NodeJS.ProcessEnv, pattern: RegExp): void {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exited');
  }) as never);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  expect(() => loadConfig(env)).toThrow();
  expect(error.mock.calls.flat().join('\n')).toMatch(pattern);

  exit.mockRestore();
  error.mockRestore();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ELICITATION', () => {
  it('defaults to on, and to on for an empty value', () => {
    // The only variable of this family that defaults to *on*. An unset switch
    // has to mean "ask", or a deployment that never heard of it would quietly
    // stop asking.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(loadConfig({}).elicitation).toBe(true);
    expect(loadConfig({ ELICITATION: '' }).elicitation).toBe(true);
    warn.mockRestore();
  });

  it('is switched off by "false", in any casing or padding', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const raw of ['false', 'FALSE', ' False ']) {
      expect(loadConfig({ ELICITATION: raw }).elicitation, raw).toBe(false);
    }
    warn.mockRestore();
  });

  it('refuses to start on anything else, naming both valid values', () => {
    // Deliberately fatal rather than falling back to the default: a typo would
    // leave the dialog running while the operator believes it is off, and
    // nothing else would ever tell them. It goes through `fail`, like every
    // other refusal in config.ts.
    for (const raw of ['1', 'off', 'no']) {
      expectExit({ ELICITATION: raw }, /ELICITATION must be "true" or "false"/);
    }
  });

  it('has already wiped the credentials by the time it can exit', () => {
    // parseElicitation sits *after* loadAuth on purpose. loadAuth is where the
    // secrets are deleted from the environment, and an exit above it would
    // leave them there for whatever a crash reporter does next.
    const env: NodeJS.ProcessEnv = {
      GSC_CLIENT_ID: 'id.apps.googleusercontent.com',
      GSC_CLIENT_SECRET: 'shh',
      GSC_REFRESH_TOKEN: '1//refresh',
      ELICITATION: 'nonsense',
    };
    expectExit(env, /ELICITATION/);
    expect(env.GSC_CLIENT_SECRET).toBeUndefined();
    expect(env.GSC_REFRESH_TOKEN).toBeUndefined();
  });
});

describe('choosing a credential', () => {
  it('starts with no credential at all, so tools stay listable', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const config = loadConfig({});
    // Not an error: a registry or sandbox inspector has to be able to enumerate
    // the tools of a server nobody gave a key to.
    expect(config.auth).toBeUndefined();
    expect(warn.mock.calls.flat().join('')).toContain('no Google credentials');
  });

  it('takes a service account key as raw JSON', () => {
    const key = JSON.stringify({
      client_email: 'robot@example.iam.gserviceaccount.com',
      private_key:
        '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
    });
    const config = loadConfig({ GSC_SERVICE_ACCOUNT_KEY: key });
    expect(config.auth).toMatchObject({ mode: 'service-account', key });
  });

  it('takes the same key base64-encoded', () => {
    // Anything that travels through a CI secret store or a Kubernetes secret
    // arrives this way; a key pasted into a shell profile does not.
    const key = JSON.stringify({
      client_email: 'robot@example.iam.gserviceaccount.com',
      private_key: 'x',
    });
    const config = loadConfig({
      GSC_SERVICE_ACCOUNT_KEY: Buffer.from(key).toString('base64'),
    });
    expect(config.auth).toMatchObject({ mode: 'service-account', key });
  });

  it('rejects an OAuth client secrets file mistaken for a service account key', () => {
    // Both are JSON downloaded from the same Cloud console page, and confusing
    // them is the most common first mistake. Without this check the failure
    // surfaces as an opaque signing error from inside google-auth-library.
    expectExit(
      {
        GSC_SERVICE_ACCOUNT_KEY: JSON.stringify({
          installed: { client_id: 'x', client_secret: 'y' },
        }),
      },
      /that is an OAuth client secrets file/
    );
  });

  it('never echoes a rejected key', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const secret = 'PRIVATE-KEY-MATERIAL-THAT-MUST-NOT-BE-LOGGED';

    expect(() => loadConfig({ GSC_SERVICE_ACCOUNT_KEY: secret })).toThrow();
    expect(error.mock.calls.flat().join('\n')).not.toContain(secret);

    exit.mockRestore();
    error.mockRestore();
  });

  it('takes a complete OAuth2 triple', () => {
    const config = loadConfig({
      GSC_CLIENT_ID: 'id',
      GSC_CLIENT_SECRET: 'secret',
      GSC_REFRESH_TOKEN: 'refresh',
    });
    expect(config.auth).toMatchObject({ mode: 'oauth-refresh-token' });
  });

  it('refuses a partial OAuth2 triple rather than falling back to ADC', () => {
    /*
     * The dangerous fallback. A typo'd variable name would otherwise leave the
     * server quietly acting as whatever account the machine is logged into —
     * which, on a developer workstation, is a person with access to everything.
     */
    expectExit(
      { GSC_CLIENT_ID: 'id', GSC_CLIENT_SECRET: 'secret' },
      /incomplete OAuth2 configuration.*GSC_REFRESH_TOKEN/s
    );
  });

  it('refuses an empty key file rather than falling back to ADC', () => {
    /*
     * The compose shape that produces this on its own:
     * `GSC_SERVICE_ACCOUNT_KEY_FILE=${GSC_KEY_FILE}` with GSC_KEY_FILE unset.
     * Docker Compose substitutes the empty string, it does not drop the
     * variable — so this is not a typo somebody has to make.
     *
     * `{ keyFile: '' }` is falsy to google-auth-library, which then looks for
     * application default credentials: on a developer workstation, an account
     * that usually sees every property in the organisation. The server started
     * without a word and its startup line said "service-account".
     */
    expectExit(
      { GSC_SERVICE_ACCOUNT_KEY_FILE: '' },
      /GSC_SERVICE_ACCOUNT_KEY_FILE is set but empty/
    );
    expectExit({ GSC_SERVICE_ACCOUNT_KEY_FILE: '   ' }, /ambient credentials/);
  });

  it('refuses an empty inline key for the same reason', () => {
    // This one already failed, through JSON.parse in decodeKey — but with a
    // message about JSON, which describes the symptom rather than the mistake.
    // The asymmetry between the two variables is what hid the key-file case.
    expectExit(
      { GSC_SERVICE_ACCOUNT_KEY: '' },
      /GSC_SERVICE_ACCOUNT_KEY is set but empty/
    );
  });

  it('does not let an empty key file quietly outrank a complete OAuth triple', () => {
    // The worst shape of the same bug: a fully configured OAuth credential is
    // present, and the empty key file used to win — sending the server to ADC
    // while the credential the operator actually set went unused.
    expectExit(
      {
        GSC_SERVICE_ACCOUNT_KEY_FILE: '',
        GSC_CLIENT_ID: 'id',
        GSC_CLIENT_SECRET: 'secret',
        GSC_REFRESH_TOKEN: 'refresh',
      },
      /GSC_SERVICE_ACCOUNT_KEY_FILE is set but empty/
    );
  });

  it('trims a key file path that arrived with whitespace', () => {
    const config = loadConfig({
      GSC_SERVICE_ACCOUNT_KEY_FILE: ' /keys/robot.json\n',
    });
    expect(config.auth).toMatchObject({
      mode: 'service-account',
      keyFile: '/keys/robot.json',
    });
  });

  it('refuses a service account and an OAuth credential at once', () => {
    // Two named identities is the same ambiguity as two service account keys,
    // and silently preferring one leaves the operator with no error, no change
    // in behaviour, and no way to tell which identity answered.
    expectExit(
      {
        GSC_SERVICE_ACCOUNT_KEY_FILE: '/keys/robot.json',
        GSC_CLIENT_ID: 'id',
        GSC_CLIENT_SECRET: 'secret',
        GSC_REFRESH_TOKEN: 'refresh',
      },
      /GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN/
    );
  });

  it('still allows ambient credentials alongside a service account', () => {
    // GOOGLE_APPLICATION_CREDENTIALS is set on half the machines this can run
    // on and nobody set it for this server. Ambient is exactly what the
    // ordering here is allowed to override; another *named* identity is not.
    const config = loadConfig({
      GSC_SERVICE_ACCOUNT_KEY_FILE: '/keys/robot.json',
      GOOGLE_APPLICATION_CREDENTIALS: '/other.json',
    });
    expect(config.auth).toMatchObject({ mode: 'service-account' });
  });

  it('reads GSC_READ_ONLY the way a compose file spells it', () => {
    /*
     * A protection, not a permission, so this one is read tolerantly — the
     * mirror image of ELICITATION above, which is fatal on anything it does not
     * know. `=1` is what a Docker Compose file or a systemd unit is most likely
     * to say, and under an exact `=== 'true'` that spelling left every write
     * tool registered while the operator believed the server could not write.
     */
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const raw of ['true', 'TRUE', ' True ', '1', 'yes', 'YES']) {
      expect(loadConfig({ GSC_READ_ONLY: raw }).readOnly, raw).toBe(true);
    }
    for (const raw of ['', 'false', '0', 'no', 'off']) {
      expect(loadConfig({ GSC_READ_ONLY: raw }).readOnly, raw).toBe(false);
    }
    warn.mockRestore();
  });

  it('refuses two service account sources at once', () => {
    expectExit(
      {
        GSC_SERVICE_ACCOUNT_KEY: '{"client_email":"a","private_key":"b"}',
        GSC_SERVICE_ACCOUNT_KEY_FILE: '/tmp/key.json',
      },
      /set exactly one/
    );
  });

  it('claims ADC only when the environment points at something', () => {
    // Otherwise google-auth-library searches the gcloud config directory and
    // then the metadata server on every call, and a 30-second metadata timeout
    // is a far worse answer than "you configured nothing".
    expect(
      loadConfig({ GOOGLE_APPLICATION_CREDENTIALS: '/x.json' }).auth
    ).toEqual({
      mode: 'adc',
    });
  });

  it('removes credentials from the environment after reading them', () => {
    // They would otherwise be visible to child processes and in
    // /proc/<pid>/environ for the process lifetime.
    const env: NodeJS.ProcessEnv = {
      GSC_CLIENT_ID: 'id',
      GSC_CLIENT_SECRET: 'secret',
      GSC_REFRESH_TOKEN: 'refresh',
    };
    loadConfig(env);
    expect(env.GSC_CLIENT_SECRET).toBeUndefined();
    expect(env.GSC_REFRESH_TOKEN).toBeUndefined();
  });

  it('removes the key file path too, and keeps the ADC one', () => {
    /*
     * The path is not a secret, but it points straight at one, and the config
     * has already captured it — nothing later reads the variable back.
     * GOOGLE_APPLICATION_CREDENTIALS is the opposite case: google-auth-library
     * re-reads it on every token request, so deleting it would break ADC.
     */
    const env: NodeJS.ProcessEnv = {
      GSC_SERVICE_ACCOUNT_KEY_FILE: '/keys/service-account.json',
      GOOGLE_APPLICATION_CREDENTIALS: '/keys/adc.json',
    };
    const config = loadConfig(env);

    expect(config.auth).toEqual({
      mode: 'service-account',
      key: undefined,
      keyFile: '/keys/service-account.json',
    });
    expect(env.GSC_SERVICE_ACCOUNT_KEY_FILE).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/keys/adc.json');
  });
});

describe('the default property and the allowlist', () => {
  it('normalises GSC_SITE_URL', () => {
    expect(
      loadConfig({ GSC_SITE_URL: 'https://example.com' }).defaultSiteUrl
    ).toBe('https://example.com/');
  });

  it('refuses a default that the allowlist would then reject', () => {
    // Every call relying on the default would be refused — a configuration that
    // is valid on both lines and broken as a pair.
    expectExit(
      {
        GSC_SITE_URL: 'sc-domain:example.com',
        GSC_ALLOWED_SITES: 'sc-domain:other.test',
      },
      /is not listed in GSC_ALLOWED_SITES/
    );
  });

  it('refuses an allowlist that names nothing', () => {
    expectExit({ GSC_ALLOWED_SITES: ' , ' }, /would refuse every call/);
  });

  it('normalises every entry of the allowlist', () => {
    const config = loadConfig({
      GSC_ALLOWED_SITES: 'https://example.com, sc-domain:Example.NET',
    });
    expect(config.allowedSites).toEqual([
      'https://example.com/',
      'sc-domain:example.net',
    ]);
  });
});

describe('normalizeSiteUrl', () => {
  it('restores the trailing slash a URL-prefix property requires', () => {
    // Search Console registers `https://example.com/`, and the same URL without
    // the slash — which is what every other tool on earth calls it — answers 403.
    expect(normalizeSiteUrl('https://example.com')).toBe(
      'https://example.com/'
    );
    expect(normalizeSiteUrl('https://example.com/shop')).toBe(
      'https://example.com/shop'
    );
  });

  it('lower-cases a domain property and keeps the prefix', () => {
    expect(normalizeSiteUrl('SC-Domain:Example.COM')).toBe(
      'sc-domain:example.com'
    );
  });

  it('rejects a domain property carrying a scheme, and says what to write', () => {
    expect(() => normalizeSiteUrl('sc-domain:https://example.com')).toThrow(
      /write "sc-domain:example\.com"/
    );
  });

  it('refuses a bare hostname rather than guessing which kind it is', () => {
    /*
     * `example.com` could be either property, they hold different data, and
     * guessing would send an analytics query at a property that exists and
     * answers with different numbers — a wrong answer rather than an error.
     */
    expect(() => normalizeSiteUrl('example.com')).toThrow(
      /is not a Search Console property/
    );
  });

  it('refuses a URL with a query or a fragment', () => {
    expect(() => normalizeSiteUrl('https://example.com/?utm=1')).toThrow(
      /origin and path only/
    );
  });

  it('refuses an empty value', () => {
    expect(() => normalizeSiteUrl('   ')).toThrow(/must not be empty/);
  });
});
