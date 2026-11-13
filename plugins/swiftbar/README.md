# plugins/ — macOS menu-bar control for the local MCP server

A [SwiftBar](https://swiftbar.app) plugin that puts a status icon in the
macOS menu bar for a locally hosted `knowledge-base-mcp-server` running
streamable HTTP under launchd (example label: `ai.knowledge-base.mcp`,
`MCP_TRANSPORT=http`, bearer auth via `MCP_AUTH_TOKEN_FILE`).

## Requires

- macOS + SwiftBar (`brew install --cask swiftbar`, or run the installer
  with `--install-swiftbar` and it will install it via Homebrew for you)
- The server already running as a launchd HTTP agent, loaded and healthy —
  the installer refuses to install otherwise. Minimal plist:

      <key>ProgramArguments</key>
      <array><string>/opt/homebrew/bin/node</string>
            <string>/path/to/repo/build/index.js</string></array>
      <key>EnvironmentVariables</key>
      <dict><key>MCP_TRANSPORT</key><string>http</string>
            <key>MCP_PORT</key><string>8090</string>
            <key>MCP_BIND_ADDR</key><string>127.0.0.1</string>
            <key>MCP_AUTH_TOKEN_FILE</key>
            <string>~/.config/kb/mcp-auth-token</string></dict>
- `node` (used to resolve config; already a server dependency)

## Install / uninstall

```bash
plugins/swiftbar/install.sh     # preflight checks → resolve config → install
plugins/swiftbar/uninstall.sh   # removes the plugin + menubar.env only
```

The installer verifies **before touching anything**: SwiftBar present,
`launchctl` service loaded and running, `http://<bind>:<port>/health`
returning `{"status":"ok"}`. It never modifies the service, the auth
token, `mcp_config.json`, or `kb.config.yaml`.

## How config is resolved

```
launchd plist > ~/.config/devin/mcp_config.json > ~/.config/kb/kb.config.yaml > defaults
```

Resolved values are written to `~/.config/kb/menubar.env`, which both
plugin scripts `source` at runtime — the scripts themselves stay
generic. Re-run `install.sh` after moving the repo, changing the port,
or renaming the service.

## Menu

`KB ●` — green when launchd reports `running` and `/health` is ok, red
otherwise. While an index write is in progress the icon turns into an
amber `KB ◐`. Dropdown: **Rebuild + restart** (npm build → kickstart, in
a Terminal window), **Reindex status…** (`kb reindex status` in a
Terminal window), Restart, Stop, Start, log files (Console), Devin MCP
config, `/health` link, and **Advanced → Uninstall plugin…** — a
confirmed self-removal (native dialog; server untouched; falls back to
deleting just its own files if the checkout is gone).

## Indexing activity

The plugin reports "is it indexing right now" from two durable on-disk
signals under the FAISS index dir — no HTTP, no auth token needed:

- `$FAISS_INDEX_PATH/.reindex.run.json` — the `kb reindex` run marker.
  Shown as `reindex: IN PROGRESS — pid …, started …` while the recorded
  PID is alive on this host.
- `$FAISS_INDEX_PATH/models/*/.kb-write.lock` — the per-model write lock
  every mutating op takes (`reindex_knowledge_base`, watcher-driven
  `updateIndex`, `add/delete_document`, `kb reindex` internals). Shown as
  `indexing: <command>` using the sibling `.kb-write.lock.owner.json`.
  Locks whose mtime is older than the proper-lockfile stale bound (~15 s)
  are treated as crash remnants, not live work.

`index: idle` is shown when neither signal is present. The index dir
resolves as `KB_FAISS_INDEX_PATH` → `KB_KB_ROOT/.faiss` →
`~/knowledge_bases/.faiss`; install.sh fills the first two from the
launchd plist / `mcp_config.json`.

## Files

| File | Role |
|---|---|
| `kb-mcp.10s.sh` | SwiftBar plugin (refresh every 10 s), symlinked into `~/Library/Application Support/SwiftBar/Plugins/` — repo edits go live on the next refresh, no reinstall needed |
| `kb-mcp-rebuild.sh` | `npm run build` + `launchctl kickstart -k` + health check |
| `kb-mcp-reindex-status.sh` | `kb reindex status` (progress ledger) in a Terminal window |
| `install.sh` | preflight + config resolution + install |
| `uninstall.sh` | removes plugin files + `menubar.env` only |
| `kb-mcp-uninstall.sh` | menu-invoked uninstall (dialog confirm, delegates to `uninstall.sh`) |
| `test.sh` | bash test suite (temp dirs only, never touches the live setup) |

## Testing

```bash
plugins/swiftbar/test.sh              # reject paths, happy path, uninstall, update + release-tag pinning
KB_SKIP_LIVE=1 plugins/swiftbar/test.sh   # CI mode: skips checks needing the live launchd service
```

Uses `KB_PLUGIN_DST`/`KB_MENUBAR_ENV`/`KB_SWIFTBAR_APP`/`KB_MCP_LABEL`/
`KB_MCP_PORT` overrides to run entirely against temp dirs — the live
SwiftBar plugin, `menubar.env`, and launchd service are never touched.

## Env overrides

| Var | Default | Purpose |
|---|---|---|
| `KB_MCP_LABEL` | `ai.knowledge-base.mcp` | launchd service label |
| `KB_MCP_PORT` / `KB_MCP_BIND` | resolved from plist | endpoint override |
| `KB_FAISS_INDEX_PATH` / `KB_KB_ROOT` | resolved from plist | index dir for the indexing indicator |
| `KB_MCP_NODE` | resolved from plist | node binary used by `Reindex status…` |
| `KB_MENUBAR_ENV` | `~/.config/kb/menubar.env` | env file location |
| `KB_PLUGIN_DST` | SwiftBar Plugins dir | alternate install target |
| `KB_SWIFTBAR_APP` | `/Applications/SwiftBar.app` | SwiftBar presence check |
| `KB_INSTALL_SWIFTBAR` | — | `=1` installs SwiftBar via brew |
