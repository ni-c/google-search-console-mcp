# FAQ and troubleshooting

## One tool I expected is missing

Almost always the tool filter rather than a bug. Check `GSC_ALLOW_TOOLS`,
`GSC_DENY_TOOLS` and `GSC_READ_ONLY` — a filtered tool is removed outright, so a
call to it answers exactly as an unknown name would, which is indistinguishable
from "this server never had it".

`GSC_READ_ONLY=true` removes all nine write tools.
`GSC_ALLOW_TOOLS=essential` leaves only five.

See [choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

The other possibility is that Google has no such method. `mobileFriendlyTest` is
the one people look for: it is still in Google's discovery document and the
service behind it was switched off in December 2023, so a tool for it could only
ever return an error.

## Everything returns 403 and the credential is right

403 covers four unrelated causes here, and the reason is in the error body rather
than the status. The server reads it and says which:

- **The API is not enabled** in the Cloud project. Search Console, Site
  Verification and Indexing are three separate switches. This is the most common
  first failure and the one that reads least like itself — "permission denied"
  sends people to Search Console's user list when the problem is a Cloud project
  they did not know they had.
- **The identity has no access to the property.** `list_sites` shows exactly
  which properties it can see; an empty list means none, which is the normal
  state of a fresh service account.
- **The token lacks the scope.** For an OAuth refresh token the scopes were fixed
  at consent and it has to be re-issued.
- **The Indexing API wants ownership**, not user access. Full user is not enough.

## A property I can see in the web interface answers 404

The spelling is exact and there are two kinds:

- `sc-domain:example.com` — a domain property
- `https://example.com/` — a URL-prefix property, **trailing slash required**

They are different properties with different data. `https://example.com` without
the slash is not a lenient spelling of the second one; it is nothing, and Google
answers 403. This server adds the slash for you, and refuses a bare `example.com`
rather than guessing which of the two you meant.

`list_sites` shows the spellings your credential can actually use.

## The property exists but every data call fails

Look at its `permissionLevel`. If it says `siteUnverifiedUser`, the property was
added without ownership ever being proven — which `sites.add` allows, silently.

`setup_site` reports this and hands over the verification token to place.

## An analytics query returns nothing

Three usual causes, in order of likelihood:

1. **The range is too recent.** Data is finalised two to three days behind. The
   default `dataState: "FINAL"` omits the incomplete days; `"ALL"` includes them.
2. **The `hour` dimension without `dataState: "HOURLY_ALL"`.** Google returns an
   empty result and no error for that combination — indistinguishable from a
   property with no traffic. This server refuses it up front instead.
3. **The property genuinely has no impressions** for that range and filter.

## The totals do not match Search Console's interface

If the query includes the `query` dimension, they will not, and neither is wrong.
Google withholds queries too rare to be anonymous, and the omitted rows still
happened — commonly a third or more of all impressions. Every totals line this
server prints says so.

Query *without* the query dimension for a true property total.

## Why is the average position different from what I calculated?

Because it is weighted by impressions, and an unweighted average of the position
column is not a meaningful number. A thousand rare queries ranking 80th would drag
a property whose real average is 12 up into the nineties.

CTR is computed the same way, from total clicks over total impressions rather
than by averaging the row CTRs.

## `request_indexing` said it worked and nothing happened

That is the documented behaviour. The Indexing API accepts a notification for any
URL the credential owns and only *acts* on pages carrying JobPosting or
BroadcastEvent structured data. For anything else it returns 200 with a timestamp
and does nothing.

There is no API that makes Google crawl an ordinary page sooner. Submit a
sitemap and wait.

## How do I refresh a sitemap Google already has?

Submit the same URL again — `submit_sitemap` is a `PUT` of an address, so
submitting is updating. There is no separate update call, and the
`google.com/ping?sitemap=` endpoint that used to nudge Google along was removed
in June 2023 with no replacement.

Google re-fetches on its own schedule; nothing can force it.

## `verify_site` fails right after I created the DNS record

Expected, and worth one retry later. DNS records take minutes to an hour to
propagate, and a freshly uploaded verification file may still be behind a CDN
cache. A failure here is almost always "not there yet" rather than "wrong".

## Can I use this against a property behind a Google Workspace policy?

Yes, with a service account under domain-wide delegation — and that is exactly
why the requested scopes follow the registered tools. A Workspace administrator
allowlists specific scopes, and asking for one that was not delegated fails the
whole token request. Narrow the tool list to what you were granted.
