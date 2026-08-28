# What is google-search-console-mcp?

An MCP server for [Google Search Console](https://search.google.com/search-console/about),
the service that tells you how Google sees your site — which queries brought
people to it, which pages are indexed, and what it made of your sitemaps.

It covers three Google APIs, because Search Console alone is not enough to set a
property up: [Search Console v1][sc] for properties, sitemaps, analytics and URL
inspection, [Site Verification v1][sv] for proving ownership, and the
[Indexing API v3][idx] for change notifications.

## Why

Search Console's web interface is fine for looking. It is a poor place to *do*
anything repetitive: adding a property means clicking through a verification
wizard, submitting forty sitemaps means submitting them forty times, and
answering "which of these two hundred pages is not indexed" means inspecting them
one at a time.

Those are exactly the jobs an MCP client is good at — and the ones where getting
the details wrong is easy and invisible. A property spelled `https://example.com`
instead of `https://example.com/` is a different property that answers 403. A
seven-day range computed in UTC covers six days of data. A totals row averaged
across query CTRs is off by an order of magnitude. This server gets those right
so the conversation above it does not have to.

## What it will not do

- **Make Google crawl something.** Nothing can. `request_indexing` exists because
  the API does, and it only has an effect on JobPosting and BroadcastEvent pages;
  every description involving it says so.
- **Report live page state.** `inspect_url` returns what Google last indexed, not
  a fresh fetch. A page fixed an hour ago still shows the old verdict.
- **Place a verification token for you.** Creating a DNS record or editing a
  template is a human step by design. `setup_site` gets you the exact record to
  paste and picks up again afterwards.
- **Show you today's numbers.** Search Console finalises data two to three days
  behind. `dataState: "ALL"` includes the incomplete recent days; nothing
  includes the missing ones.

## What it is careful about

Three operations cannot be undone and are two-step, requiring a token that only
ever appears in a previous tool result: removing a property (which discards
roughly sixteen months of history Google will not give back), removing a sitemap,
and giving up ownership.

Everything the APIs return is marked as untrusted content. Search queries are
strings the public typed into Google; page titles and crawl diagnostics come from
whoever runs the crawled site.

And the OAuth scopes follow the tools: narrowing the tool list narrows what the
credential is used for. See [Security](/guide/security).

[sc]: https://developers.google.com/webmaster-tools/v1/api_reference_index
[sv]: https://developers.google.com/site-verification/v1
[idx]: https://developers.google.com/search/apis/indexing-api/v3/quickstart
