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
- The four irreversible operations — `delete_site`, `delete_sitemap`,
  `unverify_site` and `update_site_owners` — are two-step: the first call returns
  a short-lived confirmation token bound to those exact arguments, so a
  confirmation for one property cannot be replayed against another, and one for a
  two-name owner list cannot execute a three-name one. `update_site_owners` reads
  like an update and is a replacement: the list passed becomes the complete owner
  list, so a single well-formed call removes everyone else.
- **`GSC_ALLOWED_SITES` has no exemptions.** Tools that name a property are
  checked in `resolveSite`; the Indexing API tools, which name a page instead,
  match the URL against the list the way Search Console scopes a property; and
  the verification tools, which take an opaque resource id, resolve it to a
  property before acting. `list_sites` and `list_verified_sites` filter to the
  allowlist and report how many entries they withheld — the ids the second one
  returns are what `unverify_site` acts on.
- Search queries, page titles and crawl diagnostics are marked as untrusted
  content, on every result carrying an upstream payload. Search queries in
  particular are strings arbitrary members of the public typed into Google, and
  page titles come from whoever runs the crawled site.
- A confirmation prompt's two sentences are built only from values the server
  derived. Where an operation cannot be described without naming its subject —
  a sitemap URL, an owner list — the subject is quoted below them as data,
  flattened to a single line so it cannot open one of its own.
- Credentials are deleted from the environment after start-up (including the path
  in `GSC_SERVICE_ACCOUNT_KEY_FILE`, which points at one), never sent to a
  redirect target, and never echoed into an error message — including when the
  rejected value is a key pasted into the wrong variable, and including the one
  error path whose text comes from `google-auth-library` rather than from here.
- Results are budgeted: list results drop whole entries rather than overflowing
  the model's context and name the call that fetches the rest, and a single
  oversized object has its largest field shortened — at any depth, arrays as well
  as strings — rather than being truncated into unparseable JSON.
- Verification resource ids are rejected when they are a path of dots.
  `encodeURIComponent` escapes a slash but not a dot, so `..` would otherwise
  resolve `/webResource/..` back to the collection endpoint.

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
