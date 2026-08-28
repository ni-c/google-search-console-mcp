# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

Nothing is released yet — this section becomes `## [0.1.0]` when the first tag is
pushed.

### Added

- MCP server for Google Search Console, covering three Google APIs in full:
  [Search Console v1][sc] (properties, sitemaps, search analytics, URL
  inspection), [Site Verification v1][sv] (proving and managing ownership) and
  the [Indexing API v3][idx].
- 21 tools. Eighteen map one-to-one onto an API method; the other three exist
  because the APIs do not have them and the work needs them:
  - `setup_site` reports which of the four steps a property is missing and hands
    over the DNS record or meta tag to place. Nothing in either API enforces that
    order, and `add_site` on an unverified domain succeeds while producing a
    property that answers 403 for every piece of data.
  - `submit_sitemaps` and `inspect_urls` do one property's worth of work in a
    single call, reporting per-entry results.
- Three ways to authenticate, tried in a fixed order: a service account key
  (raw JSON or base64), an OAuth2 refresh token, or application default
  credentials. A partial OAuth2 triple is refused rather than silently falling
  through to whichever account the machine is logged into.
- Relative date ranges — `period: "last28days"` — resolved against today in
  **Pacific Time**, which is the time zone Search Console counts days in. A range
  computed in UTC asks for a day Google has no data for.
- Search analytics come back as a compact table with totals, at roughly a third
  the tokens of the API's JSON. CTR is computed from the totals and average
  position is weighted by impressions, and the result says plainly that the rows
  do not sum to the property total when the query dimension is used.
- `GSC_SITE_URL` defaults the property for every tool that takes one, and
  `GSC_ALLOWED_SITES` restricts which properties the server may touch at all.
- `GSC_ALLOW_TOOLS` / `GSC_DENY_TOOLS` narrow the tool list by name or `list_*`
  prefix; `essential` selects the five read tools that cover looking at a
  property.
- `GSC_READ_ONLY=true` registers only the twelve read tools; the nine write tools
  never reach the client's tool list.

### Security

- **The requested OAuth scopes follow the registered tools.** A server narrowed
  to the Search Console tools never asks for the Site Verification or Indexing
  scope — which is the difference between working and not for a service account
  under domain-wide delegation, where an undelegated scope fails the whole token
  request. `GSC_READ_ONLY` additionally swaps `webmasters` for
  `webmasters.readonly`, so writes are impossible below the tool layer.
- The three irreversible operations — `delete_site`, `delete_sitemap` and
  `unverify_site` — are two-step: the first call returns a short-lived
  confirmation token bound to those exact arguments, so a confirmation for one
  property cannot be replayed against another.
- Search queries, page titles and crawl diagnostics are marked as untrusted
  content. Search queries in particular are strings arbitrary members of the
  public typed into Google, and page titles come from whoever runs the crawled
  site.
- Credentials are deleted from the environment after start-up, never sent to a
  redirect target, and never echoed into an error message — including when the
  rejected value is a key pasted into the wrong variable.
- Results are budgeted: list results drop whole entries rather than overflowing
  the model's context, and a single oversized object has its longest text fields
  shortened rather than being truncated into unparseable JSON.

### Notes

- There is no `hosts.ts` SSRF guard here, unlike its sibling servers, and that is
  a decision rather than an omission: there is no configurable target host. Every
  request goes to one of three hard-coded Google endpoints.
- `urlTestingTools.mobileFriendlyTest` is deliberately not exposed. It is still
  in Google's discovery document and the service behind it was switched off in
  December 2023, so a tool for it could only ever return an error.

[sc]: https://developers.google.com/webmaster-tools/v1/api_reference_index
[sv]: https://developers.google.com/site-verification/v1
[idx]: https://developers.google.com/search/apis/indexing-api/v3/quickstart

<!-- #endregion changelog -->
