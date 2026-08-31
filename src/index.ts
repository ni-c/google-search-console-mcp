#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { ToolFilterError } from './tool-filter.js';

const NAME = 'google-search-console-mcp';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.readOnly) {
    console.error(
      `${NAME}: GSC_READ_ONLY=true — write tools are not registered`
    );
  }
  if (config.allowedSites !== undefined) {
    console.error(
      `${NAME}: GSC_ALLOWED_SITES — restricted to ${config.allowedSites.join(', ')}`
    );
  }

  let server;
  try {
    server = createServer(config);
  } catch (error) {
    // A bad tool list is operator feedback, not a crash: print the sentence on
    // its own rather than behind "fatal error:" with a stack after it.
    if (error instanceof ToolFilterError) {
      console.error(`${NAME}: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  // stdout belongs to the protocol; everything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  console.error(
    config.auth === undefined
      ? `${NAME}: connected without credentials — tools are listed, but every ` +
          'call will fail until a credential is configured'
      : `${NAME}: connected using ${config.auth.mode}` +
          (config.defaultSiteUrl === undefined
            ? ''
            : `, defaulting to ${config.defaultSiteUrl}`)
  );
}

// In a container node runs as PID 1 with no default signal disposition, so
// without this handler `docker stop` waits out the grace period and SIGKILLs.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error(`${NAME}: fatal error:`, error);
  process.exit(1);
});
