# Connecting clients

## Claude Code

```sh
claude mcp add google-search-console \
  -e GSC_SERVICE_ACCOUNT_KEY_FILE=/path/to/key.json \
  -e GSC_SITE_URL=sc-domain:example.com \
  -- npx -y @ni-c/google-search-console-mcp
```

## Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-search-console": {
      "command": "npx",
      "args": ["-y", "@ni-c/google-search-console-mcp"],
      "env": {
        "GSC_SERVICE_ACCOUNT_KEY_FILE": "/path/to/key.json",
        "GSC_SITE_URL": "sc-domain:example.com"
      }
    }
  }
}
```

Claude Desktop launches the server without your shell's environment, so a
`GSC_SERVICE_ACCOUNT_KEY_FILE` written with `~` will not resolve. Use an
absolute path.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.google-search-console]
command = "npx"
args = ["-y", "@ni-c/google-search-console-mcp"]

[mcp_servers.google-search-console.env]
GSC_SERVICE_ACCOUNT_KEY_FILE = "/path/to/key.json"
GSC_SITE_URL = "sc-domain:example.com"
```

## MCP Inspector

For trying tools out by hand:

```sh
GSC_SERVICE_ACCOUNT_KEY_FILE=/path/to/key.json \
GSC_READ_ONLY=true \
  npx @modelcontextprotocol/inspector npx -y @ni-c/google-search-console-mcp
```

`GSC_READ_ONLY=true` is worth having here. The Inspector makes it very easy to
call a tool by accident, and two of the write tools discard data Google will not
give back.

## Docker

```sh
docker run --rm -i \
  -v /path/to/key.json:/key.json:ro \
  -e GSC_SERVICE_ACCOUNT_KEY_FILE=/key.json \
  -e GSC_SITE_URL=sc-domain:example.com \
  ghcr.io/ni-c/google-search-console-mcp
```

`-i` is required — the server speaks stdio, and without it the container has no
standard input to read. There is no port and no healthcheck for the same reason.

Mount the key read-only, or pass it in the environment instead:
`GSC_SERVICE_ACCOUNT_KEY` accepts the JSON directly, or base64-encoded, which is
what a Kubernetes secret or a CI secret store will hand you.

## Through mcp-hub

[mcp-hub](https://mcp-hub.ni-c.de) runs several stdio MCP servers behind one
Streamable-HTTP endpoint, which is how you reach this one from a client that
cannot spawn a local process.

```json
{
  "mcpServers": {
    "google-search-console": {
      "command": "npx",
      "args": ["-y", "@ni-c/google-search-console-mcp"],
      "env": {
        "GSC_SERVICE_ACCOUNT_KEY": "…",
        "GSC_SITE_URL": "sc-domain:example.com"
      }
    }
  }
}
```

The hub's own `allowTools` / `denyTools` in `mcp.json` and this server's
`GSC_ALLOW_TOOLS` / `GSC_DENY_TOOLS` are different mechanisms, and the difference
matters. The hub filters what it *re-exports* to the client; the server's own
variables decide what is *built* in the first place. So `"allowTools":
["essential"]` in `mcp.json` does nothing — `essential` is this server's preset,
not a tool name, and the hub is matching literal names. Put
`GSC_ALLOW_TOOLS=essential` in the `env` block instead, where it reaches the
process that understands it, and use the hub's lists for names you want the hub
to hide on top of that.

There is a second reason to prefer the server's own variables here: they also
narrow the OAuth scopes the server requests from Google. The hub's filter cannot
do that — by the time it applies, the credential is already built.

Reaching the hub's `/hub` endpoint instead replaces every server's tools with six
meta-tools, which is the other way to keep a large tool surface out of a client's
context.
