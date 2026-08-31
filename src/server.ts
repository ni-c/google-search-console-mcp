import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import {
  createTokenSource,
  scopesFor,
  type Service,
  type TokenSource,
} from './auth.js';
import {
  buildToolFilter,
  installToolFilter,
  type ToolFilter,
} from './tool-filter.js';

import { GoogleApi } from './api.js';
import type { Config } from './config.js';
import { ConfirmationStore } from './confirm.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { ALL_TOOLS, READ_TOOLS, TOOL_SERVICES } from './tools/catalogue.js';
import type { ToolContext } from './tools/context.js';
import { registerIndexingTools } from './tools/indexing.js';
import { registerInspectionTools } from './tools/inspection.js';
import { registerSetupTools } from './tools/setup.js';
import { registerSitemapTools } from './tools/sitemaps.js';
import { registerSiteTools } from './tools/sites.js';
import { registerVerificationTools } from './tools/verification.js';

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/**
 * The modules, in the order their tools appear in the catalogue.
 *
 * Each registers its own read tools and, unless `readOnly`, its write tools: the
 * split is by subject rather than by direction, because `list_sitemaps` and
 * `submit_sitemap` share a path builder and a property argument, and separating
 * them by file is how the two drift apart.
 */
const MODULES = [
  registerSiteTools,
  registerSitemapTools,
  registerAnalyticsTools,
  registerInspectionTools,
  registerVerificationTools,
  registerIndexingTools,
  registerSetupTools,
];

/**
 * The tools that will actually be registered, given read-only mode and the
 * filter.
 *
 * Needed before anything is built, because the OAuth scopes are derived from it
 * — see {@link servicesFor}. Read-only removes the write tools first, then the
 * filter narrows what is left, which is the same order `installToolFilter`
 * effectively applies.
 */
export function registeredTools(
  config: Config,
  filter: ToolFilter
): Set<string> {
  const base = config.readOnly ? [...READ_TOOLS] : [...ALL_TOOLS];
  return new Set(
    filter.active ? base.filter((tool) => filter.selected.has(tool)) : base
  );
}

/** The distinct Google services a set of tools needs to reach. */
export function servicesFor(tools: Iterable<string>): Set<Service> {
  const services = new Set<Service>();
  for (const tool of tools) {
    for (const service of TOOL_SERVICES[tool] ?? []) services.add(service);
  }
  return services;
}

export interface ServerOptions {
  /**
   * Supplies the access token instead of `google-auth-library`.
   *
   * A test hook, and the only one: every other seam in this server is a stubbed
   * `fetch`, but the credential path is not HTTP — `GoogleAuth` signs a JWT and
   * talks to Google's token endpoint itself. Injecting the token source keeps
   * the tests off the network without mocking a module, and it is what lets
   * `test/harness.ts` assert on the Authorization header rather than assuming
   * one was sent.
   */
  tokens?: TokenSource;
}

export function createServer(
  config: Config,
  options: ServerOptions = {}
): McpServer {
  // Before anything is built: an unusable tool list should fail on the way in,
  // not leave a server running with tools quietly missing.
  const filter = buildToolFilter(config);

  // Least privilege, decided here because this is the only place that knows both
  // halves — which tools survived, and whether writes are allowed at all.
  const scopes = scopesFor(
    servicesFor(registeredTools(config, filter)),
    config.readOnly
  );

  const context: ToolContext = {
    api: new GoogleApi(
      options.tokens ?? createTokenSource(config.auth, scopes)
    ),
    config,
    confirmations: new ConfirmationStore(),
    readOnly: config.readOnly,
  };

  const server = new McpServer({
    name: 'google-search-console-mcp',
    version: packageVersion(),
  });

  // Wraps server.registerTool, so it has to sit before the first register call
  // and it does not care how the register functions are organised.
  installToolFilter(server, filter);

  for (const register of MODULES) register(server, context);

  return server;
}
