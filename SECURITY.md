# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/google-search-console-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, keys, property names or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

The credential this server runs on decides everything it can reach, and the three
kinds differ enormously in blast radius:

- A **service account key** is the narrow option and the recommended one. It sees
  only the properties somebody explicitly added it to, and it is revocable on its
  own without touching a person's account. The private key in that JSON file is
  the whole credential — anyone holding it is that service account.
- An **OAuth2 refresh token** acts as the human who consented. It sees every
  property that person can see, in every Search Console account, and its scopes
  were fixed at consent time and cannot be narrowed afterwards.
- **Application default credentials** are whatever the machine happens to be
  logged into, which on a developer workstation is usually the widest of the
  three. This server never falls back to them silently: a half-configured OAuth
  triple is a startup error, precisely so a typo cannot quietly promote the
  server to a person's own account.

Four things are worth naming explicitly, because none is obvious from the APIs:

- **Search queries are attacker-influenced text.** They are strings arbitrary
  members of the public typed into Google, and this server hands them to a model
  verbatim. Page titles, canonical URLs and crawl diagnostics come from whoever
  runs the crawled site. Every result that carries an upstream payload is marked
  as untrusted content. A confirmation prompt's two sentences — what will happen
  and what it costs — are built only from values this server derived; where an
  operation cannot be described without naming its subject, the subject is quoted
  below them as data, flattened to a single line so it cannot open one of its own.
- **Deleting a property destroys sixteen months of history.** Search Console
  retains roughly that much performance data per property, `sites.delete` discards
  all of it, and re-adding the property starts an empty history. Google offers no
  undo and neither does this server — which is why the call is two-step.
- **Losing verification is worse than losing a property.** `unverify_site` drops
  the credential to `siteUnverifiedUser` on every property for that site, so every
  data call starts returning 403 and the Indexing API stops working entirely.
  Regaining it means placing a token in DNS again.
- **The Indexing API succeeds without doing anything.** It accepts a notification
  for any URL the credential owns and only acts on JobPosting and BroadcastEvent
  pages. That is not a vulnerability, but it is a result that means less than it
  says, and every tool description here repeats it.

Scopes are requested according to the tools that are actually registered, so
narrowing the tool list narrows what the credential is used for — see
`scopesFor` in `src/auth.ts`. `GSC_READ_ONLY=true` additionally requests
`webmasters.readonly` instead of `webmasters`, which makes writing impossible
below the tool layer rather than only above it.

`GSC_ALLOWED_SITES` exists for the case where one credential can see properties
belonging to different parts of your life. Most tools name a property and are
checked in `resolveSite`. Two groups do not name one, and each has its own check
rather than an exemption:

- the Indexing API tools take a _page_, so `assertUrlAllowed` matches the URL
  against the list the way Search Console scopes a property — a domain property
  covers its subdomains, a URL-prefix property covers a path-segment prefix only
- the three verification tools take an opaque resource id, so the resource is
  fetched first and its own site block is mapped back to a property

`list_sites` and `list_verified_sites` filter their results to the allowlist and
say how many entries they withheld. That is not decoration: the ids returned by
`list_verified_sites` are exactly what `unverify_site` and `update_site_owners`
act on.

There is no SSRF guard in this server, unlike its siblings, because there is
nothing to guard: no target host is configurable, and every request goes to one of
three hard-coded Google endpoints. Redirects are still refused, so a redirect away
from Google cannot carry the access token with it.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at a property whose data you would not put in a model's context.

The four operations that cannot be undone — `delete_site`, `delete_sitemap`,
`unverify_site` and `update_site_owners` — **ask a person** through MCP
elicitation: a dialog raised by the server and shown by the client, which the
model cannot answer on its behalf, and which nothing proceeds without. Where the
client cannot show a dialog they fall back to a server-generated token bound to
the exact arguments, which proves the call was made twice with the same arguments
and nothing more; the fallback text says so. `ELICITATION=false` moves a capable
client onto that fallback deliberately, and the server prints one line at startup
saying it is off.
`update_site_owners` belongs in that list despite reading like an update: the
list it takes is the complete owner list afterwards, so one well-formed call
removes everyone else and nothing here can put them back.

