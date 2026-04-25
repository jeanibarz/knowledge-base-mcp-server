# MCP Client Configuration

This server speaks stdio MCP and works with any stdio MCP client. Pick the block below that matches your client, paste it into the listed config file, and replace the placeholders with paths and credentials that match your environment.

## Placeholders used in every snippet

| Placeholder | What to substitute |
| --- | --- |
| `<PATH_TO_BUILD_INDEX>` | Absolute path to `build/index.js` after `npm run build` (e.g. `/Users/you/code/knowledge-base-mcp-server/build/index.js`). |
| `<KB_ROOT>` | Absolute path to the directory that holds your knowledge-base subfolders. |
| `<FAISS_INDEX_PATH>` | Optional. Absolute path for the FAISS index. Defaults to `$HOME/knowledge_bases/.faiss` if omitted. |
| `<HF_API_KEY>` | HuggingFace API token (or a compatible Inference Provider key). |
| `<OPENAI_API_KEY>` | OpenAI API key. |
| `<MODEL_ID>` | Optional (RFC 013, 0.3.0+). The `<provider>__<slug>` id of a registered model — used in `KB_ACTIVE_MODEL` to pin a per-MCP-process active model. Run `kb models list` to see what's registered. |

The blocks below alternate embedding providers so you can see all three configured at least once. Any client can use any provider — see the [README](../README.md) "Configure environment variables" step for the full env-var matrix.

## Upgrade model — pin `@latest` if you wire via `npx`

The snippets below use `command: "node"` + an absolute path, so upgrades happen when *you* rebuild from source. If instead you wire the server via `command: "npx"` + `args: ["-y", "@jeanibarz/knowledge-base-mcp-server@latest"]` (a common shorthand for users on the README "Install (one command)" path), **always include `@latest` explicitly**. The bare unversioned spec `@jeanibarz/knowledge-base-mcp-server` caches the resolved version in `~/.npm/_npx/` indefinitely — your client keeps using the old version after a new release ships. The `@latest` form hashes to a different cache key and re-resolves on every spawn. See RFC 012 §2.4.

Alternatively, install once globally (`npm install -g @jeanibarz/knowledge-base-mcp-server@latest`) and use the resulting absolute bin path: `which knowledge-base-mcp-server`.

## See also: `kb` CLI

For shell-driven workflows (REPL queries, scripted ingest checks, agent Bash-tool calls), the same package ships a `kb` bin that doesn't require an MCP client at all. Each `kb` invocation is a fresh process, so global upgrades are picked up immediately. See the README "Install (CLI alongside the MCP server)" section.

## Multi-model setups (RFC 013, 0.3.0+)

The default config in the snippets below resolves to a single embedding model via the legacy env vars (`EMBEDDING_PROVIDER` + `OLLAMA_MODEL`/`OPENAI_MODEL_NAME`/`HUGGINGFACE_MODEL_NAME`). On 0.3.0+, you can keep multiple models registered side-by-side and have the MCP server use any of them per-call.

Two ways to control which model the MCP server uses:

1. **Set `KB_ACTIVE_MODEL`** in the env block of your client config to pin a specific model for that MCP-child's lifetime (highest precedence after a per-call `model_name` arg). Useful when you want one client to consistently use one model regardless of `active.txt`.

   ```json
   "env": {
     "KNOWLEDGE_BASES_ROOT_DIR": "<KB_ROOT>",
     "FAISS_INDEX_PATH": "<FAISS_INDEX_PATH>",
     "KB_ACTIVE_MODEL": "openai__text-embedding-3-small",
     "OPENAI_API_KEY": "<OPENAI_API_KEY>"
   }
   ```

2. **Let the agent choose per-call** by passing `model_name` on each `retrieve_knowledge` invocation. The agent can call `list_models` first to discover registered ids. The active model (from `${FAISS_INDEX_PATH}/active.txt`) is the default when `model_name` is omitted. Manage the active model from the shell with `kb models set-active <id>`.

> **Smithery deployments are single-model only** in 0.3.0 — the hosted runner doesn't expose a CLI, so `kb models add` cannot register additional models. The `kbActiveModel` Smithery config maps to `KB_ACTIVE_MODEL` and selects which (single, env-derived) model is active. Multi-model side-by-side on hosted MCP requires a follow-up RFC.

## Claude Desktop

Config file:

- macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows — `%APPDATA%\Claude\claude_desktop_config.json`

Add to the `mcpServers` object (Ollama provider shown):

```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "node",
      "args": ["<PATH_TO_BUILD_INDEX>"],
      "env": {
        "KNOWLEDGE_BASES_ROOT_DIR": "<KB_ROOT>",
        "EMBEDDING_PROVIDER": "ollama",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_MODEL": "dengcao/Qwen3-Embedding-0.6B:Q8_0"
      }
    }
  }
}
```

Restart Claude Desktop after editing the file. The server appears in the tools menu once the handshake succeeds.

## Codex CLI

Config file: `~/.codex/config.toml`

Add an `[mcp_servers.<name>]` table (OpenAI provider shown):

