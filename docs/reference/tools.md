# Tools

Twenty-one tools across three Google APIs. Twelve read, nine write; `site_url` is
optional on every tool that takes it when
[`GSC_SITE_URL`](/reference/environment#properties) is set.

Which of them load is configurable — see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).
The five marked ★ are the `essential` preset.

Tools marked 👤 **ask a person** before they act, through MCP elicitation — a
dialog the model cannot answer on its behalf. Where the client cannot show one
they fall back to a two-call `confirm_token`, and `ELICITATION=false` takes that
fallback deliberately. See [Asking a person](/guide/approval).

Every tool declares an `outputSchema` and answers with `structuredContent`
beside the text block, so a client can use a result without parsing prose. Every
tool that reports Google's data carries `untrusted: true` and
`source: "search-console"` as fields of that object — a search query is a string
a member of the public typed into Google. Six tools are without the marker,
because their answer is a property this server was given and a fact it
established.

Every tool declares all four MCP annotations — `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`.

## Setting a property up

### `setup_site` ★ read

Reports where a property stands and what to do next, including the exact DNS
record or meta tag to place. Changes nothing.

It exists because getting a working property takes four steps in one order —
obtain a token, place it, `verify_site`, `add_site` — and **nothing in either API
enforces that order**. `add_site` on an unverified domain succeeds and leaves a
property that appears in every listing and answers 403 for every piece of data,
which looks like a permissions bug and is not.

| Argument | |
| --- | --- |
| `site_url` | The property |

The four states it reports: ready, needs the property, needs verification, needs
both.

### `get_verification_token` read

Returns the token that proves ownership, and where to put it. Nothing is created
and nothing is claimed — running it against a domain you do not own achieves
exactly nothing, which is why it is a read tool despite being an HTTP POST.

| Argument | |
| --- | --- |
| `site_url` | The property |
| `method` | `DNS`, `FILE` or `META`. Defaults to DNS for a domain property, META for a URL prefix |

A domain property can only be proven by DNS — the claim covers every host under
the name, so there is no single page to put a tag on. `ANALYTICS` and
`TAG_MANAGER` prove ownership through an existing Google product rather than a
token, so they have nothing to fetch here and are only usable with `verify_site`.

The output is the record, not just the string: for DNS it names the **apex**,
which is where people go wrong — `_google-site-verification` is the name they
reach for by analogy with DMARC and SPF, and it is not it.

### `verify_site` write

Tells Google to look for the placed token and, if it finds it, records this
credential as an owner.

| Argument | |
| --- | --- |
| `site_url` | The property |
| `method` | `DNS`, `FILE`, `META`, `ANALYTICS` or `TAG_MANAGER` |

A failure is almost always "not there yet": DNS takes minutes to an hour, and a
fresh file may be behind a CDN cache. Retry later.

### `unverify_site` 👤 write

Gives up verified ownership. Every property for the site drops to
`siteUnverifiedUser` and starts returning 403, and the Indexing API stops working
entirely. Google also refuses to remove a site's last owner.

| Argument | |
| --- | --- |
| `id` | The verification resource id, from `list_verified_sites` |
| `confirm_token` | Only on the fallback path — from this tool's first refusal |

### `update_site_owners` 👤 write

Replaces the owner list. This is how a second person or a service account is
granted ownership without placing a token of their own — and, with the wrong
list, how everybody else stops being an owner. Google's only safety net is that
it refuses to leave a site with no owner at all.

| Argument | |
| --- | --- |
| `id` | The verification resource id |
| `owners` | The **complete** list afterwards. Everyone not in it loses ownership |
| `method` | `update` (PUT, default) or `patch`. Both replace the list; the API offers both and they behave identically |
| `confirm_token` | Only on the fallback path — from this tool's first refusal |

Call `get_verified_site` first and send back the existing addresses plus the new
one. An empty list is refused — that is the shape of an accidental wipe.

### `list_verified_sites` / `get_verified_site` read

Sites this credential has proven ownership of, with all owners. A different list
from `list_sites`: that one is Search Console properties, this one is proven
ownership, and a site can be in either without the other.

## Properties

### `list_sites` ★ read

Every property this credential can see, with its permission level. The first call
to make when anything returns 403 — an empty list means the identity was never
added to any property.

`permissionLevel` is `siteOwner`, `siteFullUser`, `siteRestrictedUser`, or
`siteUnverifiedUser` — which means listed but never verified, and every data call
for it returns 403.

### `get_site` ★ read

One property and this credential's permission on it. The way to settle which of
the two spellings exists.

### `add_site` write

Adds a property. Does **not** verify ownership: unless the credential already
owns the domain, the property lands as `siteUnverifiedUser`. Use `setup_site`.

This is the one tool that does not fall back to `GSC_SITE_URL` — the default
names the property you already work with, and this argument names one that does
not exist yet.

### `delete_site` 👤 write

