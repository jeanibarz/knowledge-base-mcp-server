# knowledge-base-mcp-server — Agent Instructions

MCP server that exposes two tools — `list_knowledge_bases` and `retrieve_knowledge` — backed by a local FAISS index and a pluggable embedding provider (HuggingFace, Ollama, or OpenAI).

## Working on this repo

### Build / test / run

```bash
npm install
npm run build          # tsc → build/index.js (chmod +x, stdio-executable)
npm test               # jest --runInBand — must stay green
npm run dev            # nodemon src/index.ts for iteration
node build/index.js    # runs the server over stdio (clients launch it this way)
```

### Key architecture

- **Transport:** `StdioServerTransport` in `src/KnowledgeBaseServer.ts`. Server speaks plain JSON-RPC over stdio — any MCP client (Claude Desktop, Codex CLI, Cursor, Continue, Cline) can launch it.
- **Tool surface:** registered in `KnowledgeBaseServer.setupTools()` via the high-level `McpServer.tool(...)` API (see `@modelcontextprotocol/sdk@1.x`).
- **Embeddings:** `FaissIndexManager` picks a provider at construction time based on `EMBEDDING_PROVIDER` (`huggingface` | `ollama` | `openai`). Each provider maps to a `@langchain/*` embeddings class.
- **Index:** one FAISS store (`FaissStore` from `@langchain/community`) persisted at `FAISS_INDEX_PATH`. A sibling `model_name.txt` tracks which model built the index; a provider/model switch triggers auto-rebuild.
- **Indexing strategy:** per-file SHA256 hashes in `<kb>/.index/` decide what to re-embed on each `retrieve_knowledge` call. Hidden files/dirs (dot-prefixed) are skipped.
- **Logging:** `logger.ts` writes **only to stderr** (and optionally `LOG_FILE`). Writing to stdout corrupts the JSON-RPC stream — this is a landed bug, never reintroduce `console.log` inside the server process.

### Conventions

- **TypeScript strict** (`tsconfig.json`). No `any` without justification.
- **Conventional commits** — `feat:`, `fix(scope):`, `docs:`, `chore:` (see `git log` for prior style).
- **RFCs** under `docs/rfcs/NNN-slug.md` for non-trivial design. Drafts are first-class; merging an RFC does not imply implementation — each implementation PR references the RFC it realises.
- **CHANGELOG.md** — add an entry under `## [Unreleased]` for any user-visible change.

### Verification beyond `npm test`

The Jest suite covers logger + FAISS permission handling + utils. It does **not** exercise the live MCP wire protocol or real embedding providers. For changes that touch the tool handlers, the embedding configuration, or the stdio transport, verify end-to-end by:

1. Seeding a temp `KNOWLEDGE_BASES_ROOT_DIR` with a couple of markdown files.
2. Spawning `build/index.js` over stdio from a tiny MCP client (the SDK exposes `Client` + `StdioClientTransport`) with `EMBEDDING_PROVIDER` + the matching API key set.
3. Sending `tools/list` and `tools/call` for both tools and confirming responses.

If a bug or improvement surfaces during that E2E pass, record it as an issue (see below) — it will not be caught by `npm test` alone.

### Obvious-but-out-of-scope findings become GitHub issues

While working on anything in this repo — implementing a feature, reviewing a PR, running an end-to-end check, writing tests — you may notice bugs or improvements that are **obvious and real** but **not in scope for the current change**. Examples: a drifted schema, a deprecated upstream API that still works but is flagged, a missing test for a behaviour adjacent to the one you just touched, a README section that contradicts the code.

**Do not silently absorb these into the current PR.** Instead:

1. Finish the current task first — stay focused on the PR you opened.
2. Open a tracking issue on `jeanibarz/knowledge-base-mcp-server` with:
   - A short title in the form `<area>: <what is wrong or missing>`.
   - A body that captures enough context to act on later without re-deriving: what you saw, where (`file.ts:line` or URL), why it matters, and a suggested fix if obvious.
   - The `enhancement` or `bug` label.
   - Assignee: `jeanibarz`.
   - A link back to the PR or issue that surfaced the finding, so history is connected.
3. If the current PR description has a "Follow-ups" section, also list the new issue number there so reviewers see the handoff.

Rationale: follow-up work evaporates the moment context is lost. An issue preserves the lead; the PR that created it can stay narrow and reviewable. See #21 for an example (HuggingFace SDK v3/v4 migration spun out of #20's minimal endpoint-URL fix).

**Don't** file an issue for:
- Speculative improvements with no concrete evidence ("we could maybe refactor X someday").
- Matters of taste that the existing code consistently follows the other way.
- Anything already tracked by an open issue or RFC (`gh issue list` + `docs/rfcs/` first).

## Gotchas

- **HuggingFace endpoint:** the default now routes through `router.huggingface.co/hf-inference/models/<model>/pipeline/feature-extraction` because HuggingFace retired the legacy `api-inference.huggingface.co/models/...` endpoint. `HUGGINGFACE_ENDPOINT_URL` overrides. See CHANGELOG for context.
- **Model-switch invalidates the index:** changing `EMBEDDING_PROVIDER` or the model env var (`OLLAMA_MODEL`, `HUGGINGFACE_MODEL_NAME`, `OPENAI_MODEL_NAME`) for an existing `FAISS_INDEX_PATH` triggers an auto-rebuild via `FaissIndexManager.initialize()`. Expect a one-time delay on the next `retrieve_knowledge` call while every file is re-embedded.
- **OpenAI not exposed in `smithery.yaml`:** the code supports OpenAI, the Smithery schema does not (`enum: ["huggingface", "ollama"]`). Users deploying via Smithery cannot currently pick OpenAI — tracked for a separate fix.
- **Docs / agent skills** are being designed in `docs/rfcs/002-ai-skills-setup.md`. Until that lands, per-skill runbooks do not exist yet; this CLAUDE.md is the single agent-facing entry point.