```toml
[mcp_servers.knowledge-base]
command = "node"
args = ["<PATH_TO_BUILD_INDEX>"]

[mcp_servers.knowledge-base.env]
KNOWLEDGE_BASES_ROOT_DIR = "<KB_ROOT>"
EMBEDDING_PROVIDER = "openai"
OPENAI_API_KEY = "<OPENAI_API_KEY>"
OPENAI_MODEL_NAME = "text-embedding-ada-002"
```

Codex CLI rereads `config.toml` on each invocation, so no restart is needed.

## Cursor

Config file:

- Global — `~/.cursor/mcp.json`
- Per project — `<project>/.cursor/mcp.json` (overrides global for that workspace)

Add to the `mcpServers` object (HuggingFace provider shown):

```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "node",
      "args": ["<PATH_TO_BUILD_INDEX>"],
      "env": {
        "KNOWLEDGE_BASES_ROOT_DIR": "<KB_ROOT>",
        "EMBEDDING_PROVIDER": "huggingface",
        "HUGGINGFACE_API_KEY": "<HF_API_KEY>",
        "HUGGINGFACE_MODEL_NAME": "sentence-transformers/all-MiniLM-L6-v2",
        "HUGGINGFACE_PROVIDER": "hf-inference"
      }
    }
  }
}
```

Toggle the server on in **Cursor Settings → Features → MCP** after saving.

## Continue

Config file: `~/.continue/config.json`

Add the server under `experimental.modelContextProtocolServers` (Ollama provider shown):

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "node",
          "args": ["<PATH_TO_BUILD_INDEX>"],
          "env": {
            "KNOWLEDGE_BASES_ROOT_DIR": "<KB_ROOT>",
            "EMBEDDING_PROVIDER": "ollama",
            "OLLAMA_BASE_URL": "http://localhost:11434",
            "OLLAMA_MODEL": "dengcao/Qwen3-Embedding-0.6B:Q8_0"
          }
        }
      }
    ]
  }
}
```

Reload the Continue extension after saving.

## Cline

Config file: `cline_mcp_settings.json` inside the Cline extension's global storage directory. The exact path depends on your editor and OS — open the Cline extension, run **MCP: Edit Settings**, and it will open the right file. (Historically `.../globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`.)

Add to the `mcpServers` object. Three provider variants are shown — use only one:

**Ollama**

```json
"knowledge-base-mcp-ollama": {
  "command": "node",
  "args": ["<PATH_TO_BUILD_INDEX>"],
  "disabled": false,
  "autoApprove": [],
  "env": {
    "KNOWLEDGE_BASES_ROOT_DIR": "<KB_ROOT>",
    "EMBEDDING_PROVIDER": "ollama",
    "OLLAMA_BASE_URL": "http://localhost:11434",
    "OLLAMA_MODEL": "dengcao/Qwen3-Embedding-0.6B:Q8_0"
  },
  "description": "Retrieves similar chunks from the knowledge base based on a query using Ollama."
}
```

**OpenAI**

```json
"knowledge-base-mcp-openai": {
  "command": "node",
  "args": ["<PATH_TO_BUILD_INDEX>"],
  "disabled": false,
  "autoApprove": [],
  "env": {
    "KNOWLEDGE_BASES_ROOT_DIR": "<KB_ROOT>",
    "EMBEDDING_PROVIDER": "openai",
    "OPENAI_API_KEY": "<OPENAI_API_KEY>",
    "OPENAI_MODEL_NAME": "text-embedding-ada-002"
  },
  "description": "Retrieves similar chunks from the knowledge base based on a query using OpenAI."
}
```

**HuggingFace**

```json
"knowledge-base-mcp-huggingface": {
  "command": "node",
  "args": ["<PATH_TO_BUILD_INDEX>"],
  "disabled": false,
  "autoApprove": [],
  "env": {
    "KNOWLEDGE_BASES_ROOT_DIR": "<KB_ROOT>",
    "EMBEDDING_PROVIDER": "huggingface",
    "HUGGINGFACE_API_KEY": "<HF_API_KEY>",
    "HUGGINGFACE_MODEL_NAME": "sentence-transformers/all-MiniLM-L6-v2",
    "HUGGINGFACE_PROVIDER": "hf-inference"
  },
  "description": "Retrieves similar chunks from the knowledge base based on a query using HuggingFace."
}
```

## Verifying the connection

Once the client launches the server, run a quick smoke test from the client UI:

1. Ask the client to list the `knowledge-base` server's tools — you should see `list_knowledge_bases` and `retrieve_knowledge`.
2. Call `list_knowledge_bases`. Each subdirectory of `<KB_ROOT>` (excluding dotfiles) is one knowledge base.
3. Call `retrieve_knowledge` with a query that should hit your seeded content.

If no tools show up, the most common causes are: a wrong absolute path in `args`, the `node` binary not on the client's `PATH`, or a missing `npm run build` on the server. Logs go to stderr and to `LOG_FILE` if set — see the [Troubleshooting](../README.md#troubleshooting--logging) section.
