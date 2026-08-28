# Environment variables

Every one is optional. The server starts with none of them set, lists its tools,
and fails each call with setup instructions — which is what lets registries and
sandbox inspectors introspect it.

## Credentials

Tried in this order; the first one that is present wins.

| Variable | Description |
| --- | --- |
| `GSC_SERVICE_ACCOUNT_KEY` | Service account key, as raw JSON or base64-encoded JSON |
| `GSC_SERVICE_ACCOUNT_KEY_FILE` | Path to a service account key file. Setting this **and** the above is a startup error |
| `GSC_CLIENT_ID` | OAuth2 client id |
| `GSC_CLIENT_SECRET` | OAuth2 client secret |
| `GSC_REFRESH_TOKEN` | OAuth2 refresh token |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to application default credentials |
| `GOOGLE_CLOUD_PROJECT` | Also makes the server consider application default credentials |

The three OAuth2 variables are required **together**. A partial triple is a
startup error rather than a fall-through to application default credentials — see
[Configuration](/guide/configuration#the-credential) for why.

Application default credentials are only attempted when one of the two `GOOGLE_`
variables points at something. Otherwise `google-auth-library` would search the
gcloud config directory and then the metadata server on every call, and a
30-second metadata timeout is a far worse answer than "you configured nothing".

`GSC_SERVICE_ACCOUNT_KEY`, `GSC_CLIENT_SECRET` and `GSC_REFRESH_TOKEN` are
deleted from the environment once read.

## Properties

| Variable | Description |
| --- | --- |
| `GSC_SITE_URL` | Default property. Makes `site_url` optional on every tool that takes one — except `add_site` |
| `GSC_ALLOWED_SITES` | Comma-separated properties this server may touch at all. Anything else is refused before a request goes out |

Both are normalised on read: a URL-prefix property gains its required trailing
slash, a domain property is lower-cased, and a bare hostname is rejected. A
`GSC_SITE_URL` that `GSC_ALLOWED_SITES` would then refuse is a startup error —
valid on both lines and broken as a pair.

## Tools

| Variable | Description |
| --- | --- |
| `GSC_READ_ONLY` | `true` registers only the twelve read tools, and requests `webmasters.readonly` |
| `GSC_ALLOW_TOOLS` | Comma-separated tool names, a prefix with one trailing `*`, or `essential` |
| `GSC_DENY_TOOLS` | Same shape, subtracted from whatever the allow list left |

An empty or whitespace-only value counts as **unset**, so `GSC_ALLOW_TOOLS=` in a
compose file does not mean "allow nothing". An entry that matches no tool stops
the server with the list of real names.

See [choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).
