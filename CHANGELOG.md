# Changelog

## [Unreleased] — RFC 013 M1+M2 (draft)

### Added (technically breaking — on-disk layout migrates)

- **Multi-model embedding support (RFC 013).** Side-by-side per-model FAISS indexes under `${FAISS_INDEX_PATH}/models/<model_id>/`. Each model is fully isolated; deleting one leaves the others intact. Adding model B does not destroy model A's vectors.
- **Auto-migration from 0.2.x layout.** First 0.3.0 start (or first `kb` invocation) migrates `${PATH}/{faiss.index, model_name.txt}` → `${PATH}/models/<derived_id>/{...}` and writes `active.txt`. Atomic per-`fsp.rename`; ~12 ms measured (RFC §10 E2). Idempotent; crash-safe across renames. Refused if pre-RFC-012 indexes lack `model_name.txt` (clear recovery message — RFC §4.8 + round-1 failure F5).
- **`active.txt`** at the root of `FAISS_INDEX_PATH` (one line, the active `<model_id>`). Resolution precedence: per-call `--model=<id>` / `args.model_name` > `KB_ACTIVE_MODEL` env > `active.txt` > legacy env-var derivation. Single-writer invariant: only `bootstrapLayout`, `kb models set-active`, and `kb models add` (when absent) write it (RFC §4.7 + round-1 failure F7). Robust reader handles BOM + CRLF; hard-fails on regex-fail (round-2 failure N3).
- **`KB_ACTIVE_MODEL` env var.** Process-lifetime override of `active.txt`.
- **`kb models list`** — table of registered models with active marker.
- **`kb models add <provider> <model> [--yes] [--dry-run]`** — TTY-checked cost-estimate prompt for paid providers (round-1 failure F9 — non-TTY without `--yes` exits 2 instantly, never blocks). `.adding` sentinel during the embedding pass; `--force-incomplete` on `kb models remove` recovers from interrupts. First-registered-model auto-promotes to active (round-2 failure N2).
- **`kb models set-active <id>`** — explicit operator command. Warns if `KB_ACTIVE_MODEL` is also set.
- **`kb models remove <id> [--yes] [--force-incomplete]`** — hard delete; refuses to remove the active model. Safe while MCP is running (RFC §10 E6 — `faiss-node` is in-memory after `.load()`).
- **`kb search --model=<id>`** — per-call active-model override.
- **Per-model write locks** at `${PATH}/models/<id>/.kb-write.lock` (RFC §4.6). A long-running `kb models add B` does not block `kb search` against model A.
- **`bootstrapLayout()`** static method on `FaissIndexManager` — module-level Promise cache prevents same-process double-call (round-2 failure N1). Acquires `${PATH}/.kb-migration.lock` for CLI invocations to coordinate with peer migrations.
- New modules: `src/model-id.ts` (deterministic slug derivation), `src/active-model.ts` (sole owner of `models/<id>/` schema + active resolution + atomic `active.txt` writer + `isRegisteredModel` / `listRegisteredModels` predicates).

### Changed (technically breaking)

- **On-disk layout migrated.** Tooling outside this repo that reads `${PATH}/faiss.index/` directly must update for `models/<id>/`. Auto-migration handles the data move; external tooling needs a one-time path update.
- **`MODEL_NAME_FILE` is now per-model** at `${PATH}/models/<id>/model_name.txt`. External tooling reading the root file must update.
- **`FaissIndexManager` constructor** preferred form is `new FaissIndexManager({provider, modelName})`. Legacy zero-arg form `new FaissIndexManager()` is preserved for backward compatibility (env-fallback) but new multi-model code paths use the explicit form.
- **`KnowledgeBaseServer.handleRetrieveKnowledge`** resolves the active model per call and uses a per-`modelId` manager cache. Future M3 PR will surface `model_name` as a `retrieve_knowledge` arg.

### Status

Build clean (`npm run build`). 166 / 185 existing tests pass; 19 layout-shape failures in `FaissIndexManager.test.ts`, `KnowledgeBaseServer.test.ts`, `cli.test.ts` need rebasing for the new `models/<id>/` paths (mechanical update — same test logic, new path prefix). New tests for migration / active-model / model-id are NOT yet written. **Draft PR for design review; test work follows in a focused commit.**

