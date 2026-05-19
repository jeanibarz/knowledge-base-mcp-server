# Knowledge Base MCP Server

[![Tests](https://github.com/jeanibarz/knowledge-base-mcp-server/actions/workflows/test.yml/badge.svg)](https://github.com/jeanibarz/knowledge-base-mcp-server/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@jeanibarz/knowledge-base-mcp-server.svg)](https://www.npmjs.com/package/@jeanibarz/knowledge-base-mcp-server)
[![License](https://img.shields.io/github/license/jeanibarz/knowledge-base-mcp-server)](./UNLICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](./package.json)

This MCP server provides tools for listing and retrieving content from different knowledge bases.

### Demo

Live demo recording coming soon ([tracking #40](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/40)).

[![smithery badge](https://smithery.ai/badge/@jeanibarz/knowledge-base-mcp-server)](https://smithery.ai/server/@jeanibarz/knowledge-base-mcp-server)

<a href="https://glama.ai/mcp/servers/n0p6v0o0a4">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/n0p6v0o0a4/badge" alt="Knowledge Base Server MCP server" />
</a>

## Setup Instructions

These instructions assume you have Node.js (version 20 or higher) and npm installed on your system.

### Install (one command)

```bash
npx -y @jeanibarz/knowledge-base-mcp-server@latest
```

`npx` fetches the package from npm and launches the stdio server. Point your MCP client at `npx -y @jeanibarz/knowledge-base-mcp-server@latest` and configure the environment variables documented below. See [docs/clients.md](docs/clients.md) for copy-pasteable snippets (Claude Desktop, Codex CLI, Cursor, Continue, Cline).

> **Pin `@latest`, not the unversioned spec.** `npx -y @jeanibarz/knowledge-base-mcp-server` (no version) caches the resolved version in `~/.npm/_npx/` indefinitely — subsequent client launches reuse that cached version even after a new release ships. The `@latest` form hashes to a different cache key and re-resolves on every launch, so new fixes arrive on the next client restart instead of requiring a manual `~/.npm/_npx/` clear. See RFC 012 §2.4.

### Install (CLI alongside the MCP server, RFC 012)

For an interactive shell or AI-agent shell-tool flow, install globally and use the `kb` bin directly. The OS resolves the binary on every invocation, so `npm i -g …@latest` is picked up without restarting any AI client that has the MCP server loaded:

```bash
npm install -g @jeanibarz/knowledge-base-mcp-server@latest
kb list                       # list available knowledge bases
kb stats                      # read-only index/corpus stats
kb search "your query"                       # read-only dense search
kb search "your query" --timing              # include retrieval-stage timings
kb search "query" --refresh                  # also re-scan KB files (write path)
kb search "query" --explain-empty            # opt-in deep diagnostics when results are empty (#328)
kb search "INDEX_NOT_INITIALIZED" --mode=lexical --refresh   # BM25 debug surface (#206 stage 1)
kb search "INDEX_NOT_INITIALIZED" --mode=hybrid              # dense ⨁ BM25 fused via RRF (#206 stage 2)
kb search "src/cli-search.ts" --mode=auto    # opt-in heuristic: hybrid for code/path/error-shaped queries
kb open alpha/docs/deploy.md#L42-L78         # resolve a chunk id / kb:// URI / result path to its source file
kb llm use-endpoint http://127.0.0.1:8080/v1/chat/completions --profile=local-research-agent
kb ask "what changed in the daemonization notes?" --timing   # retrieval + local LLM answer with timings
kb ask "what changed?" --kb=work --save-transcript --title="Ask - daemon changes" --yes
kb remember --suggest --kb=work --title="Quarterly plan"
printf '# Quarterly plan\n\n...' | kb remember --kb=work --title="Quarterly plan" --stdin --yes
printf '\nFollow-up note.\n' | kb remember --kb=work --append=quarterly-plan.md --stdin --yes
kb superseded --kb=work       # read-only review for obsolete/contradicted notes
kb eval retrieval-eval.yml     # run fixture-driven retrieval checks
kb --help                     # top-level command list
kb help search                # per-command help (also: kb search --help)
kb completion bash            # generate a bash shell completion script
```

The `kb` bin shares the same env vars as the MCP server (`KNOWLEDGE_BASES_ROOT_DIR`, `FAISS_INDEX_PATH`, `EMBEDDING_PROVIDER`, `OLLAMA_*`, `OPENAI_*`, `HUGGINGFACE_*`). The consolidated operator matrix for retrieval flags, defaults, per-call overrides, rollout status, and validation commands lives in [docs/feature-flags.md](docs/feature-flags.md). `kb stats [--kb=<name>] [--format=md|json]` mirrors the MCP `kb_stats` payload for local shell use: per-KB file/chunk/byte counts, last indexed time, embedding model, index path, and version context. It is read-only and does not refresh the index. `kb search` also defaults to read-only dense retrieval — it loads the existing FAISS index but does not re-scan KB files. Pass `--refresh` to re-index. Use `--mode=hybrid` for explicit dense+BM25 rank fusion, or `--mode=auto` to keep dense for prose queries while selecting hybrid for code, path, flag, error-code, and issue-reference shaped queries. Add `--timing` to `kb search` or `kb ask` when you need per-stage elapsed milliseconds in either markdown or JSON output. Search output includes a freshness footer indicating whether the index is up-to-date relative to KB file mtimes.

RFC 018 relevance gating is off by default. Enable it per process with `KB_RELEVANCE_GATE=on`, or per CLI call with `kb search --gate`; bypass an enabled process with `--no-gate` or MCP `gate: "off"`. The judge uses `--task-context=<text>` / `--task-context-file=<path>` or MCP `task_context`, and reads `KB_GATE_LLM_ENDPOINT` / `KB_GATE_LLM_MODEL` (falling back to `KB_LLM_ENDPOINT` / `KB_LLM_MODEL`). Tuning env vars are `KB_GATE_SCORE_FLOOR` (default `0.95`), `KB_GATE_JUDGE_INPUT` (default `10`), `KB_GATE_LLM_TIMEOUT_MS` (default `8000`), and `KB_GATE_MIN_TASK_TOKENS` (default `8`). `KB_GATE_EMPTY_VERDICT` defaults to `off`; turn it on only when you are comfortable letting the gate return no retrieved context.

`kb search --format=vimgrep` prints one quickfix-compatible line per result: `path:line:col:preview`. JSON results include a stable `chunk_id` such as `alpha/docs/deploy.md#L42-L78` when chunk metadata has a KB, path, and line range; chunks without line metadata fall back to `#chunk-N`. Set `KB_EDITOR_URI=vscode`, `cursor`, or `file` to add opt-in absolute-path `editor_uri` fields and markdown `Open` links. The default `KB_EDITOR_URI=none` omits local absolute paths. `kb open <chunk-id|kb://uri|kb-relative-path>` resolves any of those pointers back to the absolute source path, validated against the KB root; it is read-only and prints the path (add `--json` for the cited line range and an `editorUri`).

`kb remember` is a conservative CLI write path for agent shells. `--suggest` lists likely existing targets from note filenames/headings, does not read stdin or write notes, and may update a small `.index` heading cache. Creates and appends require both `--stdin` and `--yes`; create uses a slugified `.md` filename and refuses overwrites, while append accepts only existing KB-relative paths. Plain EOF appends and `kb capture --append` serialize per target and commit through a temp-file fsync plus atomic rename. `kb capture` redacts common credentials from captured stdout and the displayed command line by default; pass `--no-redact` only when raw output is required. Add `--refresh` to re-index the affected KB after a successful write. For machine-readable command shapes, see [`docs/cli-json-contracts.md`](docs/cli-json-contracts.md).

`kb superseded --kb=<name>` is a read-only active-forgetting review. It scans markdown frontmatter for explicit contradiction, deprecated/dormant lifecycle status, stale verification dates, and low-confidence active notes, then uses the existing semantic index to add conservative newer-neighbor evidence when available. Use `--format=json` for agent workflows and `--include-clean` when you need a full inventory.

`kb eval <fixture.yml|json>` runs retrieval checks from fixtures. Each case can set `query`, optional `kb`, `required_sources`, `forbidden_sources`, `expected_metadata`, `max_duplicate_groups`, `stale_policy`, and `gate`. Failing ungated cases print warnings and exit 0; failing gated cases exit 1 for CI.

```yaml
gate: false
cases:
  - name: deployment runbook
    query: rollback procedure
    kb: work
    gate: true
    required_sources: [runbooks/deploy.md]
    forbidden_sources: [archive/old-deploy.md]
    expected_metadata:
      frontmatter.status: approved
    max_duplicate_groups: 1
    stale_policy: fresh
```

The MCP server (`knowledge-base-mcp-server` bin) is unchanged and still works with all the configurations in [docs/clients.md](docs/clients.md). The CLI is additive.

### Local LLM answers (RFC 015)

`kb ask` keeps retrieval deterministic and adds a local OpenAI-compatible chat step on top. It resolves the LLM endpoint from `--endpoint`, `KB_LLM_ENDPOINT`, `--llm-profile`, the active `kb llm` profile, then finally the local-research-agent default on `127.0.0.1:8080`.

Add `--save-transcript --kb=<name> --yes` to persist the generated answer as a new markdown note in that KB. The saved record includes the question, answer, citations, source chunk ids, LLM endpoint/profile/model, retrieval model, and timing metadata when `--timing` is present. `--title=<title>` controls the note title and slug; existing transcript notes are never overwritten.

```bash
# Reuse an already-running local-research-agent llama-server.
kb llm use-endpoint http://127.0.0.1:8080/v1/chat/completions --profile=local-research-agent
kb llm status
kb ask "Which notes discuss reboot recovery?" --kb=operating-environment
kb ask "Which notes discuss reboot recovery?" --kb=operating-environment \
  --save-transcript --title="Reboot recovery answer" --yes

# Optional managed service for machines that want kb to own the warm model.
kb llm install --profile=qwen --runner=llama-server \
  --bin=/path/to/llama-server --model=/path/to/model.gguf --port=8091
kb llm start --profile=qwen
kb llm set-model --profile=qwen --model=/path/to/other-model.gguf --start
kb llm uninstall --profile=qwen
```

External profiles are reuse-only: `kb llm stop`, `restart`, `uninstall`, and `reap` do not stop services owned by local-research-agent. Managed profiles are namespaced as `kb-llm@<profile>.service`, bind to `127.0.0.1`, and write leases under the user state directory so stale managed models can be reaped instead of staying loaded forever.

### Comparing embedding models (RFC 013)

Once on 0.3.0, you can keep multiple embedding models side-by-side and query each by id. Useful for retrieval-quality A/B without losing the previous model:

```bash
# List registered models. The * marks the active one.
kb models list

# Add a second model — embeds your KB once under the new model.
# For paid providers, prints an estimated cost and prompts before any HTTP traffic.
kb models add ollama nomic-embed-text          # local, free
kb models add openai text-embedding-3-small    # paid; estimate first
kb models add huggingface BAAI/bge-small-en-v1.5

# Query a specific model without changing the default.
kb search "your query" --model=openai__text-embedding-3-small

# Side-by-side comparison: unified rank/score table over both models' top-k.
kb compare "your query" ollama__nomic-embed-text-latest openai__text-embedding-3-small

# Switch the default model.
kb models set-active openai__text-embedding-3-small

# Remove a model (refuses to remove the active one).
kb models remove huggingface__BAAI-bge-small-en-v1.5
```

`<model_id>` is `<provider>__<filesystem-safe-slug>`, derived deterministically from `(provider, model_name)` as typed (e.g. `OLLAMA_MODEL=nomic-embed-text:latest` → `ollama__nomic-embed-text-latest`). On-disk layout: each model lives at `${FAISS_INDEX_PATH}/models/<id>/`. The active model is recorded in `${FAISS_INDEX_PATH}/active.txt` and overridable per-process via `KB_ACTIVE_MODEL`. See [`docs/rfcs/013-multimodel-support.md`](docs/rfcs/013-multimodel-support.md) for the full design.

**Migration from 0.2.x → 0.3.0** is automatic on first server (or `kb`) start: the existing single-model index is moved into `${FAISS_INDEX_PATH}/models/<derived_id>/` and `active.txt` is written. Atomic, ~12 ms measured. **Before upgrading**, fully exit any AI client (Claude Code, Cursor, Continue, Cline) that has the MCP server loaded — the migration acquires the single-instance PID advisory before any rename, so it cannot run while a 0.2.x MCP child is still using the directory. Keep a backup of the previous `${FAISS_INDEX_PATH}` if you need rollback safety before upgrading.

**MCP surface** — `retrieve_knowledge` gains an optional `model_name` argument; a new `list_models` tool returns the registered models; `kb_stats` reports the latest in-process `updateIndex` summary under `last_index_update` alongside the static index counts. Tools that don't pass `model_name` keep working unchanged (wire format is byte-equal to 0.2.x).

### MCP error codes

Tool errors are returned with `isError: true` and a JSON text payload so MCP clients can branch without substring matching:

```json
{
  "error": {
    "code": "PROVIDER_AUTH",
    "message": "OPENAI_API_KEY environment variable is required when using OpenAI provider"
  }
}
```

| Code | Meaning | Typical client action |
| --- | --- | --- |
| `INDEX_NOT_INITIALIZED` | A search ran before a FAISS index was available. | Retry after initialization or trigger a refresh. |
| `PROVIDER_UNAVAILABLE` | The embedding provider is temporarily unavailable. | Retry with backoff. |
| `PROVIDER_TIMEOUT` | The embedding provider timed out. | Retry with backoff. |
| `PROVIDER_AUTH` | Provider credentials are missing or invalid. | Ask the user to configure a valid API key. |
| `KB_NOT_FOUND` | The requested knowledge base does not exist. | Prompt for one of the listed knowledge bases. |
| `PERMISSION_DENIED` | The server cannot read or write a required local path. | Surface to the operator/admin. |
| `CORRUPT_INDEX` | The persisted FAISS index is corrupt or unreadable. | Rebuild or recover the index. |
| `VALIDATION` | A caller-supplied argument failed validation. | Fix the request before retrying. |
| `INTERNAL` | An unclassified server error occurred. | Surface the message and logs for investigation. |

### Install via Smithery

To install Knowledge Base Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@jeanibarz/knowledge-base-mcp-server):

```bash
npx -y @smithery/cli install @jeanibarz/knowledge-base-mcp-server --client claude
```

### Install from source

Use this path if you want to develop against the repo or pin an unreleased commit.

**Prerequisites**

*   [Node.js](https://nodejs.org/) (version 20 or higher)
*   [npm](https://www.npmjs.com/) (Node Package Manager)

1.  **Clone the repository:**

    ```bash
    git clone <repository_url>
    cd knowledge-base-mcp-server
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Configure environment variables:**

    This server supports three embedding providers: **Ollama** (recommended for reliability), **OpenAI** and **HuggingFace** (fallback option).

    ### Option 1: Ollama Configuration (Recommended)
    
    *   Set `EMBEDDING_PROVIDER=ollama` to use local Ollama embeddings
    *   Install [Ollama](https://ollama.ai/) and pull an embedding model: `ollama pull dengcao/Qwen3-Embedding-0.6B:Q8_0`
    *   Configure the following environment variables:
        ```bash
        EMBEDDING_PROVIDER=ollama
        OLLAMA_BASE_URL=http://localhost:11434  # Default Ollama URL
        OLLAMA_MODEL=dengcao/Qwen3-Embedding-0.6B:Q8_0          # Default embedding model
        KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
        ```
    *   **Minimum context window:** the embedding model must accept at least ~500 tokens of input. The default chunker emits ~1000-character chunks which commonly tokenize past 256 tokens, so models like `all-minilm` (256 ctx) will reject every request. Use `nomic-embed-text` (8192 ctx), `dengcao/Qwen3-Embedding-0.6B:Q8_0` (32K ctx), or any model with ≥512 ctx instead.

    ### Option 2: OpenAI Configuration

    *   Set `EMBEDDING_PROVIDER=openai` to use OpenAI API for embeddings
    *   Configure the following environment variables:
        ```bash
        EMBEDDING_PROVIDER=openai
        OPENAI_API_KEY=your_api_key_here
        OPENAI_MODEL_NAME=text-embedding-3-small
        KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
        ```
    *   As of this release, the OpenAI default is `text-embedding-3-small` (up from `text-embedding-ada-002`). Both produce 1536-dim vectors, but the model name change will trigger a one-time FAISS index rebuild on the next query. Override with `OPENAI_MODEL_NAME=...` if you prefer the old default.

    ### Option 3: HuggingFace Configuration (Fallback)
    
    *   Set `EMBEDDING_PROVIDER=huggingface` or leave unset (default)
    *   Obtain a free API key from [HuggingFace](https://huggingface.co/)
    *   Configure the following environment variables:
        ```bash
        EMBEDDING_PROVIDER=huggingface          # Optional, this is the default
        HUGGINGFACE_API_KEY=your_api_key_here
        HUGGINGFACE_MODEL_NAME=BAAI/bge-small-en-v1.5
        HUGGINGFACE_PROVIDER=hf-inference       # Optional, router provider for serverless inference
        KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
        ```
    *   As of this release, the HuggingFace default is `BAAI/bge-small-en-v1.5` (up from `sentence-transformers/all-MiniLM-L6-v2`). Both produce 384-dim vectors, but the model name change will trigger a one-time FAISS index rebuild on the next query. Override with `HUGGINGFACE_MODEL_NAME=...` if you prefer the old default.
    *   HuggingFace retired the legacy `api-inference.huggingface.co/models/...`
        endpoint in 2025. Feature-extraction calls are now routed through the
        Inference Providers router at
        `https://router.huggingface.co/hf-inference/models/<model>/pipeline/feature-extraction`
        by default. Set `HUGGINGFACE_PROVIDER` to choose a different supported
        Inference Provider such as `together`, `replicate`, `fireworks-ai`,
        `sambanova`, `nebius`, or `novita`. The existing
        `HUGGINGFACE_API_KEY` value can be either a Hugging Face token or a
        compatible provider key, depending on how the request is authenticated
        upstream. To target a self-hosted or dedicated Inference Endpoint, set
        `HUGGINGFACE_ENDPOINT_URL` to the full POST URL; explicit endpoint URLs
        bypass router provider selection.

    ### Additional Configuration
    
    *   The server supports the `FAISS_INDEX_PATH` environment variable to specify the path to the FAISS index. If not set, it will default to `$HOME/knowledge_bases/.faiss`. For a complete defaults and validation matrix across retrieval, ingest, diagnostics, and transport flags, see [docs/feature-flags.md](docs/feature-flags.md).
    *   **Single process per `FAISS_INDEX_PATH`.** Only one server process may write to a given `FAISS_INDEX_PATH` at a time. Running multiple processes (e.g. systemd `Restart=on-failure` racing the dying instance, pm2 with multiple replicas, Kubernetes pods sharing a PV, or a stray `kb search --refresh` overlapping the MCP server) against the same index directory can corrupt the FAISS store, hash sidecars, and pending-manifest. A process-level lockfile is the planned long-term fix — see [#44](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/44) for tracking and [`docs/architecture/threat-model.md`](docs/architecture/threat-model.md) for the current concurrency posture.
    *   Logging can be routed to a file by setting `LOG_FILE=/path/to/logs/knowledge-base.log`. Log verbosity defaults to `info` and can be adjusted with `LOG_LEVEL=debug|info|warn|error`.
    *   **Mutation audit log (opt-in).** Set `KB_MUTATION_AUDIT_LOG=/path/to/kb-mutations.jsonl` to capture an append-only JSONL ledger of KB content writes. Each line records `surface` (`cli.kb-remember` / `cli.kb-capture` / `cli.kb-ask` / `mcp.add_document` / `mcp.delete_document`), `operation`, `kb`, `relative_path`, `timestamp`, `before_sha256`, `after_sha256`, `write_performed`, `refresh_requested`, `refresh_status`, and per-surface `decision_flags`. Note content is **not** stored; only hashes and metadata. The feature is best-effort — an audit write failure logs a `warn` to stderr but never aborts the primary mutation. KB names and paths are inherent to the records, so treat the audit log with the same sensitivity as the underlying KB directory.
    *   **Tailor tool descriptions per deployment.** The `retrieve_knowledge` and `list_knowledge_bases` descriptions the agent reads when picking tools can be overridden via `RETRIEVE_KNOWLEDGE_DESCRIPTION` and `LIST_KNOWLEDGE_BASES_DESCRIPTION`. Unset or empty falls back to the built-in defaults. Example:
        ```bash
        RETRIEVE_KNOWLEDGE_DESCRIPTION="Search engineering runbooks, RFCs, and postmortems."
        LIST_KNOWLEDGE_BASES_DESCRIPTION="List available engineering knowledge bases."
        ```
    *   **Ingest filter overrides (RFC 011 M1).** The server embeds only files whose extension is in `{.md, .markdown, .txt, .rst, .html, .htm}` and excludes PDFs, workflow sidecars (`_seen.jsonl`, `_index.jsonl`), log / staging subtrees (`logs/`, `tmp/`, `_tmp/`), and OS turds (`.DS_Store`, `Thumbs.db`, `desktop.ini`). To extend the allowlist or add more exclusions:
        ```bash
        # Comma-separated extensions (case-insensitive; leading dot optional).
        INGEST_EXTRA_EXTENSIONS=".json,.yaml"
        # Comma-separated minimatch globs relative to the KB root.
        INGEST_EXCLUDE_PATHS="drafts/**,scratch.md"
        ```
        Extensionless files (e.g. `README`, `LICENSE`, `Makefile`) and PDFs are **not** embedded by the default allowlist; use `INGEST_EXTRA_EXTENSIONS=".pdf"` only when PDF extraction is intentional. The base exclusions are authoritative: operators can add more but cannot remove the built-ins.
    *   You can set these environment variables in your `.bashrc` or `.zshrc` file, or directly in the MCP settings.

4.  **Build the server:**

    ```bash
    npm run build
    ```

5.  **Add the server to your MCP client:**

    See [docs/clients.md](docs/clients.md) for copy-pasteable configuration snippets for Claude Desktop, Codex CLI, Cursor, Continue, and Cline.

6.  **Create knowledge base directories:**

    *   Create subdirectories within the `KNOWLEDGE_BASES_ROOT_DIR` for each knowledge base (e.g., `company`, `it_support`, `onboarding`).
    *   Place text files (e.g., `.txt`, `.md`) containing the knowledge base content within these subdirectories.

*   The server recursively reads all text files (e.g., `.txt`, `.md`) within the specified knowledge base subdirectories.
*   The server skips hidden files and directories (those starting with a `.`).
*   For each file, the server calculates the SHA256 hash and stores it in a file with the same name in a hidden `.index` subdirectory. This hash is used to determine if the file has been modified since the last indexing.
*   File content is split into chunks before indexing: `.md` files use `MarkdownTextSplitter` (heading-aware), and every other text file uses `RecursiveCharacterTextSplitter`. Both splitters share the same `chunkSize: 1000, chunkOverlap: 200` defaults, so a large `.txt`, `.rst`, or source file produces many chunks rather than a single embedding.
*   The content of each chunk is then added to a FAISS index, which is used for similarity search.
*   The FAISS index is automatically initialized when the server starts. It checks for changes in the knowledge base files and updates the index accordingly.

### Install (local development, live `kb` from your checkout)

Use this when you're actively developing on the repo and want your global `kb` and `knowledge-base-mcp-server` bins to always reflect the current state of `main` (or your feature branch) — without `npm publish` and without manual reinstalls after each `git pull`.

```bash
git clone https://github.com/jeanibarz/knowledge-base-mcp-server.git
cd knowledge-base-mcp-server
npm run dev:setup
```

`dev:setup` does three things, all idempotent:

1.  **`npm install` + `npm run build`** — first build, so the bins exist before linking.
2.  **`npm link`** — symlinks `kb` and `knowledge-base-mcp-server` into the global node prefix (printed during setup so you can verify it lands where you expect). From then on, every `npm run build` overwrites `build/` in place and the global bins pick up the new code on the next invocation. **No re-link needed** after rebuilds.
3.  **`git config core.hooksPath .githooks`** — points git at the tracked [`.githooks/`](./.githooks) directory so the `post-merge` and `post-rewrite` hooks fire after every `git pull` (merge or rebase) and `git merge`. The hook re-runs `npm install` if `package.json` changed and `npm run build` if any source changed. Skips quietly when nothing relevant moved. The hook order puts this **last**, so a failed install/build leaves the repo in its original state.

After setup, the daily loop is just:

```bash
git pull            # hook rebuilds automatically (merge or rebase)
kb search "..."     # uses the freshly-built bin from this checkout
```

Or, when editing locally:

```bash
# edit src/...
npm run build       # global `kb` immediately reflects your change
```

For source-mapped CLI debugging without rebuilding or relinking, run the
TypeScript CLI entrypoint directly:

```bash
npm run dev:cli -- --help
npm run dev:cli -- search "rollback procedure" --kb=work --k=5
```

The wrapper prints the active `KNOWLEDGE_BASES_ROOT_DIR`, `FAISS_INDEX_PATH`,
embedding provider, and embedding model to stderr before each invocation so
you can confirm which KB and index a command would touch.

**Switching back to the published npm release** (e.g. to compare behaviour):

```bash
npm unlink -g @jeanibarz/knowledge-base-mcp-server
npm install -g @jeanibarz/knowledge-base-mcp-server@latest
```

**Why `npm link` instead of `npm install -g .`?** `npm link` is a symlink, so `npm run build` is reflected without reinstalling. `npm install -g .` copies the build snapshot, so every change requires a re-install.

**Hook scope.** The hooks trigger on `git pull` / `git merge` / `git pull --rebase`, not on `git checkout` between branches. Run `npm run build` manually after a branch switch if needed. If a rebuild fails, the hook prints a warning and exits 0 so the pull itself isn't reported as failed — fix the build, then run `npm run build` manually.

## Usage

> **Writing notes that retrieve well?** See [`docs/authoring-knowledge.md`](docs/authoring-knowledge.md) — six-section guide on chunk-friendly markdown, frontmatter taxonomy that lifts into filters, content-boundary safety, and when to split a KB.

The server exposes two tools:

*   `list_knowledge_bases`: Lists the available knowledge bases.
*   `retrieve_knowledge`: Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 document chunks are returned with a score below a threshold of 2. A different threshold can optionally be provided using the `threshold` parameter.

You can use these tools through the MCP interface.

The `retrieve_knowledge` tool performs a semantic search using a FAISS index. The index is automatically updated when the server starts or when a file in a knowledge base is modified.

The output of the `retrieve_knowledge` tool is a markdown formatted string with the following structure:

````markdown
## Semantic Search Results

**Result 1:**

[Content of the most similar chunk]

**Source:**
```json
{
  "source": "[Path to the file containing the chunk]"
}
```

---

**Result 2:**

[Content of the second most similar chunk]

**Source:**
```json
{
  "source": "[Path to the file containing the chunk]"
}
```

> **Disclaimer:** The provided results might not all be relevant. Please cross-check the relevance of the information.
````

Each result includes the content of the most similar chunk, the source file, and a similarity score.
When chunk metadata includes line information, the markdown source header links a stable chunk handle such as `alpha/docs/deploy.md#L42-L78` to the matching `kb://alpha/docs/deploy.md#L42-L78` resource URI. Set `KB_EDITOR_URI=vscode`, `cursor`, or `file` before launching the server to also include editor-open links with local absolute paths.

## Remote transport (optional)

By default the server speaks MCP over stdio — every supported client (Claude Desktop, Codex, Cursor, Continue, Cline) launches it as a child process. [RFC 008](./docs/rfcs/008-remote-transport.md) adds opt-in **SSE** and **streamable HTTP** transports for browser-based clients, Smithery remote mode, and shared deployments. Stdio is unchanged unless you set `MCP_TRANSPORT`.

```bash
export MCP_TRANSPORT=http                         # stdio (default), sse, or http
export MCP_AUTH_TOKEN="$(openssl rand -base64 32)"   # must be ≥32 characters; shorter tokens abort startup
export MCP_ALLOWED_ORIGINS="http://localhost:5173"   # comma-separated; leave unset to deny all browser origins
export MCP_PORT=8765                                  # default
export MCP_BIND_ADDR=127.0.0.1                        # default — loopback only
node build/index.js
```

Endpoints exposed in this mode:

- `GET /health` — unauthenticated liveness probe; returns `200 {"status":"ok"}` only. Per RFC 008 §6.8 it intentionally exposes no version, uptime, or filesystem fingerprint to anonymous callers.
- `MCP_TRANSPORT=sse`: `GET /sse` opens the long-lived SSE stream and `POST /messages?sessionId=<uuid>` sends JSON-RPC messages for that session.
- `MCP_TRANSPORT=http`: `POST /mcp` initializes and sends JSON-RPC messages using streamable HTTP. The server returns `Mcp-Session-Id` during initialization; clients must send it on subsequent `GET`, `POST`, and `DELETE /mcp` requests.

All non-health transport endpoints require `Authorization: Bearer <MCP_AUTH_TOKEN>`.

**Security defaults:** the server refuses to start in SSE or streamable HTTP mode without `MCP_AUTH_TOKEN`, binds only to loopback, and uses a constant-time bearer comparison. Operators exposing the endpoint off-host should set `MCP_BIND_ADDR=0.0.0.0` *and* terminate TLS in a reverse proxy — TLS is out of scope for this server. Only one process per `FAISS_INDEX_PATH` is supported (see [`docs/architecture/threat-model.md`](./docs/architecture/threat-model.md)).

## Troubleshooting & Logging

For a command-oriented runbook covering empty results, stale-index footers, linked-checkout/global-bin drift, missing active models, backend availability, and refresh lock contention, see [`docs/troubleshooting-local-kb.md`](docs/troubleshooting-local-kb.md).

### KB availability smoke check

When `kb search` (or the MCP `retrieve_knowledge` tool) is not returning results, run the read-only `kb doctor` command first — it is the canonical availability check for retrieval and also reports local LLM readiness for `kb ask`:

```bash
kb doctor                # human-readable report
kb doctor --format=json  # machine-readable for agent shells
```

The report covers active-model resolution, FAISS index version + mtime, the latest in-process index-update summary, per-KB stale counts, embedding-backend reachability (Ollama / HuggingFace / OpenAI), local LLM endpoint readiness, CLI version, and local git state. The command exits non-zero when any required retrieval check fails (active model unresolved, index missing, backend unreachable); LLM endpoint failures are WARN rows because search can remain healthy while `kb ask` is not ready.

### Distinguishing search failure modes

`kb search` failures are classified into one of six categories so a user or agent can tell what to fix without reading stack traces. Each failure carries a stable `code`, a `category`, a human `message`, and a concrete `next_action`:

| Category | Typical codes | What to try |
| --- | --- | --- |
| `configuration` | `PROVIDER_AUTH`, `KB_NOT_FOUND`, `ACTIVE_MODEL_UNRESOLVED` | Set the missing API key, run `kb list` / `kb models list`, or `kb models set-active <id>`. |
| `indexing` | `INDEX_NOT_INITIALIZED`, `CORRUPT_INDEX` | Build or rebuild the index with `kb search --refresh`. |
| `provider` | `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT` | Verify the embedding backend is reachable (`ollama serve`, provider status page). |
| `permissions` | `PERMISSION_DENIED` | Grant write access to `$FAISS_INDEX_PATH` and per-KB `.index/`. |
| `input` | `VALIDATION` | Adjust the rejected field named in the message. |
| `lock` | `REFRESH_LOCK_BUSY` | Retry shortly; only one `kb search --refresh` writer runs per model. |

With `--format=md` the same fields render to stderr as `kb search: <message>` followed by `category:` and `next:` lines. With `--format=json` they render to stdout as `{"error":{"code","category","message","next_action",...}}` so an agent can branch on the category programmatically. When the cause is unclear, the `next_action` falls back to `kb doctor` which prints the exact health snapshot needed to diagnose.

Exit codes mirror the CLI's existing convention — `2` for configuration and input problems the user can fix without retry, `1` for runtime / index / provider / permissions / lock problems.

### Other tips

- Set `LOG_FILE` to capture structured logs (JSON-RPC traffic continues to use stdout). This is especially helpful when diagnosing MCP handshake errors because all diagnostic messages are written to stderr and the optional log file.
- Permission errors when creating or updating the FAISS index are surfaced with explicit messages in both the console and the log file. Verify that the process can write to `FAISS_INDEX_PATH` and the `.index` directories inside each knowledge base.
- Run `npm test` to execute the Jest suite (serialised with `--runInBand`) that covers logger fallback behaviour and FAISS permission handling.

## Security

The server is designed to run as a **local tool**: one user, one machine, one trusted terminal. Two trust boundaries matter in practice. The `$FAISS_INDEX_PATH` directory is a **code-execution boundary** — `FaissStore.load` deserialises the docstore via `pickleparser`, so the directory must only contain files written by this server (no untrusted backups, no shared-write mounts). The `$KNOWLEDGE_BASES_ROOT_DIR` tree is a **content boundary** — its contents are embedded and returned verbatim to the MCP client, so markdown from untrusted sources is a prompt-injection risk for downstream agents. Additionally, only **one server process per `FAISS_INDEX_PATH`** is supported today; running multiple processes against the same index will corrupt it. Full discussion, including provider-key handling and the planned concurrency lockfile, is in [`docs/architecture/threat-model.md`](./docs/architecture/threat-model.md).
