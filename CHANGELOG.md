# Changelog

## [Unreleased]

### Added

- Ollama embedding provider support as a local alternative to HuggingFace API for embeddings.
- Environment variable configuration for embedding provider selection (`EMBEDDING_PROVIDER`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`).
- End-to-end test evidence file: `ollama-embedding-e2e-results.md`.
- Documentation updates for setup and usage of both embedding providers.
- Benchmark harness under `benchmarks/` with deterministic stub fixtures, JSON output, and a non-blocking CI benchmark job.

### Changed

- Refactored embedding logic to support provider abstraction and selection.
- Improved error handling and logging for embedding operations.
- Upgraded `@huggingface/inference` to the v4 client path through a compatible `@langchain/community` release.
- `FaissIndexManager.updateIndex` now saves the FAISS index once per call instead of once per changed file, and writes hash sidecars atomically (tmp + rename) only after the index has persisted successfully. Behavior on the happy path is unchanged; a crash between save and sidecar writes now leaves the unclaimed files to be re-embedded on the next run rather than claiming hashes for vectors that never landed. (RFC 007 PR 1.1)
- Replaced blocking `fs.existsSync` calls in `FaissIndexManager` with non-blocking `fsp.stat`-based checks. (RFC 007 PR 1.1)
- `package.json` license field changed from `UNLICENSED` (SPDX: proprietary) to `Unlicense` (SPDX: public-domain), matching the `UNLICENSE` file already in the repo. Fixes false-positive "proprietary" flags from license scanners. (#32)

### Removed

- Deleted stale `src/knowledge-base-server-flow.md` mermaid diagram whose nodes (GCP credentials, stubbed similarity search) no longer match the real provider branch in `FaissIndexManager`. Git history still carries the old diagram if needed. (#33)

### Fixed

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
