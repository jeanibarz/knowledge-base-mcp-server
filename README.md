# Knowledge Base MCP Server

[![Tests](https://github.com/jeanibarz/knowledge-base-mcp-server/actions/workflows/test.yml/badge.svg)](https://github.com/jeanibarz/knowledge-base-mcp-server/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@jeanibarz/knowledge-base-mcp-server.svg)](https://www.npmjs.com/package/@jeanibarz/knowledge-base-mcp-server)
[![License](https://img.shields.io/github/license/jeanibarz/knowledge-base-mcp-server)](./UNLICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](./package.json)

Point this server at a folder of markdown notes and it becomes searchable by meaning, not just by keyword — from your AI client, or from your shell.

You keep your notes as ordinary files on your own disk. The server reads them, splits them into chunks, turns each chunk into a vector with an embedding model of your choosing (a local Ollama model, OpenAI, or HuggingFace), and stores those vectors in a local [FAISS](https://faiss.ai/) index. Run it with a local embedding model and a local LLM and your notes never leave the machine; point it at a hosted provider and only then do they cross the network. Two front doors sit on top of that index:

- **An MCP server** that any [Model Context Protocol](https://modelcontextprotocol.io) client — Claude Desktop, Codex CLI, Cursor, Continue, Cline — can call to search your notes, ask questions answered from them, and (optionally) write new ones.
- **A `kb` command-line tool** for the same corpus from a terminal or an agent's shell, plus the operational commands the MCP surface doesn't expose: indexing, diagnostics, evaluation, and note curation.

Throughout the docs, a *knowledge base* (or *shelf*) is one subdirectory of your notes root — `work/`, `research/`, `personal/` — that you can search individually or together.

### Demo

![kb CLI demo — list knowledge bases, ask a natural-language question, get scored markdown results](docs/assets/demo.svg)

Real output, no mock data: the capture drives the `kb` CLI against a small knowledge base seeded from this repo's own `docs/`, indexed with the default Ollama embedding model. Regenerate it with [`docs/assets/record-demo.sh`](docs/assets/record-demo.sh).

[![smithery badge](https://smithery.ai/badge/@jeanibarz/knowledge-base-mcp-server)](https://smithery.ai/server/@jeanibarz/knowledge-base-mcp-server)

<a href="https://glama.ai/mcp/servers/n0p6v0o0a4">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/n0p6v0o0a4/badge" alt="Knowledge Base Server MCP server" />
</a>

## Contents

| Section | Read it when |
| --- | --- |
| [Install](#install) | Getting the server or the `kb` CLI onto your machine. |
| [Configure](#configure) | Choosing an embedding provider and laying out your notes. |
| [Use the MCP server](#use-the-mcp-server) | Wiring an AI client to your knowledge bases. |
| [Use the `kb` CLI](#use-the-kb-cli) | Searching, asking, writing, and curating from a shell. |
| [Tune retrieval quality](#tune-retrieval-quality) | Turning on the optional reranking, gating, and safety stages. |
| [Remote transport](#remote-transport-optional) | Serving MCP over HTTP or SSE instead of stdio. |
| [Benchmarks](#benchmarks) | Measuring retrieval quality locally. |
| [Troubleshooting](#troubleshooting) | Searches return nothing, or something looks stale. |
| [Security](#security) | Understanding the trust boundaries before you point this at untrusted content. |
| [Documentation map](#documentation-map) | Finding the deeper reference and runbooks under `docs/`. |

## Install

All install paths need [Node.js](https://nodejs.org/) 20 or newer and npm.

### As an MCP server (one command)

```bash
npx -y @jeanibarz/knowledge-base-mcp-server@latest
```

`npx` fetches the package from npm and launches the stdio server. Point your MCP client at that same command and set the environment variables described under [Configure](#configure). [docs/clients.md](docs/clients.md) has copy-pasteable config snippets for Claude Desktop, Codex CLI, Cursor, Continue, and Cline.

> **Pin `@latest`, not the unversioned spec.** `npx -y @jeanibarz/knowledge-base-mcp-server` (no version) caches the resolved version in `~/.npm/_npx/` indefinitely — subsequent client launches reuse that cached version even after a new release ships. The `@latest` form hashes to a different cache key and re-resolves on every launch, so new fixes arrive on the next client restart instead of requiring a manual `~/.npm/_npx/` clear. See [RFC 012 §2.4](docs/rfcs/012-cli-distribution.md).

### As a CLI (`kb`)

Install globally to get the `kb` command in any shell — useful interactively, and useful as a tool an AI agent can shell out to:

```bash
npm install -g @jeanibarz/knowledge-base-mcp-server@latest
kb list          # which knowledge bases can I see?
kb doctor        # is retrieval actually healthy?
kb search "your query"
```

The OS resolves the binary on every invocation, so `npm i -g …@latest` takes effect immediately — no need to restart an AI client that already has the MCP server loaded. The `kb` bin reads the same environment variables as the MCP server. See [Use the `kb` CLI](#use-the-kb-cli) for the full command map.

### Via Smithery

To install for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@jeanibarz/knowledge-base-mcp-server):

```bash
npx -y @smithery/cli install @jeanibarz/knowledge-base-mcp-server --client claude
```

### From source

Use this path to develop against the repo or to pin an unreleased commit.

```bash
git clone https://github.com/jeanibarz/knowledge-base-mcp-server.git
cd knowledge-base-mcp-server
npm install
npm run build
```

Then set your environment variables (see [Configure](#configure)), create your knowledge base directories, and add `node build/index.js` to your MCP client config — see [docs/clients.md](docs/clients.md).

### For local development

Use this when you're actively developing on the repo and want your global `kb` and `knowledge-base-mcp-server` bins to always reflect the current state of your checkout — without `npm publish` and without a manual reinstall after every `git pull`.

```bash
git clone https://github.com/jeanibarz/knowledge-base-mcp-server.git
cd knowledge-base-mcp-server
npm run dev:setup
```

`dev:setup` does three idempotent things:

1. **`npm install` + `npm run build`** — a first build, so the bins exist before linking.
2. **`npm link`** — symlinks `kb` and `knowledge-base-mcp-server` into the global node prefix (the path is printed during setup so you can verify where it landed). From then on, each `npm run build` overwrites `build/` in place and the global bins pick up the new code on the next invocation. **No re-link needed.**
3. **`git config core.hooksPath .githooks`** — points git at the tracked [`.githooks/`](./.githooks) directory so the `post-merge` and `post-rewrite` hooks fire after every `git pull` (merge or rebase) and `git merge`. Each hook re-runs `npm install` if `package.json` changed and `npm run build` if any source changed, and stays quiet when nothing relevant moved. It runs **last** in the hook order, so a failed install or build leaves the repo in its original state.

The daily loop is then just `git pull` (the hook rebuilds) or `npm run build` after an edit; the global `kb` reflects the change on its next invocation.

**Why `npm link` and not `npm install -g .`?** `npm link` is a symlink, so a rebuild is picked up for free. `npm install -g .` copies the build snapshot, so every change needs a re-install.

**Hook scope.** The hooks fire on `git pull` / `git merge` / `git pull --rebase`, not on `git checkout` between branches — run `npm run build` yourself after a branch switch. If a rebuild fails, the hook prints a warning and exits 0 so the pull itself isn't reported as failed.

Three development helpers run against throwaway state instead of your real knowledge bases and indexes:

| Command | What it does |
| --- | --- |
| `npm run dev:doctor` | Builds the checkout, creates a disposable scratch corpus, and verifies the CLI, the native FAISS dependency, `kb list`, lexical search, and — if the configured embedding provider is reachable — dense search. Use it to smoke-check a fresh contributor shell. |
| `npm run dev:cli -- search "…" --kb=work` | Runs the TypeScript CLI entrypoint directly with source maps, so you get real stack traces without rebuilding or relinking. It prints the active `KNOWLEDGE_BASES_ROOT_DIR`, `FAISS_INDEX_PATH`, embedding provider, and model to stderr first, so you can confirm which KB and index the command would touch. |
| `npm run dev:remote -- --transport=http\|sse` | Seeds a scratch KB, picks a free loopback port, generates an `MCP_AUTH_TOKEN`, prints curl examples, starts the TypeScript server against that scratch state, and removes it on exit. Add `--keep` to inspect the generated files, or `--print-env` to emit the environment and examples without starting the server. |

**Switching back to the published npm release** (to compare behaviour, say):

```bash
npm unlink -g @jeanibarz/knowledge-base-mcp-server
npm install -g @jeanibarz/knowledge-base-mcp-server@latest
```

## Configure

Two settings matter before anything else: **where your notes live** and **which embedding model turns them into vectors**. Everything else has a working default.

```bash
KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases   # one subdirectory per knowledge base
EMBEDDING_PROVIDER=ollama                        # ollama | openai | huggingface
```

Set these in your shell profile (`.bashrc`, `.zshrc`) or directly in your MCP client's config. Every recognised variable, with its default, accepted values, and validation constraints, is listed in [`docs/reference/configuration.md`](docs/reference/configuration.md); the operator-facing view of retrieval flags and rollout status is in [docs/feature-flags.md](docs/feature-flags.md). Copy [`.env.example`](./.env.example) to `.env` for local development.

Run `kb config validate` to check your configuration before startup. It catches cross-variable mistakes as well as bad individual values — for example, `KB_CHUNK_OVERLAP` must be strictly less than `KB_CHUNK_SIZE`. `kb doctor` reports the same finding and exits non-zero when the pair is invalid.

### Pick an embedding provider

Three providers are supported for production use. A fourth, `EMBEDDING_PROVIDER=fake`, returns deterministic vectors for tests and offline fixtures — it is not suitable for real retrieval quality.

#### Ollama (recommended — local and free)

Runs the embedding model on your own machine, so no note content is sent anywhere.

```bash
EMBEDDING_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434                   # default
OLLAMA_MODEL=dengcao/Qwen3-Embedding-0.6B:Q8_0           # default
KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
```

Install [Ollama](https://ollama.ai/) and pull the model first: `ollama pull dengcao/Qwen3-Embedding-0.6B:Q8_0`.

> **Check the model's context window before you pick one.** The default chunker emits ~1000-character chunks, which commonly tokenize past 256 tokens, so a 256-token model such as `all-minilm` will reject *every* request. Use a model that accepts at least ~500 tokens: `nomic-embed-text` (8192), `dengcao/Qwen3-Embedding-0.6B:Q8_0` (32K), or anything with ≥512.

#### OpenAI

```bash
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL_NAME=text-embedding-3-small
KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
```

To reach an OpenAI-*compatible* endpoint instead of the official API — a self-hosted gateway, Volcengine Ark, OpenRouter — set `OPENAI_BASE_URL` to that endpoint's base URL, including the API version path (`OPENAI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3`). Leaving it unset keeps the default `https://api.openai.com/v1`. Azure OpenAI is reachable only through its `/openai/v1/` API-compatibility surface (`OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/v1`); classic Azure deployments need `api-key` auth, an `api-version` query parameter, and per-deployment paths, so a plain base URL cannot target them.

> **Default model changed.** The OpenAI default is now `text-embedding-3-small`, up from `text-embedding-ada-002`. Both produce 1536-dimension vectors, but the *name* change triggers a one-time FAISS rebuild on the next query. Set `OPENAI_MODEL_NAME=text-embedding-ada-002` to keep the old default.

#### HuggingFace (fallback, and the default if you set nothing)

```bash
EMBEDDING_PROVIDER=huggingface          # optional — this is the default
HUGGINGFACE_API_KEY=your_api_key_here
HUGGINGFACE_MODEL_NAME=BAAI/bge-small-en-v1.5
HUGGINGFACE_PROVIDER=hf-inference       # optional router provider for serverless inference
KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
```

A free API key from [HuggingFace](https://huggingface.co/) is enough to start.

HuggingFace retired the legacy `api-inference.huggingface.co/models/...` endpoint in 2025. Feature-extraction calls now route through the Inference Providers router at `https://router.huggingface.co/hf-inference/models/<model>/pipeline/feature-extraction`. Set `HUGGINGFACE_PROVIDER` to pick a different supported provider — `together`, `replicate`, `fireworks-ai`, `sambanova`, `nebius`, `novita`. `HUGGINGFACE_API_KEY` can hold either a Hugging Face token or a compatible provider key, depending on how the request is authenticated upstream. To target a self-hosted or dedicated Inference Endpoint, set `HUGGINGFACE_ENDPOINT_URL` to the full POST URL; an explicit endpoint URL bypasses router provider selection.

> **Default model changed.** The HuggingFace default is now `BAAI/bge-small-en-v1.5`, up from `sentence-transformers/all-MiniLM-L6-v2`. Both produce 384-dimension vectors, but the name change triggers a one-time FAISS rebuild on the next query. Set `HUGGINGFACE_MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2` to keep the old default.

Supported defaults, vector dimensions, task-prefix requirements, and reindex caveats for every model are in [`docs/reference/embedding-models.md`](docs/reference/embedding-models.md).

### Lay out your knowledge bases

Create one subdirectory per knowledge base under `KNOWLEDGE_BASES_ROOT_DIR` — for example `company/`, `it_support/`, `onboarding/` — and drop your notes inside. Subdirectories nest freely; the server reads them recursively.

```
$HOME/knowledge_bases/
├── work/
│   └── runbooks/deploy.md
├── research/
│   └── papers/retrieval.md
└── .faiss/              # index storage, created for you
```

**What gets indexed.** Only files whose extension is in the allowlist `.md`, `.markdown`, `.txt`, `.rst`, `.html`, `.htm`. Hidden files and directories (anything starting with `.`) are skipped, as are PDFs, workflow sidecars (`_seen.jsonl`, `_index.jsonl`), log and staging subtrees (`logs/`, `tmp/`, `_tmp/`), and OS clutter (`.DS_Store`, `Thumbs.db`, `desktop.ini`). Extensionless files such as `README`, `LICENSE`, or `Makefile` are **not** embedded.

To widen or narrow that:

```bash
# Comma-separated extensions (case-insensitive; leading dot optional).
INGEST_EXTRA_EXTENSIONS=".json,.yaml"
# Comma-separated minimatch globs relative to the KB root.
INGEST_EXCLUDE_PATHS="drafts/**,scratch.md"
```

Add `".pdf"` only when PDF extraction is intentional. The base exclusions are authoritative: you can add more, but you cannot remove the built-ins. The full loader/extension matrix is in [`docs/reference/loaders.md`](docs/reference/loaders.md).

**How a file becomes searchable.** For each ingestable file the server computes a SHA256 hash and stores it in a hidden `.index/` subdirectory next to the file, so a later pass can tell whether the file changed since it was last indexed. Changed content is split into chunks — `.md` files with a heading-aware `MarkdownTextSplitter`, everything else with `RecursiveCharacterTextSplitter`, both at `chunkSize: 1000, chunkOverlap: 200`, so a large `.txt` or `.rst` file becomes many chunks rather than one blurry embedding. Each chunk is embedded and added to the FAISS index, which is initialized on server start and updated whenever the server notices changed files.

Writing notes the server can retrieve well is its own topic: [`docs/authoring-knowledge.md`](docs/authoring-knowledge.md) covers chunk-friendly markdown, the frontmatter taxonomy, content-boundary safety, and the note lifecycle.

### Index storage

The FAISS index lives at `FAISS_INDEX_PATH`, defaulting to `$KNOWLEDGE_BASES_ROOT_DIR/.faiss`. Each embedding model gets its own subdirectory under it, so registering a second model never overwrites the first — see [Compare embedding models](#compare-embedding-models).

**Sharing an index path across processes.** Several MCP and CLI processes may share one trusted `FAISS_INDEX_PATH`; writes serialize through per-model locks and versioned atomic saves. Keep the directory local and trusted — do not put it on a filesystem that untrusted peers can write to. See [Security](#security) and [`docs/architecture/threat-model.md`](docs/architecture/threat-model.md).

### Logging and audit

- `LOG_FILE=/path/to/logs/knowledge-base.log` mirrors structured logs to a file. Verbosity is `LOG_LEVEL=debug|info|warn|error`, defaulting to `info`. Logs never go to stdout, which carries the JSON-RPC stream.
- `KB_MUTATION_AUDIT_LOG=/path/to/kb-mutations.jsonl` records an append-only ledger of every KB content write. Each line captures which surface performed it (`cli.kb-remember`, `cli.kb-capture`, `cli.kb-ask`, `mcp.add_document`, `mcp.delete_document`), the operation, the KB and relative path, a timestamp, `before_sha256` / `after_sha256`, whether the write and refresh happened, and per-surface decision flags. **Note content is never stored** — only hashes and metadata. Audit writes are best-effort: a failure logs a warning to stderr but never aborts the write it was recording. KB names and paths are inherent to the records, so treat the audit log as being as sensitive as the KB directory itself.

### Tailor the MCP tool descriptions

The descriptions your AI client sees for each tool can be overridden before server start, which is worth doing when a deployment serves one specific corpus and you want the model to reach for the right tool. Unset or empty falls back to the built-in defaults.

```bash
RETRIEVE_KNOWLEDGE_DESCRIPTION="Search engineering runbooks, RFCs, and postmortems."
ASK_KNOWLEDGE_DESCRIPTION="Answer from engineering runbooks with citations."
LIST_KNOWLEDGE_BASES_DESCRIPTION="List available engineering knowledge bases."
LIST_MODELS_DESCRIPTION="List embedding models registered for engineering retrieval."
KB_STATS_DESCRIPTION="Report engineering KB index and transport health."
```

## Use the MCP server

### Tools

Your client sees these tools (registered in `src/KnowledgeBaseServer.ts`):

| Tool | What it's for |
| --- | --- |
| `list_knowledge_bases` | Discover which shelves exist, so the agent can scope a later search instead of guessing a name. |
| `retrieve_knowledge` | The core semantic search — returns the passages most relevant to a query so an agent can ground its answer in your documents rather than in what the model already knows. Searches one knowledge base if `knowledge_base` is given, otherwise all of them. Returns at most 10 chunks by default. `threshold` caps how far a match may be from the query (it is a *distance*, so lower is closer); the default of 2 is the far end of the scale and so rarely excludes anything on its own — lower it to make retrieval stricter, or see [relevance gating](#relevance-gating) for a stage designed to do that job properly. In hybrid mode the threshold is not applied at all, because both legs are over-fetched before fusion. |
| `ask_knowledge` | Retrieve, then have a configured local or OpenAI-compatible LLM write an answer with citations — one call instead of retrieve-then-prompt. |
| `list_models` | List the registered embedding models and which one is active. |
| `kb_stats` | Read-only corpus, index, model, cache, and transport statistics — useful for a health check without touching the index. |
| `diff_index` | Compare retrieval results across two persisted index versions, to see what a rebuild actually changed. |
| `add_document` | Write a text document into a KB through the guarded mutation path. |
| `delete_document` | Delete a KB-relative document through the guarded mutation path. |
| `reindex_knowledge_base` | Force a global rebuild, optionally validating a named KB first. |

Exact input schemas, types, and bounds are generated from the shipped tool registry in [`docs/reference/mcp-tools.md`](docs/reference/mcp-tools.md).

> **Turning off writes (`KB_INGEST_ENABLED`).** The last three tools — `add_document`, `delete_document`, `reindex_knowledge_base` — are only registered when `KB_INGEST_ENABLED` is `on`, which is the default. Set it to `off` to remove all three and leave a strictly read-only tool surface. Do this for shared or read-only deployments where an accidental agent write would be costly.

### Resources

Clients that want to enumerate and read source documents directly, rather than searching them, can use MCP resources. `resources/list` returns `kb://<knowledge-base>/<encoded-relative-path>` URIs for every ingestable, non-quarantined file under `KNOWLEDGE_BASES_ROOT_DIR`; `resources/read` returns the raw document as text, or as a base64 PDF blob when `.pdf` has been opted into ingest. See [`docs/mcp-resources.md`](docs/mcp-resources.md) for URI, MIME type, and percent-encoding details.

### Logging

The server advertises the standard MCP `logging` capability. HTTP and SSE clients can call `logging/setLevel` to pick a minimum notification level for their session; stdio accepts the request as a no-op. This is independent of `KB_LOG_FORMAT` and `LOG_FILE`. See [`docs/mcp-logging.md`](docs/mcp-logging.md).

### What a result looks like

`retrieve_knowledge` returns a markdown string, one block per match:

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

Each result carries the chunk content, its source file, and a similarity score. When chunk metadata includes line numbers, the source header links a stable chunk handle such as `alpha/docs/deploy.md#L42-L78` to the matching `kb://alpha/docs/deploy.md#L42-L78` resource URI. Set `KB_EDITOR_URI=vscode`, `cursor`, or `file` before launching the server to also emit editor-open links containing local absolute paths; the default `none` keeps absolute paths out of the response.

### Error codes

Tool errors come back with `isError: true` and a JSON text payload, so a client can branch on a stable code instead of matching substrings:

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

The complete taxonomy, including CLI-local codes, is generated into [`docs/reference/error-codes.md`](docs/reference/error-codes.md).

## Use the `kb` CLI

`kb` reads the same environment variables as the MCP server (`KNOWLEDGE_BASES_ROOT_DIR`, `FAISS_INDEX_PATH`, `EMBEDDING_PROVIDER`, `OLLAMA_*`, `OPENAI_*`, `HUGGINGFACE_*`), so once the server works, the CLI works. It exists for two audiences: a person at a terminal, and an AI agent that has a shell tool but no MCP connection.

**Every command has a full generated reference in [`docs/reference/cli.md`](docs/reference/cli.md)** — the map below is for orientation, not completeness.

### Command map

| Task | Commands |
| --- | --- |
| **See what's there** | `kb list` · `kb stats` · `kb tags` · `kb where "<topic>"` |
| **Search** | `kb search` · `kb open` · `kb related` · `kb explain` |
| **Answer with an LLM** | `kb llm` · `kb ask` |
| **Gather evidence** | `kb research plan` · `kb research collect` |
| **Write and curate notes** | `kb remember` · `kb capture` · `kb import-url` · `kb tag` · `kb promote` · `kb superseded` · `kb stale-check` · `kb quarantine` · `kb cite` |
| **Manage embedding models** | `kb models` · `kb compare` |
| **Measure quality** | `kb feedback` · `kb eval` · `kb eval-gate` |
| **Operate and diagnose** | `kb doctor` · `kb config validate` · `kb serve` · `kb reindex` · `kb logs` · `kb diagnose` · `kb cache` · `kb verify` |
| **Shell integration** | `kb --help` · `kb help <command>` · `kb completion bash\|zsh\|fish` |

### Search

`kb search` is read-only by default: it loads the existing index but does not re-scan your files. Pass `--refresh` when you want it to notice edits first. Output ends with a freshness footer telling you whether the index is current relative to your files' modification times.

```bash
kb search "your query"                        # dense (semantic) search over all shelves
kb search "your query" --kb=work --k=5        # scope to one shelf, cap results
kb search "your query" --refresh              # re-scan KB files first (this writes)
kb search "your query" --timing               # per-stage elapsed milliseconds
kb search "your query" --explain-empty        # deep diagnostics when nothing comes back
```

**Choosing a retrieval mode.** Semantic ("dense") search finds passages that *mean* the same thing as your query, which is what you want for prose questions. It is weaker on exact tokens — a file path, a flag name, an error code — because those carry little meaning to an embedding model. `--mode` picks the strategy:

| Mode | How it ranks | Reach for it when |
| --- | --- | --- |
| `dense` (default) | Vector similarity against the FAISS index. | You're asking a question in prose. |
| `lexical` | BM25, the classic keyword/term-frequency ranking used by search engines. | You know the exact string — `INDEX_NOT_INITIALIZED`, `src/cli.ts`. |
| `hybrid` | Runs both and merges the two ranked lists with RRF (Reciprocal Rank Fusion, which scores a result by its *position* in each list rather than by raw scores, so incomparable scales don't need normalizing). | You want exact-token recall without giving up semantic matches. |
| `auto` | Heuristic: dense for prose, hybrid for queries shaped like code, paths, flags, error codes, or issue references. | You don't want to think about it. |

```bash
kb search "INDEX_NOT_INITIALIZED" --mode=lexical
kb search "retrieval benchmarks" --mode=lexical --lexical-unit=source  # rank whole files, not chunks
kb search "INDEX_NOT_INITIALIZED" --mode=hybrid
kb search "src/cli-search.ts" --mode=auto
```

**Widening a match.** A chunk is roughly a thousand characters, so a good hit is often the middle of a longer thought. `--context-before`, `--context-after`, and `--context-window` attach the adjacent chunks from the same source to each dense match — more to read, but fewer follow-up queries. See [docs/search-neighbor-context.md](docs/search-neighbor-context.md) for the JSON shape and the tradeoffs.

```bash
kb search "runbook rollback" --context-window=1
```

**Steering the result set.** These operators are additive and read-only; each addresses a different way plain top-k disappoints you:

| Operator | Use it when |
| --- | --- |
| `--diverse` | Your top results are near-duplicates from one file and you'd rather see coverage across sources. It reranks a bounded pool of dense candidates to spread the results over more source files. |
| `--anti-query="<text>"` | You want to push results away from a known-irrelevant neighbouring topic. Candidates close to the negative query are penalized, but only among candidates the positive query already supports. |
| `--plus="<text>"` / `--minus="<text>"` | You want to nudge the query itself, adding positive and negative components to the query vector rather than filtering afterwards. |

```bash
kb search "agent evidence" --diverse --format=json
kb search "agent evidence" --anti-query="frontend styling"
kb search "queue debt" --plus="slow loop" --minus="UI layout" --format=json
```

JSON output includes an `advanced_retrieval` block explaining the mode, constraints, query components, and per-result scoring signals, so you can see *why* a result ranked where it did.

**Output formats.**

| Flag | Shape |
| --- | --- |
| `--format=md` (default) | Human-readable markdown blocks. |
| `--format=json` | Full envelope with scores, metadata, and the `advanced_retrieval` explanation. |
| `--format=compact` | One `score\|kb\|path:line` line per hit, for terse operator listings. |
| `--format=vimgrep` | One `path:line:col:preview` line per hit, for editor quickfix lists. |
| `--batch-jsonl` | Reads `{"query":"…","kb":"…","k":N}` records from stdin and emits one JSON envelope per line. |

```bash
printf '{"query":"q1"}\n{"query":"q2"}\n' | kb search --batch-jsonl
```

**Following a result back to its source.** JSON results carry a stable `chunk_id` such as `alpha/docs/deploy.md#L42-L78` whenever the chunk has a KB, path, and line range; chunks without line metadata fall back to `#chunk-N`.

```bash
kb open alpha/docs/deploy.md#L42-L78     # resolve a chunk id, kb:// URI, or result path to a source file
kb related alpha/docs/deploy.md#L42-L78  # find dense neighbors of an existing result chunk
```

`kb open` validates the path against the KB root and prints it; add `--json` for the cited line range and an `editorUri`. `kb related` fetches the indexed seed chunk behind the handle, searches with its text, and excludes the seed itself unless you pass `--include-self`.

### Ask: answers from a local LLM

`kb ask` keeps retrieval deterministic and adds a chat step on top: retrieve, then have an OpenAI-compatible LLM write an answer with citations. It accepts the same `--mode` values as `kb search`, plus `--rerank`.

The endpoint is resolved in order: `--endpoint`, then `KB_LLM_ENDPOINT`, then `--llm-profile`, then the active `kb llm` profile, and finally the default local-research-agent address on `127.0.0.1:8080`. ([local-research-agent](https://github.com/jeanibarz/local-research-agent) is a separate project that runs a local `llama-server`; `kb` can reuse one you already have running, or manage its own — see below.)

```bash
kb llm use-endpoint http://127.0.0.1:8080/v1/chat/completions --profile=local-research-agent
kb llm status
kb ask "Which notes discuss reboot recovery?" --kb=operating-environment
kb ask "why does src/cli.ts throw?" --mode=hybrid --rerank
kb ask "what changed in the daemonization notes?" --timing
```

**Saving an answer as a note.** `--save-transcript --kb=<name> --yes` writes the answer into that KB as a new markdown note recording the question, answer, citations, source chunk ids, LLM endpoint/profile/model, retrieval model, and — with `--timing` — timing metadata. `--title=<title>` sets the note title and slug. Existing transcript notes are never overwritten.

```bash
kb ask "what changed?" --kb=work --save-transcript --title="Ask - daemon changes" --yes
```

**Keeping a note out of LLM prompts.** A note whose frontmatter contains `kb_policy: { no_llm_context: true }` still appears in search results, but `kb ask` and MCP `ask_knowledge` drop it before calling the LLM and report the count under `context_packing.policy_filtered_chunks`. [Contextual-preface ingest](#contextual-prefaces-at-ingest) and [relevance-gate](#relevance-gating) judging exclude it too, while keeping the chunk as ordinary retrieval data.

**Developing offline.** `KB_LLM_FAKE=on` routes `kb ask`, [relevance-gate](#relevance-gating) judging, and [contextual-preface](#contextual-prefaces-at-ingest) generation to a deterministic in-process fake LLM — no endpoint required. When a client needs a real OpenAI-compatible localhost endpoint instead, run `npm run dev:mockllm -- --port=18080`. Rules are customizable via `KB_LLM_FAKE_RULES`; see [docs/testing/fake-llm.md](docs/testing/fake-llm.md).

**Managing a warm model.** If you want `kb` to own the model process rather than reuse someone else's:

```bash
kb llm install --profile=qwen --runner=llama-server \
  --bin=/path/to/llama-server --model=/path/to/model.gguf --port=8091
kb llm start --profile=qwen
kb llm set-model --profile=qwen --model=/path/to/other-model.gguf --start
kb llm uninstall --profile=qwen
```

External profiles are reuse-only: `kb llm stop`, `restart`, `uninstall`, and `reap` never stop a service owned by local-research-agent. Managed profiles are namespaced as `kb-llm@<profile>.service`, bind to `127.0.0.1`, and write leases under the user state directory, so a stale managed model can be reaped instead of staying resident forever.

### Gather evidence for a broad question

`kb research` is a read-only workflow for agent shells that need a wide evidence pass before writing an answer, RFC, eval plan, or issue. It deliberately does *not* call an LLM, start a model, refresh indexes, or write notes — it only reads and organizes what retrieval already knows.

Run `plan` first to inspect the deterministic shelf/query plan, then `collect` into a run directory:

```bash
kb research plan "synthesize an end-to-end approach for autonomous research agents and evals" --format=json
kb research collect "synthesize an end-to-end approach for autonomous research agents and evals" \
  --run-dir /tmp/kb-research-autonomous-agents-evals-20260521 \
  --format=json
```

Then read the generated `evidence_packet.md` and synthesize yourself. The run directory also holds `run.json`, `plan.json`, `ledger.json`, and `events.jsonl`: `ledger.json` stays lossless for audit and debugging, while `evidence_packet.md` is the human-scannable view. The JSON contract and stable artifact fields are in [`docs/cli-json-contracts.md`](docs/cli-json-contracts.md#kb-research); a longer walk-through — when to use it, how to read the packet, and the downstream `kb ask` and `kb feedback` plumbing — is in [`docs/operations/research-workflow.md`](docs/operations/research-workflow.md).

### Write and curate notes

These commands let an agent shell contribute back to a knowledge base, conservatively. The full task-oriented workflow, from collection through tagging, review, and promotion, is in [`docs/authoring-knowledge.md`](docs/authoring-knowledge.md#6-curate-notes-through-their-lifecycle); machine-readable command shapes are in [`docs/cli-json-contracts.md`](docs/cli-json-contracts.md).

**`kb remember` — create or append a note.** `--suggest` is the safe first step: it lists likely existing targets from note filenames and headings, reads no stdin, and writes no notes (it may refresh a small `.index` heading cache). Actually writing requires *both* `--stdin` and `--yes`. Creating uses a slugified `.md` filename and refuses to overwrite; appending accepts only an existing KB-relative path. Appends serialize per target and commit through a temp file, fsync, and atomic rename.

```bash
kb remember --suggest --kb=work --title="Quarterly plan"
printf '# Quarterly plan\n\n...' | kb remember --kb=work --title="Quarterly plan" --stdin --yes
printf '\nFollow-up note.\n' | kb remember --kb=work --append=quarterly-plan.md --stdin --yes
```

`kb capture` runs a command and appends its stdout to a note as a fenced block. It redacts common credential shapes from both the captured output and the displayed command line by default — pass `--no-redact` only when you truly need the raw text. Add `--refresh` to either command to re-index the affected KB after a successful write.

**`kb import-url` — snapshot a web page or PDF as a note, with provenance.** It fetches over http(s), runs HTML and PDF responses through the same loaders the indexer uses, and writes one note whose YAML frontmatter records `source_url`, `fetched_at`, `content_sha256`, `content_type`, `http_status`, and `byte_count`.

```bash
kb import-url --kb=research https://example.com/article
```

The fetch is deliberately fenced in, because a URL is attacker-controlled input: only http and https schemes are allowed; redirects are followed manually and re-validated at every hop (`--max-redirects`, default 5); responses are size-capped (`--max-bytes`, default 8 MiB) and time-bounded (`--timeout`, default 30000 ms); and private, loopback, and link-local addresses are refused unless you pass `--allow-local-network` (an SSRF guard). The note path defaults to a slug of the page title — `--note=<path.md>` chooses it, `--title` overrides the title, `--refresh` re-indexes afterwards. It refuses to overwrite an existing note.

**`kb tag` — maintain one note's frontmatter tags.** The default is a dry run; repeat `--add` or `--remove` for several tags and pass `--yes` to commit through the atomic writer and the KB's `.kb-policy.json` mutation policy. The note body is preserved byte-for-byte, and malformed frontmatter is rejected before anything is written.

```bash
kb tags --kb=work                       # list facet values (tags/status/type) with counts
kb tags --facet=status --format=json    # discover the vocabulary for kb search --status filters
kb tag work/runbooks/deploy.md --add=verified        # dry run
kb tag work/runbooks/deploy.md --add=verified --yes  # commit
```

`kb tags` reads note files directly, but an existing *index* only learns a new tag value after `kb search --refresh`.

**`kb superseded` — find notes that have gone stale.** A read-only "active forgetting" review: it scans frontmatter for explicit contradictions, deprecated or dormant lifecycle status, stale verification dates, and low-confidence active notes, then uses the semantic index to add conservative newer-neighbor evidence where it exists. `--format=json` suits agent workflows; `--include-clean` gives a full inventory.

```bash
kb superseded --kb=work
kb promote alpha/docs/deploy.md   # review and update lifecycle frontmatter on one note
kb stale-check --kb=work          # find path / URL references that no longer resolve
kb quarantine list --kb=work      # inspect per-file ingest quarantine entries
kb cite alpha/docs/deploy.md      # export BibTeX or CSL-JSON from note frontmatter
```

### Compare embedding models

You can keep several embedding models side by side and query each by id — useful for an A/B on retrieval quality without throwing away the index you already trust.

```bash
# List registered models. The * marks the active one.
kb models list

# Add a second model — embeds your KB once under the new model.
# For paid providers, prints an estimated cost and prompts before any HTTP traffic.
kb models add ollama nomic-embed-text          # local, free
kb models add openai text-embedding-3-small    # paid; estimate first
kb models add huggingface BAAI/bge-small-en-v1.5
kb models add ollama nomic-embed-text --index-type=sq8   # FAISS scalar quantization
kb models add ollama nomic-embed-text --index-type=hnsw  # HNSW approximate search backend

# Query a specific model without changing the default.
kb search "your query" --model=openai__text-embedding-3-small

# Side-by-side comparison: unified rank/score table over both models' top-k.
kb compare "your query" ollama__nomic-embed-text-latest openai__text-embedding-3-small

# Switch the default model.
kb models set-active openai__text-embedding-3-small

# Remove a model (refuses to remove the active one).
kb models remove huggingface__BAAI-bge-small-en-v1.5
```

How a model id and its storage are derived:

- **Id format** — `<provider>__<filesystem-safe-slug>`, computed deterministically from `(provider, model_name)` exactly as you typed it. `OLLAMA_MODEL=nomic-embed-text:latest` becomes `ollama__nomic-embed-text-latest`.
- **On disk** — each model lives at `${FAISS_INDEX_PATH}/models/<id>/`.
- **Active model** — recorded in `${FAISS_INDEX_PATH}/active.txt`; override per-process with `KB_ACTIVE_MODEL`.
- **Index type** — `KB_INDEX_TYPE` or `kb models add --index-type=flat|sq8|hnsw`, explained in [docs/operations/index-quantization.md](docs/operations/index-quantization.md).

See [`docs/reference/embedding-models.md`](docs/reference/embedding-models.md) for supported defaults, vector dimensions, task-prefix requirements, and reindex caveats, and [RFC 013](docs/rfcs/013-multimodel-support.md) for the design.

> **Upgrading from the single-model layout.** Migration is automatic on the first server or `kb` start: the existing single-model index moves into `${FAISS_INDEX_PATH}/models/<derived_id>/` and `active.txt` is written. Concurrent starts coordinate through `${FAISS_INDEX_PATH}/.kb-migration.lock`. Keep a backup of the previous `${FAISS_INDEX_PATH}` if you want a rollback path. On the MCP side the change is additive: `retrieve_knowledge` gained an optional `model_name`, `list_models` is new, and `kb_stats` now reports the latest in-process `updateIndex` summary under `last_index_update`. Tools that don't pass `model_name` behave exactly as before — the wire format is byte-equal to 0.2.x.

### Measure retrieval quality

**`kb feedback` — record judgments, then turn them into tests.** Each judgment appends to a per-KB ledger at `<kb>/.index/relevance-feedback.jsonl`. `promote` materialises every ledger row for a query into a retrieval-eval case, so accumulated human judgment becomes regression coverage instead of evaporating.

```bash
kb feedback add --kb=work --query="rollback procedure" \
  --source=runbooks/deploy.md --verdict=relevant   # also: irrelevant | stale | misleading
kb feedback add --kb=work --query="rollback procedure" \
  --source=runbooks/deploy.md --verdict=relevant \
  --relevance=3 --chunk-id=work/runbooks/deploy.md#L42-L78   # graded 0..3, pinned to one chunk
kb feedback list --kb=work
kb feedback promote --kb=work --query="rollback procedure" \
  --fixture=docs/testing/feedback-fixture.yml --yes
```

See [`docs/operations/feedback-workflow.md`](docs/operations/feedback-workflow.md).

**`kb eval` — run fixture-driven retrieval checks.** A case can set `query`, and optionally `kb`, `required_sources`, `forbidden_sources`, `expected_metadata`, `max_duplicate_groups`, `stale_policy`, and `gate`. A case's `gate` field is unrelated to [relevance gating](#relevance-gating) — here it means "should failing this case break the build". Failing *ungated* cases print warnings and exit 0; failing *gated* cases exit 1, which is what makes this usable in CI.

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

**`kb eval-gate` — validate the relevance gate before you trust it.** Runs the gate end-to-end against a labelled-queries fixture (a statistical floor, plus an optional LLM judge) and reports per-stage precision, recall, and false-empty rate. Run it whenever you change `KB_GATE_*` tuning or the judge prompt.

```bash
kb eval retrieval-eval.yml
kb eval-gate docs/testing/fixtures/rfc-018-gate-eval/queries.yml
```

See [`docs/operations/eval-gate-harness.md`](docs/operations/eval-gate-harness.md).

### Operate and diagnose

```bash
kb doctor                          # availability snapshot: index, embedding backend, LLM
kb config validate                 # static env-var schema validation before startup
kb serve                           # loopback daemon for warm reads; --warm pre-loads indexes
kb serve status                    # daemon liveness and degraded-mode diagnostics
kb reindex --with-context          # rebuild the index with contextual prefaces
kb reindex status --format=json    # ledger of recent and in-flight reindex passes
kb logs show --request-id=<id>     # read canonical request logs by id
kb logs recent --limit=20 --format=json
kb diagnose --request-id=<id> --repro-bundle=/tmp/kb-diag
kb cache list                      # inspect local cache surfaces
kb cache prune                     # prune stale cache entries
kb verify                          # slow integrity checks for persisted indexes and sidecars
```

**`kb serve`** runs the loopback daemon that clients passing `--daemon` use for warm reads, so a query doesn't pay model and index load time on every invocation. `kb serve [--host=127.0.0.1] [--port=17799] [--idle-timeout-ms=300000] [--warm]` brings it up; `--warm` (or `KB_DAEMON_PREWARM=on`) pre-loads the active model, FAISS index, and lexical indexes before reporting ready. `kb serve status [--json]` reports reachability, pid, idle timeout, supported commands, and prewarm state at `KB_DAEMON_URL` (default `http://127.0.0.1:17799`). SIGINT or SIGTERM stops it, and CLI commands fall back to direct in-process execution whenever the daemon is unreachable. See [`docs/operations/daemon-lifecycle.md`](docs/operations/daemon-lifecycle.md).

**`kb reindex`** rebuilds the index. `--with-context` adds [contextual prefaces](#contextual-prefaces-at-ingest) (requires `KB_CONTEXTUAL_RETRIEVAL=on` and a `KB_LLM_ENDPOINT`). `kb reindex status` reads the durable run-state and per-source sidecar ledgers to report liveness, eligible indexed files, sidecar coverage, pending files, resolved and failed chunks, and failure codes. Note that `--kb=<name>` is only a guard and estimator hint — a rebuild always covers the entire single-index-per-model layout ([RFC 017 §5](docs/rfcs/017-contextual-retrieval.md)).

**`kb logs`** reads the structured request log emitted under `KB_LOG_FORMAT=canonical` or `both`. `kb logs show --request-id=<id>` pulls every line of one retrieval; `--query-sha=<hash>` follows a recurring query; `kb logs recent --limit=<n>` shows the latest entries. `--format=json` emits a report envelope, `--format=csv|tsv|ndjson` flat event rows for downstream tooling.

**`kb diagnose`** packages the canonical events for a request into a private redacted bundle for sharing on an issue. Canonical logs never store raw query text, so pass `--query`, `--query-file`, or `--stdin` if you also want it to replay `kb explain --repro-bundle` with the model, KB scope, k, and threshold hints inferred from the log event.

## Tune retrieval quality

Plain dense retrieval is the default and needs no configuration. Five further stages sit around it. Four are **off by default**, because each buys precision or safety at a cost you should choose deliberately; the fifth, the untrusted-content guard, is on. The complete flag matrix — defaults, per-call overrides, rollout status, validation commands — is in [docs/feature-flags.md](docs/feature-flags.md).

### Contextual prefaces at ingest

Chunking a note breaks it into ~1000-character pieces, and the embedding model sees each piece alone. So a chunk reading

> "We pin it to CPU because the 24 GB card is already maxed by the gate model."

carries none of what makes it findable: *which* service is pinned, *which* card, *which* model. Its vector lands near other passages about "pinning" rather than near the GPU-contention question an operator would actually type. The note is indexed and still effectively invisible.

A **contextual preface** fixes this at ingest rather than at query time. Before a chunk is embedded, an LLM writes a short passage — roughly 50–100 tokens — describing where that chunk sits in its document, and the preface is prepended to the text that gets vectorized. The chunk now embeds as what it *is about*, not just what it literally says. Anthropic, who published the technique, measured a 49% reduction in top-5 retrieval failures on a code-and-prose benchmark.

Two things worth knowing before you turn it on. The text returned to callers is unchanged — prefaces affect the vector, never what `retrieve_knowledge` or `kb search` hands back. And the cost is real: one LLM call per chunk at ingest time. Generated prefaces are cached in per-source sidecars, so a reindex only pays for chunks that actually changed.

```bash
KB_CONTEXTUAL_RETRIEVAL=on     # plus a KB_LLM_ENDPOINT to generate against
kb reindex --with-context      # backfill existing shelves
kb reindex status              # sidecar coverage, pending files, failures
```

Design and rollout details are in [RFC 017](docs/rfcs/017-contextual-retrieval.md).

### Cross-encoder reranking

Dense retrieval scores your query and each chunk *separately*, then compares the two vectors — fast, because chunk vectors are computed once at index time, but the model never sees the query and the chunk together. A **cross-encoder** does: it reads the pair jointly and scores the match directly, which is markedly more precise and far too slow to run over a whole corpus. Reranking gets both by using dense (or hybrid) retrieval to pick a shortlist, then re-ordering just that shortlist with the cross-encoder.

Enable it with `KB_RERANK=on`, or per call with `kb search --rerank` / `kb ask --rerank`. You pay a small amount of latency per query.

| Env var | Description | Default |
| --- | --- | --- |
| `KB_RERANK` | Enable the cross-encoder reranking stage. | `off` |
| `KB_RERANK_MODEL` | Cross-encoder model id used for reranking. | (built-in default) |
| `KB_RERANK_TOP_N` | How many top candidates to feed into the reranker. | (built-in default) |
| `KB_RERANK_SKIP_DOMAINS` | Comma-separated KB domain names to skip reranking for. | (none) |

`KB_RERANK_DEVICE` (`cuda`, `cpu`) and `KB_RERANK_DTYPE` (`fp32`, …) are optional Transformers.js / ONNX Runtime overrides for cross-encoder execution — set them when you need runtime-specific acceleration or dtype control. Both are listed by `kb config show` and validated by `kb config validate`. Design details are in [RFC 019](docs/rfcs/019-cross-encoder-reranker.md).

### Relevance gating

Retrieval always returns *something*: ask about a topic your notes don't cover and you still get the ten least-bad chunks. The retrieval-time similarity threshold doesn't save you — it defaults to the far end of the distance scale and rarely excludes anything (see [`retrieve_knowledge`](#tools)). Fed to an LLM, those chunks read as authoritative context and quietly corrupt the answer. Relevance gating adds a check between retrieval and use — a statistical score floor, then optionally an LLM judge — that drops chunks which don't actually match the task, and can return nothing at all rather than something wrong.

That is a real tradeoff: the gate can also discard genuinely relevant chunks, lowering recall to raise precision. That's why it is off unless you opt in.

```bash
KB_RELEVANCE_GATE=on          # enable for a whole process
kb search "…" --gate          # enable for one call
kb search "…" --no-gate       # bypass in a process where it is enabled
```

The judge takes the task description from `--task-context=<text>` / `--task-context-file=<path>` (MCP: `task_context`) and reads `KB_GATE_LLM_ENDPOINT` / `KB_GATE_LLM_MODEL`, falling back to `KB_LLM_ENDPOINT` / `KB_LLM_MODEL`. MCP callers can pass `gate: "off"` to bypass.

| Env var | Meaning | Default |
| --- | --- | --- |
| `KB_GATE_SCORE_FLOOR` | Statistical score floor a chunk must clear. | `0.95` |
| `KB_GATE_JUDGE_INPUT` | How many surviving chunks reach the LLM judge. | `10` |
| `KB_GATE_LLM_TIMEOUT_MS` | Judge call timeout. | `8000` |
| `KB_GATE_MIN_TASK_TOKENS` | Minimum task-context length before judging runs at all. | `8` |
| `KB_GATE_EMPTY_VERDICT` | Allow the gate to return *no* context. | `off` |

Turn `KB_GATE_EMPTY_VERDICT` on only once you're comfortable with a caller receiving zero retrieved context. Validate any tuning change with `kb eval-gate` before relying on it; the design is in [RFC 018](docs/rfcs/018-context-relevance-gating.md).

### Ingest-time secret scanning

Notes captured from terminals and logs sometimes carry credentials. Set `KB_INGEST_SECRET_SCAN=on` to scan chunk text and frontmatter for credential-shaped content *before* it is embedded. Hits are quarantined with reason `secret_detected` and skipped before any FAISS write, so the secret never reaches the index.

```bash
kb quarantine list --reason=secret_detected
```

Use `KB_SECRET_SCAN_BYPASS_KBS=trusted-kb,...` only for shelves that intentionally store credential examples. See [Ingest secret scan](docs/operations/secret-scan.md).

### Untrusted-content guard

Anything you retrieve gets pasted into an LLM's context, so a note containing "ignore previous instructions" is an injection vector aimed at whatever agent asked the question. Every retrieved chunk therefore passes through the untrusted-content guard, which scans for prompt-injection signals — system-role markers, instruction-override phrasing, Unicode bidi / zero-width / tag control characters — and marks what it finds.

Unlike the other three stages, this one is **on by default** (`KB_INJECTION_GUARD=tag`):

| Value | Behaviour |
| --- | --- |
| `tag` (default) | Annotate the chunk's metadata with what was detected. |
| `wrap` | Fence the content with sentinel strings so a downstream prompt can tell data from instructions. |
| `both` | Both of the above. |
| `off` | No scanning. |

Set `off` only on shelves you fully control, or use `KB_INJECTION_GUARD_BYPASS_KBS=trusted-kb,...` to exempt specific shelves without weakening the global default.

## Remote transport (optional)

By default the server speaks MCP over stdio — every supported client (Claude Desktop, Codex, Cursor, Continue, Cline) launches it as a child process, which is the right shape for a single-user local tool. [RFC 008](./docs/rfcs/008-remote-transport.md) adds opt-in **SSE** and **streamable HTTP** transports for browser-based clients, Smithery remote mode, and shared deployments. Stdio behaviour is unchanged unless you set `MCP_TRANSPORT`.

```bash
export MCP_TRANSPORT=http                            # stdio (default), sse, or http
export MCP_AUTH_TOKEN="$(openssl rand -base64 32)"   # must be ≥32 characters; shorter tokens abort startup
# Or MCP_AUTH_TOKEN_FILE=/run/secrets/kb-mcp-token to read the token from a file; takes precedence over MCP_AUTH_TOKEN
export MCP_ALLOWED_ORIGINS="http://localhost:5173"   # comma-separated; unset denies all browser origins
export MCP_PORT=8765                                 # default
export MCP_BIND_ADDR=127.0.0.1                       # default — loopback only
export MCP_AUTH_BACKOFF_THRESHOLD=5                  # failed bearer attempts before backoff; 0 disables
export MCP_AUTH_BACKOFF_MS=30000                     # Retry-After window for auth backoff
node build/index.js
```

Endpoints in this mode:

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Liveness probe. Returns `200 {"status":"ok"}` and nothing else — no version, uptime, or filesystem fingerprint for anonymous callers (RFC 008 §6.8). |
| `GET /ready` | bearer | Readiness probe for operators and reverse proxies. `200` when the active model resolves, the active index file is present, and the embedding backend answers a tiny smoke query; otherwise `503` listing only the failing check names. |
| `GET /sse` + `POST /messages?sessionId=<uuid>` | bearer | `MCP_TRANSPORT=sse`: long-lived stream, plus JSON-RPC messages for that session. |
| `POST /mcp` | bearer | `MCP_TRANSPORT=http`: streamable HTTP. The server returns `Mcp-Session-Id` during initialization; clients must send it on subsequent `GET`, `POST`, and `DELETE /mcp` requests. |

Every non-health endpoint, `/ready` included, requires `Authorization: Bearer <token>`. `MCP_AUTH_TOKEN_FILE` reads the token from a mounted secret file — contents are trimmed, must still be at least 32 characters, and take precedence over `MCP_AUTH_TOKEN`. Repeated bearer failures from one remote address enter a bounded in-memory backoff and receive `Retry-After`; a successful authentication clears that address's state. Behind a reverse proxy the backoff key is the proxy's socket address, not `X-Forwarded-For`, so configure throttling proxy-side for anything internet-facing.

**Security defaults.** The server refuses to start in SSE or HTTP mode without `MCP_AUTH_TOKEN` or `MCP_AUTH_TOKEN_FILE`, binds to loopback only, and compares bearer tokens in constant time. To expose it off-host, set `MCP_BIND_ADDR=0.0.0.0` **and** terminate TLS in a reverse proxy — TLS is out of scope for this server.

For a disposable playground during development, use `npm run dev:remote` (see [For local development](#for-local-development)).

## Benchmarks

`npm run bench:beir` runs a local [BEIR](https://github.com/beir-cellar/beir) retrieval benchmark with credential-free lexical retrieval, so you can measure a chunking or ranking change instead of guessing at it:

```bash
npm run bench:beir -- --dataset=scifact --split=test --mode=lexical --lexical-unit=source --output-dir=/tmp/kb-beir-scifact
```

The runner builds a temporary KB root and emits metrics JSON plus a TREC run file, along with reproduction metadata: git SHA, command, dataset checksum, runtime versions, chunking config, and latency percentiles. **These are local artifacts, not official BEIR leaderboard submissions** — the lexical source path is scored at document level, matching `kb search --mode=lexical --lexical-unit=source`. See [benchmarks/README.md](benchmarks/README.md#beirscifact-local-retrieval-benchmark) for smoke-test commands and caveats, and [benchmarks/results/README.md](benchmarks/results/README.md) for the archived SciFact run.

Optuna tuning is optional and runs only when you invoke it. This sweeps lexical chunking parameters and writes a replayable best-config file:

```bash
npm run bench:tune -- \
  --trials=12 \
  --direction=maximize \
  --metric=metrics.ndcgAt10 \
  --study-name=scifact-lexical \
  --best-config-out=/tmp/kb-scifact-lexical-best.json \
  --param-int=KB_CHUNK_SIZE=256:1024:128 \
  --param-int=KB_CHUNK_OVERLAP=0:128:32 \
  -- npm run bench:beir -- --dataset=scifact --split=test --mode=lexical --max-queries=25 --output-dir=/tmp/kb-scifact-tune
```

Replaying the best trial needs no Optuna install:

```bash
npm run bench:tune -- --replay-config=/tmp/kb-scifact-lexical-best.json
```

## Troubleshooting

Start with the command-oriented runbook in [`docs/troubleshooting-local-kb.md`](docs/troubleshooting-local-kb.md) — it covers empty results, stale-index footers, linked-checkout and global-bin drift, missing active models, backend availability, and refresh lock contention. For a live incident, [`docs/operations/incident-response.md`](docs/operations/incident-response.md) is keyed by symptom. For Ollama, llama-server, n8n, systemd user units, remote transports, or `kb serve`, see the [local service operations runbook](docs/operations/local-services.md).

### Start with `kb doctor`

When `kb search` (or the MCP `retrieve_knowledge` tool) returns nothing, run the read-only `kb doctor` first. It is the canonical availability check for retrieval and also reports local LLM readiness for `kb ask`.

```bash
kb doctor                    # human-readable report
kb doctor --format=json      # machine-readable, for agent shells
```

The full report covers four areas:

- **Retrieval readiness** — active-model resolution, FAISS index version and mtime, the latest in-process index-update summary, and per-KB stale counts.
- **Backend reachability** — the embedding provider (Ollama / HuggingFace / OpenAI), plus the `kb ask` and relevance-gate LLM endpoints.
- **LLM usage counters**, broken down by operation — calls, errors, p95 latency, reported token totals, attempts and retries, cache hit outcomes, and how often an answer actually changed as a result. Provider and model attribution is *bounded*: only the few most-used values are tracked by name, so a long tail of models can't grow the counter set without limit.
- **Local install state** — the CLI version and local git state, which is what catches a global `kb` bin pointing at a stale checkout.

It **exits non-zero when a required retrieval check fails** — unresolved active model, missing index, unreachable backend. LLM endpoint failures are only WARN rows, because search can be perfectly healthy while `kb ask` or the optional gate is not ready.

Four focused modes answer narrower questions without loading the full health report:

| Command | Use when |
| --- | --- |
| `kb doctor --endpoints` | You only need to know whether the configured local endpoints are reachable before starting or wiring clients. Checks MCP bind address/port availability, `KB_DAEMON_URL` health, Ollama embedding reachability, `KB_LLM_ENDPOINT` or the active LLM profile, and `KB_GATE_LLM_ENDPOINT` when the gate is on. The gate row is skipped when the gate is disabled, its endpoint is unset, or the fake judge is active. |
| `kb doctor --locks` | A refresh or model write reports lock contention. Scans per-model `.kb-write.lock` paths and reports lock age, the recorded owner PID and command for new locks, stale suspicion, and conservative next actions — it never deletes a lock file. |
| `kb doctor --kb-symlinks` | You're auditing KB content roots. Scans with `lstat`, does not follow symlinked directories, and classifies targets as inside-root, escaping, broken, or loop/error, with capped examples. |
| `kb doctor --bug-report=/tmp` | You're opening an issue or handing diagnostics to another operator. Writes a timestamped directory with redacted `doctor.json`, `stats.json`, recent canonical log summaries, runtime and environment metadata, and a README. It excludes note contents and raw API keys, but KB names, paths, model names, and log metadata can still be sensitive. |

### Reading a search failure

`kb search` failures are sorted into six categories so you — or an agent — can tell what to fix without reading a stack trace. Every failure carries a stable `code`, a `category`, a human `message`, and a concrete `next_action`.

| Category | Typical codes | What to try |
| --- | --- | --- |
| `configuration` | `PROVIDER_AUTH`, `KB_NOT_FOUND`, `ACTIVE_MODEL_UNRESOLVED` | Set the missing API key, run `kb list` / `kb models list`, or `kb models set-active <id>`. |
| `indexing` | `INDEX_NOT_INITIALIZED`, `CORRUPT_INDEX` | Build or rebuild the index with `kb search --refresh`. |
| `provider` | `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT` | Verify the embedding backend is reachable (`ollama serve`, provider status page). |
| `permissions` | `PERMISSION_DENIED` | Grant write access to `$FAISS_INDEX_PATH` and each KB's `.index/`. |
| `input` | `VALIDATION` | Adjust the rejected field named in the message. |
| `lock` | `REFRESH_LOCK_BUSY` | Retry shortly; only one `kb search --refresh` writer runs per model. |

With `--format=md` these render to stderr as `kb search: <message>` followed by `category:` and `next:` lines. With `--format=json` they render to stdout as `{"error":{"code","category","message","next_action",...}}`, so an agent can branch on the category. When the cause is unclear, `next_action` falls back to `kb doctor`. Exit codes follow the CLI convention: **2** for configuration and input problems you can fix without retrying, **1** for runtime, index, provider, permission, and lock problems.

### Other tips

- Set `LOG_FILE` to capture structured logs. JSON-RPC traffic keeps using stdout, so this is especially useful for diagnosing MCP handshake errors — every diagnostic message goes to stderr and the optional log file.
- Permission errors when creating or updating the index are surfaced explicitly in both the console and the log file. Check that the process can write to `FAISS_INDEX_PATH` and to the `.index/` directory inside each knowledge base.
- `npm test` builds the project, runs the parallel Jest project with `--maxWorkers=4`, then the serial project with `--runInBand`. The suite covers logger fallback behaviour and FAISS permission handling.

## Security

This server is designed to run as a **local tool**: one user, one machine, one trusted terminal. Two trust boundaries matter in practice.

**`$FAISS_INDEX_PATH` is a code-execution boundary.** `FaissStore.load` deserialises the docstore via `pickleparser`, so the directory must contain only files this server wrote — no untrusted backups, no shared-write mounts. Several MCP and CLI processes may share a *trusted* index path; writes coordinate through per-model locks and atomic saves.

**`$KNOWLEDGE_BASES_ROOT_DIR` is a content boundary.** Its contents are embedded and returned verbatim to the MCP client, so markdown from an untrusted source is a prompt-injection risk for whatever agent consumes the result. The [untrusted-content guard](#untrusted-content-guard) mitigates this by default but does not eliminate it.

The full discussion — provider-key handling, path validation, remote transport posture, and concurrency — is in [`docs/architecture/threat-model.md`](./docs/architecture/threat-model.md).

## Documentation map

[`docs/`](docs/README.md) has a full index. The most common destinations:

| If you want to… | Read |
| --- | --- |
| Wire up a specific MCP client | [docs/clients.md](docs/clients.md) |
| Write notes that retrieve well | [docs/authoring-knowledge.md](docs/authoring-knowledge.md) |
| Look up any command, flag, env var, tool, metric, or error code | [docs/reference/](docs/reference/) — generated from source, so it never drifts |
| See every retrieval flag with its default and rollout status | [docs/feature-flags.md](docs/feature-flags.md) |
| Script against CLI JSON output | [docs/cli-json-contracts.md](docs/cli-json-contracts.md) |
| Run or recover a deployment | [docs/operations/](docs/operations/README.md) |
| Understand how the system is built | [docs/architecture/](docs/architecture/README.md) |
| Understand why it's built that way | [docs/rfcs/](docs/rfcs/) and [docs/architecture/adr/](docs/architecture/adr/) |

> **A note on "RFC NNN".** Non-trivial design decisions in this project are written up as numbered RFCs under [`docs/rfcs/`](docs/rfcs/) — they're this repo's own design-doc series, not IETF documents. When a section above cites one, it's pointing at the full rationale behind a feature, not at something you need to read to use it.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow, and [CLAUDE.md](./CLAUDE.md) for the agent-facing guide to architecture, conventions, and verification steps.
