# RFC 011 — arxiv-backend: operational KB for the local-research-agent ingestion pipeline

- **Status:** Draft — awaiting approval
- **Author:** Jean Ibarz (drafted by automation)
- **Target:** `jeanibarz/knowledge-base-mcp-server` `main`
- **Related:** RFC 006 (multi-provider fusion — embedding provider plurality), RFC 007 (architecture & performance — per-KB indexes, file watcher, `refresh_knowledge_base` tool), RFC 009 (error taxonomy — `PROVIDER_UNAVAILABLE` / `PROVIDER_TIMEOUT` codes), RFC 010 (MCP surface v2 — `resolveKbPath`, `parseFrontmatter`, chunk metadata, metadata filters, Resources, `kb_stats`, ingest tools)
- **References (GitHub issues):** none yet — this RFC is the first tracked artifact

## 1. Summary

An external ingestion pipeline in `jeanibarz/local-research-agent` (n8n workflow `arxiv-ingestion`, branch `feat/arxiv-ingestion-workflow`) now populates two knowledge bases — `arxiv-llm-inference` (5 papers as of 2026-04-24) and `llm-as-judge` (currently ingesting as of 2026-04-25) — with a layout this server does not know how to serve. Each KB contains `notes/<arxiv_id>.md` (YAML-frontmatter + structured sections), `pdfs/<arxiv_id>.pdf` (2–22 MB raw PDFs), `_seen.jsonl` (ledger), and `logs/<date>.log`. The server's current file walker (`src/utils.ts:19-47`) picks up every non-dotfile entry under a KB, so `_seen.jsonl` and daily logs get embedded as search corpus, and multi-megabyte PDFs are read into a `MarkdownTextSplitter` that was never intended to chunk binary content. Meanwhile, `retrieve_knowledge` has been wedged for every caller: the currently-configured embedding provider (Ollama on `localhost:11434`, model `nomic-embed-text:latest` per `~/knowledge_bases/.faiss/model_name.txt`) is unreachable — `curl -sS http://localhost:11434/api/tags` returns `Connection refused` — and the catch block at `src/KnowledgeBaseServer.ts:136` surfaces this as a three-word prose string `fetch failed` with no indication of *which* backend failed or what the operator should do about it. `list_knowledge_bases` continues to work because it never touches the embedding provider (`src/KnowledgeBaseServer.ts:69-89` reads the filesystem directly).

This RFC proposes five co-designed primitives that turn the server into an operational backend for the arxiv workflow, without re-litigating decisions that belong to RFCs 006/007/009/010:

1. **Ingest filters** — a per-KB exclude contract (`_seen.jsonl`, `logs/**`, plus an extension allowlist) so the walker only feeds text to the splitter. §5.2.
2. **PDF policy: sidecar, not corpus** — PDFs are listed, addressable via `kb://` Resources (RFC 010 §5.3), and surfaced as `pdf_path` metadata on the companion note's chunks, but **are not text-extracted or embedded in v1**. The arxiv pipeline already produces the searchable view (the `.md` note); re-deriving it from the PDF is duplicated work and a parser-dependency risk. §5.3.
3. **First-class frontmatter metadata** — extend the RFC 010 M1 chunk-metadata shape with a `frontmatter` blob (structured whitelist of `arxiv_id`, `title`, `authors`, `published`, `relevance_score`, plus the `llm-as-judge`-specific keys), and add filter predicates (`published_after`, `published_before`, `min_relevance_score`, `arxiv_id`) that compose with RFC 010 §5.6's `extensions`/`path_glob`/`tags`. §5.4.
4. **Reindex-trigger watcher** — the workflow `touch`es `~/knowledge_bases/.reindex-trigger` on every successful paper write. v1 ships a dotfile-aware mtime poller that complements RFC 007 §6.6's `fs.watch` watcher (which, per `getFilesRecursively`'s dotfile skip, would not see the trigger today). §5.5.
5. **Graceful provider-unavailable mode** — when the embedding provider refuses to connect, `retrieve_knowledge` must (a) emit the RFC 009 `PROVIDER_UNAVAILABLE` code with an operator hint naming the unreachable backend, and (b) optionally fall back to a metadata-only answer (return files matching `{tags, arxiv_id, min_relevance_score, path_glob}` without similarity search) so callers that only asked for a frontmatter-scoped list get useful output. §5.6.

Non-exhaustive list of things this RFC **does not do**: embed PDFs, add BM25, replace RFC 009's serialization, redesign RFC 010's `add_document` tool, extract a new vector store, or change the arxiv workflow. It is a docs-only change — implementation lands after approval as six additive PRs (M1–M6, §8) that each reference this RFC.

## 2. Motivation

### 2.1 The `fetch failed` reproduction

