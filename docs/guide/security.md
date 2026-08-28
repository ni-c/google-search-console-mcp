# Security

## What the credential can do

The blast radius depends entirely on which kind you use, and the three differ
enormously:

| Credential | Sees |
| --- | --- |
| Service account | Only the properties it was explicitly added to. Revocable on its own |
| OAuth2 refresh token | Everything the consenting person sees, in every account. Scopes fixed at consent |
| Application default | Whatever the machine is logged into — usually the widest |

The service account is the recommended one for exactly this reason. Nothing about
this server makes an OAuth token safer than the account behind it.

## Scopes follow the tools

The OAuth scopes requested at startup are derived from the tools that are
actually registered — see `scopesFor` in `src/auth.ts`. Denying the Indexing
tools means the Indexing scope is never requested.

`GSC_READ_ONLY=true` additionally swaps `webmasters` for `webmasters.readonly`,
which makes writing impossible below the tool layer rather than only above it.

The one gap worth naming: Site Verification has no read-only scope. Google's
`siteverification.verify_only` is write-only and cannot list, so the read tools
there need the full scope. That is a limit of Google's scope design, not an
oversight here.

## Irreversible operations are two-step

Three tools refuse their first call and return a short-lived token bound to those
exact arguments:

| Tool | What it costs |
| --- | --- |
| `delete_site` | Roughly 16 months of performance history, discarded. Re-adding starts empty |
| `unverify_site` | Owner access to the site; every property for it drops to 403, and the Indexing API stops working |
| `delete_sitemap` | Submission history and error report. The least severe of the three — `submit_sitemap` puts it back |

A plain boolean `confirm` parameter would not do. The model could set it on the
first call, or be talked into it by instructions hidden in upstream content — and
this server hands the model plenty of that. A random token that only ever appears
in a *previous* tool result cannot be guessed.

The token is bound to a resource key, so a confirmation issued for one property
cannot be replayed against another, and it is single-use.

## Untrusted content

Everything the APIs return is marked as untrusted, and "it is only search data"
is exactly the wrong intuition:

- **Search queries** are strings arbitrary members of the public typed into
  Google, handed to a model verbatim.
- **Page titles, canonical URLs and crawl diagnostics** come from whoever runs
  the crawled site.

Someone who wants a model to act on their instructions can put them in a page
title and wait to be crawled. Confirmation prompts therefore never quote anything
that came from an API — no property label, no page title, nothing.

## Credentials never reach the output

- Deleted from the environment after start-up, so they are not visible to child
  processes or in `/proc/<pid>/environ`.
- `redirect: 'error'` on every request: a redirect away from Google cannot carry
  the access token with it.
- A rejected value is described rather than echoed. `GSC_REFRESH_TOKEN` and
  `GSC_ALLOW_TOOLS` are adjacent lines in every compose file, and a paste into
  the wrong one must not print the secret into the client's log.
- The startup line names *which kind* of credential is in use, never the value.

## No SSRF guard, on purpose

The sibling servers in this family all carry a `hosts.ts` that refuses loopback,
link-local and cloud-metadata addresses. This one does not, and that is a
decision rather than an omission: no target host is configurable here. Every
request goes to one of three hard-coded Google endpoints, so there is no
attacker-controlled destination to guard against.

## Budgets

A tool result is capped at 100 kB. List results drop **whole entries** rather
than slicing the JSON — a truncated document is not a smaller answer, it is an
unparseable one — and say how many were dropped and how to narrow the request. A
single oversized object has its longest text fields shortened, each marked, so
the structure survives.

The budget counts bytes, not characters. Search queries are the most multilingual
free text there is, and a character budget would let through three times what it
promises.

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/ni-c/google-search-console-mcp/security/advisories/new),
never a public issue, and do not include real credentials or property names.
