# Changelog

## [Unreleased]

### Added

- Ollama embedding provider support as a local alternative to HuggingFace API for embeddings.
- Environment variable configuration for embedding provider selection (`EMBEDDING_PROVIDER`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`).
- End-to-end test evidence file: `ollama-embedding-e2e-results.md`.
- Documentation updates for setup and usage of both embedding providers.

### Changed

- Refactored embedding logic to support provider abstraction and selection.
- Improved error handling and logging for embedding operations.

### Fixed

- Addressed reliability issues (timeouts, hanging) with HuggingFace API by providing a local fallback.

---

> For details, see the implementation log and test evidence files included in this release.
