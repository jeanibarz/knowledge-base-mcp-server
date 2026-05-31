# knowledge-base-mcp-server — Agent Instructions

Local-first knowledge-base MCP server and `kb` CLI backed by embedded FAISS indexes and pluggable embedding providers (HuggingFace, Ollama, or OpenAI).

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

- **Transport:** `src/KnowledgeBaseServer.ts` starts stdio by default and can opt into SSE or streamable HTTP via `MCP_TRANSPORT`. HTTP/SSE mode requires `MCP_AUTH_TOKEN` and defaults to loopback.
- **MCP tool surface:** tools are registered in `KnowledgeBaseServer.registerTools()`. Current tools include `list_knowledge_bases`, `retrieve_knowledge`, `ask_knowledge`, `list_models`, `kb_stats`, `diff_index`, `add_document`, `delete_document`, and `reindex_knowledge_base`.
- **CLI surface:** `src/cli.ts` is the `kb` dispatcher. Command-specific behavior lives in `src/cli-*.ts`; shared command-independent logic belongs in `*-core.ts` helpers.
- **Embeddings:** `FaissIndexManager` is constructed for a concrete `(provider, modelName)` pair. Provider defaults come from `EMBEDDING_PROVIDER` plus provider-specific model env vars.
- **Index layout:** `$FAISS_INDEX_PATH/active.txt` selects a model id. Each model stores metadata and versioned FAISS data under `$FAISS_INDEX_PATH/models/<model_id>/`; `active-model.ts` is the layout authority.
- **Indexing strategy:** per-file SHA256 and chunk manifests in `<kb>/.index/` decide what to re-embed. Mutating refreshes use per-model write locks plus versioned atomic saves.
- **Logging:** `logger.ts` writes **only to stderr** (and optionally `LOG_FILE`). Writing to stdout corrupts the JSON-RPC stream — this is a landed bug, never reintroduce `console.log` inside the server process.

### Conventions

- **TypeScript strict** (`tsconfig.json`). No `any` without justification.
- **Conventional commits** — `feat:`, `fix(scope):`, `docs:`, `chore:` (see `git log` for prior style).
- **RFCs** under `docs/rfcs/NNN-slug.md` for non-trivial design. Drafts are first-class; merging an RFC does not imply implementation — each implementation PR references the RFC it realises.

### Verification beyond `npm test`

The Jest suite is broad but still does **not** exercise every live MCP wire path or real embedding provider. For changes that touch tool handlers, embedding configuration, or transports, verify end-to-end by:

1. Seeding a temp `KNOWLEDGE_BASES_ROOT_DIR` with a couple of markdown files.
2. Spawning `build/index.js` over stdio from a tiny MCP client (the SDK exposes `Client` + `StdioClientTransport`) with `EMBEDDING_PROVIDER` plus the matching API key or local daemon set.
3. Sending `tools/list` and representative `tools/call` requests for the changed tools.
4. For HTTP/SSE changes, run `npm run dev:remote -- --transport=http` or `--transport=sse`.

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

- **HuggingFace endpoint:** the default now routes through `router.huggingface.co/hf-inference/models/<model>/pipeline/feature-extraction` because HuggingFace retired the legacy `api-inference.huggingface.co/models/...` endpoint. `HUGGINGFACE_ENDPOINT_URL` overrides.
- **Model-switch no longer wipes the active index:** multi-model support stores each `(provider, model)` under its own `models/<id>/` directory. `kb models add` builds additional models side by side; `kb models set-active` changes the default.
- **OpenAI not exposed in `smithery.yaml`:** the code supports OpenAI, the Smithery schema does not (`enum: ["huggingface", "ollama"]`). Users deploying via Smithery cannot currently pick OpenAI — tracked for a separate fix.
- **Docs / agent skills** have historical design notes in `docs/rfcs/002-ai-skills-setup.md`, but this `CLAUDE.md`, `README.md`, and `docs/architecture/` are the current repo-facing entry points.
- **KB-author guidance** — when writing notes the server is meant to retrieve, see `docs/authoring-knowledge.md`. It documents chunker constants, the frontmatter whitelist, content-boundary risk, and the dense vs. lexical vs. hybrid retrieval trade-offs an author can lean into.
