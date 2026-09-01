import type { McpServer } from '@modelcontextprotocol/server';
import type { Approver, ConfirmationStore } from 'mcp-approval';

import type { GoogleApi } from '../api.js';
import type { Config } from '../config.js';

/**
 * What every tool module gets.
 *
 * The whole `Config` rather than the two fields a module happens to need,
 * because `resolveSite` takes it: the default property and the allowlist are
 * consulted on nearly every call, and threading them separately would mean every
 * new module remembering to pass both.
 *
 * `readOnly` is passed rather than checked by the caller, because the modules are
 * organised by *subject* — properties, sitemaps, ownership — not by whether a
 * tool writes. `list_sitemaps` and `submit_sitemap` share a path builder and a
 * property argument, and separating them by file is how the two drift apart.
 */
export interface ToolContext {
  api: GoogleApi;
  config: Config;
  confirmations: ConfirmationStore;
  /** Asks a person where the client can show a prompt; the store is the fallback. */
  approval: Approver;
  readOnly: boolean;
}

export type Registrar = (server: McpServer, context: ToolContext) => void;
