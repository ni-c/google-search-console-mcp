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

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs lint, build and the suite on Node 22 and 24, plus npm audit, CodeQL and a Trivy scan of the container image.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, confirmation tokens, anything that
  builds a request URL): please describe the attack you are defending against, or the
  one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both eslint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/google-search-console-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/google-search-console-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/google-search-console-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
