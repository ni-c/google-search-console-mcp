# Getting started

## Requirements

- Node.js 22 or newer, or Docker
- A Google Cloud project — free, and you may already have one
- A property in Search Console, or the ability to edit DNS for a domain you own

## Enable the APIs

This is the step everybody skips, and skipping it produces a 403 that reads as a
permission problem. In the [Google Cloud console](https://console.cloud.google.com/apis/library),
enable the ones you need — they are three separate switches:

| API | Needed for |
| --- | --- |
| Google Search Console API | Everything except ownership and indexing |
| Site Verification API | `verify_site`, `get_verification_token`, `setup_site` |
| Indexing API | `request_indexing`, `get_indexing_status` |

If you only want to read analytics, the first one is enough.

## Get a credential

A **service account** is the recommended option. It sees only the properties you
add it to, and deleting its key does not touch your own Google account.

1. In the Cloud console, create a service account and download a JSON key.
2. Note its `client_email` — it looks like
   `something@project.iam.gserviceaccount.com`.
3. In Search Console, under Settings → Users and permissions, add that address.
   **Owner** if you want the Indexing API; **Full** is enough for everything else.

For a property that does not exist yet, skip step 3 — `setup_site` will walk you
through giving the service account ownership instead.

## Configure it

```sh
export GSC_SERVICE_ACCOUNT_KEY_FILE=~/keys/gsc.json
export GSC_SITE_URL=sc-domain:example.com     # optional, defaults site_url
```

The property spelling matters and is not guessed for you:

- `sc-domain:example.com` — a **domain property**, covering every scheme,
  subdomain and port.
- `https://example.com/` — a **URL-prefix property**, covering exactly that
  prefix. The trailing slash is required.

They are different properties holding different data, so `example.com` on its own
is refused rather than resolved to one of them.

## Run it

```sh
npx -y google-search-console-mcp
```

It starts even with no credential at all and lists its tools; every call then
fails with setup instructions. That is deliberate, so registries and sandbox
inspectors can introspect it.

## Check that it works

`list_sites` is the first call to make. It answers three questions at once:
whether the credential works, which properties it can see, and what it may do
with each.

An empty list is not an error — it is the normal state of a fresh service account
nobody has granted anything to yet. A property listed as `siteUnverifiedUser` is
listed but not verified, and every data call for it will return 403.

## Set up a property

```
setup_site with site_url "sc-domain:example.com"
```

It reports which of the four steps is missing and hands over the exact DNS record
to create. Place it, then call `verify_site`, then `add_site`. The order matters:
`add_site` on an unverified domain succeeds and leaves a property that answers
403 for everything.

## Submit a sitemap

```
submit_sitemap with feedpath "https://example.com/sitemap.xml"
```

Success means Google accepted the address, not that the file is valid — it is
fetched later. `get_sitemap` a few minutes afterwards shows `lastDownloaded`, the
URL counts and any errors. To refresh a sitemap Google already knows, submit the
same URL again; there is no separate update call.
