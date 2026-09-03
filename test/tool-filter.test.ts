import { describe, expect, it, vi } from 'vitest';

import { ToolFilterError } from 'mcp-tool-allowlist';

import { toolFilterFor } from '../src/server.js';
import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  READ_TOOLS,
  TOOL_SERVICES,
  WRITE_TOOLS,
} from '../src/tools/catalogue.js';
import { connect, testConfig } from './harness.js';
import { expectPortableToolSchemas } from 'mcp-integration-harness';

/**
 * The catalogue is a hand-maintained list, and this file is what stops it
 * drifting from reality.
 *
 * Note that no test here writes a tool name out except where the name itself is
 * the subject. Keeping a second copy of twenty-one names in the test file would
 * mean the assertion passes whenever both copies are wrong together, which is
 * exactly the failure it exists to catch.
 */

async function registeredNames(
  overrides: Parameters<typeof connect>[0] = {}
): Promise<string[]> {
  const client = await connect(overrides);
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).sort();
}

describe('the catalogue and the server agree', () => {
  it('registers exactly the tools the catalogue declares', async () => {
    expect(await registeredNames()).toEqual([...ALL_TOOLS].sort());
  });

  it('registers exactly the read tools under GSC_READ_ONLY', async () => {
    expect(await registeredNames({ readOnly: true })).toEqual(
      [...READ_TOOLS].sort()
    );
  });

  it('splits every tool into exactly one of read and write', () => {
    const overlap = READ_TOOLS.filter((tool) =>
      (WRITE_TOOLS as readonly string[]).includes(tool)
    );
    expect(overlap).toEqual([]);
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
  });

  it('marks every read tool as read-only and no write tool', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const readOnly = tool.annotations?.readOnlyHint === true;
      expect(readOnly, `${tool.name} has the wrong readOnlyHint`).toBe(
        (READ_TOOLS as readonly string[]).includes(tool.name)
      );
    }
  });

  it('declares an output schema on every tool', async () => {
    // The same argument as the annotations below, one field along. A tool that
    // says nothing about its result forces a client to parse prose to find out
    // what it got, and the SDK sends no `structuredContent` at all for a tool
    // that declared no schema — six tools here answered with a sentence.
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      // An object root, not merely a schema. SEP-2106 allows an array or a
      // scalar, but a 2025-era client is served that same tool with the schema
      // rewritten to `{result: …}` — so it would answer in two shapes
      // depending on who asked.
      expect(tool.outputSchema?.type, tool.name).toBe('object');
    }
  });

  it('advertises schemas every client can read', async () => {
    // Legal JSON Schema is not enough. `{}` in a schema position — what zod
    // writes for `looseObject`, `catchall` and `z.unknown()` — and `type` as an
    // array are both refused, or silently dropped, by some clients. Neither is
    // a contract: each has an equivalent spelling that says the same thing, so
    // there is nothing here to excuse.
    const client = await connect();
    const { tools } = await client.listTools();
    expectPortableToolSchemas(tools);
  });

  it('marks every result built from Google’s data as untrusted', async () => {
    // "It is only search data" is exactly the wrong intuition: a search query
    // is a string a member of the public typed into Google, and a page title
    // comes from the crawled site. A client that reads only
    // `structuredContent` must not get either unframed.
    const client = await connect();
    const { tools } = await client.listTools();
    const plain = tools
      .filter((tool) => {
        const properties = tool.outputSchema?.properties as
          Record<string, unknown> | undefined;
        return properties?.untrusted === undefined;
      })
      .map((tool) => tool.name)
      .sort();
    // The six whose answer is a property this server was given and a fact it
    // established. A marker on those would make the marker mean nothing.
    expect(plain).toEqual([
      'add_site',
      'delete_site',
      'delete_sitemap',
      'submit_sitemap',
      'submit_sitemaps',
      'unverify_site',
    ]);
  });

  it('declares all four annotation hints on every tool', async () => {
    // Not a style rule. Two of the four default to a *stronger* claim than
    // silence suggests: the specification gives destructiveHint and
    // openWorldHint a default of true, so a tool that omits them announces
    // itself as destructive and open-world. Five write tools here stated only
    // idempotentHint and inherited the rest.
    const client = await connect();
    const { tools } = await client.listTools();
    const hints = [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ] as const;
    for (const tool of tools) {
      for (const hint of hints) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe(
          'boolean'
        );
      }
    }
  });

  it('warns only where history or access is lost', async () => {
    // What a property holds is sixteen months of performance data, and that is
    // what delete_site destroys — re-adding starts empty. Adding, submitting
    // and verifying take nothing away, and all five used to inherit
    // destructiveHint: true from the default.
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    for (const additive of [
      'add_site',
      'verify_site',
      'submit_sitemap',
      'submit_sitemaps',
      'request_indexing',
    ]) {
      expect(byName.get(additive)?.destructiveHint, additive).toBe(false);
    }
    for (const destructive of [
      'delete_site',
      'delete_sitemap',
      'unverify_site',
      'update_site_owners',
    ]) {
      expect(byName.get(destructive)?.destructiveHint, destructive).toBe(true);
    }
  });

  it('assigns every tool to at least one Google service', () => {
    // Without this, a new tool silently contributes no scope and fails at
    // runtime with a 403 that blames permissions.
    for (const tool of ALL_TOOLS) {
      expect(TOOL_SERVICES[tool], `${tool} has no service`).toBeDefined();
      expect(TOOL_SERVICES[tool]?.length).toBeGreaterThan(0);
    }
    // And nothing in the map that is not a tool — a renamed tool would leave
    // its old entry behind, which is silent.
    for (const name of Object.keys(TOOL_SERVICES)) {
      expect(
        ALL_TOOLS,
        `${name} is in TOOL_SERVICES but is not a tool`
      ).toContain(name);
    }
  });
});

