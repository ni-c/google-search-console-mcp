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
