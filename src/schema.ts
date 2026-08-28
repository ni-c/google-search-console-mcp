import { z } from 'zod';

import { normalizeSiteUrl, type Config } from './config.js';

/**
 * The `site_url` argument, and the reason it is optional.
 *
 * Almost every method in all three APIs takes a property, and a session usually
 * concerns one. `GSC_SITE_URL` therefore supplies a default and this argument
 * becomes optional — which is not only convenience: a property the model never
 * spells out is a property it cannot misspell into a different one. Domain and
 * URL-prefix properties for the same site hold different numbers, so a typo
 * there is a wrong answer rather than an error.
 *
 * Left required when no default is configured, so the schema itself says the
 * argument is needed rather than every call failing at runtime.
 */
export function siteUrlSchema(config: Config): z.ZodType<string | undefined> {
  const described = z
    .string()
    .describe(
      'The Search Console property: "sc-domain:example.com" for a domain ' +
        'property, or "https://example.com/" for a URL-prefix property ' +
        '(the trailing slash is required)' +
        (config.defaultSiteUrl === undefined
          ? ''
          : `. Defaults to ${config.defaultSiteUrl} (GSC_SITE_URL)`)
    );
  return config.defaultSiteUrl === undefined ? described : described.optional();
}

/**
 * Resolves the property for a call: the argument, else the configured default,
 * checked against the allowlist.
 *
 * The allowlist is checked here rather than at the API boundary because this is
 * the one place every tool passes through. `GSC_ALLOWED_SITES` exists for the
 * case where one Google account can see both private and work properties, and a
 * guard that some tool could bypass would not be worth having.
 */
export function resolveSite(config: Config, given: string | undefined): string {
  const raw = given ?? config.defaultSiteUrl;
  if (raw === undefined) {
    throw new Error(
      'site_url is required — no default is configured. Set GSC_SITE_URL to ' +
        'default it, or pass the property explicitly. list_sites shows which ' +
        'properties this credential can see.'
    );
  }

  const site = normalizeSiteUrl(raw);

  if (
    config.allowedSites !== undefined &&
    !config.allowedSites.includes(site)
  ) {
    throw new Error(
      `${site} is not in GSC_ALLOWED_SITES. This server may only touch: ` +
        `${config.allowedSites.join(', ')}.`
    );
  }
  return site;
}

/**
 * A URL that goes into a request as data — a sitemap feedpath, a page to
 * inspect, a URL to notify the Indexing API about.
 *
 * Only http and https are accepted. Nothing here fetches the URL, so this is not
 * an SSRF guard; it is that `file:///etc/passwd` and `javascript:…` are never a
 * page Google can crawl, and a schema that accepts them turns an obvious mistake
 * into a puzzling 400 from Google three layers down. `z.url()` alone would let
 * both through — it validates the shape, not the scheme.
 */
export const webUrl = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'must be an absolute http:// or https:// URL' }
);

/** A `YYYY-MM-DD` date, which is the only format any of these APIs accept. */
export const isoDate = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}$/,
    'must be a date in YYYY-MM-DD form, for example 2026-08-28'
  )
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    message: 'is not a real date',
  });

/**
 * The confirmation token argument, shared by every guarded tool.
 *
 * Described rather than named `confirm`, so that a model reading the schema
 * learns it cannot invent the value — it only ever appears in the result of a
 * previous call.
 */
export const confirmToken = z
  .string()
  .optional()
  .describe(
    "The token from this tool's previous refusal. Call without it first to see " +
      'what would happen and receive the token; it cannot be guessed or reused.'
  );
