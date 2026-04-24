# Knowledge Base MCP Server

[![Tests](https://github.com/jeanibarz/knowledge-base-mcp-server/actions/workflows/test.yml/badge.svg)](https://github.com/jeanibarz/knowledge-base-mcp-server/actions/workflows/test.yml)
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

These instructions assume you have Node.js and npm installed on your system.

### Installing via Smithery

To install Knowledge Base Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@jeanibarz/knowledge-base-mcp-server):

```bash
npx -y @smithery/cli install @jeanibarz/knowledge-base-mcp-server --client claude
```

### Manual Installation
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

    ### Option 2: OpenAI Configuration

    *   Set `EMBEDDING_PROVIDER=openai` to use OpenAI API for embeddings
    *   Configure the following environment variables:
        ```bash
        EMBEDDING_PROVIDER=openai
        OPENAI_API_KEY=your_api_key_here
        OPENAI_MODEL_NAME=text-embedding-3-small
        KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
        ```
    *   As of this release, the OpenAI default is `text-embedding-3-small` (up from `text-embedding-ada-002`). Both produce 1536-dim vectors, but the model name change will trigger a one-time FAISS index rebuild on the next query. Override with `OPENAI_MODEL_NAME=...` if you prefer the old default. See the [CHANGELOG](./CHANGELOG.md) for details.

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
    *   As of this release, the HuggingFace default is `BAAI/bge-small-en-v1.5` (up from `sentence-transformers/all-MiniLM-L6-v2`). Both produce 384-dim vectors, but the model name change will trigger a one-time FAISS index rebuild on the next query. Override with `HUGGINGFACE_MODEL_NAME=...` if you prefer the old default. See the [CHANGELOG](./CHANGELOG.md) for details.
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
    
    *   The server supports the `FAISS_INDEX_PATH` environment variable to specify the path to the FAISS index. If not set, it will default to `$HOME/knowledge_bases/.faiss`.
    *   Logging can be routed to a file by setting `LOG_FILE=/path/to/logs/knowledge-base.log`. Log verbosity defaults to `info` and can be adjusted with `LOG_LEVEL=debug|info|warn|error`.
    *   **Tailor tool descriptions per deployment.** The `retrieve_knowledge` and `list_knowledge_bases` descriptions the agent reads when picking tools can be overridden via `RETRIEVE_KNOWLEDGE_DESCRIPTION` and `LIST_KNOWLEDGE_BASES_DESCRIPTION`. Unset or empty falls back to the built-in defaults. Example:
        ```bash
        RETRIEVE_KNOWLEDGE_DESCRIPTION="Search engineering runbooks, RFCs, and postmortems."
        LIST_KNOWLEDGE_BASES_DESCRIPTION="List available engineering knowledge bases."
        ```
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

## Usage

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

## Remote transport (optional)

By default the server speaks MCP over stdio — every supported client (Claude Desktop, Codex, Cursor, Continue, Cline) launches it as a child process. Stage 1 of [RFC 008](./docs/rfcs/008-remote-transport.md) adds an opt-in **SSE** transport for browser-based clients, Smithery remote mode, and shared deployments. Stdio is unchanged unless you set `MCP_TRANSPORT`.

```bash
export MCP_TRANSPORT=sse
export MCP_AUTH_TOKEN="$(openssl rand -base64 32)"   # must be ≥32 characters; shorter tokens abort startup
export MCP_ALLOWED_ORIGINS="http://localhost:5173"   # comma-separated; leave unset to deny all browser origins
export MCP_PORT=8765                                  # default
export MCP_BIND_ADDR=127.0.0.1                        # default — loopback only
node build/index.js
```

Endpoints exposed in this mode:

- `GET /health` — unauthenticated liveness probe; returns `200 {"status":"ok"}` only. Per RFC 008 §6.8 it intentionally exposes no version, uptime, or filesystem fingerprint to anonymous callers.
- `GET /sse` — long-lived SSE stream. Requires `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- `POST /messages?sessionId=<uuid>` — JSON-RPC POST per session. Same bearer requirement.

Streamable-HTTP is **not** wired up in stage 1 — `MCP_TRANSPORT=http` is rejected at startup. See RFC 008 §9 for the full rollout plan.

**Security defaults:** the server refuses to start in SSE mode without `MCP_AUTH_TOKEN`, binds only to loopback, and uses a constant-time bearer comparison. Operators exposing the endpoint off-host should set `MCP_BIND_ADDR=0.0.0.0` *and* terminate TLS in a reverse proxy — TLS is out of scope for this server. Only one process per `FAISS_INDEX_PATH` is supported (see [`docs/architecture/threat-model.md`](./docs/architecture/threat-model.md)).

## Troubleshooting & Logging

- Set `LOG_FILE` to capture structured logs (JSON-RPC traffic continues to use stdout). This is especially helpful when diagnosing MCP handshake errors because all diagnostic messages are written to stderr and the optional log file.
- Permission errors when creating or updating the FAISS index are surfaced with explicit messages in both the console and the log file. Verify that the process can write to `FAISS_INDEX_PATH` and the `.index` directories inside each knowledge base.
- Run `npm test` to execute the Jest suite (serialised with `--runInBand`) that covers logger fallback behaviour and FAISS permission handling.

## Security

The server is designed to run as a **local tool**: one user, one machine, one trusted terminal. Two trust boundaries matter in practice. The `$FAISS_INDEX_PATH` directory is a **code-execution boundary** — `FaissStore.load` deserialises the docstore via `pickleparser`, so the directory must only contain files written by this server (no untrusted backups, no shared-write mounts). The `$KNOWLEDGE_BASES_ROOT_DIR` tree is a **content boundary** — its contents are embedded and returned verbatim to the MCP client, so markdown from untrusted sources is a prompt-injection risk for downstream agents. Additionally, only **one server process per `FAISS_INDEX_PATH`** is supported today; running multiple processes against the same index will corrupt it. Full discussion, including provider-key handling and the planned concurrency lockfile, is in [`docs/architecture/threat-model.md`](./docs/architecture/threat-model.md).
