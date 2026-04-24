# 0004 — `MarkdownTextSplitter` as the only splitter

- **Status:** Accepted (interim — recursive-character fallback is a follow-up)
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

**Option 1.** `src/FaissIndexManager.ts:261-275` (and the fallback rebuild's mirror at `:317-332`) branches on `.md` extension:

- `.md` → `MarkdownTextSplitter({ chunkSize: 1000, chunkOverlap: 200, keepSeparator: false })` creates multiple documents preserving markdown structure.
- Anything else → one `Document` wrapping the whole file.

## Pros and Cons

**Pros:**
- Correct markdown structure preservation for the dominant case (headings, lists, code fences split cleanly).
- No config surface; no foot-guns for new users.
- Non-`.md` files still work — just as a single chunk. Small text files will be fine; large non-markdown files will produce one huge vector that reduces retrieval quality.

**Cons:**
- Large non-markdown files (e.g. `.txt` transcripts, `.org` notes, code files) get a single document, which is wrong for retrieval. A `RecursiveCharacterTextSplitter` fallback would be the obvious fix.
- No way to override the chunk size / overlap without forking.
- Duplicated splitter construction between the changed-file branch and the fallback branch (`:261-267` vs `:319-323`). A refactor could hoist it to a helper.

## More Information

- The recursive-character fallback for non-markdown files is a known follow-up; capturing it here so future maintainers see it is an intentional deferral, not an oversight.
- RFC 006 discusses retrieval quality more broadly; the splitter question can move inside that umbrella if the tiered retrieval work lands first.
