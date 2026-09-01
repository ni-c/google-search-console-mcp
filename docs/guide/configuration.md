# Configuration

Every setting is an environment variable. The full table is in the
[environment reference](/reference/environment); this page is about the choices
behind them.

## The credential

Three kinds, tried in this order — explicit beats ambient:

1. `GSC_SERVICE_ACCOUNT_KEY` or `GSC_SERVICE_ACCOUNT_KEY_FILE`
2. `GSC_CLIENT_ID` + `GSC_CLIENT_SECRET` + `GSC_REFRESH_TOKEN`
3. `GOOGLE_APPLICATION_CREDENTIALS`, or a `gcloud` login

A **partial** OAuth triple is a startup error rather than a reason to fall
through to the third. That fallback is the dangerous one: a typo in
`GSC_CLIENT_ID` would otherwise leave the server quietly acting as whatever
account the machine is logged into, which on a developer workstation is usually
someone with access to everything.

`GSC_SERVICE_ACCOUNT_KEY` accepts raw JSON or base64-encoded JSON. Both spellings
are needed in practice — a key pasted into a shell profile keeps its braces and
newlines, while anything that travels through a CI secret store or a Kubernetes
secret arrives encoded.

If you paste an OAuth *client secrets* file where the service account key belongs
— they are both JSON from the same console page — the server says so by name
rather than failing later inside the signing code.

## The default property

`GSC_SITE_URL` makes `site_url` optional on every tool that takes one. That is
not only convenience: a property the model never spells out is a property it
cannot misspell into a different one, and the two spellings for a site hold
different data.

`add_site` is the one exception and deliberately does **not** use the default.
The default names the property you already work with; that argument names one
that does not exist yet, and silently re-adding the default is never what was
meant.

## Restricting which properties are reachable

`GSC_ALLOWED_SITES` takes a comma-separated list, and anything not in it is
refused before a request goes out. It exists for the case where one Google
account can see properties belonging to different parts of your life — work and
personal, or several clients.

Most tools name a property, and for those the check sits in `resolveSite`. Two
shapes of tool do not name one, and each is checked separately rather than being
exempt:

- the **Indexing API** tools take a page URL. It is matched against the list the
  way Search Console scopes a property: `sc-domain:example.com` covers every
  subdomain, and `https://example.com/shop` covers `…/shop/item` but not
  `…/shopping`.
- the **verification** tools take an opaque resource id, which says nothing about
  the property it belongs to. The resource is fetched first and its own site
  block mapped back to a property.

`list_sites` and `list_verified_sites` also filter to the allowlist and report
how many entries they withheld — a property listed but refused by every other
tool is a name disclosed for nothing, and the ids from `list_verified_sites` are
exactly what `unverify_site` acts on.

## Read-only mode

`GSC_READ_ONLY=true` does two things, and the second is the one that matters:

- the nine write tools are never registered, so they are not in `tools/list` and
  a call to one is answered exactly as an unknown name would be;
- the server requests the `webmasters.readonly` scope instead of `webmasters`, so
  a write is impossible below the tool layer rather than only above it.

It does not narrow the Site Verification scope, because Google does not offer a
read-only one — `siteverification.verify_only` is write-only and cannot list. If
that matters, deny the verification tools as well and the scope goes away with
them.

## Turning the approval dialog off

`delete_site`, `delete_sitemap`, `unverify_site` and `update_site_owners` ask a
person through MCP elicitation before they act. `ELICITATION=false` takes them to
the two-call token instead. It does not remove the guard; there is no setting in
which a guarded call goes unannounced.

The variable deliberately carries no `GSC_` prefix, which means it reaches every
MCP server in the same environment, and — unlike `GSC_READ_ONLY` — a value it does
not recognise **stops the server** rather than failing off. See
[Asking a person](/guide/approval).

## Choosing the tools that load

Twenty-one tools is a lot to put in front of a model that needs three of them.
Every visible tool costs context on every request, and a model picks the right
one far more reliably from a handful.

```sh
GSC_ALLOW_TOOLS=essential            # the curated five
GSC_ALLOW_TOOLS='list_*,get_site'    # exact names, or a prefix with one *
GSC_DENY_TOOLS='delete_*'            # subtracted from whatever allow left
```

Allow decides what is in; deny is subtracted from it. A pattern is a literal
prefix plus exactly one trailing `*` — `*_sites` and `list_*_x` are rejected
outright, because they look plausible, match nothing, and would otherwise be
silent forever.

`essential` is `list_sites`, `get_site`, `list_sitemaps`,
`query_search_analytics` and `inspect_url`. All five read; it is the preset for
letting a model look at a property without being able to change it.

**An entry that matches no tool stops the server**, naming the entry and listing
the real names. An ignored typo would leave a tool missing from `tools/list` with
nothing pointing at the cause, and nobody traces an absence back to an
environment variable.

Naming a write tool while `GSC_READ_ONLY` is set is also an error, and says so —
"unknown tool" would be the one answer that is wrong, since the tool exists and
read-only is why it is not there.

### It narrows the credential too

The OAuth scopes this server requests are derived from the tools that are
actually registered, not hard-coded. A server denied the Indexing tools never
asks Google for the Indexing scope.

That is more than tidiness. For a service account under domain-wide delegation
the scopes are allowlisted by a Workspace administrator, and asking for one that
was not delegated fails the **whole** token request with `unauthorized_client` —
so a server that always asked for all three would be unusable for someone granted
only Search Console.