## [0.2.2] — 2026-04-25

### Changed (internal — no surface change)

- **Lock module split (RFC 013 M0).** `src/lock.ts` is split into `src/instance-lock.ts` (PID advisory — `acquireInstanceAdvisory`, `releaseInstanceAdvisory`, `InstanceAlreadyRunningError`, `PID_FILE_PATH_FOR_TESTS`) and `src/write-lock.ts` (`withWriteLock`). The two mechanisms had different lifecycles (long-lived single-instance advisory vs. short-lived per-write coordination) and were conceptually mixed; round-3 of RFC 012 review flagged the boundary nit and deferred it. RFC 013 M0 acts on it now because RFC 013 M1+M2 will narrow the write lock from `FAISS_INDEX_PATH` to `${PATH}/models/<id>/` for per-model isolation, which is cleaner against a single-purpose `write-lock.ts` than a mixed module. **No external API change** — the previous `withWriteLock(fn)` signature changes to `withWriteLock(resource, fn)` with all in-tree callers (KnowledgeBaseServer, ReindexTriggerWatcher path, CLI `--refresh`) passing `FAISS_INDEX_PATH` as the resource for behavior parity. See [`docs/rfcs/013-multimodel-support.md`](./docs/rfcs/013-multimodel-support.md) §4.6.

## [0.2.1] — 2026-04-25

### Fixed

- **`kb` CLI silently exits 0 when invoked via the `npm install -g` symlink.** The 0.2.0 driver guard (`process.argv[1]?.endsWith('/cli.js')`) was correct for direct invocations (`node build/cli.js`, `./build/cli.js`) but failed for the production install path: when invoked through the symlink at `~/.nvm/.../bin/kb`, `process.argv[1]` is the symlink path (ends in `/kb`), not the canonical `cli.js`, so the driver block never ran. Replaced with `realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)` which collapses the symlink and matches in all four cases (direct, shebang, install-g symlink, test import). New regression test exercises the symlink case via `fs.symlink`. RFC 012 §6.2 specified a `npm pack && npm install -g` smoke gate that would have caught this; wiring that into CI is tracked separately.

## [0.2.0] — 2026-04-25

### Added

- **`kb` CLI bin (RFC 012 M1).** A new bin alongside `knowledge-base-mcp-server`, invoked from PATH so updates via `npm install -g @jeanibarz/knowledge-base-mcp-server@latest` are picked up on every invocation — no AI-client (Claude Code, Codex CLI, Cursor, Continue, Cline) restart needed for the operator's fix-and-test loop. Two subcommands: `kb list` and `kb search <query>`. The `search` path defaults to **read-only** (loads the existing FAISS index, runs similarity search, no writes); pass `--refresh` to also re-scan KB files under the write lock. `--stdin` reads the query from stdin (multi-line safe — no shell escaping bugs for AI-agent-generated queries with newlines/quotes). `--format=md` (default) reproduces MCP `retrieve_knowledge`'s wire output plus a single-line freshness footer; `--format=json` returns a structured object with `results`, `index_mtime`, `stale`, `modified_files`, `new_files`. See [`docs/rfcs/012-cli-distribution.md`](./docs/rfcs/012-cli-distribution.md).

- **CLI freshness footer.** Default `kb search` runs a cheap stat-only walk of every KB and emits one of two footers per call: `> _Index up-to-date as of <iso8601>._` or `> _Index may be stale: N modified, M new file(s) since <iso8601>. Run \`kb search --refresh\` to update._`. Mtime source is the inner FAISS binary file (`${FAISS_INDEX_PATH}/faiss.index/faiss.index`), not the directory — directory mtime doesn't update on file overwrites. ~50–100 ms cost added; `--refresh` mode emits "Index refreshed at …" instead.

- **CLI model-mismatch check.** `kb search` reads `model_name.txt` and exits `2` with a clear stderr message if the on-disk index was built with a different embedding model than the CLI's env points at. Closes the silent vector-space-mismatch failure mode that arose from MCP-server `mcp.json` env diverging from shell `~/.bashrc` env. `--refresh` emits a warning instead and proceeds (the existing model-switch path triggers a full re-embed).

