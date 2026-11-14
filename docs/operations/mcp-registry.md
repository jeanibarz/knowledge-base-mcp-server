# MCP Registry listing

Use this runbook after an npm release to publish the matching listing on the
official [MCP Registry](https://registry.modelcontextprotocol.io), which MCP
client directories draw from. The listing is described by `server.json` at the
repository root. Publishing is a manual maintainer step; `release.yml` does not
run it.

## How ownership is verified

The registry name `io.github.jeanibarz/knowledge-base-mcp-server` is tied to
the `jeanibarz` GitHub account, so publishing requires a GitHub login as that
account. The registry then checks that the npm package
`@jeanibarz/knowledge-base-mcp-server` at the listed version contains
`"mcpName": "io.github.jeanibarz/knowledge-base-mcp-server"` in its
`package.json`. A version published to npm before `mcpName` was added cannot be
listed.

## Keep server.json in sync

Every release bump must set the same version in three places: `package.json`
`version`, `server.json` `version`, and `server.json` `packages[0].version`.
`src/mcp-registry-config.test.ts` fails when they drift, when the server name
stops matching `mcpName`, or when a declared environment variable is missing
from `CONFIG_SCHEMA`.

## Publish after an npm release

1. Confirm the release is on npm and carries `mcpName`:

   ```bash
   npm view @jeanibarz/knowledge-base-mcp-server@<version> mcpName
   ```

2. Install `mcp-publisher` (one time) from the
   [registry releases](https://github.com/modelcontextprotocol/registry/releases),
   for example on Linux x86-64:

   ```bash
   curl -sSfL https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_linux_amd64.tar.gz | tar xz mcp-publisher
   ```

3. From the repository root, on the release tag, validate and publish:

   ```bash
   ./mcp-publisher validate
   ./mcp-publisher login github
   ./mcp-publisher publish
   ```

## Confirm

```bash
curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=knowledge-base-mcp-server'
```

The response lists the server with the new version.

## If the schema URL moves

The registry is in preview. When `mcp-publisher validate` reports a deprecated
schema, update `$schema` in `server.json` to the URL the
[registry docs](https://github.com/modelcontextprotocol/registry/tree/main/docs)
currently use, then rerun `validate`.
