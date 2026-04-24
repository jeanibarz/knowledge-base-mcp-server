# Architecture

This folder documents the **knowledge-base-mcp-server as it is today**. Every claim here should resolve to a file and line on the current `main` — if you notice drift, fix the doc in the same PR that changes the code.

## Why this folder exists

`docs/rfcs/` describes *where we're going* — drafts, proposals, decisions still in flight. This folder describes *where we are now*:

| Folder             | Perspective       | Audience                           |
| ------------------ | ----------------- | ---------------------------------- |
| `docs/rfcs/`       | Forward-looking   | Anyone deciding what to build next |
| `docs/architecture/` | Snapshot of `main` | New contributors; external users reasoning about cost / privacy / scale; reviewers checking that a PR doesn't silently contradict the model |

C4 + ADR + sequence/state/data views are the pragmatic minimum for a 6-file codebase. All diagrams are mermaid (renders in GitHub).

## Reading order

If you've never seen this repo before, read top-to-bottom:

1. [`c4-context.md`](./c4-context.md) — one page. Who talks to the server, what it touches on disk, where the trust boundaries are.
2. [`c4-container.md`](./c4-container.md) — the process and its two on-disk stores (`FAISS_INDEX_PATH`, `KNOWLEDGE_BASES_ROOT_DIR`) as independent containers with different lifecycles.
3. [`c4-component.md`](./c4-component.md) — the five TypeScript modules inside the server process and how they depend on each other.
4. [`sequence-retrieve.md`](./sequence-retrieve.md) — `retrieve_knowledge` end-to-end, cold and warm.
5. [`sequence-reindex.md`](./sequence-reindex.md) — what happens when `EMBEDDING_PROVIDER` or the model env var changes under an existing index.
6. [`state-index.md`](./state-index.md) — the FAISS-index lifecycle (None → Loading → Loaded → Rebuilding → Recovering).
7. [`data-model.md`](./data-model.md) — on-disk artifacts and the chunk metadata schema.
8. [`qa-budgets.md`](./qa-budgets.md) — latency / memory / cost budgets and the current scale ceiling.
9. [`threat-model.md`](./threat-model.md) — trust boundaries, provider keys, concurrency constraint, path-traversal plan.
10. [`adr/`](./adr/) — five decisions in MADR 3.0 format (`0001` faiss-over-qdrant, `0002` per-file-hash-sidecars, `0003` stdio-only-transport, `0004` markdown-splitter-default, `0005` auto-rebuild-on-model-change).

## Conventions

- **Every architectural claim is anchored.** Write `src/FaissIndexManager.ts:153-164` inline, not "somewhere in `FaissIndexManager`". If a reviewer can't click through, the doc is not load-bearing.
- **Every diagram is mermaid.** No PNGs, no ASCII art except in code blocks that explain a mermaid snippet.
- **Each doc stays under 250 lines** (ADRs under 100). Tight text + one diagram + one table > walls of prose.
- **Drift is a bug.** A PR that changes code under `src/` and leaves an anchor stale here should be reviewed the same way as a failing test.

## What this folder does NOT contain

- **Proposals** — they go in `docs/rfcs/`.
- **API reference** — the MCP tool surface is registered in `src/KnowledgeBaseServer.ts:33-50` and described one level up, in the repo root `README.md`.
- **Runbooks or agent skills** — designed in `docs/rfcs/002-ai-skills-setup.md`; until that lands, agent-facing guidance lives in the repo root `CLAUDE.md`.