- **`FaissIndexManager.initialize({ readOnly?: boolean })`.** Method-level flag. When `true`, suppresses the previously unconditional `model_name.txt` write. `FaissStore.load` is itself read-only, so this is the single seam needed to make the entire init path safe to run alongside a separate writer (e.g. the MCP server) without write-lock contention. The CLI default uses this; MCP and `kb search --refresh` use the unchanged write-path.

- **Atomic `model_name.txt` write.** `FaissIndexManager.initialize` (write path) now writes `model_name.txt` via tmp + atomic rename instead of `fsp.writeFile`. The previous truncate-then-write pattern caused false-positive CLI mismatch errors when a CLI invocation landed in the truncate window of an MCP server's `initialize`.

- **Split-lock coordination via `proper-lockfile` (new dep).** Two distinct mechanisms in `src/lock.ts`:
  - **PID advisory** at `${FAISS_INDEX_PATH}/.kb-mcp.pid`. Acquired atomically with `O_CREAT | O_EXCL` (mode 0o600) by `KnowledgeBaseServer.run()` on startup; released on graceful shutdown. Two concurrent MCP servers against the same `FAISS_INDEX_PATH` are now refused — the second fails-fast with a clear "another instance running (PID N)" message. Stale PID files (recorded PID is dead) are silently overwritten.
  - **Write lock** at `${FAISS_INDEX_PATH}/.kb-write.lock`. Acquired only around `updateIndex` calls inside `KnowledgeBaseServer`, `ReindexTriggerWatcher`, and `kb search --refresh`. Released immediately after. Default `kb search` (read-only) does NOT acquire it. Heartbeat enabled (5 s) so long-running re-embeds aren't false-stale.

- New extracted modules `src/formatter.ts` (markdown/JSON formatters + `sanitizeMetadataForWire`) and `src/kb-fs.ts` (`listKnowledgeBases`). Both surfaces (MCP + CLI) import from them; the CLI no longer drags in MCP-SDK transitive imports just to format output.

### Changed

- **Single MCP-server-per-`FAISS_INDEX_PATH` is now enforced (technically breaking).** The constraint was previously documented in the README and `docs/architecture/threat-model.md` but not enforced. Users who (against documented guidance) ran two MCP servers against the same `FAISS_INDEX_PATH` will now see the second one fail-fast with `InstanceAlreadyRunningError`. No change for users who follow the documented guidance. If you genuinely need two servers, give them separate `FAISS_INDEX_PATH` values.

- `KnowledgeBaseServer.handleRetrieveKnowledge`, the `ReindexTriggerWatcher` callback, and `kb search --refresh` all wrap `updateIndex()` in the new write lock. Behavior is unchanged in the steady state; concurrent writers serialize instead of racing.

- The markdown formatter and `sanitizeMetadataForWire` move from `KnowledgeBaseServer.ts` to `src/formatter.ts`. The old export path is preserved as a re-export for backward compat with existing code that imported from `KnowledgeBaseServer`. MCP wire output is byte-equal to before.

- `package.json` `bin` adds `kb` → `build/cli.js`. The existing `knowledge-base-mcp-server` → `build/index.js` is unchanged. Build script chmods both bins.

## [0.1.2] — 2026-04-25

### Fixed

- **EISDIR on FAISS index recovery (RFC 012 M0).** `FaissIndexManager.initialize()` called `fsp.unlink(indexFilePath)` on the model-switch and corrupt-index recovery branches. Modern `@langchain/community` `FaissStore.save()` writes a *directory* at `indexFilePath` (containing `faiss.index` + `docstore.json`), not a file, so `unlink` threw `EISDIR` and the recovery never ran. Replaced with `fsp.rm(indexFilePath, { recursive: true, force: true })` which handles both the modern directory layout and the legacy single-file layout. Latent bug: only triggered on embedding-model switch or on a corrupt index. Two new tests cover the directory-layout case for both branches; existing tests for the legacy file layout continue to pass. Pre-requisite for RFC 012 M1 (CLI). See [`docs/rfcs/012-cli-distribution.md`](./docs/rfcs/012-cli-distribution.md) §5.1.

## [Unreleased]

### Added