The reproduction runs against the currently-deployed MCP server (the one registered in the user's Claude Code config, launching `build/index.js` over stdio). Two real tool calls:

```text
# Call 1 — works:
tools/call list_knowledge_bases → [
  "arxiv-llm-inference", "autonomous-agent", "claude-code-notes",
  "doc_onshape", "llm-as-judge", "test_kb"
]

# Call 2 — fails:
tools/call retrieve_knowledge { query: "sparse attention KV cache quantization",
                                knowledge_base_name: "arxiv-llm-inference" }
→ Error retrieving knowledge: fetch failed
```

The divergence between the two is what `src/KnowledgeBaseServer.ts` codifies:

- `handleListKnowledgeBases` (`src/KnowledgeBaseServer.ts:69-89`) calls `fsp.readdir(KNOWLEDGE_BASES_ROOT_DIR)` and returns the filtered list. It never touches an embedding provider.
- `handleRetrieveKnowledge` (`src/KnowledgeBaseServer.ts:91-139`) first awaits `this.faissManager.updateIndex(...)` (line 101), which walks new/changed files and calls `addDocuments` / `fromTexts` — both of which invoke `embedDocuments`. On a fresh worktree with no changed files, update still succeeds, but the subsequent `similaritySearch` (line 105) invokes `embedQuery`, which also hits the provider. The first provider call on a cold day will be in one of those two paths; either way, it reaches out over HTTP.

The operator reality (as of 2026-04-25): `EMBEDDING_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://localhost:11434` (the default at `src/config.ts:37`), and `~/knowledge_bases/.faiss/model_name.txt` contains `nomic-embed-text:latest`. A direct probe:

```
$ curl -sS --max-time 3 http://localhost:11434/api/tags
curl: (7) Failed to connect to localhost port 11434 after 0 ms: Connection refused
```

Ollama was removed in the prior system crash (see `~/git/local-research-agent/docs/progress.md` 2026-04-24 entry). The `undici` HTTP client used by `@langchain/ollama` wraps `ECONNREFUSED` as `TypeError: fetch failed` with the `cause` chain carrying the underlying `AggregateError` / `ConnectError`. The catch at `src/KnowledgeBaseServer.ts:131-138` discards the cause and prepends `Error retrieving knowledge: `, giving the client exactly `fetch failed` with no indication of which backend is unreachable.

**What the operator needs to know but cannot deduce from the wire:** (a) that the failing backend is Ollama at `localhost:11434`, not HuggingFace or OpenAI; (b) whether the failure is transient (DNS flake, daemon restart) or permanent (daemon uninstalled); (c) what action fixes it (start Ollama, pull `nomic-embed-text`, or `EMBEDDING_PROVIDER=huggingface` with `HUGGINGFACE_API_KEY=…`). Today they get none of that.

RFC 009 already designs the wire-level answer: `PROVIDER_UNAVAILABLE` with `transient: true` and a `hint` field naming the backend and a recovery action (RFC 009 §5.2, row `PROVIDER_UNAVAILABLE`). RFC 009 M2 classifies the catch at `src/FaissIndexManager.ts:388-396` via `classifyProviderError` (RFC 009 §5.7, bottom row). This RFC does not duplicate that work; it **requires** RFC 009 M2 (or its equivalent hand-classification) as a dependency of M6 so the arxiv operator sees a useful error when the stack is half-booted. §7.3 records the coordination branch.

### 2.2 The layout mismatch — what the walker sees vs. what it should serve

The real on-disk layout for `arxiv-llm-inference` on 2026-04-25:

```
~/knowledge_bases/arxiv-llm-inference/
├── .index/                            # per-file SHA256 sidecars (FaissIndexManager)
├── _seen.jsonl                         # ledger: {id, seen_at, status} per line
├── logs/2026-04-24.log                 # empty today, but the workflow writes here
├── notes/
│   ├── 2604.21215.md  (frontmatter + sections)
│   ├── 2604.21221.md
│   ├── 2604.21254.md
│   ├── 2604.21602.md
│   └── 2604.21645.md
└── pdfs/
    ├── 2604.21215.pdf  (416 KiB – 22 MiB range observed)
    ├── 2604.21221.pdf
    ├── 2604.21254.pdf
    ├── 2604.21602.pdf
    └── 2604.21645.pdf
```

`src/utils.ts:getFilesRecursively` (`src/utils.ts:19-47`) skips only dot-prefixed entries (line 28). `_seen.jsonl` is **not** dot-prefixed, and neither is `logs/` — both get walked today. Three concrete consequences:

1. **Log noise in the embedding corpus.** `logs/2026-04-24.log` is currently empty on the sample KBs, but the workflow writes ingest run notes here. A half-full log looking like `2026-04-25T01:03 ingested 2604.21564` would be chunked by `MarkdownTextSplitter` (`src/FaissIndexManager.ts:226-234` chooses the markdown splitter because the extension test is `.md`; for `.log` it falls through to `RecursiveCharacterTextSplitter` — not skipped), embedded, and returned as a hit when the operator queries "what did we ingest yesterday". That is not a KB-level answer; that's an operator-stderr concern.
2. **Ledger pollution.** `_seen.jsonl`'s lines match `{"id":"2604.21645","seen_at":"2026-04-24T22:37:01.985Z","status":"ingested"}` — compact JSON; the splitter will happily one-chunk it. Every retrieval hits this file with a low-relevance chunk consisting of `arxiv_id` tokens that *also* appear in the real notes, skewing similarity.
3. **Binary PDF through a text splitter.** `FaissIndexManager.buildChunkDocuments` (`src/FaissIndexManager.ts:219-258`) routes any non-`.md` extension through `RecursiveCharacterTextSplitter`. For a `.pdf`, `fsp.readFile(filePath, 'utf-8')` (`src/FaissIndexManager.ts:318`) reads the binary as a UTF-8 string — corrupting multi-byte sequences into U+FFFD replacement chars — and the splitter chunks the garbage. A 22 MiB PDF becomes ~22 000 one-KiB chunks of mostly-replacement-character text, each one embedded via a separate provider call. On a 5-paper KB this is the difference between "5 × 1 chunk" and "5 × ~1500 chunks of noise" at ingest, and every retrieval call then has to overfetch through that noise.

The server has never been exercised against a KB with this shape. Today's KBs (`claude-code-notes`, `doc_onshape`) contain only `.md` at the top level — no nested `pdfs/`, no sidecar JSONL, no daily logs. The arxiv workflow is the first producer to put pressure on the walker's exclusion rules, and the rules do not exist yet.

### 2.3 Frontmatter is already structured — but the server discards it

The arxiv workflow writes notes with rich YAML frontmatter:

```yaml
---
arxiv_id: 2604.21221
title: "Sparse Forcing: Native Trainable Sparse Attention for Real-time Autoregressive Diffusion Video Generation"
authors: "Boxun Xu, Yuming Du, Zichang Liu, Siyu Yang, Ziyang Jiang"
published: 2026-04-23
tags: ["kv-cache", "quantization", "fine-tuning", "benchmarking"]
relevance_score: 7
ingested_at: 2026-04-24T22:42:27.567Z
---
```

`llm-as-judge` additionally carries `judge_method`, `metrics_used`, `bias_handling`, `practical_takeaways` — but **as `##` sections inside the body**, not frontmatter fields (verified against `~/knowledge_bases/llm-as-judge/notes/2604.21564.md`). The frontmatter for both KBs shares the same seven keys; the body differs.

`src/utils.ts:parseFrontmatter` (`src/utils.ts:159-212`, landed for RFC 010 M1) extracts `tags` only and returns `{ tags, body }` — every other frontmatter key is parsed by `js-yaml` and then discarded. The discarded fields are exactly the ones an agent needs to slice the corpus:

- "Which kv-cache papers rank above relevance 7?" — needs `tags` *and* `relevance_score`.
- "Show me the llm-as-judge papers published since April 20th." — needs `published`.
- "What have we ingested today?" — needs `ingested_at`.
- "Open the PDF for 2604.21221." — needs `arxiv_id` plus a path-to-PDF convention.

Extending `parseFrontmatter` to capture more than `tags` is cheap (the YAML is already parsed at `src/utils.ts:191`); the design work is (a) what shape the extracted blob takes, (b) how it rides through `ChunkMetadata`, (c) how filters compose on top, and (d) how the hit formatter at `src/KnowledgeBaseServer.ts:111-119` surfaces the structured fields without regressing the generic-metadata dump that existing tests assert on. §5.4 proposes the minimal coherent answer.

### 2.4 RFC 010 handles the surface; RFC 011 handles the content

RFC 010 M1 (authoritative for chunk-metadata per its §5.1.3) adds six fields to every chunk: `{source, knowledgeBase, relativePath, extension, tags, chunkIndex}`. It does **not** lift arbitrary frontmatter into metadata — only `tags` — and it does not know about sibling-file conventions (PDF next to MD with matching basename). RFC 010 M4 (metadata filters) gives us `extensions`/`path_glob`/`tags` — useful, but does not know `published_after` or `min_relevance_score`. RFC 010 M5 (Resources) lists files via `kb://<kb>/<path>` with a mimetype allowlist that explicitly excludes `.pdf` (RFC 010 §5.3.3) — *correct* for the "reads text over the wire" path but *wrong* for a pipeline where PDFs are useful-to-list-even-if-we-don't-read-them.

This RFC sits on top of RFC 010:

| Concern | RFC 010 says | RFC 011 extends with |
| --- | --- | --- |
| Chunk metadata | `{source, knowledgeBase, relativePath, extension, tags, chunkIndex}` | adds optional `frontmatter: {arxiv_id?, title?, authors?, published?, relevance_score?, …}` and `pdf_path?` (§5.4) |
| Retrieval filters | `extensions`, `path_glob`, `tags` (AND semantics) | adds `published_after`, `published_before`, `min_relevance_score`, `arxiv_id` (§5.4.4) |
| Resources mimetype map | `.md/.txt/.json/.csv/.html/.xml/.yaml` only (refuses `.pdf`) | extends with `.pdf → application/pdf` as a list-but-refuse-read entry (§5.3) |
| Ingest tools | `add_document`/`delete_document`/`refresh_knowledge_base` operate on text | `delete_document` learns to handle sibling-PDF removal (§5.3) |
| File watcher | RFC 007 §6.6 `fs.watch({recursive:true})` (on-by-default on supported platforms) | adds dotfile-trigger poller that sees `~/knowledge_bases/.reindex-trigger` (§5.5) |
| Error codes | RFC 009 `PROVIDER_UNAVAILABLE` / `PROVIDER_TIMEOUT` | adds a metadata-only fallback path gated by a new `METADATA_ONLY_ON_PROVIDER_DOWN` env flag (§5.6) |

No overlap with RFC 010 is re-implemented. Overlaps explicitly called out in §5.8.

## 3. Goals

- **G1.** `retrieve_knowledge` against an arxiv-shaped KB never embeds `_seen.jsonl`, `logs/**`, or any `.pdf` bytes. The walker refuses them at the filter layer, not at the splitter layer.
- **G2.** Every `.md` hit carries the note's frontmatter as structured metadata so a calling agent can render `{arxiv_id, title, relevance_score, tags}` without re-parsing the chunk body.
- **G3.** `retrieve_knowledge` accepts new predicates (`published_after`, `published_before`, `min_relevance_score`, `arxiv_id`) that compose with RFC 010's `extensions`/`path_glob`/`tags` via AND semantics (same contract as RFC 010 §5.6.2).
- **G4.** Every `.md` hit whose basename has a matching sibling `../pdfs/<basename>.pdf` carries a `pdf_path` metadata field so callers can open the PDF directly (e.g. via `resources/read` once M5 lifts the PDF refusal, or via a dedicated UX).
- **G5.** The MCP response to a `retrieve_knowledge` that hits an unreachable provider is actionable: `PROVIDER_UNAVAILABLE` code, a hint naming the backend URL, and — when `METADATA_ONLY_ON_PROVIDER_DOWN=true` — a metadata-only fallback result set when the query has at least one metadata filter.
- **G6.** The arxiv workflow's `touch ~/knowledge_bases/.reindex-trigger` on paper-write is noticed by the server within `REINDEX_TRIGGER_POLL_MS` (default 5000), without the user having to shell into `refresh_knowledge_base`.
- **G7.** No change to the wire contract of `list_knowledge_bases` and no breaking change to `retrieve_knowledge` (new fields are additive; existing clients continue to work).

## 4. Non-goals

- **NG1 — PDF text extraction.** The arxiv workflow already writes a `.md` note summarizing each PDF; re-extracting the PDF text inside the server (pdf-parse, pdfjs-dist, etc.) adds a ~2 MB dependency, forks the canonical summary source, and trades a server binary size increase for information the KB already has. §6.1 covers the trade-off. When a future use case needs PDF-content retrieval (OCR'd figures, captions, equations), a dedicated RFC proposes the extractor.
- **NG2 — Rewriting the arxiv ingestion workflow.** `arxiv-ingestion.json` belongs to `local-research-agent`. This RFC treats its output layout as a contract and reads it, not writes it. Changes to the workflow are out of scope; the only cross-repo coupling is (a) exclusion rules match the workflow's sidecar filenames (§5.2) and (b) the trigger path `~/knowledge_bases/.reindex-trigger` is a documented integration point (§5.5) that both repos reference.
- **NG3 — BM25 / lexical fallback.** `@langchain/community/retrievers/bm25` is installed transitively (RFC 006 §2.3), but implementing a retriever-fusion path is RFC 006's territory. §5.6's metadata-only fallback is **structured-filter-only** — no free-text scoring — so a caller with no filter arguments still gets `PROVIDER_UNAVAILABLE` with no results. A BM25 fallback for `query`-only calls is a follow-up RFC.
- **NG4 — Full KB-specific frontmatter validation.** The arxiv workflow owns the frontmatter schema for its notes. This RFC lifts a **whitelist** of known keys into metadata (§5.4.1); unknown keys are preserved as `frontmatter.extras` (string → string-or-array), not validated. JSON-Schema enforcement is a v2.
- **NG5 — Replacing `getFilesRecursively`.** The existing walker at `src/utils.ts:19-47` stays; §5.2 wraps its output with a post-filter step. Rewriting the walker to be recursive+filtered in one pass is a performance micro-opt (it would let us skip `readdir` into `logs/`); RFC 007 §6.1's benchmarks are the right place to motivate that.
- **NG6 — Multiple frontmatter formats.** TOML frontmatter (`+++`), JSON frontmatter, etc. YAML between `---` fences only (existing contract per `src/utils.ts:165-167`).
- **NG7 — Authorship of `kb_stats` per-KB counts.** RFC 010 M3 owns `chunk_count_live` / `file_count`. This RFC adds a new field `papers_count` (= count of `.md` files under `notes/`) for arxiv-shaped KBs; the generic counts remain RFC 010's. §5.7 documents the composition.
- **NG8 — Multi-tenant trust boundary.** Same as RFC 010 NG1: local process, single user.
- **NG9 — `ingested_at` as a sort key.** `ingested_at` is preserved as metadata but not a first-class filter predicate in v1. A caller wanting "recent papers" uses `published_after`. Ingestion-time ordering is workflow-dependent and is a weaker signal for relevance.

## 5. Proposed design

### 5.1 Primitives consumed from RFC 010 M1

This RFC assumes RFC 010 M1 (foundations) has merged. The following are **not** reintroduced here:

- `resolveKbPath` (`src/paths.ts` per RFC 010 §5.1.1 — currently lives at `src/utils.ts:80-149` in 0.1.1 pre-merge form).
- `isValidKbName` / `KB_NAME_REGEX` (`src/utils.ts:58-70` today; moves to `src/paths.ts` under RFC 010 M1).
- `parseFrontmatter` returning `{ tags, body }` (`src/utils.ts:159-212`). §5.4.1 extends it to return `{ tags, body, frontmatter }`.
- Chunk metadata six-field shape from RFC 010 §5.1.3. §5.4.2 adds two more fields on top of it.

If RFC 010 M1 has **not** merged when this RFC's M1 opens, the implementation PR adds `parseFrontmatter` extensions inline and a clearly-flagged TODO to rebase onto RFC 010 M1's layout once it lands. §8.4 records the branch.

### 5.2 Ingest filters — per-KB exclusion + extension allowlist

#### 5.2.1 Why file-level, not walker-level

The minimal fix is to filter the output of `getFilesRecursively` before it reaches the splitter. Walker-level filtering (skip entire subdirectories) is a micro-optimisation that saves `readdir` calls on `logs/`; on a 5–50 file KB the saving is negligible, and the filtering rules are easier to reason about as a post-walk predicate. A future RFC 007 walker rewrite can fold the filter into the traversal loop; v1 sits on top.

#### 5.2.2 Exclusion contract

Two rules, applied in order at the filtering point (new code, §5.2.4):

**Rule A — path-based exclusions.** A file is excluded if **any** of the following match its path relative to the KB root:

- Segment-literal match: any path segment equals `_seen.jsonl`, `_seen.json`, or `_index.jsonl` (the last two are defensive — the arxiv workflow only writes `_seen.jsonl`, but adjacent workflows might pick the other names).
- First-segment match: first path segment equals `logs`, `tmp`, or `_tmp`. (`logs/**` covers the arxiv workflow; `tmp`/`_tmp` cover common workflow staging dirs without claiming the flat-file name `tmp.md` at KB root.)
- Tail-literal match: basename exactly equals `.DS_Store`, `Thumbs.db`, or `desktop.ini`.

Dotfile-prefixed entries were already excluded by `src/utils.ts:28`, so `.index/`, `.reindex-trigger`, `.DS_Store` (dot-prefixed), etc. are covered by the existing walker skip. Rule A targets the **non**-dot-prefixed cases.

**Rule B — extension allowlist.** After Rule A, a file is included only if its lowercased extension is in the ingest allowlist:

```
.md, .markdown, .txt, .rst
```

Explicitly excluded by omission: `.pdf`, `.jsonl`, `.json` (unless revisited — see below), `.log`, `.png`, `.jpg`, `.docx`, `.epub`. This is narrower than the RFC 010 §5.3.3 Resources mimetype map by design:

- `.json` / `.yaml` / `.csv` / `.xml` / `.html` are **not** in the ingest allowlist. They *may* be in a KB (the Resources surface in RFC 010 M5 is happy to serve them), but their text content typically isn't prose — embedding a JSON array or a CSV row as a dense chunk is almost always the wrong retrieval unit. An operator who *does* want those embedded sets `INGEST_EXTRA_EXTENSIONS=".json,.yaml"` (§5.2.3).
- `.pdf` is handled as a sibling-file surface (§5.3), not corpus.

The allowlist is file-extension-based; the walker does not inspect file magic. This matches `FaissIndexManager.buildChunkDocuments`'s existing extension test at `src/FaissIndexManager.ts:224`.

#### 5.2.3 Configuration

Two env vars, read once at `FaissIndexManager` construction:

| Variable | Default | Purpose |
| --- | --- | --- |
| `INGEST_EXTRA_EXTENSIONS` | *(empty)* | Comma-separated list of additional extensions to include. Case-insensitive, leading dot optional (`".json"` and `"json"` both accepted). Merged with the base allowlist. |
| `INGEST_EXCLUDE_PATHS` | *(empty)* | Comma-separated list of additional path-relative-to-KB-root prefixes or glob patterns (minimatch syntax, dependency added by RFC 010 M4) to exclude. Example: `INGEST_EXCLUDE_PATHS="drafts/**,scratch.md"`. Merged with Rule A. |

Rule A's built-in list is authoritative — operators can *add* exclusions but not remove them. A KB that actually wants `_seen.jsonl` embedded is not a KB this server supports; that's a workflow design bug.

#### 5.2.4 Implementation site

`src/FaissIndexManager.ts:289` (`const filePaths = await getFilesRecursively(knowledgeBasePath);`) and `src/FaissIndexManager.ts:361` (the rebuild-path equivalent) both consume the walker output. A shared helper `filterIngestablePaths(paths, kbPath)` at `src/utils.ts` (next to `getFilesRecursively`) runs Rule A then Rule B, returns the filtered list. Both call sites wrap the walker:

```ts
const filePaths = filterIngestablePaths(
  await getFilesRecursively(knowledgeBasePath),
  knowledgeBasePath
);
```

Behaviour on an all-markdown KB (the three pre-existing KBs) is identical to today — every `.md` is in the allowlist, no path matches Rule A.

#### 5.2.5 Test matrix

- (a) arxiv KB fixture: `notes/*.md`, `pdfs/*.pdf`, `_seen.jsonl`, `logs/2026-04-24.log` → exactly the five `.md` files pass the filter.
- (b) Existing all-markdown KB: filter is a no-op; identical set to today.
- (c) `INGEST_EXTRA_EXTENSIONS=".json"`: a `notes/config.json` is included, `_seen.jsonl` still excluded (Rule A takes precedence over Rule B's allowlist).
- (d) `INGEST_EXCLUDE_PATHS="drafts/**"`: `drafts/scratch.md` excluded, `notes/paper.md` included.
- (e) Case sensitivity: `NOTES/PAPER.MD` on a case-insensitive filesystem is included; `.PDF` is excluded regardless of host case.
- (f) Symlinked file at `_seen.jsonl` pointing to a real content file: excluded (basename match runs before content inspection).

### 5.3 PDF policy — sidecar, not corpus

#### 5.3.1 Decision

**v1 does not extract or embed PDFs.** The arxiv pipeline produces a `.md` note for every PDF that contains the summary, key results, tags, and relevance score — which is exactly the semantic slice an agent asks for. The PDFs are kept on disk because: (a) they are the authoritative source the note was derived from; (b) the note's "Source" section links the PDF as a relative path (`../pdfs/<id>.pdf`); (c) a human-in-the-loop review workflow needs to open the PDF sometimes.

v1 therefore treats PDFs as **addressable non-corpus**: visible to `list_knowledge_bases` indirectly (the file count bumps), reachable via `kb://<kb>/pdfs/<id>.pdf` once RFC 010 M5 extends its mimetype map (§5.3.3 below), and surfaced as metadata (`pdf_path`) on the companion note's chunks so a hit carries enough info to open the PDF.

#### 5.3.2 What *addressable non-corpus* means, concretely

- `retrieve_knowledge` never returns a chunk whose `source` ends in `.pdf`. The ingest filter (§5.2) is the single enforcement point.
- `resources/list` (RFC 010 M5) emits a `kb://` URI for each PDF with `mimeType: application/pdf`. This requires extending RFC 010 §5.3.3's table. See §5.3.3 below.
- `resources/read` on a `.pdf` URI returns `BlobResource` — the MCP spec's binary-content shape — with the raw bytes base64-encoded. Size cap from RFC 010 §5.3.2 (`RESOURCES_READ_MAX_BYTES`, default 10 MiB) applies. A 22 MiB PDF is refused with a clean error; operators raise the cap or use an external reader.
- `kb_stats` gains a `pdf_count` integer per KB (RFC 010 §5.7.2 shape is extended — see §5.7). Counted off the same `getFilesRecursively` walk, filtered to `.pdf` extension.

#### 5.3.3 Mimetype map extension for RFC 010 M5

RFC 010 §5.3.3 currently refuses `.pdf`. This RFC proposes the following **additive** amendment to that table (to be applied when RFC 010 M5 lands, or as a follow-up PR if M5 ships first):

| Extension | `mimeType` | Returned as |
| --- | --- | --- |
| `.pdf` | `application/pdf` | **binary** (`BlobResource`, base64-encoded blob in the MCP response) |

Implementation: at `resources/read` (RFC 010 §5.3.2 step 7), when `extension === '.pdf'` the handler reads the file as a `Buffer` (no UTF-8 decode) and emits `{ contents: [{ uri, mimeType: 'application/pdf', blob: buffer.toString('base64') }] }`. The size gate at step 6 is unchanged — `RESOURCES_READ_MAX_BYTES` applies to the raw byte count. Error message on oversize explicitly names the cap so operators can raise it.

A client unable to display PDFs (CLI-only) receives the base64 blob and presumably saves it to disk or ignores it; `resources/list` carries the mimetype so a client that does not want PDFs filters them client-side. This is the same contract MCP's Filesystem reference server uses for binary resources.

#### 5.3.4 `pdf_path` on note metadata

`FaissIndexManager.buildChunkDocuments` (`src/FaissIndexManager.ts:219-258`) is the single ingestion entry. Extend it: after computing `relativePath`, if the file is a `.md` under a KB that has a sibling `pdfs/<basename-without-ext>.pdf`, attach `pdf_path: "pdfs/<basename>.pdf"` (forward-slash, relative to KB root — identical separator contract to RFC 010 §5.1.3's `relativePath`).

Sibling-detection algorithm (at ingest time, not retrieval time):

1. `ext = path.extname(filePath).toLowerCase()`. If `ext !== '.md'` skip.
2. `stem = path.basename(filePath, ext)` — e.g. `2604.21221`.
3. `dir = path.dirname(filePath)` — e.g. `~/knowledge_bases/arxiv-llm-inference/notes`.
4. Candidate sibling: `path.join(dir, '..', 'pdfs', `${stem}.pdf`)`.
5. `fs.existsSync(candidate)` — if true, set `pdf_path` to the forward-slash relative path under KB root.
6. If false, check a secondary convention: `path.join(dir, `${stem}.pdf`)` (same-dir sibling). This covers KBs that colocate instead of splitting into `notes/` and `pdfs/`.
7. If neither exists, `pdf_path` is omitted from metadata.

The sync `existsSync` is chosen over `fsp.stat` because this runs per-chunk during ingest and the ingest path is already `await`-heavy; one sync `existsSync` per file (not per chunk — we memoize per file) is cheaper than introducing another async boundary. Memoization: the sibling lookup happens once per file, before the splitter loop, and the computed `pdf_path` is passed into the metadata spread at `src/FaissIndexManager.ts:247-256`.

**TOCTOU.** If the PDF is deleted between ingest and retrieval, `pdf_path` is stale. The dead-source filter from RFC 010 M4 (§5.6.6) addresses the `source` file; this RFC does **not** propagate the check to `pdf_path`. A stale `pdf_path` is a 404 on follow-up `resources/read`, not a dangerous action. A future RFC can add a dead-pdf check when it becomes a real problem; v1 accepts the drift.

#### 5.3.5 `delete_document` and the sibling PDF

RFC 010 M6's `delete_document` (§5.4.3) deletes one file and its hash sidecar. If a caller invokes `delete_document { path: "notes/2604.21221.md" }`, the sibling PDF at `pdfs/2604.21221.pdf` is **not** deleted. This is intentional — the caller asked to delete the note, not the PDF, and the PDF is a separate addressable resource.

The companion case — `delete_document { path: "pdfs/2604.21221.pdf" }` — today would traverse through `resolveKbPath` fine, `fsp.rm` the file, and attempt to remove the hash sidecar (which doesn't exist because PDFs aren't ingested). That's an error the user doesn't want to see. §5.3.6 covers this.

A convenience tool `delete_paper { knowledge_base_name, arxiv_id }` that deletes both note and PDF is out of scope for v1 — if a user wants to atomically drop a paper, two `delete_document` calls (one per file) are the documented pattern. A follow-up issue can propose the convenience.

#### 5.3.6 `delete_document` on a non-ingested file

RFC 010 M6.2 calls `faissManager.decrementChunkCount(kbName, chunks)` reading the `chunks` field from the sidecar. For a PDF that was never ingested, there is no sidecar. This RFC adds to the M6.2 checklist: if the sidecar does not exist, skip the counter decrement (not an error — the file was never ingested). The file removal still proceeds. CHANGELOG note documents: "delete_document on a non-ingested file (e.g. a `.pdf` under the §5.2 exclusion list) succeeds without touching counters."

### 5.4 Frontmatter as first-class metadata + new filter predicates

#### 5.4.1 `parseFrontmatter` — return the whole frontmatter object

`src/utils.ts:parseFrontmatter` currently returns `{ tags, body }`. Extended signature:

```ts
export function parseFrontmatter(content: string): {
  tags: string[];
  body: string;
  frontmatter: Record<string, unknown>;
};
```

Implementation change: the parsed object at `src/utils.ts:191` (`parsed = yaml.load(yamlRaw, { schema: yaml.FAILSAFE_SCHEMA })`) is already available but currently only `tags` is extracted. The extension keeps the `FAILSAFE_SCHEMA` (RFC 010 §5.1.4 non-goal "no `!!js/*`") so values remain strings — `relevance_score: 7` arrives as the string `"7"`, which §5.4.4 coerces per-predicate.

Behaviour contract:

- `frontmatter` is **always** an object (`{}` on no-frontmatter files, malformed YAML, or non-string top-level keys). Never `null`, never `undefined`. This matches the graceful-degradation pattern already in `parseFrontmatter`.
- The set of keys is whatever the YAML produced. No filtering, no whitelist at the parser level — §5.4.2 does the whitelist at the metadata-attachment site.
- `tags` continues to be returned separately for back-compat with RFC 010 M1's callers. It is also available under `frontmatter.tags` (pre-coercion string shape).

#### 5.4.2 `ChunkMetadata` — whitelisted frontmatter lift

RFC 010 §5.1.3's shape is extended with two optional fields:

```ts
type ChunkMetadata = {
  // RFC 010 M1 fields (unchanged):
  source: string;
  knowledgeBase: string;
  relativePath: string;
  extension: string;
  tags: string[];
  chunkIndex: number;

  // RFC 011 additions:
  frontmatter?: {
    arxiv_id?: string;
    title?: string;
    authors?: string;         // the workflow serializes as a comma-joined string
    published?: string;       // ISO date (YYYY-MM-DD); kept as string, not Date
    relevance_score?: number; // coerced from string per §5.4.3
    ingested_at?: string;     // ISO-8601; kept as string
    judge_method?: string;    // llm-as-judge-specific but lifted generically
    metrics_used?: string;    // llm-as-judge-specific
    bias_handling?: string;   // llm-as-judge-specific
    extras?: Record<string, string>; // any other string-valued keys (§5.4.2)
  };
  pdf_path?: string;          // forward-slash, KB-relative; §5.3.4
};
```

Attachment happens at `buildChunkDocuments` (`src/FaissIndexManager.ts:246-256`), once per file, and the same object is spread into every chunk. The JSON-serialized metadata block in the MCP response (`src/KnowledgeBaseServer.ts:115`) picks this up for free — no formatter changes needed.

**Whitelist enforcement at attachment time.** `buildChunkDocuments` consumes `frontmatter` from `parseFrontmatter` and lifts only the eight known keys above into the typed shape. Any other string-valued key goes into `frontmatter.extras`. Non-string-valued keys (after FAILSAFE coercion, these are rare — YAML arrays, nested objects) are dropped with a `debug` log noting the key name (not value, to avoid leakage).

**Why whitelist instead of lift-all.** The `ChunkMetadata` shape is the MCP wire contract (per RFC 010 §5.1.3, serialized verbatim as the "Source" JSON block). Lifting every frontmatter key means a file whose frontmatter is `api_key: sk-xyz` leaks the key on every hit. A whitelist + `extras` (which is explicitly a string-map and is documented as a leak surface the operator owns) forces the leak risk to be opt-in at the workflow author's end. §7.1 R2 documents the residual risk.

#### 5.4.3 Type coercion

- `relevance_score`: `parseInt(raw, 10)` with `Number.isFinite` check. Non-numeric → omit the field, log `debug`. Range: no server-side clamp; the workflow emits 0–10 today, a paper rated 11 is preserved as 11.
- `published`, `ingested_at`: kept as the raw string. No `Date` parsing on the server — different callers want different date libraries, and `"2026-04-23"` is already sortable as a string. Predicates at §5.4.4 do string comparison.
- All other fields: string, passed through verbatim.

#### 5.4.4 New filter predicates on `retrieve_knowledge`

RFC 010 §5.6.1 extends the Zod schema with `extensions` / `path_glob` / `tags`. This RFC adds four more, applied at the same post-filter step (RFC 010 §5.6.3):

```ts
{
  // RFC 010 additive fields (unchanged):
  query: z.string(),
  knowledge_base_name: z.string().optional(),
  threshold: z.number().optional(),
  extensions: z.array(z.string()).optional(),
  path_glob: z.string().optional(),
  tags: z.array(z.string()).optional(),

  // RFC 011 additions:
  published_after: z.string().optional().describe(
    'ISO date (YYYY-MM-DD). Chunk passes iff frontmatter.published >= this string (lexicographic, which is date-correct for ISO dates).'
  ),
  published_before: z.string().optional().describe(
    'ISO date (YYYY-MM-DD). Chunk passes iff frontmatter.published <= this string.'
  ),
  min_relevance_score: z.number().optional().describe(
    'Chunk passes iff frontmatter.relevance_score >= this number.'
  ),
  arxiv_id: z.string().optional().describe(
    'Chunk passes iff frontmatter.arxiv_id === this exact string.'
  ),
}
```

**Semantics.**

- `published_after` / `published_before` use lexicographic string comparison on the `"YYYY-MM-DD"` shape, which is order-preserving for ISO dates. A chunk whose `frontmatter.published` is missing or unparseable **fails** the predicate (does not pass it "because the date is unknown"). AND-with-RFC-010-predicates matches RFC 010 §5.6.2 exactly.
- `min_relevance_score` requires `frontmatter.relevance_score` to be present and `>=`. Missing → fails the predicate.
- `arxiv_id` is an exact-string match — no substring, no prefix. Chosen because arxiv IDs collide at the prefix level (`2604.21` is a prefix of both `2604.21215` and `2604.21221`). Callers wanting prefix match use `path_glob: "notes/2604.21*.md"`.
- `published_after > published_before` is not treated as an error — it simply matches zero chunks. Consistent with RFC 010's "empty-sentinel or structurally-impossible predicate matches nothing" behaviour.

**Combining.** AND across all predicates from RFC 010 and RFC 011. A chunk must satisfy every supplied filter. OR is still out of scope (§5.6.2 of RFC 010 Alternatives); callers make two calls.

**Implementation location.** The post-filter helper `matchesFilters(doc.metadata, predicates)` introduced by RFC 010 M4 (§5.6.3) extends with the four new predicates. The function stays pure — no async I/O — so cost is constant per-candidate.

#### 5.4.5 Retrieval response shape

No change to the outer response envelope (`src/KnowledgeBaseServer.ts:108-122`). The "Source" JSON block per hit is automatically richer because `doc.metadata` now carries the extra fields. An agent rendering a hit sees:

```json
{
  "source": "/home/jean/knowledge_bases/arxiv-llm-inference/notes/2604.21221.md",
  "knowledgeBase": "arxiv-llm-inference",
  "relativePath": "notes/2604.21221.md",
  "extension": ".md",
  "tags": ["kv-cache", "quantization", "fine-tuning", "benchmarking"],
  "chunkIndex": 2,
  "frontmatter": {
    "arxiv_id": "2604.21221",
    "title": "Sparse Forcing: …",
    "authors": "Boxun Xu, Yuming Du, …",
    "published": "2026-04-23",
    "relevance_score": 7,
    "ingested_at": "2026-04-24T22:42:27.567Z"
  },
  "pdf_path": "pdfs/2604.21221.pdf"
}
```

Existing tests that assert the presence of `source` continue to pass (field preserved). Tests that assert the *exact* metadata block match (there are none today per `src/KnowledgeBaseServer.test.ts`) would need updating; none are broken by the additive field set.

### 5.5 Reindex trigger — dotfile-aware mtime poller

#### 5.5.1 The trigger contract

The arxiv workflow touches `~/knowledge_bases/.reindex-trigger` on every successful paper write (confirmed: `ls -la ~/knowledge_bases/` shows the file with mtime matching the last ingested paper, 2026-04-25 00:58). The file is dotfile-prefixed, so it is **not** under a specific KB — it sits at the KB root dir. This is the integration convention the server reads.

Server contract:

- A change to `~/knowledge_bases/.reindex-trigger`'s mtime (detected via poll) triggers a global `updateIndex()` pass (no KB argument → all KBs).
- The trigger file's contents are ignored in v1. v2 can introduce a per-KB trigger format (`{"kb": "arxiv-llm-inference"}`) to narrow the scan — the walker is already per-KB-parameterized (`src/FaissIndexManager.ts:270-281`).

#### 5.5.2 Why poll, not watch

RFC 007 §6.6's `fs.watch({recursive: true})` watcher is on-by-default on macOS/Windows/Linux-where-supported. But `getFilesRecursively` and the walker in general skip dotfiles (`src/utils.ts:28`), and the RFC 007 watcher pattern is "watch the same tree the walker walks" — the recursive watch starts at `KNOWLEDGE_BASES_ROOT_DIR` and the watcher callback would indeed see `.reindex-trigger` events. But:

- On Linux, `fs.watch` emits inconsistent events for dotfiles — some kernels fire `change` with `filename = '.reindex-trigger'` inside the root watch; others fire no event because the inode wasn't tracked. Cannot rely on it.
- On Docker / WSL2 / bind-mounted directories, `fs.watch` recursion falls back to polling internally in Node >= 20 (observed via `util.inspect` on the `FSWatcher` instance); the poll interval is platform-dependent. A dedicated poller with a known interval is more predictable.
- The trigger semantics are "coalesce all writes in the last N seconds into one re-index" — a fixed poll interval naturally debounces. A watcher emitting N events in one tight burst would either re-index N times or need a separate debouncer.

A 5-second default poll is cheap (`fsp.stat` on one file) and predictable across platforms. It runs **in addition to** the RFC 007 watcher — the watcher handles per-file edits inside each KB (the inline editing case), the poller handles the workflow-trigger integration.

#### 5.5.3 Implementation

New module `src/triggerWatcher.ts`:

```ts
export class ReindexTriggerWatcher {
  constructor(
    rootDir: string,
    onTrigger: () => Promise<void>,
    pollMs: number,
  );
  start(): void;
  stop(): Promise<void>;
}
```

- Wiring: `KnowledgeBaseServer.runStdio` / `runSse` (`src/KnowledgeBaseServer.ts:170-189`) instantiate the watcher after `faissManager.initialize()`. `onTrigger` = `() => faissManager.updateIndex(undefined)` (global re-index).
- `start()` kicks off a `setInterval(pollMs)` that `fsp.stat`s `<rootDir>/.reindex-trigger`. On ENOENT, no-op (the first time the workflow runs on a fresh install, the file doesn't exist yet). On successful stat, compare `mtimeMs` against the in-memory last-seen value. If greater, enqueue the `onTrigger` call.
- Coalescing: if a trigger fires while `onTrigger()` is in flight, a single-slot "pending" flag is set. On completion, if pending → run once more; else → idle. This matches the drain semantics of RFC 007 §6.2 `updateIndex` single-slot queue.
- `stop()` clears the interval and awaits the in-flight call.
- Shutdown: wired into the `SIGINT`/`SIGTERM` handlers at `src/KnowledgeBaseServer.ts:34-37` and `:194-197` (the existing `installHttpShutdown`/SIGINT wiring). A missed stop leaks a timer; Node exits cleanly either way.

#### 5.5.4 Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `REINDEX_TRIGGER_POLL_MS` | `5000` | Poll interval in ms. `0` disables the poller. Clamp: `[1000, 60000]`. |
| `REINDEX_TRIGGER_PATH` | `<KNOWLEDGE_BASES_ROOT_DIR>/.reindex-trigger` | Absolute path to the trigger file. Operator-overridable for tests or non-standard setups. |

#### 5.5.5 Observability

- On trigger fire: `logger.info('Reindex trigger observed at mtime <iso>; running updateIndex(*)')`.
- On poller start: `logger.info('ReindexTriggerWatcher started; poll=<ms>ms path=<path>')`.
- On `onTrigger` failure: `logger.error('Reindex trigger handler failed:', err)` — the poller itself does not propagate the error; the next trigger runs normally. An agent querying before the next successful re-index sees stale results, not a crash.

#### 5.5.6 Why not write to `.reindex-trigger` from `add_document`

The MCP tool `add_document` (RFC 010 §5.4.2) calls `updateIndex(knowledgeBaseName)` synchronously as its last step. The arxiv workflow does **not** use `add_document` — it writes files directly with a n8n `Write Binary File` node. `.reindex-trigger` exists for the direct-write case. If a workflow one day switches to `add_document`, the trigger is redundant but harmless (the next poll sees the mtime change after `add_document` already finished the re-index — the `updateIndex` call is idempotent on a clean state).

### 5.6 Graceful provider-unavailable mode

#### 5.6.1 The classification path (depends on RFC 009 M2)

RFC 009 M2's `classifyProviderError` wraps any network-layer error from the embedding provider call into `KBError('PROVIDER_UNAVAILABLE', …)` or `KBError('PROVIDER_TIMEOUT', …)`. This RFC **requires** that classifier to exist before the fallback semantics below make sense — otherwise the catch at `src/FaissIndexManager.ts:388-429` still bubbles up raw `fetch failed`.

Dependency gate: RFC 011 M6 (the fallback mode) does not ship until RFC 009 M2 has merged. If the operational problem becomes urgent, a minimal hand-classifier can be included in RFC 011 M6's PR — § 8.4 branch A.

#### 5.6.2 The hint contract

When `PROVIDER_UNAVAILABLE` fires, the `hint` field names the backend concretely. The `FaissIndexManager` already knows which provider is configured (`this.embeddingProvider`, `this.modelName`, and provider-specific URL constants). The classifier composes:

| Provider | `hint` |
| --- | --- |
| `ollama` | `"Ollama is unreachable at <OLLAMA_BASE_URL>. Start the Ollama daemon or set EMBEDDING_PROVIDER to huggingface/openai."` |
| `huggingface` | `"HuggingFace router is unreachable at <HUGGINGFACE_ENDPOINT_URL>. Check network, or set EMBEDDING_PROVIDER to ollama."` |
| `openai` | `"OpenAI API is unreachable. Check network, or set EMBEDDING_PROVIDER to ollama/huggingface."` |

The URLs in the hint come from the already-loaded config (`src/config.ts:37`, `src/config.ts:33`); they are **not** re-derived from the error's `cause`. No API keys appear in any hint (RFC 009 §5.6 leak rules).

#### 5.6.3 Metadata-only fallback — when it fires

A new env flag:

| Variable | Default | Purpose |
| --- | --- | --- |
| `METADATA_ONLY_ON_PROVIDER_DOWN` | `false` | When `true` AND the current `retrieve_knowledge` call supplied at least one of `extensions`/`path_glob`/`tags`/`published_after`/`published_before`/`min_relevance_score`/`arxiv_id` AND the embedding provider call fails with `PROVIDER_UNAVAILABLE` or `PROVIDER_TIMEOUT`, the handler falls back to a metadata-only result set: walk the KBs, apply RFC 010 §5.2 filters, return matching files as synthetic hits with `score: null`. |

The fallback path:

1. Catch `KBError` with `code ∈ {PROVIDER_UNAVAILABLE, PROVIDER_TIMEOUT}` at `src/KnowledgeBaseServer.ts:131-138`.
2. Check (a) `METADATA_ONLY_ON_PROVIDER_DOWN === 'true'`, (b) at least one metadata predicate is present in the call args.
3. If both true, walk KBs via `getFilesRecursively` → `filterIngestablePaths` → read each `.md` → `parseFrontmatter` → apply predicates → emit top 10 as synthetic hits (score=null, pageContent = first 500 chars of body as a preview).
4. **Decorate every hit** with a metadata field `retrieval_mode: "metadata-only"` so a calling agent does not mistake the fallback for semantic results.
5. Attach a top-level disclaimer to the response text: `"⚠ Embedding provider unavailable; showing metadata-only matches."`.
6. If either gate is false, bubble the `KBError` to the regular RFC 009 serializer — the caller gets the JSON error payload with the helpful hint. No silent fallback on a query-only call.

**Why gate on "at least one metadata predicate".** A metadata-only fallback for a bare query call would degrade to "random 10 files" — worse than an error. The gate guarantees the fallback only fires when the caller actually asked for structured filtering.

#### 5.6.4 Ordering of metadata-only results

Without semantic scoring, the fallback needs a deterministic ordering. v1 ordering (applied in sequence, stable sort):

1. Descending `frontmatter.relevance_score` (missing → score 0).
2. Descending `frontmatter.published` (missing → `"0000-00-00"`).
3. Ascending `relativePath` (lexicographic tiebreak).

Matches a "show me the most relevant newest paper first" intuition for arxiv workflows without introducing a tunable. A future RFC can make this configurable.

#### 5.6.5 Interaction with the retry loop

RFC 009's `transient: true` signals the caller may retry. When `METADATA_ONLY_ON_PROVIDER_DOWN=true` and the fallback fires, the response is **not** `isError: true` — it's a successful call with degraded data. The caller does not retry automatically. If the caller wants to force a retry (because the operator just started Ollama), they call `retrieve_knowledge` again; the fallback is a per-call behaviour, not sticky state.

### 5.7 `kb_stats` — arxiv-specific fields

RFC 010 M3's `kb_stats` shape (§5.7.2) gets two optional fields per KB:

```json
{
  "knowledge_bases": {
    "arxiv-llm-inference": {
      "file_count": 5,
      "chunk_count_live": 42,
      "total_bytes_indexed": 83201,
      "last_updated_at": "2026-04-24T22:45:01Z",
      "papers_count": 5,       // NEW — count of .md files under notes/
      "pdf_count": 5           // NEW — count of .pdf files
    }
  }
}
```

Computed from the same `getFilesRecursively` walk. `papers_count` is "files whose `relativePath` matches `notes/**/*.md`"; `pdf_count` is "files whose extension is `.pdf`". Both fields are omitted entirely from the response for KBs where the count is 0 (keeps responses clean for the legacy all-flat-markdown KBs).

No changes to RFC 010's other `kb_stats` fields. S3 latency budget (50 ms p95 on 500-file KB) is preserved — the two counts fall out of the same walk.

### 5.8 Composition with RFCs 006/007/009/010 — interaction table

| Concern | RFC says | RFC 011 says |
| --- | --- | --- |
| Chunk metadata shape | RFC 010 §5.1.3 (six fields) | §5.4.2 adds `frontmatter?` and `pdf_path?` — both optional, additive |
| `parseFrontmatter` signature | RFC 010 §5.1.4 returns `{ tags, body }` | §5.4.1 extends to return `{ tags, body, frontmatter }` — back-compat |
| `retrieve_knowledge` filters | RFC 010 §5.6: `extensions`/`path_glob`/`tags` | §5.4.4 adds `published_after`/`published_before`/`min_relevance_score`/`arxiv_id` |
| Resources mimetype | RFC 010 §5.3.3: refuses `.pdf` | §5.3.3 extends with `.pdf → application/pdf` as `BlobResource` |
| `kb_stats` shape | RFC 010 §5.7.2 | §5.7 adds optional `papers_count`/`pdf_count` per KB |
| Error codes | RFC 009 `PROVIDER_UNAVAILABLE`/`_TIMEOUT` | §5.6.2 supplies backend-specific `hint` text |
| File watcher | RFC 007 §6.6 `fs.watch` recursive (on supported platforms) | §5.5 adds a dotfile-aware mtime poller alongside (complementary, not replacement) |
| `refresh_knowledge_base` tool | RFC 007 §6.3 / RFC 010 §5.4.5 | unchanged; the trigger poller calls `updateIndex(*)` directly, not through the tool |
| Ingest filters | — | §5.2 (new primitive; RFC 010 M6's `add_document` inherits via `updateIndex`) |
| PDF handling | RFC 010 M5 refuses; RFC 006 §7 flags as future work | §5.3 — addressable non-corpus |

## 6. Alternatives considered

### 6.1 Embed PDF-extracted text into the corpus

**Rejected.** Options surveyed:

- `pdf-parse` (~450 KB) — battle-tested, maintained, but adds a native dependency on `pdfjs-dist` (via `pdf-parse`'s internals). Performance: ~100 ms per MB on typical arxiv papers. A 22 MiB paper → ~2.2 s of synchronous extraction inside the ingest path.
- `pdfjs-dist` (~2 MB) — used by Mozilla, richest layout extraction, but has a heavier API surface (workers, rendering) intended for browser use.
- `@langchain/community/document_loaders/fs/pdf` — wraps `pdf-parse`; effectively the `pdf-parse` option at our call-site granularity.

The cost is not just the dependency: every paper gets indexed twice (once as note, once as PDF-extracted text), `kb_stats.chunk_count_live` balloons, and semantic search returns two near-duplicate chunks per relevant paper. The workflow author already decided which slice of the paper is retrieval-worthy (the `.md` note); re-extracting the whole PDF re-introduces the information the note deliberately compressed.

If a future use case needs PDF-content retrieval (e.g. an agent that asks "quote the equation from section 4 of paper 2604.21221") a dedicated RFC proposes it with: (a) a PDF-only ingest path that embeds per-page chunks; (b) metadata `pdf_page` on those chunks; (c) ranking such that `.md` note hits are preferred. That's an additive mode on top of this RFC's layout.

### 6.2 BM25 fallback instead of metadata-only

**Rejected for v1.** `@langchain/community/retrievers/bm25` is installed transitively (RFC 006 §2.3). A BM25 retriever over the KB's `.md` bodies would provide a true lexical-search fallback that serves bare-`query` calls (§5.6.3's gate excludes those today). Deferred because:

- RFC 006 owns retriever-fusion and the multi-provider seam. Adding a BM25 retriever here without the fusion story is a one-off that doesn't compose with RFC 006's `fast`/`balanced`/`deep` tiers.
- The arxiv use case is structured-filter-heavy — a caller asking "kv-cache papers from this week" cares about `tags`+`published_after`, not about lexical query matching against the body text.
- BM25 on a 10-file KB is approximately "grep with tf-idf weights" — the gain over metadata-filter-only is marginal for this corpus size.

A follow-up issue proposes BM25 when (a) the arxiv KBs grow past 100 papers, or (b) an agent workflow demands bare-query semantic fallback.

### 6.3 Hard-fail on provider down, no fallback at all

**Considered.** The pure RFC 009 answer — `PROVIDER_UNAVAILABLE` with `transient: true` and a clear hint — is arguably sufficient. A calling agent sees the error, explains to the human, the human fixes the provider, the retry works.

**Partially accepted.** That *is* the default behaviour. `METADATA_ONLY_ON_PROVIDER_DOWN=false` by default; the fallback is opt-in. The fallback exists because there is one specific workflow where it's the right answer: an agent that already knows which paper it wants (by tag, by ID, by date range) and is about to open its PDF — the semantic search isn't load-bearing, and forcing the human to restart Ollama just to fetch a file they already filtered to is theater. Opt-in by design.

### 6.4 Write the reindex trigger *into* each KB directory instead of the root

`~/knowledge_bases/arxiv-llm-inference/.reindex-trigger` would be walker-native (with the per-KB pass). **Rejected** because:

- Not how the workflow writes today (we don't redesign the workflow, §NG2).
- Multi-KB coordination: if both `arxiv-llm-inference` and `llm-as-judge` write papers simultaneously, two per-KB triggers compete; the root trigger is one mtime.
- RFC 007 §6.6's watcher already sees per-KB file edits directly — per-KB triggers are redundant with the watcher, while the root trigger integrates with a workflow that isn't using per-file edits.

### 6.5 Make the reindex-trigger watcher on-by-default unconditionally

**Partially adopted.** The poller starts by default (`REINDEX_TRIGGER_POLL_MS=5000`). The disable path is `REINDEX_TRIGGER_POLL_MS=0`. On platforms / deployments that don't want the extra syscall-every-5-seconds, the opt-out is one env var.

### 6.6 Extend `parseFrontmatter` with schema validation (Zod, JSON Schema)

**Rejected for v1.** The frontmatter contract is owned by the arxiv workflow; validating here creates a two-sided coupling that breaks whenever either repo changes the schema. The whitelist in §5.4.2 is *soft* validation — unknown-key-preserving, typo-forgiving. A v2 can introduce a strict mode gated by `FRONTMATTER_SCHEMA=<path>.json` if the operator wants CI-enforced schemas.

### 6.7 Ship the ingest filter only for arxiv-named KBs

A KB-name-conditional filter (`if (kbName.startsWith('arxiv-')) exclude _seen.jsonl`) **rejected** because it ties server behaviour to naming conventions. The exclude list is content-based (`_seen.jsonl` is a ledger regardless of KB name) and applies uniformly. Back-compat: no pre-existing KB contains `_seen.jsonl` or a `logs/` dir (verified via `ls`).

## 7. Risks, unknowns, open questions

### 7.1 Risks

- **R1 — Frontmatter key leak via `extras`.** §5.4.2's `extras` map carries any non-whitelisted string-valued frontmatter keys verbatim into chunk metadata and thence onto the wire. A workflow author who accidentally writes `api_key: sk-…` into the frontmatter leaks it. Mitigations: (a) §5.4.2 whitelist is exhaustive for known workflow keys, so `extras` is empty for well-formed arxiv notes; (b) README "Security posture" section (landed with RFC 010 S7) gains a subsection flagging `extras` as an unwhitelisted surface; (c) a leak-test (see §9 S8) seeds a fixture frontmatter with a sentinel key and asserts that a `retrieve_knowledge` response does not surface that key unless the operator has set `FRONTMATTER_EXTRAS_WIRE_VISIBLE=true` (env opt-in for `extras` to reach the wire). **Default: `extras` is collected at parse time but stripped at the MCP boundary** — kept in `metadata.frontmatter.extras` on the server-side `Document` object (useful for server logging) but dropped during JSON serialization in `handleRetrieveKnowledge`. This belt-and-braces approach means a workflow-author typo does not become a client-visible leak.
- **R2 — PDF size on `resources/read`.** A 22 MiB PDF exceeds RFC 010's default `RESOURCES_READ_MAX_BYTES=10 MiB`. Operators raising the cap pay memory (Node loads the file into a single `Buffer` + its base64-encoded copy = 4/3× the byte count as a JS string). Mitigation: document the default in README, and for the arxiv use case recommend `RESOURCES_READ_MAX_BYTES=33554432` (32 MiB) as a sane upper bound given observed PDFs.
- **R3 — Poller churn under a misconfigured workflow.** A workflow that touches `.reindex-trigger` in a tight loop (bug: once per log line instead of once per paper) triggers a re-index every 5 s. The single-slot coalescing in §5.5.3 prevents overlap, but CPU stays elevated. Mitigation: `logger.warn` when the trigger mtime advances more than 10× in a 60-second window (operator signal).
- **R4 — Dead `pdf_path` on retrieval.** If a PDF is deleted but the note stays, the note's `pdf_path` metadata points at a missing file. A caller following the path with `resources/read` gets a 404 from the Resources handler. §5.3.4 accepts this drift; R4 notes it for the README. A dead-pdf filter is out of scope (§NG9 reasoning extends).
- **R5 — Ingest filter misclassification.** An operator names a legitimate content file `logs.md` at the KB root and it is **not** excluded (Rule A checks first-segment `logs/`, not basename `logs.md`). But a `logs/` subdirectory with legitimate content inside is excluded entirely. Documented as intended; `INGEST_EXCLUDE_PATHS=""` cannot undo Rule A (§5.2.3), so a caller with a legitimate `logs/` subdir has to rename it.
- **R6 — Provider-down fallback emits truncated preview that the caller mistakes for a full chunk.** §5.6.3 step 3 uses the first 500 chars of body as `pageContent` — shorter than a real chunk. A caller concatenating `pageContent` across hits to build a context window gets 5 000 chars instead of ~10 000. Mitigation: the disclaimer at §5.6.3 step 5 is textual, but a programmatic client might ignore it. v1 accepts this; a v2 could emit a `resource_reference` to the full note URI instead of a body preview.

### 7.2 Unknowns

- **U1 — `fs.watch` behaviour on `~/knowledge_bases/.reindex-trigger`.** If RFC 007 §6.6's watcher *does* see dotfile events on a given platform, the poller is redundant. Acceptable — the poller remains cheap and predictable, and the watcher is a "nice to have" that may or may not fire. Test matrix: platform × watcher-enabled × trigger-file-touch → confirm re-index runs (via either path) within 10 seconds.
- **U2 — Frontmatter with non-ISO dates.** `published: "April 23, 2026"` breaks lexicographic comparison. v1 documents "ISO dates only"; workflows that violate it get silently-failing predicates. A future RFC can add `Date.parse` fallback with explicit opt-in.
- **U3 — Multi-shard counts with RFC 006.** §5.7's `papers_count` and `pdf_count` are file-system-derived, so they are shard-invariant. No interaction with RFC 006's multi-provider fusion.
- **U4 — Concurrent trigger-poll and RFC 007 watcher.** Both can fire `updateIndex` concurrently. RFC 007 §6.2's single-slot queue was designed for self-serialization of `updateIndex`. This RFC's §5.5.3 coalescing is a *second* single-slot queue on top. If RFC 007's queue is per-`FaissIndexManager`, the poller's call arrives at the same queue; if it's per-call-site, they interleave. Implementation check at M4 time: share the RFC 007 queue, not duplicate it.

### 7.3 Open questions for Jean

- **Q1 — `.pdf` in Resources (§5.3.3).** RFC 010 deliberately refuses PDFs in its M5. Accepting `.pdf` here is a direct amendment to RFC 010's table. Option A: include the amendment in RFC 011's PR (requires Jean to cross-approve both RFCs in one review). Option B: ship RFC 011 without the Resources extension and add a follow-up RFC (or PR) once RFC 010 M5 is live. Draft picks **A** — amend in the same PR because the `pdf_path` metadata is useless without a way to open the PDF. Confirm.
- **Q2 — `METADATA_ONLY_ON_PROVIDER_DOWN` default (§5.6.3).** Draft picks `false` (fallback is opt-in). Alternative: default `true` — arxiv callers almost always supply at least one metadata filter, so the default fallback would usually do the right thing. The safer (non-silent-degradation) default is `false`; the more-useful-for-this-user default is `true`. Confirm.
- **Q3 — `extras` visibility (§7.1 R1).** Default: `extras` stripped at the wire. The leak mitigation is stronger, but an operator who *wants* their custom frontmatter keys on the wire has to flip `FRONTMATTER_EXTRAS_WIRE_VISIBLE=true`. Alternative: ship visible by default, since the `.md` file contents are already visible via `resources/read`. Draft picks stripped-by-default; the leakage risk is asymmetric. Confirm.
- **Q4 — `arxiv_id` filter vs. `path_glob`.** Technically, `arxiv_id: "2604.21221"` and `path_glob: "notes/2604.21221.md"` return the same chunks for well-formed arxiv KBs. Keeping `arxiv_id` as a first-class predicate is ergonomic but slightly redundant. Confirm: keep as-is, or drop and document the `path_glob` idiom?
- **Q5 — Reindex trigger file semantics (§5.5.2).** v1 ignores contents. Future per-KB trigger format (`{"kb": "arxiv-llm-inference"}`) would narrow the re-index scan. Worth specifying now with the workflow author, or defer to when multi-KB pressure actually shows up in benchmarks?

## 8. Rollout plan

### 8.1 Milestones

Each M is a separate PR against `main`, referencing this RFC and the per-item checklist in §10. Gates are concrete — a PR merges only when its gate passes.

1. **M1 — Ingest filters** (`filterIngestablePaths` + Rule A/B). Smallest, highest-value, no dependencies. **Gate:** `npm test` green; new tests cover the six scenarios in §5.2.5; a manual reproduction on `arxiv-llm-inference` confirms `_seen.jsonl`, `logs/**`, and `.pdf` files are skipped on the next `updateIndex`.
2. **M2 — `parseFrontmatter` frontmatter lift + ChunkMetadata extension** (`frontmatter?` + `pdf_path?`). Depends on M1 for the filter (a KB with `_seen.jsonl` gets properly filtered before frontmatter parsing even sees it, avoiding a "frontmatter doesn't parse on a JSONL" warning). **Gate:** `buildChunkDocuments` attaches the whitelisted frontmatter to every chunk; sibling-PDF detection works (one `existsSync` per `.md` file); the leak test from §9 S8 passes with `extras` stripped at the wire boundary.
3. **M3 — Retrieval filter predicates** (`published_after` / `published_before` / `min_relevance_score` / `arxiv_id`). Depends on RFC 010 M4 (the post-filter infrastructure). **Gate:** four predicate tests pass in isolation and combined (AND across RFC 010 and RFC 011 predicates); `retrieve_knowledge` latency does not regress more than 5% vs. the RFC-010-only baseline (cheap predicates, so the budget is tight).
4. **M4 — Reindex-trigger watcher** (`ReindexTriggerWatcher`). No dependency beyond M1's filter (trigger file is at root, not inside a KB — it doesn't need the filter). **Gate:** integration test: touch `<rootDir>/.reindex-trigger`, assert `updateIndex` fires within `2 × poll_ms`. Single-slot coalescing test: touch five times in a row, assert at most two `updateIndex` calls (one in-flight, one queued).
5. **M5 — `kb_stats` arxiv fields + Resources `.pdf` mimetype amendment.** Depends on RFC 010 M3 (for `kb_stats` plumbing) and RFC 010 M5 (for Resources handler). **Gate:** `kb_stats` on `arxiv-llm-inference` returns `{papers_count: 5, pdf_count: 5}`; `resources/read` on `kb://arxiv-llm-inference/pdfs/2604.21221.pdf` returns a `BlobResource` with a valid base64 body; size-cap refusal works for >10 MiB PDFs.
6. **M6 — Graceful provider-unavailable + metadata-only fallback.** Depends on **RFC 009 M2** (error classifier) and M3 (needed for the fallback to apply the metadata predicates). **Gate:** with Ollama down and `METADATA_ONLY_ON_PROVIDER_DOWN=false`, a `retrieve_knowledge` call returns a clean `PROVIDER_UNAVAILABLE` payload with the backend-specific hint. With the flag `true` and a filter predicate supplied, the fallback returns a list of matching notes in §5.6.4 order. With the flag `true` and **no** predicate, the error payload still returns (no silent random-10 result set).

### 8.2 Feature flag / back-compat

Every new primitive is additive at the wire level. The only opt-ins:

- `METADATA_ONLY_ON_PROVIDER_DOWN` — default `false`, opt-in only.
- `INGEST_EXTRA_EXTENSIONS` / `INGEST_EXCLUDE_PATHS` — empty by default, opt-in extensions.
- `REINDEX_TRIGGER_POLL_MS` — default `5000`, set to `0` to disable.
- `FRONTMATTER_EXTRAS_WIRE_VISIBLE` — default `false`, opt-in leak.

No breaking change to existing fields. The only behaviour shift is M1: a KB today that has `_seen.jsonl` or a `logs/` directory loses those files from its embedding corpus. No such KB exists today (verified via `ls`), so no user is affected.

### 8.3 Deprecation schedule

Nothing deprecated. The ingest filter (§5.2) *narrows* what the walker feeds the splitter but it narrows it to a set that was never explicitly supported — the current behaviour is "whatever the dotfile-skip walker returns", not a documented contract. The narrowing is a bug fix.

### 8.4 Cross-RFC coordination

- **With RFC 009.** M6 depends on `classifyProviderError`. Three branches:
  - **Branch A (RFC 009 M2 merged):** M6 consumes the classifier directly.
  - **Branch B (RFC 009 M2 not merged when M6 opens):** M6 includes a minimal hand-classifier inline (detect `cause.code === 'ECONNREFUSED'` / `'ENOTFOUND'` / `'ETIMEDOUT'` → `PROVIDER_UNAVAILABLE`; detect `cause.name === 'AbortError'` → `PROVIDER_TIMEOUT`). M6's PR description states Branch B and cross-links RFC 009. When RFC 009 M2 later lands, it replaces the inline classifier in one PR.
  - **Branch C (RFC 009 rejected):** M6 ships with the inline classifier permanently. `PROVIDER_UNAVAILABLE` is an RFC 011-specific code in that world; the wire shape matches RFC 009's design but the taxonomy has one row.
- **With RFC 010.** Every RFC 011 milestone depends on RFC 010 M1 (chunk metadata shape + parseFrontmatter). If RFC 010 M1 has not merged when RFC 011 M2 opens, M2's PR extends `parseFrontmatter` with the `frontmatter` field inline (the function is small; the inline version is compatible with the RFC 010 M1 shape). Same for M3 (depends on RFC 010 M4's post-filter machinery) and M5 (depends on RFC 010 M3 / M5). §5.8's table is the coordination contract.
- **With RFC 007.** M4's trigger poller runs alongside (does not replace) RFC 007 §6.6's watcher. §7.2 U4 tracks the queue-sharing concern.

## 9. Success metrics

Structural (enforced at CI / PR review):

- **S1 — Zero non-`.md/.markdown/.txt/.rst` files are embedded.** Integration test: ingest a fixture KB with `.md`/`.pdf`/`.jsonl`/`.log`, assert `kb_stats.chunk_count_live` counts only the `.md` chunks.
- **S2 — Every `.md` hit carries whitelisted frontmatter.** Integration test: `retrieve_knowledge` against the arxiv fixture, assert every result's `metadata.frontmatter.arxiv_id` matches the filename's stem.
- **S3 — PDF sibling detection.** Integration test: hit on a note whose sibling PDF exists → `metadata.pdf_path` present; hit on a note without sibling → `pdf_path` absent (not empty string).
- **S4 — Four new filter predicates work, AND with RFC 010 predicates.** Unit tests as §5.4.4; combined test with `{tags: [...], min_relevance_score: 7, published_after: "2026-04-20"}` against the fixture returns only the expected papers.
- **S5 — Reindex trigger fires within 2× poll interval.** Integration test: touch trigger file, assert `updateIndex(undefined)` invocation within 10 s (with default `REINDEX_TRIGGER_POLL_MS=5000`).
- **S6 — Provider-down error is actionable.** Integration test: stub the embedding client to throw `ECONNREFUSED`, invoke `retrieve_knowledge`, assert response contains `"PROVIDER_UNAVAILABLE"` and a hint mentioning the backend URL.
- **S7 — Metadata-only fallback returns deterministically-ordered results.** Integration test: with `METADATA_ONLY_ON_PROVIDER_DOWN=true`, embedding stub throwing `ECONNREFUSED`, and `tags: ["kv-cache"]`, assert the result list is sorted by `relevance_score` desc, then `published` desc.

Security / leak-prevention:

- **S8 — `extras` leak test.** Seed a fixture frontmatter with `sentinel_key: "SECRET_VALUE_XYZ"`; `retrieve_knowledge` response does NOT contain `"SECRET_VALUE_XYZ"` unless `FRONTMATTER_EXTRAS_WIRE_VISIBLE=true` is set.

Qualitative:

- **S9 — README gains.** One section "Operational KB for ingestion pipelines" with (a) the arxiv layout diagram, (b) the four env-var knobs, (c) the PDF-as-sidecar policy, (d) the metadata-only fallback flow. Landed with M6.
- **S10 — CHANGELOG.** One `Added` entry per milestone; M1's entry explicitly flags the narrowing of the ingest corpus (operators with `logs/` subdirs are alerted).

## 10. Implementation checklist

File anchors resolve against `main` at the RFC's base commit (`be5ad19` per current `git log`).

### M1 — Ingest filters

- [ ] **M1.1** New helper `filterIngestablePaths(paths: string[], kbRoot: string): string[]` in `src/utils.ts`. Implements Rule A (path exclusions) and Rule B (extension allowlist). Pure function, no I/O.
- [ ] **M1.2** Config reads: `INGEST_EXTRA_EXTENSIONS`, `INGEST_EXCLUDE_PATHS` in `src/config.ts` next to the other env parsing. `minimatch` dep already added by RFC 010 M4; reuse.
- [ ] **M1.3** Wire the helper into `FaissIndexManager` at `src/FaissIndexManager.ts:289` and `src/FaissIndexManager.ts:361` (both walker consumption sites).
- [ ] **M1.4** Unit tests covering §5.2.5 scenarios (a)–(f).
- [ ] **M1.5** Integration test against an arxiv-shaped fixture KB in `src/` test tree: `_seen.jsonl`, `logs/<date>.log`, `pdfs/<id>.pdf`, `notes/<id>.md`. Assert ingest only touches `notes/*.md`.
- [ ] **M1.6** CHANGELOG `Added` / `Changed` entry flagging the narrowing.

### M2 — Frontmatter lift + sibling PDF detection

- [ ] **M2.1** Extend `parseFrontmatter` in `src/utils.ts:159-212` to return `{ tags, body, frontmatter }`. Frontmatter is an object of string values (per FAILSAFE schema) or `{}` on no-frontmatter / malformed.
- [ ] **M2.2** Extend `ChunkMetadata` type and `buildChunkDocuments` (`src/FaissIndexManager.ts:219-258`): whitelist per §5.4.2, coerce per §5.4.3, attach `frontmatter` to every chunk's metadata once per file.
- [ ] **M2.3** Sibling PDF detection (§5.3.4): compute once per `.md` file at the top of `buildChunkDocuments`, before the splitter runs; attach `pdf_path` to metadata if a sibling exists.
- [ ] **M2.4** `FRONTMATTER_EXTRAS_WIRE_VISIBLE` env var in `src/config.ts`. When false (default), the MCP serializer at `src/KnowledgeBaseServer.ts:115` strips `frontmatter.extras` before `JSON.stringify`. Implemented via a `sanitizeMetadataForWire(metadata, env)` helper so unit tests can exercise both branches.
- [ ] **M2.5** Tests for the leak path (§9 S8), whitelist coverage, coerce-or-drop behaviour on `relevance_score`, sibling PDF detection (present / absent / non-standard location).

### M3 — New retrieval filter predicates

- [ ] **M3.1** Extend the Zod schema at `src/KnowledgeBaseServer.ts:60-64` with `published_after`, `published_before`, `min_relevance_score`, `arxiv_id` per §5.4.4.
- [ ] **M3.2** Extend the `matchesFilters` helper (introduced by RFC 010 M4) with the four predicates. Pure functions, no I/O.
- [ ] **M3.3** Tests: each predicate in isolation, all four combined, combined with RFC 010's `tags`/`extensions`/`path_glob`, missing-field behaviour (predicate fails), malformed-date behaviour.
- [ ] **M3.4** Bench check: `retrieve_knowledge` latency on the arxiv fixture with all 7 predicates applied, vs. with none. Assert ≤5% regression.

### M4 — Reindex-trigger watcher

- [ ] **M4.1** New module `src/triggerWatcher.ts` with `ReindexTriggerWatcher` class per §5.5.3.
- [ ] **M4.2** Config: `REINDEX_TRIGGER_POLL_MS` (default 5000, clamp [1000, 60000], 0 = disabled) and `REINDEX_TRIGGER_PATH` (default `<KNOWLEDGE_BASES_ROOT_DIR>/.reindex-trigger`) in `src/config.ts`.
- [ ] **M4.3** Wire into `KnowledgeBaseServer.runStdio` and `runSse` at `src/KnowledgeBaseServer.ts:170-189`: construct after `faissManager.initialize()`, `start()` immediately, `stop()` in the SIGINT/SIGTERM handlers.
- [ ] **M4.4** Coalescing logic: single-slot pending flag per §5.5.3.
- [ ] **M4.5** Tests: trigger fires `updateIndex(undefined)` within `2 × poll_ms`; five rapid touches cause ≤2 `updateIndex` invocations; ENOENT on first poll is a no-op; `stop()` prevents further polls mid-flight.
- [ ] **M4.6** Observability logs per §5.5.5.

### M5 — `kb_stats` fields + Resources PDF amendment

- [ ] **M5.1** Extend `FaissIndexManager.stats(kbName?)` (introduced by RFC 010 M3.1) to compute `papers_count` (files matching `notes/**/*.md`) and `pdf_count` (files ending `.pdf`) off the same walk.
- [ ] **M5.2** Extend `kb_stats` tool response shape per §5.7; fields omitted when 0.
- [ ] **M5.3** Extend RFC 010 §5.3.3 mimetype map with `.pdf → application/pdf` at the `resources/list` emission site.
- [ ] **M5.4** Extend `resources/read` handler (RFC 010 §5.3.2) to return `BlobResource` for `.pdf`: read as `Buffer`, base64-encode, emit `{ contents: [{ uri, mimeType: 'application/pdf', blob: base64 }] }`. Size cap applies unchanged.
- [ ] **M5.5** Tests: `kb_stats` on arxiv fixture returns the expected counts; `resources/read` on a sub-cap PDF returns a valid base64 blob; `resources/read` on an over-cap PDF returns a clean size-cap error naming the cap.
- [ ] **M5.6** README update: "Opening a PDF from a knowledge base" worked example.

### M6 — Graceful provider-unavailable + metadata-only fallback

- [ ] **M6.1** Confirm RFC 009 M2's classifier is available; if not, include inline `classifyProviderError(error)` per §8.4 Branch B.
- [ ] **M6.2** `PROVIDER_UNAVAILABLE` / `PROVIDER_TIMEOUT` hint composition per §5.6.2. Sourced from `FaissIndexManager`'s `embeddingProvider` + config constants.
- [ ] **M6.3** `METADATA_ONLY_ON_PROVIDER_DOWN` config in `src/config.ts`. Default `false`.
- [ ] **M6.4** Metadata-only fallback logic in `handleRetrieveKnowledge` (`src/KnowledgeBaseServer.ts:131-138`): catch classified errors, gate on flag + predicate presence, walk → filter → respond per §5.6.3.
- [ ] **M6.5** Deterministic ordering per §5.6.4.
- [ ] **M6.6** Tests: provider-down without flag → RFC 009 error payload; provider-down with flag + filter → metadata-only results; provider-down with flag + no filter → RFC 009 error payload (no random fallback).
- [ ] **M6.7** Tests: the disclaimer text and `retrieval_mode: "metadata-only"` tag on every fallback hit.
- [ ] **M6.8** README "Operational KB for ingestion pipelines" section (§9 S9).
- [ ] **M6.9** CHANGELOG entry calling out the new env flag and the `PROVIDER_UNAVAILABLE` hint.

---
