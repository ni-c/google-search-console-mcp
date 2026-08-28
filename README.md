# google-search-console-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/google-search-console-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/google-search-console-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/google-search-console-mcp)](https://www.npmjs.com/package/google-search-console-mcp)
[![npm downloads](https://img.shields.io/npm/dm/google-search-console-mcp)](https://www.npmjs.com/package/google-search-console-mcp)
[![node](https://img.shields.io/node/v/google-search-console-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/google-search-console-mcp)](LICENSE)
[![container](https://img.shields.io/badge/ghcr.io-ni--c%2Fgoogle--search--console--mcp-blue)](https://github.com/ni-c/google-search-console-mcp/pkgs/container/google-search-console-mcp)
[![docs](https://img.shields.io/badge/docs-google--search--console--mcp.ni--c.de-informational)](https://google-search-console-mcp.ni-c.de)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[Google Search Console](https://search.google.com/search-console/about), the
service that tells you how Google sees your site — this reads it and sets it up.

Lets MCP clients like Claude Code, Claude Desktop or Codex create a property and
prove ownership of it, submit and refresh sitemaps, ask what any URL's index
status is, and query the whole Performance report — with the irreversible
operations behind a confirmation token and the write tools switchable off
entirely.

21 tools is the ceiling, not the floor: `GSC_ALLOW_TOOLS=essential` registers a
curated five instead, and a model picks the right tool far more reliably from
five than from 21 — see
[choosing which tools load](#choosing-which-tools-load).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://google-search-console-mcp.ni-c.de/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://google-search-console-mcp.ni-c.de/architecture-light.svg">
  <img src="https://google-search-console-mcp.ni-c.de/architecture.svg" alt="An MCP client talks to google-search-console-mcp over stdio; the server calls the Search Console, Site Verification and Indexing APIs over HTTPS." width="800">
</picture>

## What makes it different

**It can actually create a working property.** Getting one takes four steps in a
fixed order — obtain a verification token, place it in DNS or on the page,
verify ownership, add the property — and nothing in Google's APIs enforces that
order. Calling `sites.add` first _succeeds_ and leaves a property that appears in
every listing and answers 403 for every piece of data, which looks like a
permissions bug and is not. `setup_site` reports which step is missing and hands
over the exact DNS record to paste. Servers that expose `sites.add` alone can
only add properties somebody already verified by hand.

**Three APIs, not one.** Search Console v1 is ten methods and does not include
ownership. Site Verification is a separate service with its own scope, its own
host and an incompatible way of naming the same site —
`sc-domain:example.com` there is `{type: INET_DOMAIN, identifier: example.com}`,
and passing the property spelling straight through is accepted and verifies a
domain literally called `sc-domain:example.com`. The Indexing API is a third.
All three are covered, and the translation between them is in
`src/site-identity.ts`.

**The numbers are right.** Search analytics come back as a table with totals
where CTR is computed from the totals rather than averaged across rows, and
average position is weighted by impressions. Unweighted, a thousand rare queries
ranking 80th drag a property's real average of 12 up into the nineties. The
result also says plainly that the rows do not sum to the property total when the
query dimension is used — Google withholds rare queries for anonymity, commonly a
third or more of all impressions, and a total printed without that caveat is a
number people will quote.

**It knows where these APIs are sharp.** The trailing slash on
`https://example.com/` is mandatory and its absence is a 403; a domain property
and a URL-prefix property for the same site are different properties with
different data, so a bare hostname is refused rather than guessed at; days are
counted in **Pacific Time**, so a `last7days` computed in UTC asks for a day
Google has no data for; the `hour` dimension silently returns nothing without
`dataState: HOURLY_ALL`; Google omits empty arrays entirely, so a fresh
credential's property list arrives as `{}`; and the Indexing API returns 200 for
any owned URL while only acting on JobPosting and BroadcastEvent pages.

## Requirements

- Node.js 22 or newer (or the container image)
- A Google credential — a service account key, an OAuth2 refresh token, or
  application default credentials
- The APIs you intend to use enabled in a Google Cloud project: **Search
  Console API**, and separately **Site Verification API** and **Indexing API**

## Configuration

The server starts without credentials and lists its tools; every call then fails
with setup instructions rather than a Google error. That is deliberate, so
registries and sandbox inspectors can introspect it.

| Variable                         | Description                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GSC_SERVICE_ACCOUNT_KEY`        | Service account key as raw JSON, or base64-encoded JSON                                                        |
| `GSC_SERVICE_ACCOUNT_KEY_FILE`   | Path to a service account key file. Alternative to the above — setting both is an error                        |
| `GSC_CLIENT_ID`                  | OAuth2 client id                                                                                               |
| `GSC_CLIENT_SECRET`              | OAuth2 client secret                                                                                           |
| `GSC_REFRESH_TOKEN`              | OAuth2 refresh token. All three OAuth2 variables are required together                                         |
| `GOOGLE_APPLICATION_CREDENTIALS` | Application default credentials, used when no `GSC_` credential is set                                         |
| `GSC_SITE_URL`                   | Default property, e.g. `sc-domain:example.com` or `https://example.com/`. Makes `site_url` optional everywhere |
| `GSC_ALLOWED_SITES`              | Comma-separated properties this server may touch at all; anything else is refused                              |
| `GSC_READ_ONLY`                  | `true` registers only the twelve read tools                                                                    |
| `GSC_ALLOW_TOOLS`                | Comma-separated tool names, a `list_*` prefix, or `essential`                                                  |
| `GSC_DENY_TOOLS`                 | Same shape, subtracted from whatever the allow list left                                                       |

Credentials are tried in that order — explicit beats ambient. A **partial** OAuth
triple is a startup error rather than a reason to fall through to application
default credentials, because that fallback would quietly run the server as
whatever account the machine is logged into.

### Which credential

A **service account** is the recommended one: it sees only the properties you
explicitly add it to, and revoking it does not touch anyone's Google account.
Add its `client_email` under Settings → Users and permissions in Search Console,
or give it ownership with `verify_site`. Note that the Indexing API requires
**owner**, not full user.

An **OAuth2 refresh token** acts as the person who consented and sees everything
they see. Its scopes were fixed at consent time and cannot be widened later.

### Choosing which tools load

Every visible tool costs context on every request, and a model picks the right
one far more reliably from five than from 21. Two variables narrow the list:

```sh
GSC_ALLOW_TOOLS=essential          # the curated five
GSC_ALLOW_TOOLS='list_*,get_site'  # exact names, or one trailing *
GSC_DENY_TOOLS='delete_*'          # subtracted from whatever allow left
```

`essential` is `list_sites`, `get_site`, `list_sitemaps`,
`query_search_analytics` and `inspect_url` — everything needed to look at a
property, and nothing that changes it.

An entry that matches no tool **stops the server** with the list of real names.
An ignored typo would otherwise leave a tool missing from `tools/list` with
nothing pointing at the cause, and nobody traces an absence back to an
environment variable.

Narrowing the list also narrows the credential: the OAuth scopes this server
requests are derived from the tools that are actually registered, so a server
denied the Indexing tools never asks for the Indexing scope.

## Installation

### Claude Code

```sh
claude mcp add google-search-console -- npx -y google-search-console-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "google-search-console": {
      "command": "npx",
      "args": ["-y", "google-search-console-mcp"],
      "env": {
        "GSC_SERVICE_ACCOUNT_KEY_FILE": "/path/to/key.json",
        "GSC_SITE_URL": "sc-domain:example.com"
      }
    }
  }
}
```

### Codex

```toml
[mcp_servers.google-search-console]
command = "npx"
args = ["-y", "google-search-console-mcp"]

[mcp_servers.google-search-console.env]
GSC_SERVICE_ACCOUNT_KEY_FILE = "/path/to/key.json"
GSC_SITE_URL = "sc-domain:example.com"
```

### Docker

```sh
docker run --rm -i \
  -v /path/to/key.json:/key.json:ro \
  -e GSC_SERVICE_ACCOUNT_KEY_FILE=/key.json \
  -e GSC_SITE_URL=sc-domain:example.com \
  ghcr.io/ni-c/google-search-console-mcp
```

## Tools

`site_url` is optional on every tool that takes it when `GSC_SITE_URL` is set.

### Properties and ownership

| Tool                     | What it does                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `setup_site`             | Reports which of the four setup steps a property is missing, with the DNS record or meta tag to place. Changes nothing |
| `list_sites`             | Every property this credential can see, with its permission level                                                      |
| `get_site`               | One property — the way to settle which of the two spellings exists                                                     |
| `add_site`               | Adds a property. Does **not** verify ownership                                                                         |
| `delete_site`            | Removes a property and its history. Two-step                                                                           |
| `list_verified_sites`    | Sites this credential has proven ownership of, with all owners                                                         |
| `get_verified_site`      | One of them by its opaque resource id                                                                                  |
| `get_verification_token` | The token, and exactly where to put it. Claims nothing                                                                 |
| `verify_site`            | Checks for the placed token and records ownership                                                                      |
| `unverify_site`          | Gives up ownership. Two-step                                                                                           |
| `update_site_owners`     | Replaces the owner list. `method: "patch"` uses PATCH, which behaves identically                                       |

### Sitemaps

| Tool              | What it does                                                   |
| ----------------- | -------------------------------------------------------------- |
| `list_sitemaps`   | Submitted sitemaps, with download times, URL counts and errors |
| `get_sitemap`     | One sitemap — where a submission's errors actually appear      |
| `submit_sitemap`  | Submits or refreshes one. There is no separate update call     |
| `submit_sitemaps` | Up to 50 in one call, with per-entry results                   |
| `delete_sitemap`  | Removes one. Two-step                                          |

### Search analytics and indexing

| Tool                     | What it does                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `query_search_analytics` | The Performance report: clicks, impressions, CTR and position by any dimensions, with filters and relative periods |
| `inspect_url`            | What Google knows about one URL — index status, canonicals, crawl time, rich results                               |
| `inspect_urls`           | Up to 20 URLs, condensed to verdicts                                                                               |
| `get_indexing_status`    | Indexing API notification history for a URL                                                                        |
| `request_indexing`       | Notifies Google a URL changed. Only acts on JobPosting and BroadcastEvent pages                                    |

## Not exposed, on purpose

`urlTestingTools.mobileFriendlyTest` is still in Google's discovery document and
the service behind it was switched off in December 2023. A tool for it could only
ever return an error, so there is not one.

## Safety

**Three operations are two-step.** `delete_site`, `delete_sitemap` and
`unverify_site` refuse the first call and return a short-lived token bound to
those exact arguments; the second call performs the operation. A confirmation
issued for one property cannot be replayed against another, and the token only
ever appears in a previous tool result, so a model cannot invent it.

**Everything from the APIs is marked untrusted.** Search queries are strings the
public typed into Google; page titles and crawl diagnostics come from whoever
runs the crawled site. Someone who wants a model to act on their instructions can
put them in a page title and wait to be crawled.

**Read-only goes below the tool layer.** `GSC_READ_ONLY=true` does not register
the write tools _and_ requests `webmasters.readonly` instead of `webmasters`, so
a write is impossible even if a tool tried.

**Credentials never leak into output.** They are deleted from the environment
after start-up, never sent to a redirect target, and a rejected value is
described rather than echoed — including when it is a key pasted into
`GSC_ALLOW_TOOLS` by mistake.

## Development

```sh
npm install
npm test            # no network — every test runs against a stubbed fetch
npm run lint
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Releasing

Update `CHANGELOG.md`, bump the version in `package.json` and `server.json`, then
push a signed tag:

```sh
git tag -s v0.1.0 -m 'v0.1.0' && git push origin main v0.1.0
```

`release.yml` runs the suite, publishes to npm with provenance through a trusted
publisher, pushes the multi-arch image to GHCR and updates the MCP registry entry.
