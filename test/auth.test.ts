import { describe, expect, it } from 'vitest';

import {
  createTokenSource,
  SCOPES,
  scopesFor,
  type Service,
} from '../src/auth.js';
import { registeredTools, servicesFor, toolFilterFor } from '../src/server.js';

import { ALL_TOOLS, READ_TOOLS } from '../src/tools/catalogue.js';
import { testConfig } from './harness.js';

function set(...services: Service[]): Set<Service> {
  return new Set(services);
}

describe('scopesFor', () => {
  it('asks for the read-only Search Console scope in read-only mode', () => {
    // Defence in depth: `webmasters.readonly` cannot write even if a tool tried.
    expect(scopesFor(set('search-console'), true)).toEqual([
      SCOPES.webmastersReadonly,
    ]);
    expect(scopesFor(set('search-console'), false)).toEqual([
      SCOPES.webmasters,
    ]);
  });

  it('does not ask for a scope no registered tool needs', () => {
    /*
     * The point of deriving scopes from tools rather than hard-coding three.
     * For a service account under domain-wide delegation the scopes are
     * allowlisted by a Workspace administrator, and asking for one that was not
     * delegated fails the whole token request with `unauthorized_client` — so a
     * server that always asked for all three would be unusable for someone
     * granted only Search Console.
     */
    expect(scopesFor(set('search-console'), false)).not.toContain(
      SCOPES.siteVerification
    );
    expect(scopesFor(set('search-console'), false)).not.toContain(
      SCOPES.indexing
    );
  });

  it('still asks for the full verification scope in read-only mode', () => {
    // Site Verification has no read-only scope of its own — `verify_only` is
    // write-only and cannot list. A limit of Google's scope design, not an
    // oversight here.
    expect(scopesFor(set('site-verification'), true)).toEqual([
      SCOPES.siteVerification,
    ]);
  });

  it('asks for nothing when nothing is registered', () => {
    expect(scopesFor(set(), false)).toEqual([]);
  });
});

describe('which scopes a given configuration ends up asking for', () => {
  function scopesOf(
    overrides: Parameters<typeof testConfig>[0] = {}
  ): string[] {
    const config = testConfig(overrides);
    return scopesFor(
      servicesFor(registeredTools(config, toolFilterFor(config))),
      config.readOnly
    );
  }

  it('asks for all three by default', () => {
    expect(scopesOf().sort()).toEqual(
      [SCOPES.webmasters, SCOPES.siteVerification, SCOPES.indexing].sort()
    );
  });

  it('drops the indexing scope when those tools are denied', () => {
    const scopes = scopesOf({
      denyTools: 'request_indexing,get_indexing_status',
    });
    expect(scopes).not.toContain(SCOPES.indexing);
    expect(scopes).toContain(SCOPES.webmasters);
  });

  it('asks for one scope under the essential preset', () => {
    // Every essential tool is Search Console, so a credential narrowed to that
    // preset needs exactly one grant.
    expect(scopesOf({ allowTools: 'essential' })).toEqual([SCOPES.webmasters]);
  });

  it('swaps to the read-only scope under GSC_READ_ONLY', () => {
    const scopes = scopesOf({ readOnly: true });
    expect(scopes).toContain(SCOPES.webmastersReadonly);
    expect(scopes).not.toContain(SCOPES.webmasters);
  });
});

describe('registeredTools', () => {
  it('is every tool with no filter', () => {
    const config = testConfig();
    expect(registeredTools(config, toolFilterFor(config)).size).toBe(
      ALL_TOOLS.length
    );
  });

  it('drops the write tools before the filter is applied', () => {
    const config = testConfig({ readOnly: true });
    expect([...registeredTools(config, toolFilterFor(config))].sort()).toEqual(
      [...READ_TOOLS].sort()
    );
  });
});

describe('the token source when nothing is configured', () => {
  it('exists, so the server can start and list its tools', () => {
    // A registry or sandbox inspector cannot enumerate a server that refuses to
    // boot, and Glama's listing stays "not tested" if it cannot.
    expect(() => createTokenSource(undefined, [])).not.toThrow();
  });

  it('fails every call with the setup instructions', async () => {
    await expect(
      createTokenSource(undefined, []).getAccessToken()
    ).rejects.toThrow(/no Google credentials configured/);
  });

  it('says so rather than naming an identity it does not have', () => {
    expect(createTokenSource(undefined, []).describe()).toBe(
      'nothing configured'
    );
  });
});

describe('the token source for each credential kind', () => {
  it('describes a service account by where its key came from', () => {
    // Never the key itself — `describe()` is printed at startup.
    const fromEnv = createTokenSource(
      {
        mode: 'service-account',
        key: '{"client_email":"a","private_key":"b"}',
        keyFile: undefined,
      },
      []
    );
    expect(fromEnv.describe()).toContain('GSC_SERVICE_ACCOUNT_KEY');
    expect(fromEnv.describe()).not.toContain('private_key');

    const fromFile = createTokenSource(
      { mode: 'service-account', key: undefined, keyFile: '/keys/robot.json' },
      []
    );
    expect(fromFile.describe()).toContain('/keys/robot.json');
  });

  it('describes an OAuth credential without its secret', () => {
    const source = createTokenSource(
      {
        mode: 'oauth-refresh-token',
        clientId: 'id',
        clientSecret: 'SECRET-VALUE',
        refreshToken: 'REFRESH-VALUE',
      },
      []
    );
    expect(source.describe()).not.toContain('SECRET-VALUE');
    expect(source.describe()).not.toContain('REFRESH-VALUE');
  });

  it('describes application default credentials', () => {
    expect(createTokenSource({ mode: 'adc' }, []).describe()).toBe(
      'application default credentials'
    );
  });
});