describe('the essential preset', () => {
  it('names only tools that exist, and is 5 to 8 of them', () => {
    expect(ESSENTIAL_TOOLS.length).toBeGreaterThanOrEqual(5);
    expect(ESSENTIAL_TOOLS.length).toBeLessThanOrEqual(8);
    for (const tool of ESSENTIAL_TOOLS) expect(ALL_TOOLS).toContain(tool);
    expect(new Set(ESSENTIAL_TOOLS).size).toBe(ESSENTIAL_TOOLS.length);
  });

  it('survives read-only mode, because every member reads', () => {
    // The preset is chosen by an operator, not typed per call, so a member that
    // read-only suppresses would silently shrink it.
    for (const tool of ESSENTIAL_TOOLS) expect(READ_TOOLS).toContain(tool);
  });

  it('is what GSC_ALLOW_TOOLS=essential selects', async () => {
    expect(await registeredNames({ allowTools: 'essential' })).toEqual(
      [...ESSENTIAL_TOOLS].sort()
    );
  });
});

describe('narrowing the tool list', () => {
  it('takes exact names', async () => {
    expect(
      await registeredNames({ allowTools: 'list_sites,get_site' })
    ).toEqual(['get_site', 'list_sites']);
  });

  it('takes a trailing-star prefix', async () => {
    const names = await registeredNames({ allowTools: 'list_*' });
    expect(names).toContain('list_sites');
    expect(names).toContain('list_sitemaps');
    expect(names).not.toContain('get_site');
  });

  it('subtracts the deny list from the allow list', async () => {
    const names = await registeredNames({
      allowTools: 'list_*',
      denyTools: 'list_verified_sites',
    });
    expect(names).not.toContain('list_verified_sites');
    expect(names).toContain('list_sites');
  });

  it('answers tools/list rather than "method not found" when all are filtered', async () => {
    // The SDK installs its tools/list handler from inside the registration
    // path, so a server that *skipped* every tool would answer the whole method
    // with an error. Registering and removing is what keeps this an empty list.
    const client = await connect({ allowTools: 'list_sites' });
    await expect(client.listTools()).resolves.toBeDefined();
  });
});

describe('refusing a tool list that cannot mean what it says', () => {
  it('rejects a name that matches nothing', () => {
    expect(() =>
      toolFilterFor(testConfig({ allowTools: 'list_siets' }))
    ).toThrow(ToolFilterError);
  });

  it('names a write tool that read-only suppresses, instead of "unknown tool"', () => {
    // The one answer that would be wrong: the tool exists, read-only is why it
    // is not there, and saying "no such tool" sends the reader hunting a typo.
    expect(() =>
      toolFilterFor(testConfig({ allowTools: 'delete_site', readOnly: true }))
    ).toThrow(/read-only mode suppresses.*unset GSC_READ_ONLY/s);
  });

  it('warns rather than fails when a pattern only matches write tools', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      toolFilterFor(
        testConfig({ allowTools: 'list_*,delete_*', readOnly: true })
      )
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('contributes nothing')
    );
    warn.mockRestore();
  });

  it('refuses to start with an empty tool list', () => {
    expect(() =>
      toolFilterFor(
        testConfig({ allowTools: 'list_sites', denyTools: 'list_sites' })
      )
    ).toThrow(/leave no tools registered/);
  });

  it('does not echo a value that could be a pasted credential', () => {
    // GSC_REFRESH_TOKEN and GSC_ALLOW_TOOLS are adjacent lines in every compose
    // file. A rejected entry must not print the secret into the client's log.
    const secret =
      '1//0eXaMPLE-refresh-token-value-that-is-long-AND-mixed-case';
    let message = '';
    try {
      toolFilterFor(testConfig({ allowTools: secret }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(secret);
    expect(message).toContain('redacted');
  });
});
