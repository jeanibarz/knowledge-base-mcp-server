# 0004 — `MarkdownTextSplitter` as the only splitter

- **Status:** Superseded by recursive-character fallback and chunk-size flags
- **Date:** 2026-04-24 (back-documented)
- **Deciders:** Repo owner

## Context and Problem Statement

Source files must be chunked before embedding. The splitter choice controls chunk boundaries, chunk sizes, and how well downstream similarity search preserves semantic units (headings, list items, code fences).

## Decision Drivers

- **Markdown is the dominant file type.** The README (`README.md:180`) explicitly expects `.md` and `.txt`. Most target use cases (project docs, personal notes, wikis) are markdown.
- **Zero-config for common cases.** Users shouldn't have to reason about splitter selection on day one.
- **LangChain-native.** Swapping in a custom splitter later shouldn't require a major-version bump.
- **Chunk size / overlap tuning.** Want reasonable defaults; 1000 / 200 is conventional for sentence-transformers-class embeddings.

## Considered Options

1. **`MarkdownTextSplitter` for `.md`, one-document-per-file for everything else** — current.
2. **`RecursiveCharacterTextSplitter`** everywhere.
3. **Configurable splitter per file extension** via an env-loaded map.
4. **No splitting** — embed full file contents as one document.

## Decision Outcome

**Original outcome: option 1.** Markdown used `MarkdownTextSplitter`; other
files were single documents.

**Current outcome:** `src/file-ingest.ts` builds chunks for every ingestable file.
Markdown still uses `MarkdownTextSplitter`, while non-markdown text extracted
from `.txt`, `.rst`, `.html`, `.pdf` when explicitly enabled, and operator-added
extensions uses `RecursiveCharacterTextSplitter`. `KB_CHUNK_SIZE` and
`KB_CHUNK_OVERLAP` control the shared chunking constants.

## Pros and Cons

**Pros:**
- Correct markdown structure preservation for the dominant case.
- Large non-markdown files are split instead of becoming one huge vector.
- Operators can tune chunk size/overlap without forking.

**Cons:**
- Chunking is now a broader ingest concern rather than a markdown-only decision;
  future splitter changes should update `src/file-ingest.ts` and
  `docs/feature-flags.md` together.

## More Information

- The recursive-character fallback for non-markdown files has landed.
- RFC 006 discusses retrieval quality more broadly; the splitter question can move inside that umbrella if the tiered retrieval work lands first.
