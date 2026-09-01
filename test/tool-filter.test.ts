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
