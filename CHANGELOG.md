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

### Added

- Tools that need a confirmation now **ask the user**, on clients that can show
  a prompt. The two-call `confirm_token` remains for clients that cannot, so
  nothing that works today stops working — but where a person can be asked, one
  is, instead of a token that only proves the same call was made twice.

- `ELICITATION` switches the dialog off — `false` sends a client that could have
  been asked down the two-call-token path instead. For a scheduled job or a test
  harness, where a dialog is the wrong shape rather than an unwanted one.

  It does **not** remove the guard: there is no setting in which a guarded call
  goes unannounced. Two deliberate rough edges come with it. The variable is
  **not prefixed**, so one `export ELICITATION=false` reaches every MCP server in
  the environment — which is why a server started with it off prints a line
  saying so, and why the fallback text names the server instead of blaming a
  client that was working fine. And a value that is neither `true` nor `false`
  **stops the server**: it is the only variable here that defaults to _on_, so
  failing open on a typo would leave the dialog running while the operator
  believed it was off. It is read after the credentials are wiped from the
  environment, so that exit cannot leave them behind.

- A `docs/guide/approval.md` page.

### Changed

- Runs on **MCP SDK 2.0**. Existing clients see the same protocol revision they
  always did; the change is the package layout behind it, and it is what lets
  the dialog above work on both protocol eras from one code path — including
  behind a stateless gateway, where the older mechanism silently fell back to
  the weaker token for every client.

- The linter is **oxlint** instead of eslint plus typescript-eslint, which
  lifts the TypeScript ceiling: typescript-eslint pins `typescript` below 6.1,
  so this repository was held on TypeScript 6 by its linter rather than by its
  code.

- The tool filter, the confirmation store and the documentation-asset generator
  now come from **`mcp-tool-allowlist`**, **`mcp-approval`** and
  **`svg-asset-set`** rather than from copies kept here — 791 fewer lines, and
  one place to fix each. None of them has a runtime dependency of its own.

## [0.1.1] - 2026-08-30

### Fixed

- A search query containing a backslash directly before a pipe no longer breaks
  the analytics table. `escapeCell` escaped the pipe but not the backslash, so
  `shoes \| nike` came out as `shoes \\| nike` — an escaped backslash followed by
  a live column separator, which is exactly the row split the escaping prevents.

## [0.1.0] - 2026-08-29

First release.

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

- The npm package is **`@ni-c/google-search-console-mcp`**, scoped, while the
  repository, the image and the docs domain are unscoped. `npm view` reported the
  unscoped name as free, but npm's similarity check runs only at publish time and
  refused it as too close to the existing `google-searchconsole-mcp`. The MCP
  registry name is unaffected — that is `io.github.ni-c/google-search-console-mcp`
  either way.
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