- RFC 011 M4: a dotfile-aware mtime poller (`ReindexTriggerWatcher`) now watches `<KNOWLEDGE_BASES_ROOT_DIR>/.reindex-trigger` and kicks off an `updateIndex(*)` pass whenever the file's mtime advances. External workflows (the arxiv-ingestion n8n flow is the canonical producer) can `touch` the trigger after writing new content, and a running server picks the write up without an explicit `refresh_knowledge_base` call. Poll interval is `REINDEX_TRIGGER_POLL_MS` (default 5000 ms, clamped to `[1000, 60000]`; `0` disables the watcher entirely). The watched path is `REINDEX_TRIGGER_PATH` (default `<ROOT>/.reindex-trigger`). Bursts of rapid touches are coalesced: at most one `updateIndex` runs in flight at a time, with at most one more queued. The first successful stat seeds a baseline — a pre-existing trigger file that predates server startup is NOT treated as "new content landed while we were running". Runs alongside RFC 007 §6.6's `fs.watch` recursive watcher (complementary, not a replacement). `stop()` drains the in-flight callback so SIGINT/SIGTERM shutdown does not race a write. Closes part of RFC 011; see [`docs/rfcs/011-arxiv-backend.md`](./docs/rfcs/011-arxiv-backend.md) §5.5.
- RFC 011 M2: every chunk's metadata now carries a typed `frontmatter` block lifting the arxiv / llm-as-judge schema keys (`arxiv_id`, `title`, `authors`, `published`, `relevance_score`, `ingested_at`, `judge_method`, `metrics_used`, `bias_handling`). `relevance_score` is coerced from its FAILSAFE-YAML string form to a number via `parseInt`; non-numeric values are dropped with a debug log. Any *other* string-valued frontmatter key lands in `frontmatter.extras`, which is **stripped from `retrieve_knowledge` responses by default** — set `FRONTMATTER_EXTRAS_WIRE_VISIBLE=true` to surface extras on the wire. This defaults to the safer posture so a workflow-author typo like `api_key: sk-…` in note frontmatter cannot leak through the MCP boundary. For `.md` files, the server also looks for a sibling PDF at `<kb>/pdfs/<stem>.pdf` (arxiv layout) or `<same-dir>/<stem>.pdf` (colocated layout) and attaches the KB-directory-relative path as `pdf_path` on every chunk. Non-whitelisted YAML arrays / nested maps are dropped (no safe scalar target). `parseFrontmatter` now returns `{ tags, body, frontmatter }` — the new field is additive and existing destructures continue to work. Closes part of RFC 011; see [`docs/rfcs/011-arxiv-backend.md`](./docs/rfcs/011-arxiv-backend.md) §5.4 and §7.1 R1.
- RFC 011 M1: ingest filter that narrows the set of files `FaissIndexManager` feeds to the embedding splitter. Workflow sidecars (`_seen.jsonl`, `_index.jsonl`), log/staging subtrees (`logs/`, `tmp/`, `_tmp/`), OS turds (`.DS_Store`, `Thumbs.db`, `desktop.ini`) and any file whose extension is not in `{.md, .markdown, .txt, .rst}` are now excluded before they reach the chunker. Operators can add more extensions via `INGEST_EXTRA_EXTENSIONS` (comma-separated, leading dot optional) and more exclude globs via `INGEST_EXCLUDE_PATHS` (minimatch syntax, relative to KB root; negation syntax `!pattern` is disabled via `nonegate` to prevent accidental inversion). The base allowlist and base exclusion rules are authoritative — operators can only extend, not remove. **Migration note:** a KB today that contained `_seen.jsonl`, a `logs/` directory, or extensionless files (`README`, `LICENSE`, `Makefile`) will drop those from its embedding corpus on the next `retrieve_knowledge` call. No existing KB in the wild was known to carry such files at time of writing; rename extensionless files with a `.md`/`.txt` suffix if you want them indexed. Closes part of RFC 011; see [`docs/rfcs/011-arxiv-backend.md`](./docs/rfcs/011-arxiv-backend.md) §5.2.
- `package.json` is scoped to `@jeanibarz/knowledge-base-mcp-server` with a new `bin` entry, so `npx -y @jeanibarz/knowledge-base-mcp-server` launches the stdio server once the first version is on npm. A `files` allowlist restricts the published tarball to `build/`, `CHANGELOG.md`, and `UNLICENSE` plus npm's auto-included `README.md` and `package.json`. Partial closure of #41.
- `.github/workflows/release.yml` publishes to npm with `--provenance --access public` on a `v*.*.*` tag push. Requires an `NPM_TOKEN` repository secret; the first publish is a follow-up maintainer action. Closes #41.
- RFC 010 M2: `RETRIEVE_KNOWLEDGE_DESCRIPTION` and `LIST_KNOWLEDGE_BASES_DESCRIPTION` env vars override the built-in tool descriptions, so the same binary can present as "search engineering runbooks" vs. "search personal notes" to different clients without a recompile. Unset/empty falls back to the existing strings — no behaviour change for current deployments. Closes #52.
- RFC 010 M1 foundations: path-traversal guard (`resolveKbPath`), KB-name validator (`isValidKbName` / `assertValidKbName`), frontmatter parser (`parseFrontmatter`), and richer chunk metadata (`tags`, `relativePath`, `chunkIndex`, `extension`, `knowledgeBase`). No user-visible API change. Partial work toward #49, #51, #53, #54.
- Optional SSE transport behind `MCP_TRANSPORT=sse`. Stdio remains the default; setting `MCP_TRANSPORT=sse` plus `MCP_AUTH_TOKEN` exposes the same two tools over an HTTP/SSE endpoint with bearer-token auth, an origin allow-list, and an unauthenticated `GET /health` probe. See the new "Remote transport (optional)" section in the README and [`docs/rfcs/008-remote-transport.md`](./docs/rfcs/008-remote-transport.md) for the full design. Partial closure of #48 — streamable-http follows.
- Ollama embedding provider support as a local alternative to HuggingFace API for embeddings.
- Environment variable configuration for embedding provider selection (`EMBEDDING_PROVIDER`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`).
- End-to-end test evidence file: `ollama-embedding-e2e-results.md`.
- Documentation updates for setup and usage of both embedding providers.
- Benchmark harness under `benchmarks/` with deterministic stub fixtures, JSON output, and a non-blocking CI benchmark job.
- Smithery config now exposes `openai` as a selectable `embeddingProvider`, with `openaiApiKey` / `openaiModelName` config props plumbed through `commandFunction` so Smithery deployments can pick the OpenAI provider the code already supports. (#34)
- Root `.dockerignore` so `docker build` stops copying `node_modules/`, `.git/`, `build/`, `benchmarks/results/`, `.claude/`, `*.log`, and `ollama-embedding-e2e-results.md` into the builder context — faster builds, tighter layer cache. (#36)
- `.github/workflows/test.yml` runs `npm ci && npm run build && npm test` on Node 20 and 24 for every pull request and every push to `main`, so regressions in the Jest suite or `tsc` block merge. (#37)

### Changed

- README now links to a dedicated `docs/clients.md` with setup snippets for Claude Desktop, Codex CLI, Cursor, Continue, and Cline. Closes #38. References #40 (badges only — demo recording pending).
- Refactored embedding logic to support provider abstraction and selection.
- Improved error handling and logging for embedding operations.
- Upgraded `@huggingface/inference` to the v4 client path through a compatible `@langchain/community` release.
- `FaissIndexManager.updateIndex` now saves the FAISS index once per call instead of once per changed file, and writes hash sidecars atomically (tmp + rename) only after the index has persisted successfully. Behavior on the happy path is unchanged; a crash between save and sidecar writes now leaves the unclaimed files to be re-embedded on the next run rather than claiming hashes for vectors that never landed. (RFC 007 PR 1.1)
- Replaced blocking `fs.existsSync` calls in `FaissIndexManager` with non-blocking `fsp.stat`-based checks. (RFC 007 PR 1.1)
- `package.json` license field changed from `UNLICENSED` (SPDX: proprietary) to `Unlicense` (SPDX: public-domain), matching the `UNLICENSE` file already in the repo. Fixes false-positive "proprietary" flags from license scanners. (#32)
- Declared `engines.node >=20` in `package.json` so installs on unsupported Node versions fail fast. README prerequisite bumped from Node 16+ to Node 20+ to match — both 16 and 18 are EOL. (#35)
- Default embedding models upgraded: HuggingFace default is now `BAAI/bge-small-en-v1.5` (was `sentence-transformers/all-MiniLM-L6-v2` from 2021); OpenAI default is now `text-embedding-3-small` (was `text-embedding-ada-002`). Vector dimensions are unchanged (384 for HF, 1536 for OpenAI), so callers downstream of the FAISS store keep working. **Migration impact:** the model-name change trips the auto-rebuild guard in `FaissIndexManager.initialize` (`src/FaissIndexManager.ts:153-164`), so existing indexes will be rebuilt once on the next `retrieve_knowledge` call — expect a one-time delay while every file is re-embedded. No user action required; pin the previous defaults via `HUGGINGFACE_MODEL_NAME` / `OPENAI_MODEL_NAME` if you want to skip the rebuild. (#47)
- `tsconfig.json` now excludes `src/**/*.test.ts` from compilation, so `npm run build` no longer emits compiled Jest test files (and their sourcemaps) into `build/`. Jest keeps running the same suite because `ts-jest` compiles tests from source at test time. With the `files` allowlist from #41, the published tarball drops from ~267 kB to ~122 kB unpacked. (#82)

### Removed

- Deleted stale `src/knowledge-base-server-flow.md` mermaid diagram whose nodes (GCP credentials, stubbed similarity search) no longer match the real provider branch in `FaissIndexManager`. Git history still carries the old diagram if needed. (#33)

### Fixed

- The `threshold` argument on `retrieve_knowledge` now actually filters results by similarity score. Previously the filter was silently dropped by the FAISS vector store (`FaissStore.similaritySearchVectorWithScore` ignores filter arguments), so every request behaved as if `threshold=2` regardless of the caller-supplied value. `FaissIndexManager.similaritySearch` now post-filters `[doc, score]` tuples by `score <= threshold` in the same pass as the KB-scope filter. Closes #72.
- `MCP_ALLOWED_ORIGINS` now normalizes scheme+host case and a single trailing slash before matching the browser-sent `Origin` header. Previously operator config like `https://app.example.com/` (or `Http://Localhost:5173`) silently rejected every real browser request because browsers send the RFC 6454 form. (#77)
- `retrieve_knowledge` now honors its `knowledge_base_name` argument at query time. Previously the name was passed only to the indexer (`FaissIndexManager.updateIndex`), while the similarity search ran over the entire global FAISS store — so results routinely leaked across KBs despite the tool description promising the opposite. `FaissIndexManager.similaritySearch` now post-filters `[doc, score]` tuples by the `source` metadata's KB-path prefix and over-fetches when scoped so up to `k` same-KB hits still surface. Follow-up #72 tracks a related `threshold` arg that turned out to be dead code. (#71)
- Non-markdown text files (`.txt`, `.rst`, source code, logs, …) are now split with `RecursiveCharacterTextSplitter` (same `chunkSize: 1000, chunkOverlap: 200` defaults as the markdown path) instead of being wrapped in a single `Document`. Previously, a large non-markdown file produced one embedding and one retrieval result, collapsing recall to near-zero on any content other than `.md`. (#45)
- A corrupt or unreadable FAISS index file no longer wedges startup. `FaissIndexManager.initialize` now logs a warning, deletes the corrupt `faiss.index` (and its `.json` sidecar, best-effort), and falls through to the existing rebuild path so the next `retrieve_knowledge` call re-embeds from source instead of failing. Previously the only recovery was a manual `rm -rf $FAISS_INDEX_PATH`. (#57)
- Retrieval-quality benchmark now simulates approximate-nearest-neighbor behavior per KB so the `fanout_factor` sweep is actually sensitive across `f ∈ {1, 2, 3, 5, 10}` — exact per-KB search made the sweep collapse to a single value. Baseline regenerated. (RFC 007 PR 0.1, #26)
- Addressed reliability issues (timeouts, hanging) with HuggingFace API by providing a local fallback.
- HuggingFace embedding provider was broken by HuggingFace retiring the legacy
  `api-inference.huggingface.co/models/...` serverless endpoint. Feature-extraction
  calls are now routed through the Inference Providers router at
  `router.huggingface.co/hf-inference/models/<model>/pipeline/feature-extraction`.
  A new `HUGGINGFACE_ENDPOINT_URL` env var lets users override the endpoint
  (e.g. for self-hosted or dedicated HuggingFace Inference Endpoints).
- Added `HUGGINGFACE_PROVIDER` so non-default Inference Providers can be selected without custom glue while preserving `hf-inference` as the default.

---

> For details, see the implementation log and test evidence files included in this release.
