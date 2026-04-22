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