Removes a property. Search Console retains roughly 16 months of performance data
per property and this discards all of it; re-adding starts an empty history.
Ownership verification is unaffected.

## Sitemaps

### `list_sitemaps` ★ read

Submitted sitemaps with download times, per-content-type URL counts, warnings and
errors.

| Argument | |
| --- | --- |
| `site_url` | The property |
| `sitemap_index` | Restrict to the children of this sitemap index |

Without `sitemap_index` you get only sitemaps submitted **directly** — the
children of a submitted index are not listed, so a site that submitted one index
and nothing else looks like it has no sitemaps.

### `get_sitemap` read

The full record for one sitemap. This is where a submission's errors appear —
never in the response to `submit_sitemap`.

### `submit_sitemap` write

Submits a sitemap URL, or refreshes one Google already knows. There is no
separate update call: submitting is a `PUT` of an address, so doing it again *is*
updating. The old `ping` endpoint was removed in June 2023 with no replacement.

Success means Google accepted the address, not that the sitemap is valid — it is
fetched later, and parse errors show up in `get_sitemap` minutes to hours
afterwards.

### `submit_sitemaps` write

Up to 50 sitemaps for one property in a single call, with per-entry results. The
API has no batch method; this makes the calls one after another and one failure
does not stop the rest.

### `delete_sitemap` 👤 write

Removes a sitemap. Google stops using it for discovery and the submission history
is discarded; the file itself is untouched and `submit_sitemap` puts it back.
The least severe of the four guarded operations.

## Search analytics

### `query_search_analytics` ★ read

The whole Performance report: clicks, impressions, CTR and average position by
any combination of dimensions.

| Argument | |
| --- | --- |
| `site_url` | The property |
| `period` | `today`, `yesterday`, `last7days`, `last14days`, `last28days`, `last3months`, `last6months`, `last12months`, `last16months` |
| `start_date` / `end_date` | `YYYY-MM-DD`. Alternative to `period`, not combinable with it |
| `dimensions` | `date`, `query`, `page`, `country`, `device`, `searchAppearance`, `hour` |
| `type` | `WEB` (default), `IMAGE`, `VIDEO`, `NEWS`, `DISCOVER`, `GOOGLE_NEWS` |
| `data_state` | `FINAL` (default), `ALL`, `HOURLY_ALL` |
| `aggregation_type` | `AUTO` (default), `BY_PROPERTY`, `BY_PAGE`, `BY_NEWS_SHOWCASE_PANEL` |
| `filters` | `{dimension, operator, expression}`; operator defaults to `EQUALS` |
| `filter_type` | `and` (default) or `or` |
| `row_limit` | 1–25 000, **default 100** |
| `start_row` | Zero-based offset for paging |

Four things worth knowing:

- **`period` resolves against today in Pacific Time**, which is the time zone
  Search Console counts days in. A range computed in UTC asks for a day Google
  has no data for.
- **`hour` requires `data_state: "HOURLY_ALL"`.** Any other combination returns
  an empty result and no error, so this server refuses it up front.
- **The default `row_limit` is 100, not the API's maximum.** Raising it is the
  fastest way to fill a context window with near-identical rows; page with
  `start_row` instead.
- **With the `query` dimension the rows do not sum to the property total.**
  Google withholds rare queries for anonymity, commonly a third or more of all
  impressions. The result says so.

The output is a table with a totals line. CTR is total clicks over total
impressions, and average position is weighted by impressions — an unweighted
average of that column is not a meaningful number.

## URL inspection and indexing

### `inspect_url` ★ read

What Google knows about one URL: index verdict, coverage state, last crawl,
robots.txt state, the canonical Google chose versus the one declared, mobile
usability, and rich-result problems.

It reports the **indexed** state, not a live fetch — a page fixed an hour ago
still shows what Google last saw.

Quota: 2 000 calls per property per day, 600 per minute. That is a daily budget,
not a rate limit you can wait out.

### `inspect_urls` read

Up to 20 URLs in one call, condensed to the verdict fields. Stops early on a 429,
because the day's quota being gone means every remaining call would fail
identically.

Twenty rather than the fifty `submit_sitemaps` allows, precisely because of that
daily budget.

### `get_indexing_status` read

When this credential last notified Google about a URL through the Indexing API,
and what kind of notification. Notification history only — it says nothing about
whether the page is indexed. `inspect_url` answers that.

### `request_indexing` write

Notifies Google that a URL was updated or removed.

| Argument | |
| --- | --- |
| `url` | The URL that changed |
| `type` | `URL_UPDATED` (default) or `URL_DELETED` |

**Google only acts on this for JobPosting and BroadcastEvent pages.** For any
other page the call succeeds, returns a timestamp, and changes nothing. It is not
a way to get an ordinary page crawled sooner.

Requires the credential to be a verified **owner** — user access is not enough,
and the API answers 403 without saying which of the two is missing.
`URL_DELETED` requires the page to actually return 404 or 410; Google checks.
