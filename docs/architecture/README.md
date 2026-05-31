# Architecture

This folder documents the **knowledge-base-mcp-server as it is today**. Every claim here should resolve to a file and line on the current `main` — if you notice drift, fix the doc in the same PR that changes the code.

## Why this folder exists

`docs/rfcs/` describes *where we're going* — drafts, proposals, decisions still in flight. This folder describes *where we are now*:

| Folder             | Perspective       | Audience                           |
| ------------------ | ----------------- | ---------------------------------- |
| `docs/rfcs/`       | Forward-looking   | Anyone deciding what to build next |
| `docs/architecture/` | Snapshot of `main` | New contributors; external users reasoning about cost / privacy / scale; reviewers checking that a PR doesn't silently contradict the model |

C4 + ADR + sequence/state/data views are the pragmatic minimum for this small MCP server. All diagrams are mermaid (renders in GitHub).

## Reading order

If you've never seen this repo before, read top-to-bottom:

1. [`c4-context.md`](./c4-context.md) — one page. Who talks to the server, what it touches on disk, where the trust boundaries are.
2. [`c4-container.md`](./c4-container.md) — the process and its two on-disk stores (`FAISS_INDEX_PATH`, `KNOWLEDGE_BASES_ROOT_DIR`) as independent containers with different lifecycles.
3. [`c4-component.md`](./c4-component.md) — the TypeScript modules inside the server process and CLI, plus how they depend on each other.
4. [`sequence-retrieve.md`](./sequence-retrieve.md) — `retrieve_knowledge` end-to-end, including dense/hybrid retrieval, refresh, cache, gate, and reranker behavior.
5. [`sequence-reindex.md`](./sequence-reindex.md) — forced rebuild and model-selection behavior under the current multi-model layout.
6. [`sequence-research-collect.md`](./sequence-research-collect.md) — `kb research collect` end-to-end: planner, per-shelf hybrid search loop, and atomic artifact writes.
7. [`sequence-feedback-promote.md`](./sequence-feedback-promote.md) — `kb feedback add` (append to ledger) and `kb feedback promote` (materialise into a `kb eval` fixture).
8. [`state-index.md`](./state-index.md) — the per-model FAISS-index lifecycle from construction through load, build, update, rebuild, recovery, and failure.
9. [`data-model.md`](./data-model.md) — on-disk artifacts and the chunk metadata schema.
10. [`qa-budgets.md`](./qa-budgets.md) — latency / memory / cost budgets and the current scale ceiling.
11. [`threat-model.md`](./threat-model.md) — trust boundaries, provider keys, remote transport posture, path validation, and concurrency behavior.
12. [`adr/`](./adr/) — accepted decisions plus superseded historical decisions. Older ADRs remain useful context, but each file should say when a later RFC or implementation changed the active behavior.

## Conventions

- **Every architectural claim is anchored.** Write `src/FaissIndexManager.ts:153-164` inline, not "somewhere in `FaissIndexManager`". If a reviewer can't click through, the doc is not load-bearing.
- **Every diagram is mermaid.** No PNGs, no ASCII art except in code blocks that explain a mermaid snippet.
- **Each doc stays under 250 lines** (ADRs under 100). Tight text + one diagram + one table > walls of prose.
- **Drift is a bug.** A PR that changes code under `src/` and leaves an anchor stale here should be reviewed the same way as a failing test.
- **Check anchors locally.** Run `npm run docs:check-anchors` before review to report stale file-line and symbol anchors. It is warning-only while historical drift remains; use `npm run docs:check-anchors -- --strict` when you want stale anchors to fail the command.

## What this folder does NOT contain

- **Proposals** — they go in `docs/rfcs/`.
- **API reference** — the MCP tool surface is registered in `src/KnowledgeBaseServer.ts` and described one level up, in the repo root `README.md`.
- **Runbooks or agent skills** — operational runbooks live under `docs/operations/`; agent-facing repo guidance lives in the repo root `CLAUDE.md`.
