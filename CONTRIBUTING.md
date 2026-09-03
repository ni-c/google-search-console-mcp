# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/google-search-console-mcp.git && cd google-search-console-mcp
npm install
npm test          # no network access — every test runs against a stubbed fetch
npm run build
```

A minimal dev environment:

```sh
# A service account is the right credential for development: it sees only the
# properties you explicitly add it to, and you can delete the key afterwards
# without touching your own Google account.
export GSC_SERVICE_ACCOUNT_KEY_FILE=~/keys/gsc-dev.json
export GSC_SITE_URL=sc-domain:example.com
export GSC_READ_ONLY=true          # drop this only to work on a write tool
npm run build && npx @modelcontextprotocol/inspector node dist/index.js
```

Three things about developing against the real APIs:

- **Do not develop write tools against a property you care about.** `delete_site`
  discards sixteen months of history that Google will not give back. Register a
  throwaway domain, or use a URL-prefix property on a subdomain nothing links to.
- **The URL Inspection API has a daily budget**, 2 000 calls per property, not a
  rate limit you can wait out. A loop in a debugger spends it.
- **The APIs must be enabled in a Cloud project**, one by one — Search Console,
  Site Verification and Indexing are three separate switches. The 403 you get
  otherwise reads as a permission problem and is not; `statusHint` in
  `src/result.ts` is what tells the two apart.

You do not need any of this to work on most of the server. The whole suite runs
against a stubbed `fetch` and touches no network.

## Why there is no integration suite

Every other server in this family has a `test/integration/` that brings up its
backend in Docker, spawns the built server over stdio and calls every tool in
the catalogue against it — the one test a stubbed `fetch` cannot do, because a
stub can only agree with whatever its author believed about the API.

This server cannot have one, and the reason is not effort. Its backend is
Google: Search Console, Site Verification and the Indexing API have no
self-hosted edition, no emulator and no sandbox project. There is nothing to
put in a `compose.yml`.

**The gap is named rather than papered over.** Writing a fake Google and testing
against it would produce a green suite that proves the same thing the unit tests
already prove — that this server agrees with itself — while looking like
coverage of something more. So the unit tests stay what they are, and the
verification against the real APIs is manual and written down here:

1. A service account with a throwaway property, as in the section above. Nothing
   that matters, because `delete_site` is on the list.
2. `GSC_READ_ONLY=true` for the read tools, then `false` once, deliberately, for
   the write ones.
3. Through the MCP Inspector, tool by tool, comparing what comes back with the
   Search Console web interface for the same property and date range.
4. Watch the two budgets: URL Inspection is **2 000 calls per property per day**
   and is spent, not throttled, and the aggregated tables lag by two to three
   days — a report that looks empty for yesterday is usually correct.

Anything found this way belongs in the tool's own description, where the next
model reading it will see it, and in a unit test that pins the shape.

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs lint, build and the suite on Node 22 and 24, plus npm audit, CodeQL and a Trivy scan of the container image.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, confirmation tokens, anything that
  builds a request URL): please describe the attack you are defending against, or the
  one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/google-search-console-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/google-search-console-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/google-search-console-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
