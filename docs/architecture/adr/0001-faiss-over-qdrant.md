# 0001 — FAISS (embedded) over a standalone vector DB

- **Status:** Accepted
- **Date:** 2026-04-24 (back-documented)
- **Deciders:** Repo owner

## Context and Problem Statement

The server needs a vector store. It must persist across restarts, survive the user wiping its data dir, and work with whatever machine a Claude Desktop / Codex CLI / Cursor user happens to have — which is almost always a laptop without a running database daemon.

## Decision Drivers

- **Zero-deps install.** MCP users launch the server from `npx` or a compiled `node build/index.js`; adding "also run a Docker container" is a non-starter for the primary audience.
- **Local-first privacy.** Users who pick Ollama for embeddings are signalling that data should not leave the machine; a network-shaped vector DB would cut against that.
- **Operational surface area.** A single Node.js process with files on disk is easy to reason about; a separate DB process is one more thing to restart, update, back up, and secure.
- **Good-enough recall at this scale.** Target is thousands of files, tens of MB of index — well within FAISS's embedded sweet spot.

## Considered Options

1. **Embedded FAISS** via `@langchain/community/vectorstores/faiss` + `faiss-node`.
2. **Qdrant** (self-hosted container or Qdrant Cloud).
3. **Chroma** (embedded Python DB behind an HTTP shim, or the newer Rust core).
4. **SQLite + `sqlite-vec`** extension.
5. **DuckDB** with vector extensions.

## Decision Outcome

**Option 1 — embedded FAISS.** Used via `FaissStore` (`src/FaissIndexManager.ts:7`) and persisted to `$FAISS_INDEX_PATH/faiss.index` (`:351`).

## Pros and Cons

**Pros:**
- No daemon, no port, no Docker. `npm install && npm start` works.
- Index is just a file — `rm -rf` is safe reset; `tar` is safe backup.
- First-class LangChain integration (`FaissStore.fromTexts`, `addDocuments`, `similaritySearchWithScore`).

**Cons:**
- Docstore is pickle-serialized (`pickleparser@0.2.1`, `package.json:27`). Loading an attacker-controlled index directory is code-execution-shaped — see [`../threat-model.md`](../threat-model.md).
- No native support for concurrent writers; one process per `$FAISS_INDEX_PATH` (issue #44, [`../threat-model.md`](../threat-model.md)).
- Index files are platform-endian; fixtures cannot be shared across architectures (flagged in RFC 007 §8).
- Deletions are not supported natively (faiss-node) — orphan vectors accumulate until a full rebuild.

## More Information

- RFC 006 (multi-provider tiered retrieval) and RFC 007 (architecture/perf) both assume FAISS; neither proposes replacing it.
- A future RFC may swap the docstore format away from pickle to close the trust-boundary risk without abandoning the embedded-index model.
