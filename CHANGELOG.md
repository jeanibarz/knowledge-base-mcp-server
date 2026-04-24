# Changelog

## [Unreleased]

### Added

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

### Removed

- Deleted stale `src/knowledge-base-server-flow.md` mermaid diagram whose nodes (GCP credentials, stubbed similarity search) no longer match the real provider branch in `FaissIndexManager`. Git history still carries the old diagram if needed. (#33)

### Fixed

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
