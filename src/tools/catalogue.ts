import type { Service } from '../auth.js';

/**
 * The tools this server can register, declared rather than discovered.
 *
 * Declared, because the tool filter has to answer "is this a name you have?"
 * *before* anything is registered — and in read-only mode the write tools are
 * never registered at all. Deriving the catalogue from what actually reached
 * `registerTool` would make `GSC_ALLOW_TOOLS=delete_site` report "unknown tool"
 * under `GSC_READ_ONLY=true`, which is the one answer that is wrong.
 *
 * This is also the full tool surface, hard-coded on purpose: a tool that appears
 * or disappears by accident is a change to the server's contract and has to be a
 * deliberate edit here. `test/tool-filter.test.ts` asserts that these lists and
 * the tools the server really registers are the same set, so the duplication
 * cannot drift — and the test file keeps no second copy of the names.
 */

/**
 * Registered always. Every one carries `readOnlyHint: true`.
 *
 * "Read" means "changes nothing at Google". `get_verification_token` is in here
 * despite being an HTTP POST: it computes the token a DNS record or HTML file
 * would have to contain and returns it. Nothing is created, nothing is claimed,
 * and running it against a domain you do not own achieves exactly nothing.
 */
export const READ_TOOLS = [
  // Properties
  'list_sites',
  'get_site',
  // Sitemaps
  'list_sitemaps',
  'get_sitemap',
  // Search analytics
  'query_search_analytics',
  // URL inspection
  'inspect_url',
  'inspect_urls',
  // Ownership
  'list_verified_sites',
  'get_verified_site',
  'get_verification_token',
  // Indexing API
  'get_indexing_status',
  // Guidance
  'setup_site',
] as const;

/** Registered unless `GSC_READ_ONLY` is set. */
export const WRITE_TOOLS = [
  // Properties
  'add_site',
  'delete_site',
  // Sitemaps
  'submit_sitemap',
  'submit_sitemaps',
  'delete_sitemap',
  // Ownership
  'verify_site',
  'unverify_site',
  'update_site_owners',
  // Indexing API
  'request_indexing',
] as const;

/** Every tool, read-only mode aside. */
export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * Which Google service each tool talks to.
 *
 * This is what makes the requested OAuth scopes follow the registered tools
 * rather than being a fixed list of three — see `scopesFor` in `auth.ts`. A
 * server narrowed to the Search Console tools never asks for the Site
 * Verification or Indexing scope, which is the difference between working and
 * not for a service account under domain-wide delegation.
 *
 * `setup_site` names two because it genuinely reads from both: it asks Search
 * Console which properties exist and Site Verification which are owned, and the
 * answer is the gap between those two lists.
 */
export const TOOL_SERVICES: Readonly<Record<string, readonly Service[]>> = {
  list_sites: ['search-console'],
  get_site: ['search-console'],
  add_site: ['search-console'],
  delete_site: ['search-console'],
  list_sitemaps: ['search-console'],
  get_sitemap: ['search-console'],
  submit_sitemap: ['search-console'],
  submit_sitemaps: ['search-console'],
  delete_sitemap: ['search-console'],
  query_search_analytics: ['search-console'],
  inspect_url: ['search-console'],
  inspect_urls: ['search-console'],
  list_verified_sites: ['site-verification'],
  get_verified_site: ['site-verification'],
  get_verification_token: ['site-verification'],
  verify_site: ['site-verification'],
  unverify_site: ['site-verification'],
  update_site_owners: ['site-verification'],
  get_indexing_status: ['indexing'],
  request_indexing: ['indexing'],
  setup_site: ['search-console', 'site-verification'],
};

/**
 * What `GSC_ALLOW_TOOLS=essential` selects.
 *
 * Five tools, all read-only, and that is deliberate rather than shy: the preset
 * is what somebody chooses when they want a model looking at a property without
 * being able to change it. Everything that writes — adding a property, verifying
 * ownership, submitting a sitemap — is a task you go looking for, and
 * `GSC_ALLOW_TOOLS` names those explicitly.
 *
 * `get_site` earns its place over `inspect_urls` because the single most common
 * failure with this API is a property that is spelled almost right, and
 * `get_site` is how you find out which of the two spellings exists.
 *
 * `test/tool-filter.test.ts` checks every name here exists and that the list is
 * within 5..8.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'list_sites',
  'get_site',
  'list_sitemaps',
  'query_search_analytics',
  'inspect_url',
];