### What a confirmation proves, and what it does not

A confirmation binds an answer to an operation. The sealed request state carries
the resource key — `orderedResourceKey` from `mcp-approval`, which fingerprints
the tool name and the exact targets _in order_ — so an answer cannot be moved
from the question it was given to a different one: a confirmation for
`delete_site` on one property cannot authorise it on another, and a token issued
for one sitemap does not remove a different one, or the same pair with the roles
swapped. The two-call `confirm_token` fallback is bound the same way.

A sealed state also proves **freshness**, since `mcp-approval` 0.8.1: "this
answer belongs to this question" and "this answer has not been used already" are
different properties, and the seal alone gives only the first. Each state carries
a nonce, spent the first time an answer arrives with it — accepted or declined —
so the same state presented again counts as no answer and produces a fresh
question. That matters because this server speaks both protocol revisions:
`serveStdio` in `src/index.ts` negotiates `2025-11-25`, where the SDK bridges the
dialog inside the same `tools/call` and the state never reaches the caller, and
`2026-07-28`, where the call returns `input_required` and the client retries
carrying the state and the answer. On the second the state is an artefact the
caller holds, and without the nonce it could be presented again for as long as it
lived. The token fallback is single-use by construction: a matching token is spent
as it is checked.

What remains is the shape both records share: they live in the process. A stdio
server is spawned per session, so that is the flow's lifetime — but a restart
between the two halves of a dialog forgets what was spent, and a state minted
before it opens as if unseen, until it expires.

The sentence a person reads is built only from values this server derived, and
"derived" is checked, not assumed: a domain property is held to what a hostname
can be — no whitespace, no control character, no credentials, no port — before
it can name the target of a dialog, whether it came from the caller or from a
verification resource Google returned.

## What Google sends, and what answers in its place

Every request goes to Google, but what answers is whatever sits on the path: a
corporate proxy that inspects TLS, a captive portal, an outbound filter. The
code assumes nothing about the shape of a response beyond what it checks:

- **The status is decided before the body is read.** An error body is read under
  its own small ceiling and cut, never refused, so a `429` or a `503` with a large
  body is still the status it is — retried where a retry is safe, and explained
  by the hint for that status. A success body is read under the ceiling for its
  endpoint: one megabyte for a record, eight for a URL inspection, sixty-four for
  a search analytics query, whose size the caller chose through `row_limit`.
- **Every field an output schema types is held to that type at the boundary.** A
  row that is not an object is dropped, a key that is not a string is written out
  as one, a metric that is not a finite number is left out, a site block that is
  `null` is not a site, and an empty `200` is an empty record. None of them takes
  the listing they appear in down; the schema is never what refuses an answer.
- **Text is cleaned on the way out.** Control characters are stripped and lone
  surrogates repaired in both channels, and a key of `__proto__` in Google's JSON
  stays an own property. Text quoted from an error body is labelled as somebody
  else's, stripped and cut; a `content-type` header is cut too.
- **The access token is checked before it becomes a header.** A token the
  runtime would refuse is reported as no token, never quoted.

## Budgets

A tool result is capped at 100 kB in _each_ channel: list results drop whole
entries and say how many, a single oversized object has its largest fields
shortened at any depth, and `query_search_analytics` carries in its structured
half exactly the rows its table shows, with a `truncated` block naming the next
`start_row`. The shortener remembers where it cut by identity, not by the shape
of the value, so a string that happens to end in the shortening note is
shortened like any other.

Caller strings have ceilings — 2 048 characters for a property, a URL or a
resource id, 254 for an owner address, 35 for a language tag — and what is
rejected is described, not echoed. A batch tool (`submit_sitemaps`,
`inspect_urls`) works under a wall-clock budget of two minutes per call, checked
before each request, and says how far it got when the budget runs out.

Every diagnostic the server prints describes a rejected configuration value
rather than quoting it, unless the value is short and shaped like a setting: the
variables next to the key in a compose file are exactly where a key ends up by
mistake.
