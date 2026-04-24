# RFC 010 — MCP surface v2: Resources, ingest, filters, stats, description overrides

- **Status:** Draft — awaiting approval
- **Author:** Jean Ibarz (drafted by automation)
- **Target:** `jeanibarz/knowledge-base-mcp-server` `main`
- **Related:** RFC 006 (multi-provider fusion), RFC 007 (architecture & performance)
- **References (GitHub issues):** #49, #51, #52, #53, #54 (all remain open; each closes via its own implementation PR per §8)

## 1. Summary

The MCP surface this server exposes is exactly two tools today —
`list_knowledge_bases` and `retrieve_knowledge` at `src/KnowledgeBaseServer.ts:34-49`.
Five open issues (#49, #51, #52, #53, #54) independently flag gaps that all flow
from that minimal surface: Resources aren't exposed (#49), ingest is shell-only
(#51), tool descriptions are hard-coded (#52), retrieval has no metadata filters
(#53), and there is no way to observe index state (#54). They share three
cross-cutting concerns — path-traversal safety, the chunk-metadata shape, and
tool-registration plumbing — that are cheaper to design once than five times.
This RFC unifies them into one design: a shared `resolveKbPath()` guard, a
KB-name validator, enriched chunk metadata, and a minimal YAML frontmatter
contract, all landing in one foundations milestone (M1) before the user-visible
features ship through M2–M6 in dependency + risk order. The deliverable is one
doc and (after approval) six additive, back-compat PRs that take the tool
surface from 2 tools to 6 tools + a Resources surface without changing any
existing client contract.

## 2. Motivation

### 2.1 Evidence from code — the surface is two tools

The full registered surface lives at `src/KnowledgeBaseServer.ts:34-49`:

```ts
private setupTools() {
  this.mcp.tool(
    'list_knowledge_bases',
    'Lists the available knowledge bases.',
    async () => this.handleListKnowledgeBases()
  );

  this.mcp.tool(
    'retrieve_knowledge',
    'Retrieves similar chunks from the knowledge base based on a query. …',
    {
      query: z.string()…,
      knowledge_base_name: z.string().optional()…,
      threshold: z.number().optional()…,
    },
    async (args) => this.handleRetrieveKnowledge(args)
  );
}
```

The constructor wires a `StdioServerTransport` and an `McpServer`
(`src/KnowledgeBaseServer.ts:19-30`) but never calls anything like
`setupResources()` — the `resources/*` capability is simply absent from the
handshake. A client that asks for Resources sees an empty list; a client that
sends `resources/read` gets a "method not found" error back from the SDK. This
is #49.

Ingest has no MCP entry point at all. `handleListKnowledgeBases`
(`src/KnowledgeBaseServer.ts:52-72`) reads the directory and filters
dot-prefixed entries; there is no `addDocument`-style handler. An agent cannot
persist a conversation snippet into a KB without shell access — the same gap
flagged in `chroma-mcp` (`chroma_add_documents`) and `pinecone-mcp`
(`upsert-records`). This is #51.

The two tool descriptions are literal strings in code (`src/KnowledgeBaseServer.ts:36`
and `src/KnowledgeBaseServer.ts:42`). Every deployment of this server — whether
it fronts engineering runbooks, personal notes, or incident postmortems —
advertises the same generic text. The model's tool-selection policy reads the
description, so the override is how you steer "which tool do I pick?". This is
#52.

`retrieve_knowledge`'s argument surface is three fields
(`src/KnowledgeBaseServer.ts:43-47`): `query`, `knowledge_base_name`,
`threshold`. There is no extension filter, no path glob, no tag predicate.
**And the `threshold` argument today is a no-op in practice.**
`FaissIndexManager.similaritySearch` (`src/FaissIndexManager.ts:394-408`) builds
a filter object `{ score: { $lte: threshold } }` at line 399 and passes it to
`FaissStore.similaritySearchWithScore`. But `FaissStore`'s implementation
(`node_modules/@langchain/community/dist/vectorstores/faiss.js:111` — the
`similaritySearchVectorWithScore` override) accepts only `(query, k)` and
silently drops the filter argument entirely — it is *not even score-filtered*.
The filter object at line 399 is effectively dead code today. Metadata
filtering therefore has to happen *outside* the FAISS call, and so does the
existing `threshold`, which is what M4 will fix. Chunk metadata today is
`{ source: filePath }` only (set at `src/FaissIndexManager.ts:267`,
`src/FaissIndexManager.ts:272`, `src/FaissIndexManager.ts:324`,
`src/FaissIndexManager.ts:329`); there's no `extension`, no `relativePath`, no
`tags` to filter on even if the filter plumbing existed. This is #53.

There is no way to observe index state from the MCP surface. "How many files
are in this KB?" requires reading the filesystem. "When did the index last
update?" requires `stat` on `$FAISS_INDEX_PATH/faiss.index`. "What embedding
model built it?" is in `model_name.txt` (`src/FaissIndexManager.ts:25`,
`src/FaissIndexManager.ts:146-148`) but no tool surfaces it.
`pinecone-mcp`'s `describe-index-stats` is the precedent for fixing this.
This is #54.

### 2.2 Shared root cause

Each of the five issues calls out the same two files as the edit site:
`src/KnowledgeBaseServer.ts:33-50` (tool registration) and
`src/FaissIndexManager.ts` (chunking + search). Three of them (#49, #51, #53)
need a path-traversal guard that accepts a user-supplied relative path and
refuses `../../etc/passwd`. Three (#51, #53, #54) need richer chunk metadata
than today's `{ source }`. Two (#53, #54) need a YAML frontmatter parser.
Solving these in five serial PRs without a unifying contract is how we end up
with three slightly different `resolveKbPath` implementations that disagree on
corner cases, two overlapping metadata shapes, and a YAML parser used
inconsistently. Designing them together costs one RFC and produces one M1
foundations PR; splitting them does not.

The implementation-cost argument for unifying is strongest at §5.3 (Resources)
and §5.4 (ingest) — both consume `resolveKbPath` and both write/read into KB
directories. M2 (description overrides) and parts of M3 (stats) are
convenience packaging: they could land as drive-bys against the unchanged
server. Keeping one RFC preserves design coherence for the heaviest
consumers; the drive-bys ride along.

### 2.3 What RFC 006 / 007 have already claimed

This RFC must not re-litigate decisions already made. Concretely:

- **Per-KB index isolation and the `refresh_knowledge_base` tool name** are RFC
  007's turf (RFC 007 §6.3, §6.4; RFC 007 stage 3.1 for the tool; stage
  4.1+4.2 for the per-KB layout). This RFC uses RFC 007's names and
  signatures — it does not redesign the on-disk layout. §5.4 resolves the
  naming overlap in writing.
- **Chunk metadata `chunkIndex` and `knowledgeBase`** are claimed by RFC 006
  M1.3 (RFC 006 §5.5.2 dedup key; RFC 006 §10 M1.3 checklist) and used in RFC
  007 §6.4.3's metadata-based migration path. This RFC adds `tags`,
  `extension`, `relativePath` *and takes authoritative ownership of the chunk
  metadata shape* (§5.1.3) to avoid a coordination race.
- **Tombstones and FAISS delete semantics** are flagged in RFC 007 §6.4.1
  (tombstone marker on delete; orphaned vectors until rebuild). This RFC
  cross-references that; it does not duplicate.
- **Multi-provider fusion** is RFC 006's territory. §5.7 shows how `kb_stats`
  handles the multi-shard layout if RFC 006 lands first.

### 2.4 Competitive audit (quoting the issues)

- **#49** (Resources): *"MCP clients that enumerate Resources — e.g. Claude
  Desktop's `@`-mention, Cursor's file picker, Continue's context builder —
  see nothing."* Filesystem reference server is the design precedent.
- **#51** (Ingest): *"`chroma-mcp`: `chroma_add_documents`,
  `chroma_update_documents`, `chroma_delete_documents`. `pinecone-mcp`:
  `upsert-records`."*
- **#52** (Description override): *"`qdrant-mcp` lets operators override
  descriptions via env vars, so the same binary can present as 'Search product
  engineering docs and runbooks' or 'Search incident postmortems'."*
- **#53** (Filters): *"`chroma-mcp`: `where` argument for metadata filters.
  `pinecone-mcp`: `filter` argument on `search-records`."*
- **#54** (Stats): *"`pinecone-mcp`'s `describe-index-stats` is the
  precedent."*

## 3. Goals

- **G1.** Unify the five cross-cutting concerns (path resolution, KB-name
  validation, chunk metadata, frontmatter parsing) into a single M1
  foundations milestone that no user-visible tool depends on in isolation.
- **G2.** Add MCP Resources (`kb://{kb}/{path}`) so clients with file-picker
  UIs can directly reference KB documents without going through similarity
  search.
- **G3.** Add ingest tools (`add_document`, `delete_document`,
  `refresh_knowledge_base`) so agents can mutate a KB over the MCP surface,
  consistent in naming with RFC 007.
- **G4.** Add tool-description env-var overrides so operators can steer
  tool-selection policy without patching the binary.
- **G5.** Add metadata filters (`extensions`, `path_glob`, `tags`) to
  `retrieve_knowledge`, back-compatible with today's
  `{ query, knowledge_base_name, threshold }`.
- **G6.** Add `kb_stats` so agents and operators can introspect index state.
- **G7.** Keep every change additive at the tool-protocol level — a client
  that knows nothing about the new tools/arguments still works against this
  server.

## 4. Non-goals

- **NG1 — Multi-tenant ACLs.** Who-can-read-what is deferred to a future
  remote-transport RFC (provisionally "RFC 008"; no stub exists yet — if it
  opens before this RFC merges, the references in §5 are upgraded to the
  actual PR/RFC number). v1 assumes the local process is a single-user trust
  boundary (same as today).
- **NG2 — True FAISS vector delete for `delete_document` in v1.**
  **Correction from round-1 review**: `faiss-node` *does* expose
  `removeIds(ids)` (`faiss-node/lib/index.d.ts:109`) and
  `FaissStore.delete({ ids })` is fully implemented in
  `@langchain/community/dist/vectorstores/faiss.js:150-177`. So this is
  technically achievable. **We defer it nonetheless** because implementing it
  requires tracking `filePath → ids[]` at ingest time (today's sidecar at
  `src/FaissIndexManager.ts:243-244` stores a single hash string — no ids).
  That sidecar-format change is a cleaner fit for RFC 007's manifest work
  (RFC 007 §6.2.1, stage 2.1) than for this RFC. §5.4.4 documents the v1
  shortcut (file-only delete + dead-source filter on retrieve) and the clean
  upgrade path (once the sidecar carries ids, `delete_document` gains one
  line: `await this.faissIndex.delete({ ids: sidecar.ids })`).
- **NG3 — Front-matter schema standardization.** We ship a minimal contract
  (string `tags` or `tags: [string]`, ignore unknown keys, FAILSAFE YAML
  schema so no `!!js/*` type-coercion surface). No JSON-Schema validation,
  no required fields, no CI gate on frontmatter shape.
- **NG4 — `resources/subscribe`.** Live resource-update streaming depends on
  RFC 007 §6.6's watcher (RFC 007 stage 5.1) landing on-by-default. v1 ships
  `resources/list` + `resources/read` only. See §5.3.4.
- **NG5 — Per-argument tool-description overrides.** #52 calls this out as
  optional v2. We expose only the *tool-level* description env vars in v1.
- **NG6 — Batch/bulk ingest.** `add_document` accepts one document per call.
- **NG7 — Rewriting RFC 007's per-KB layout.** If RFC 007 stage 4.1+4.2 has
  landed by the time this RFC is implemented, §5.4 and §5.7 consume its
  layout directly. If not, the implementation PRs wait on RFC 007.
- **NG8 — Changing the single FAISS store's provider/model story.** RFC 006's
  territory.
- **NG9 — `update_document` (edit-in-place).** Whole-file replace is covered
  by `add_document { overwrite: true }` (§5.4.2). True append / edit-in-place
  needs content-addressed versioning and is out of scope; a client that wants
  to append calls `resources/read` → concatenate → `add_document` overwrite.

## 5. Proposed design

### 5.1 Unified cross-cutting primitives (specified once, used everywhere)

These primitives are the M1 foundations PR. They land with **no user-facing
tool surface change** — they are pure building blocks consumed by M2–M6.

#### 5.1.1 Path resolution & traversal guard — `resolveKbPath`

**Location:** new file `src/paths.ts` (module-scoped helper; does not live on
`KnowledgeBaseServer` or `FaissIndexManager` because both call it).

**Signature:**

```ts
export async function resolveKbPath(
  kbName: string,
  relativePath: string,
): Promise<{ abs: string; kbRoot: string; relative: string }>;
```

**Contract** (the canonical, round-1-reviewed version):

1. **Validate `kbName`** against the regex in §5.1.2. Throw `Error("invalid KB name")` on mismatch.
2. **Null-byte check.** If `relativePath.includes('\0')`, throw
   `Error("path contains null byte")`. Older Node behaved inconsistently
   here; an explicit check is cheap.
3. **Cross-platform separator normalization.** Convert any backslashes in
   `relativePath` to forward-slashes. We enforce POSIX semantics on the
   untrusted input regardless of host OS, consistent with §5.1.3's
   forward-slash contract and the `kb://` URI scheme (§5.2).
4. **Lexical traversal check.** Use `path.posix.normalize` (not the platform
   `path.normalize`, to make the check platform-independent):
   `normalized = path.posix.normalize(relativePath)`.
   - If `path.posix.isAbsolute(normalized)` (leading `/`), throw
     `Error("path must be relative")`.
   - Split on `'/'` and reject if any segment equals `..`. Equivalent
     formulation: `normalized === '..' || normalized.startsWith('../') ||
     normalized.includes('/../') || normalized.endsWith('/..')`. This is
     **segment-aware** and must NOT reject filenames that merely start with
     `..` (e.g. `..notes.md` at the KB root is a legal filename and must be
     accepted).
5. **Build the absolute candidate.** `kbRoot = path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName)`;
   `candidate = path.join(kbRoot, normalized)`.
6. **Realpath-walk for symlink safety.** Because `candidate` may not exist
   yet (e.g. `add_document` creating a new file), walk up from `candidate`
   until an existing ancestor is found, realpath that ancestor (`fsp.realpath`
   — follows symlinks as intended), and re-append the remaining tail. Call
   the result `resolvedCandidate`. The walk-up probe uses `fsp.stat` (follows
   symlinks) so symlinks in the walked chain are detected as "existing" and
   trigger `realpath` on them — which is desired: a symlink pointing outside
   the KB must surface in the prefix check below.
7. **Prefix check.** `kbRootReal = await fsp.realpath(kbRoot)`. Build the
   comparison prefix: `const prefix = kbRootReal.endsWith(path.sep) ? kbRootReal : kbRootReal + path.sep`.
   This handles the filesystem-root edge case (e.g. `realpath(kbRoot) === '/'`
   on a chrooted deployment). If `resolvedCandidate !== kbRootReal` AND
   `!resolvedCandidate.startsWith(prefix)`, throw
   `Error("path escapes KB root")`.
8. **Return.** `{ abs: resolvedCandidate, kbRoot: kbRootReal, relative: normalized }`.

**Error messages MUST NOT leak absolute paths** — they include the
user-supplied `relativePath` only. Server-side logging retains absolute paths
for operator diagnostics, writing to stderr only per CLAUDE.md.

**Tests (M1):** cover (a) happy path inside KB; (b) `../` escape rejected;
(c) absolute `/etc/passwd` rejected; (d) symlink-to-outside rejected after
realpath; (e) non-existent target with existing parent (the `add_document`
case) accepted; (f) non-existent target with non-existent parent chain
accepted while still rejecting `..` in the chain; (g) filename literally named
`..foo.md` at KB root is **accepted** (segment-aware check regression);
(h) null byte in path rejected; (i) Windows-style `..\\..\\secrets`
(backslash separator) rejected on POSIX after normalization;
(j) percent-encoded `%2E%2E` decoded upstream (in `resources/read`) still
flows through this guard and is rejected; (k) `KNOWLEDGE_BASES_ROOT_DIR` is
the filesystem root — the prefix check still works.

#### 5.1.2 KB-name validation — `isValidKbName`

**Location:** same `src/paths.ts`.

```ts
export const KB_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/;
export function isValidKbName(name: string): boolean;
```

**Rules:**

- First char `[a-z0-9]` — forbids leading `.` (no dotfiles) and leading `-`
  (no ambiguity with CLI flags).
- Remaining chars `[a-z0-9._-]` — forbids `/` (separator), `\\` (Windows
  separator), uppercase (case-folding bugs on case-insensitive filesystems).
- No explicit `..` check needed — leading-dot rule rejects `..foo`. The
  regex does accept names like `a..b` or `a.` (trailing dot); these are
  safe because `/` is forbidden (no path segmentation), but on Windows
  filesystems a trailing dot may collide with the same name minus the dot
  (NTFS strips them on create). We accept this in v1 — it only matters on
  Windows hosts and only for KB renaming.
- Added to the test matrix: `..foo`, `a..b`, `a.`, `node_modules`, `A`
  (uppercase rejected), `KB-2025` (uppercase + `-`, rejected), empty string.

**Back-compat for existing directories.** Users may already have KB
directories with names that don't match the new regex (e.g. `My Notes`,
`KB-2025`). M1 applies the regex **only on tool inputs**, not to
directory-listing in `list_knowledge_bases` — that continues to emit whatever
directory names are present. A KB with an invalid name is visible via
`list_knowledge_bases` but unreachable via the new tools (a client calling
`add_document` on `My Notes` gets an "invalid KB name" error). The CHANGELOG
entry for M1 flags this and recommends renaming such KBs. A migration helper
is out of scope.

#### 5.1.3 Chunk metadata schema (**authoritative**)

**Current shape** (four call sites, all identical):
`src/FaissIndexManager.ts:267`, `:272`, `:324`, `:329` — all set
`{ source: filePath }` only.

**Proposed shape**, written onto every `Document.metadata` during ingest:

```ts
type ChunkMetadata = {
  source: string;          // absolute file path (unchanged — back-compat)
  knowledgeBase: string;   // NEW — first path segment under KNOWLEDGE_BASES_ROOT_DIR
  relativePath: string;    // NEW — path under <kb>/, forward-slashes only, no leading ./
  extension: string;       // NEW — lowercased, includes the dot: ".md", ".txt", ""
  tags: string[];          // NEW — from frontmatter; [] when none
  chunkIndex: number;      // NEW — 0-based index within the file's chunk list;
                           //       0 for non-markdown files (one-chunk whole file)
};
```

**Cross-RFC contract — authoritative:** RFC 010 M1 writes **all six fields**
at all four splitter call sites unconditionally. RFC 006 M1.3 previously
claimed `knowledgeBase` and `chunkIndex`; the RFC 006 draft anchor at
`src/FaissIndexManager.ts:235-240` pre-dates the current layout and points at
one call site. Rather than rely on coordination-by-README — which was flagged
as a "race-prone contract" in round-1 review — **this RFC takes ownership of
the chunk metadata shape**:

- If RFC 010 M1 lands first: RFC 006 M1.3 becomes a no-op for chunk metadata
  (RFC 006 M1.3 was only introducing the two fields this RFC already writes).
  RFC 006's other M1.3 work (`Shard.ts` introduction) is unaffected.
- If RFC 006 M1.3 lands first *as currently written* (single call site, two
  fields): RFC 010 M1 still writes all six fields at all four call sites —
  the four-site coverage in this RFC is authoritative and supersedes RFC
  006's M1.3 single-site anchor.
- Either way, M1's PR description explicitly states "RFC 010 M1 is
  authoritative for chunk metadata; any prior RFC 006 M1.3 mention of
  `chunkIndex`/`knowledgeBase` is subsumed by this change."

**Deterministic `chunkIndex`.** The splitter today is `MarkdownTextSplitter`
from `langchain/text_splitter` configured at
`src/FaissIndexManager.ts:262-266`. Output is an ordered array;
`chunkIndex = arrayIndex`. For non-markdown files the whole file is one
`Document` (`src/FaissIndexManager.ts:268-275`) — `chunkIndex = 0`.

**Forward-slashes in `relativePath`.** On Windows, `path.relative` returns
backslashes. M1 normalizes to forward-slashes before writing metadata, so the
glob engine (minimatch, §5.6) and the `kb://` URIs (§5.2) both agree on one
separator. Tested.

**Interaction with `source`.** `source` stays as an absolute path for
back-compat — existing tests assert its value (e.g. the "file path inside a
result" check in `src/FaissIndexManager.test.ts`). `relativePath` is the new
field filters and URIs address against. The MCP response formatter in
`handleRetrieveKnowledge` continues to serialize the whole metadata block
including `source`; clients consuming the RFC's new fields can render
`kb://<knowledgeBase>/<relativePath>` instead of the absolute `source`.
Full removal of absolute paths from client-visible output is a v2 concern
tracked against a future remote-transport RFC.

#### 5.1.4 Frontmatter parsing

**Location:** new `src/frontmatter.ts`; new dependency `gray-matter ^4.0.3`
(pin documented in M1 PR, verified at implementation time to use
`js-yaml ≥ 3.13` which supports the `FAILSAFE_SCHEMA` we rely on below).

**Signature:**

```ts
export function parseFrontmatter(content: string): {
  tags: string[];
  body: string;      // content with frontmatter stripped, or original if no frontmatter
};
```

**Rules:**

- **Delimiter detection with a size cap.** If the first 4 bytes of `content`
  are not `"---\n"` / `"---\r\n"`, return `{ tags: [], body: content }`
  with zero parsing work. Short-circuit for the common case.
- **Frontmatter size cap — enforced by slicing, not just pre-scanning.**
  Before invoking `gray-matter`, find the closing `---` delimiter by scanning
  at most the first `FRONTMATTER_MAX_BYTES` (default 64 KiB, env-overridable)
  of `content`. If no closing delimiter is found within the cap, treat the
  file as having no frontmatter (`{ tags: [], body: content }`) and log
  `debug`. When the delimiter IS found, pass
  `content.slice(0, closingDelimiterEnd)` (not the full `content`) to
  `gray-matter` so the YAML parser's input is bounded at the cap
  regardless of what lies after the frontmatter. This defends against an
  author smuggling a fake `---` inside a YAML value — if `gray-matter`
  received the full content it would independently re-scan and re-parse
  past the caller's cap, negating the DoS protection.
- **Safe YAML schema.** Configure `gray-matter` to use a YAML parser bound to
  `js-yaml`'s `FAILSAFE_SCHEMA`:
  ```ts
  matter(prefix, {
    engines: {
      yaml: {
        parse: (s) => jsYaml.load(s, { schema: jsYaml.FAILSAFE_SCHEMA }),
        stringify: () => { throw new Error('stringify not used'); },
      },
    },
  });
  ```
  FAILSAFE forbids `!!js/*` tags (no code execution surface) and does not
  resolve non-string scalars (a YAML `true` stays the string `"true"`),
  eliminating type-coercion surprises on `tags: true` and the like.
- **Parse errors → fallback.** If `gray-matter` throws (malformed YAML),
  log `warn` with `relativePath` and return `{ tags: [], body: content }`.
  Parser hangs / OOM are bounded by the size cap above.
- **Extract `tags`:**
  - If `Array.isArray(data.tags)`: filter to `typeof === 'string'`, trim,
    drop empty, dedupe.
  - Else if `typeof data.tags === 'string'`: `[data.tags.trim()]` after
    empty-drop.
  - Else: `[]`.
  - If ≥1 non-string element was silently dropped from an array, log
    `debug` with the file's `relativePath`.
- Ignore every other frontmatter key in v1. Unknown-key handling is
  "silently dropped".

**When parsing runs.** Inside `updateIndex`, right after `fsp.readFile`
(`src/FaissIndexManager.ts:254` and `src/FaissIndexManager.ts:312`), before
the splitter call. `tags` is attached to every chunk the file produces.
`body` replaces `content` as the splitter input so chunks don't contain the
YAML block.

**Non-markdown with `---\n` prefix.** A non-markdown file that starts with
`---\n` is most likely *intended* to carry frontmatter (e.g. a `.txt`
wrapped to add tags). The prefix check is the signal; the extension is not.

**Test matrix:** no-frontmatter; valid tags as list; valid tag as string;
tags with non-string elements (e.g. `[1, "release"]` → `["release"]` only);
malformed YAML (graceful fallback); CRLF delimiters; billion-laughs alias
expansion (size-cap-rejected *or* FAILSAFE-parsed without expansion, timing
< 100 ms); 128 KiB leading `---\n` without closing delimiter (treated as
"no frontmatter" content); `tags: true` under FAILSAFE (stays string, not
coerced).

### 5.2 URI scheme and naming glossary

- **`kb://<kb-name>/<relative-path>`** — an MCP Resource URI. `<kb-name>`
  matches `KB_NAME_REGEX`; `<relative-path>` is forward-slash-separated. The
  server decodes once via `decodeURI` on the pathname (see §5.3.2 for the
  security rationale — `decodeURI` preserves `%2F` and `%23` which prevents
  URL-encoded separator smuggling; `%2E%2E` still decodes to `..` but the
  downstream `resolveKbPath` guard catches it).
- **Shard.** RFC 006 concept: one (provider, model) pair's FAISS store. This
  RFC is shard-agnostic at the tool surface; `kb_stats` rolls up across
  shards in v1 (§5.7.6).
- **KB.** Knowledge base directory under `KNOWLEDGE_BASES_ROOT_DIR`. Same
  meaning as `list_knowledge_bases` returns today.
- **Document / chunk.** Same as RFC 006 §5.5.2: a `Document` from
  `@langchain/core`, whose `metadata` conforms to §5.1.3.

### 5.3 Issue #49 — MCP Resources surface

**Registered capability:** `resources` (new). `setupResources()` method added
to `KnowledgeBaseServer`, invoked from the constructor next to `setupTools()`
(`src/KnowledgeBaseServer.ts:24`).

#### 5.3.1 `resources/list`

Enumerates every file across every KB. Pseudo-spec (literate prose, *not*
executable TS — the implementation PR writes the real code):

- Read `$KNOWLEDGE_BASES_ROOT_DIR` entries.
- For each entry that passes `isValidKbName` and does not start with `.`:
  call `getFilesRecursively(kbRoot)` (already in `src/utils.ts:18`, already
  skips dotfiles at `src/utils.ts:25-27`).
- For each returned file: check the extension is in the mimetype map
  (§5.3.3). Skip unsupported extensions.
- Emit
  `{ uri: kb://<kbName>/<relative-forward-slash>, name: basename, mimeType, description: 'Document in knowledge base "<kbName>"' }`.

**Soft cap on list cardinality.** Enforce
`RESOURCES_LIST_MAX_ENTRIES` (default 10 000, env-overridable). On the
10 000-th entry: stop walking, append a diagnostic entry
`{ uri: 'kb://.diagnostic/truncated', name: 'LIST_TRUNCATED', description: 'resources/list truncated at N entries — use a future pagination API' }`,
and log `warn` with the total file count. This is a v1 safety valve, not
pagination — pagination itself is v2 (R5 in §7.1).

#### 5.3.2 `resources/read`

Given `uri = kb://<kb-name>/<relative-path>`:

1. Parse as `new URL(uri)`. Reject if `protocol !== 'kb:'`.
2. Extract `kbName = url.hostname` (not `url.host`; `host` includes the port
   if supplied). If empty, reject with error
   `"kb:// URI requires a non-empty KB authority"`.
3. **Immediately** call `isValidKbName(kbName)` and reject with
   `"invalid KB name in kb:// URI"` on failure — do not rely on
   `resolveKbPath` as the first validator; future refactors that rewire the
   read path must not lose the explicit name check.
4. `relativePath = decodeURI(url.pathname).replace(/^\//, '')`.
   `decodeURI` is used deliberately instead of `decodeURIComponent`:
   `decodeURI` preserves `%2F`, `%23`, etc., preventing URL-encoded
   separators from being interpreted as path separators after decode.
   `%2E%2E` still decodes to `..`, but the subsequent `resolveKbPath`
   normalize-and-reject-`..` guard catches it. **Do NOT** switch to
   `decodeURIComponent` without re-proving the traversal chain.
5. `{ abs } = await resolveKbPath(kbName, relativePath)` — traversal guard.
6. **Size cap.** `stat = await fsp.stat(abs)`. If `stat.size >
   RESOURCES_READ_MAX_BYTES` (default `10_485_760` = 10 MiB,
   env-overridable via `RESOURCES_READ_MAX_BYTES`), reject with a clean MCP
   error — do not attempt to load a multi-GB file into a single V8 string.
7. `content = await fsp.readFile(abs, 'utf-8')` — text-only in v1; see
   §5.3.3.
8. Return `{ contents: [{ uri, mimeType, text: content }] }`.

#### 5.3.3 Mimetype map

Conservative and minimal:

| Extension | `mimeType` | Returned as |
| --- | --- | --- |
| `.md`, `.markdown` | `text/markdown` | text |
| `.txt` | `text/plain` | text |
| `.json` | `application/json` | text |
| `.csv` | `text/csv` | text |
| `.html`, `.htm` | `text/html` | text |
| `.xml` | `application/xml` | text |
| `.yaml`, `.yml` | `application/yaml` | text |
| *anything else* | — | **refused** — see below |

Refusal rationale: the server has no PDF/DOCX/etc. extractors today (RFC 006
§2 and RFC 007 §4 both flag PDF loaders as future work). Advertising a
`.pdf` Resource but returning raw bytes would mislead clients. Unsupported
extensions return an MCP error "no reader available for extension <ext>"
rather than being listed-and-broken. When a loader lands, the table grows.

**Consequence for `resources/list`:** the list enumerates only files whose
extension is in the map above. A KB with mixed markdown and PDFs shows only
the markdown in v1. CHANGELOG calls this out. `kb_stats` (§5.7) reports
total file counts unconditionally so users see what's hidden.

#### 5.3.4 `resources/subscribe` — explicitly v2

Gated on RFC 007 stage 5.1's watcher being on-by-default (per RFC 007 §6.6
and §9 decision gate B). Once live, a follow-up PR flips on
`resources/subscribe` + emits `resources/updated` when the watcher's
dirty-set flush completes. No design in this RFC — the watcher's
notifications are what we subscribe to. Tracked as "follow-up to M5" in §8.

### 5.4 Issue #51 — Ingest tools (`add_document`, `delete_document`, `refresh_knowledge_base`)

#### 5.4.1 Naming coordination with RFC 007 (resolves the overlap)

RFC 007 §6.3 (stage 3.1) proposes an MCP tool `refresh_knowledge_base` with
this signature:

```ts
this.mcp.tool(
  'refresh_knowledge_base',
  'Force a rescan of the given knowledge base …',
  { knowledge_base_name: z.string().optional() },
  async (args) => { await this.faissManager.updateIndex(args.knowledge_base_name); … },
);
```

This RFC adopts that name (earlier drafts floated `reindex_knowledge_base`;
corrected after review). Coordination:

- RFC 007 is further along in the implementation queue (PRs 0.0, 0.1, 1.1
  have merged — see `git log`). Matching its name avoids a user-visible
  rename.
- **Branch A**: RFC 007 stage 3.1 ships first → this RFC's M6 *consumes* the
  tool (no duplication).
- **Branch B**: RFC 007 stage 3.1 has NOT shipped when M6 opens → M6 adds
  `refresh_knowledge_base` with identical semantics, and RFC 007 stage 3.1
  is closed "subsumed by RFC 010 M6" (cross-post to both issues).
- **Branch C**: RFC 007's decision gate A rejects §6.3 (the mtime
  short-circuit in RFC 007 §7.5 hits G3, removing the motivation for
  `SKIP_PER_QUERY_INDEX`) → RFC 010 M6 **still** ships
  `refresh_knowledge_base` because ingest tools need an explicit re-index
  escape hatch regardless of whether the per-query scan stays.

From here, this RFC uses `refresh_knowledge_base` unconditionally.

#### 5.4.2 `add_document`

```ts
this.mcp.tool(
  'add_document',
  'Write a new document into a knowledge base and schedule it for indexing. ' +
    'Path is relative to the KB root. Parent directories are created. ' +
    'Refuses to overwrite an existing file unless overwrite:true is passed. ' +
    'After the file is written, the KB is re-indexed incrementally.',
  {
    knowledge_base_name: z.string().describe('…'),
    path: z.string().describe('Relative path under the KB root. Forward-slash separator. No `..` segments.'),
    content: z.string().describe('UTF-8 text content of the new document.'),
    overwrite: z.boolean().optional().describe('Default false. If true, replace an existing file.'),
  },
  async (args) => this.handleAddDocument(args),
);
```

**Behaviour (corrected after security review):**

1. `{ abs } = await resolveKbPath(args.knowledge_base_name, args.path)`.
2. Enforce `ADD_DOCUMENT_MAX_BYTES` (default 10 MiB, env-overridable). If
   `Buffer.byteLength(args.content, 'utf-8')` exceeds the cap, reject with
   a clean error. Symmetric with `RESOURCES_READ_MAX_BYTES` (§5.3.2).
3. `await fsp.mkdir(path.dirname(abs), { recursive: true })`.
4. **Intermediate-directory re-check.** `O_NOFOLLOW` on `open` only checks
   the final component — it does NOT prevent symlink traversal through
   intermediate directories that may have been created or swapped between
   `resolveKbPath` (step 1) and the `open` call (step 5). Re-run the §5.1.1
   realpath prefix check on `path.dirname(abs)` immediately after `mkdir`
   and before `open`: if the realpath of `dirname(abs)` is no longer a
   prefix of `realpath(kbRoot)`, abort. This closes the intermediate-dir
   symlink race under adversarial fs conditions; under the NG1 single-user
   trust boundary it's defensive but cheap.
5. **Open atomically with `O_NOFOLLOW`.** The plain `fsp.writeFile` call
   follows symlinks, which opens a TOCTOU window where a concurrent process
   can plant a symlink at `<abs>` after step 4 and before the open. Use
   instead:
   ```ts
   const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC, O_NOFOLLOW } = fs.constants;
   const baseFlags = O_WRONLY | O_CREAT | O_NOFOLLOW;
   const flags = args.overwrite
     ? baseFlags | O_TRUNC   // overwrite=true: truncate if file exists, still refuse symlinks
     : baseFlags | O_EXCL;   // overwrite=false: fail if file exists (atomic create)
   const fh = await fsp.open(abs, flags, 0o644);
   try { await fh.writeFile(args.content, 'utf-8'); } finally { await fh.close(); }
   ```
   The `O_NOFOLLOW` flag is honoured by Node's `fs.promises.open` on Linux
   and macOS; on platforms without it the open fails fast with `EINVAL` —
   acceptable. Windows: `O_NOFOLLOW` is a no-op, but the platform lacks
   symlink-creation rights by default for non-admins, which mitigates
   most of the attack surface. Documented as a known gap in the README's
   security section.
6. `await this.faissManager.updateIndex(args.knowledge_base_name)` —
   synchronous re-index of the KB. Returns after the new file's chunks are
   in the index.

**Why synchronous re-index.** An agent workflow that says "save this to
notes, then ask what I have on X" *depends* on the new content being
queryable. A background re-index would race. Consistent with RFC 007's
`refresh_knowledge_base`.

**Ingest-path side-effects inherited.** `updateIndex` applies §5.1.3
metadata enrichment, §5.1.4 frontmatter parsing, and RFC 007 §6.2's batching
(once stage 2.1 ships). No `add_document`-specific ingest path.

#### 5.4.3 `delete_document`

```ts
this.mcp.tool(
  'delete_document',
  'DESTRUCTIVE: Delete a document from a knowledge base. Removes the file and its hash sidecar. ' +
    'Note: faiss-node supports vector deletion (FaissStore.delete), but this server does not ' +
    'yet track per-file vector IDs at ingest time, so v1 removes the file only. Orphan vectors ' +
    'for the removed file remain in the index until a rebuild via refresh_knowledge_base after ' +
    'clearing $FAISS_INDEX_PATH/. True vector delete lands when RFC 007 extends the sidecar with IDs.',
  {
    knowledge_base_name: z.string(),
    path: z.string(),
  },
  async (args) => this.handleDeleteDocument(args),
);
```

**Behaviour (corrected after round-1 review):**

1. `{ abs, kbRoot, relative } = await resolveKbPath(args.knowledge_base_name, args.path)`.
2. `await fsp.rm(abs)` — errors if the file doesn't exist (preferred to
   silent success; a caller deleting something that isn't there has a bug).
   `fsp.rm` unlinks the symlink itself rather than following it (confirmed
   behaviour; safe).
3. Best-effort remove the hash sidecar at
   `<kbRoot>/.index/<dirname(relative)>/<basename(relative)>` — using
   `relative` on BOTH sides to match what ingest wrote at
   `src/FaissIndexManager.ts:229-231` (earlier drafts used
   `basename(abs)`; that diverges from the ingest path when symlinks are
   involved). If the sidecar doesn't exist, ignore.
4. Do **not** run `updateIndex` — the next retrieval call picks up the
   deleted-file state.

#### 5.4.4 FAISS orphan-vectors — documented limitation + upgrade path

**Round-1 correction.** `faiss-node` exposes `removeIds(ids: number[])` on
the base `Index` class (`faiss-node/lib/index.d.ts:109`), and
`@langchain/community/dist/vectorstores/faiss.js:150-177` implements
`FaissStore.delete({ ids })` fully — it resolves ids to FAISS labels via
`_mapping`, calls `this.index.removeIds(indexIdToDelete)`, and updates the
docstore and mappings. So vector delete **is** technically achievable.

**Why v1 defers it (NG2):** the current per-file sidecar at
`src/FaissIndexManager.ts:243-244` stores a single SHA-256 hash. To call
`FaissStore.delete({ ids })`, the sidecar must also record the vector IDs
produced at ingest time. That format change is substantial — it touches
every `updateIndex` write site and needs crash-safety equivalent to the
hash tmp+rename pattern. RFC 007 §6.2.1 (stage 2.1) already designs a
manifest-based sidecar evolution; adding `ids: number[]` to that manifest
is the clean upgrade point. Duplicating the work here would fork the
sidecar design.

**v1 consequences, stated bluntly:**

- A `retrieve_knowledge` call after `delete_document` may return a chunk
  whose `source` no longer exists on disk. M4's dead-source filter
  (§5.6.6 — **moved from M6 per round-1 scope review**) `fsp.stat`s each
  of the ≤ top_k result rows and drops dead ones. Cost: one `stat` per
  result — negligible. TOCTOU: a delete that happens after `stat` and
  before return is not masked; the caller sees a live-looking row and a
  follow-up `resources/read` returns 404. Acceptable.
- The FAISS index file grows monotonically with deletes until rebuilt.
- `kb_stats` v1 reports a single `chunk_count_live` per KB (§5.7.4 —
  ingest-only-accurate, decremented only on `delete_document` when the
  file existed). A separate top-level `chunk_count_on_disk_global`
  (=`FaissStore.index.ntotal()` summed across all shards) is exposed so
  the operator sees whole-server divergence. Per-KB
  `chunk_count_on_disk` becomes available only once RFC 007 stage
  4.1+4.2 lands the per-KB FAISS store split (each KB's store has its
  own `.ntotal()`). Rule of thumb (whole-server): rebuild when
  `sum(chunk_count_live) < 0.7 × chunk_count_on_disk_global` or
  monthly, whichever first — documented in README.

**Clean upgrade path (v2):** once RFC 007's manifest includes per-file
vector IDs, `delete_document` becomes:

```ts
// v2 implementation after sidecar carries ids:
await this.faissIndex.delete({ ids: sidecar.ids });   // real vector delete
await fsp.rm(abs);
await fsp.rm(sidecarPath);
```

— one-line addition at the top of today's handler. No schema change to the
`delete_document` MCP tool. Tracked as an RFC 010 v2 follow-up.

#### 5.4.5 `refresh_knowledge_base`

Adopted from RFC 007 §6.3 (see §5.4.1 for the three-branch consumption
plan). No new design in this RFC.

#### 5.4.6 Optional kill-switch — `KB_INGEST_ENABLED`

**Defense-in-depth for prompt-injection scenarios.** A KB file's content can
contain instructions that persuade a model to call `delete_document` on
user-critical files. v1 ships with ingest enabled by default (matches the
local-trust assumption in NG1), but operators can disable the write surface
with a single env var:

```
KB_INGEST_ENABLED=false
```

When `false`, `setupTools` **does not register** `add_document`,
`delete_document`, or `refresh_knowledge_base` — they don't appear in
`tools/list`. The read-side tools (`list_knowledge_bases`,
`retrieve_knowledge`, `kb_stats`) and Resources surface continue to work.
Zero runtime cost, no coupling to a future remote-transport RFC. This is a
strictly additive safety valve; per-tool auth with bearer tokens remains
RFC 008's territory (NG1).

### 5.5 Issue #52 — Tool description overrides

#### 5.5.1 Env-var contract

Two environment variables, read once at server construction (not per-call):

| Variable | Default | Purpose |
| --- | --- | --- |
| `RETRIEVE_KNOWLEDGE_DESCRIPTION` | *(current hard-coded string at `src/KnowledgeBaseServer.ts:42`)* | Override for `retrieve_knowledge`. |
| `LIST_KNOWLEDGE_BASES_DESCRIPTION` | `"Lists the available knowledge bases."` | Override for `list_knowledge_bases`. |

Both are read in `setupTools()` (`src/KnowledgeBaseServer.ts:33-50`) and fall
back to the current literal strings on unset/empty.

#### 5.5.2 Why only these two

The new tools added by this RFC (`add_document`, `delete_document`,
`refresh_knowledge_base`, `kb_stats`) also register description strings.
Extending the override pattern to all of them is cheap — one
`process.env.*` lookup per tool — but only `retrieve_knowledge` and
`list_knowledge_bases` are model-facing in a way that materially changes
tool selection. The ingest tools are called because an agent *decided* to
write something; description doesn't steer selection in the same way. v1
ships only the two called out in #52; adding the rest is a one-line-per-tool
patch release if anyone asks.

#### 5.5.3 Per-arg overrides — explicitly v2

Issue #52 flags per-arg overrides as "optional v2". We honour that: M2 ships
tool-level only.

### 5.6 Issue #53 — Metadata filters on `retrieve_knowledge`

#### 5.6.1 Extended schema — additive

`src/KnowledgeBaseServer.ts:43-47` today:

```ts
{
  query: z.string(),
  knowledge_base_name: z.string().optional(),
  threshold: z.number().optional(),
}
```

M4 adds three fields, keeping every existing field unchanged:

```ts
{
  query: z.string(),
  knowledge_base_name: z.string().optional(),
  threshold: z.number().optional(),
  // threshold: unchanged semantics; deprecated by RFC 006 §8.3 (removed in v0.4.0).
  extensions: z.array(z.string()).optional().describe(
    'Limit results to chunks whose source file extension matches one of these (with leading dot; e.g. [".md", ".pdf"]).'
  ),
  path_glob: z.string().optional().describe(
    'Limit results to chunks whose relativePath matches this glob (minimatch syntax, e.g. "runbooks/**/*.md"). Leading slashes are stripped before matching.'
  ),
  tags: z.array(z.string()).optional().describe(
    'Limit results to chunks whose source file has ALL of these frontmatter tags (AND semantics).'
  ),
}
```

**Back-compat:** a client that only knows the three existing fields works
unchanged.

#### 5.6.2 Filter semantics

- **`extensions`**: chunk passes iff `metadata.extension ∈ extensions`.
  `metadata.extension` is already lowercased at ingest (§5.1.3), so the
  filter lowercases only the caller-supplied values and does a direct
  compare. **Empty array `extensions: []` means no filter** (every chunk
  passes), distinct from the field being undefined; semantics are
  identical to omitting the field.
- **`path_glob`**: chunk passes iff
  `minimatch(metadata.relativePath, path_glob, { dot: false, matchBase: false })`.
  Leading slashes in `path_glob` are stripped first
  (`path_glob.replace(/^\/+/, '')`) because `minimatch` treats a leading
  slash as filesystem-root. **Empty string `path_glob: ""` means no
  filter** (every chunk passes).
- **`tags`**: chunk passes iff every `tag ∈ tags` is present in
  `metadata.tags` (AND semantics). **Empty array `tags: []` means no
  filter** (every chunk passes), distinct from the field being undefined.

Summary: empty-container sentinels (`extensions: []`, `path_glob: ""`,
`tags: []`) all mean "no filter applied" — semantically equivalent to
omitting the field. Tested.

**Combining:** a chunk must satisfy every supplied filter (AND across the
three). Matches `chroma-mcp`'s `where` with multiple predicates. A caller
wanting OR makes two calls. Complex-filter support (generic `filter` JSON)
is a v2.

#### 5.6.3 Post-filter (FAISS filter is ignored entirely today)

**Round-1 correction.** Earlier drafts claimed FAISS's filter argument is
"score-only". Verified against
`node_modules/@langchain/community/dist/vectorstores/faiss.js:111`: the
`similaritySearchVectorWithScore` override accepts only `(query, k)` and
**ignores the filter argument entirely** — so the existing
`{ score: { $lte: threshold } }` at `src/FaissIndexManager.ts:399` is dead
code today. This means:

- The existing `threshold` is a **no-op in production**. The 10 result
  default ceiling at `src/KnowledgeBaseServer.ts:88` (`k = 10` hard-coded)
  is the only effective cap.
- M4 must apply BOTH the new metadata filters AND a manual score cap in the
  post-filter step, restoring threshold's intended behaviour.

**Implementation:**

1. `candidates = await similaritySearchWithScore(query, k * overfetch)`
   (filter argument dropped entirely — it's ignored anyway).
2. `filtered = candidates.filter(([doc, score]) => score <= threshold
   && matchesFilters(doc.metadata, { extensions, path_glob, tags }))`.
3. `return filtered.slice(0, k)`.

`overfetch` is env-controlled via `RETRIEVE_POST_FILTER_OVERFETCH` (default
4, clamp `[1, 20]`). Today's `k = 10` means 40 FAISS candidates per call —
sub-millisecond even on indexes with tens of thousands of vectors
(empirically verified via RFC 007's `benchmarks/` harness on a synthetic
500-chunk KB). When RFC 006 M3 raises `top_k` to a caller-supplied value
capped at 100, the worst case is 400 FAISS candidates — still
sub-millisecond.

**Under-filled result sets.** When fewer than `k` results pass the filter:

- Log `warn` with `{ kb, filters, requested_k, returned: n, overfetch_used }`.
- Return the under-filled set (never fail the call).

The operator raises `overfetch` or loosens filters. Recursive re-fetching
is a v2.

#### 5.6.4 Dead-code cleanup

M4 **also removes** the `{ score: { $lte: threshold } }` object at
`src/FaissIndexManager.ts:399` because the post-filter now applies the
threshold explicitly. That line is pre-existing dead code; killing it in
M4 is a small CHANGELOG entry ("fix: threshold argument is now honored;
was previously a no-op").

#### 5.6.5 `path_glob` library choice

`minimatch` — well-known (npm, test runners, git), tiny (~40 KB), zero
config. Alternative `picomatch` is faster but has subtle bracket-dialect
differences; for ≤ `k × overfetch` post-filter checks, the feature match
beats speed. Added as a direct dep in M4.

#### 5.6.6 Dead-source filter (moved here from M6 per round-1 scope review)

The dead-source filter — `fsp.stat` each result's `metadata.source` and drop
rows whose file no longer exists on disk — is **a mitigation for
independent drift between the FAISS index and the filesystem**, not
specifically for `delete_document`. A file can disappear via direct shell
`rm`, a misfired `mv`, or a user reorganizing their KB; the stale-row
symptom is identical regardless of whether `delete_document` caused it.
Moving this filter to M4 (alongside the metadata-filter post-processing —
same edit site: the `handleRetrieveKnowledge` body between
`similaritySearch` and response formatting) makes `retrieve_knowledge`
robust to filesystem drift independently of ingest-surface adoption.

Pseudo-sketch (literate, not compilable):

```
resultsPostFilter = [];
for ([doc, score] of candidates) {
  if (score > threshold) continue;
  if (!matchesFilters(doc.metadata, …)) continue;
  // Dead-source filter — stat the on-disk source:
  try { await fsp.stat(doc.metadata.source); }
  catch { deadCount += 1; continue; }
  resultsPostFilter.push([doc, score]);
  if (resultsPostFilter.length >= k) break;
}
if (deadCount > 0) logger.warn(`dropped ${deadCount} dead-source results`);
```

TOCTOU window between `stat` and response delivery is accepted — a caller
whose follow-up `resources/read` 404s sees the drift one call late, not
silently indefinitely.

**Observability, not accounting.** The `deadCount` value is **only**
logged; it does **not** decrement `kb_stats`'s `chunk_count_live`
(§5.7.4). Decrementing a persistent per-KB counter from a query-path
observation would drift under repeated queries against the same dead
file (each query re-observes and re-decrements). The counter stays
ingest-only-accurate; divergence between live counts and the on-disk
global (§5.7.2 `chunk_count_on_disk_global`) is the durable signal for
orphan-vector state.

### 5.7 Issue #54 — `kb_stats` tool

#### 5.7.1 Tool shape

```ts
this.mcp.tool(
  'kb_stats',
  'Introspect knowledge-base index state: per-KB file/chunk counts, embedding provider/model, and index-path info. ' +
    'Accepts an optional knowledge_base_name to narrow to one KB.',
  { knowledge_base_name: z.string().optional() },
  async (args) => this.handleKbStats(args),
);
```

#### 5.7.2 Return shape

```json
{
  "knowledge_bases": {
    "company": {
      "file_count": 42,
      "chunk_count_live": 318,
      "total_bytes_indexed": 485221,
      "last_updated_at": "2026-04-22T14:03:11Z"
    }
  },
  "embedding": {
    "provider": "ollama",
    "model": "dengcao/Qwen3-Embedding-0.6B:Q8_0",
    "dim": 768
  },
  "chunk_count_on_disk_global": 412,
  "index_path": "/home/jean/knowledge_bases/.faiss",
  "server": {
    "version": "0.1.0",
    "uptime_ms": 1823451
  }
}
```

**Field semantics:**

| Field | Format | Notes |
| --- | --- | --- |
| `file_count` | integer | Live file count from `getFilesRecursively(kbPath).length`. |
| `chunk_count_live` | integer \| `null` | Manager's per-KB counter (§5.7.4). `null` before first ingest. Ingest-only-accurate: incremented on ingest, decremented only when `delete_document` removes a previously-ingested file. **Not** touched by the dead-source filter at retrieval time (§5.6.6 — those drops are logged, not counted). |
| `total_bytes_indexed` | integer | Sum of `fs.stat(file).size` for every file under the KB. |
| `last_updated_at` | ISO-8601 UTC with `Z` suffix, or `null` if index file doesn't exist yet | mtime of the FAISS index (today's single-file; RFC 007 stage 4.1+4.2's per-KB `faiss.index` if shipped — in which case the field becomes per-KB). |
| `embedding.provider`, `embedding.model` | strings | From `FaissIndexManager` instance fields. |
| `embedding.dim` | integer | Lazy-computed (§5.7.3). |
| `chunk_count_on_disk_global` | integer \| `null` | Top-level (not per-KB) in v1. Global FAISS vector count from `this.faissIndex.index.ntotal()`. Divergence vs `sum(chunk_count_live)` signals orphan vectors. `null` when no index file exists yet. **Becomes per-KB and moves under each `knowledge_bases.<kb>` entry** once RFC 007 stage 4.1+4.2 lands the per-KB FAISS store split. |
| `index_path` | string | `FAISS_INDEX_PATH` from `src/config.ts:9`. |
| `server.version` | string | `package.json#version`, read once at module init. |
| `server.uptime_ms` | integer | `Date.now() - serverStartMs`. |

Emitted as `TextContent` with `text = JSON.stringify(…, null, 2)`, matching
the pattern used by `handleListKnowledgeBases`
(`src/KnowledgeBaseServer.ts:57-58`).

#### 5.7.3 `dim` discovery

One-time lookup: embed the known string `"."` on first `kb_stats` call and
cache the vector length. Avoids a hard-coded provider→dim map. The
round-trip is typically 30–200 ms depending on provider — outside the S3
budget (§9) on a cold first call, within on warm calls. Implementation note
marked "unverified; confirm at M3 time that the provider round-trip fits
the budget or fall back to cached-on-initialize discovery".

#### 5.7.4 `chunk_count_live` and `chunk_count_on_disk_global` — implementation

**Round-1 correction.** `FaissStore.index.ntotal` is a **method** (not a
property) — it's called as `this.index.ntotal()` with parens in
`@langchain/community/dist/vectorstores/faiss.js:93,116,195,197`. `ntotal()`
returns the **global** total across all KBs in today's single-FAISS-store
layout, so it is NOT a per-KB number on its own.

**Strategy in v1:**

- **`chunk_count_live` per KB** — new in-memory counter
  `Map<kbName, number>` on `FaissIndexManager`, incremented at the three
  `addDocuments` / `fromTexts` call sites (`src/FaissIndexManager.ts:280`,
  `:286`, `:339`). Decremented **only** when `delete_document` removes a
  file that had been ingested (the manager subtracts that file's chunk
  count; the chunk count per file is tracked alongside the hash in the
  sidecar JSON — a two-field record `{ hash, chunks }` that supersedes
  today's plain-string sidecar). The dead-source filter in §5.6.6 does
  **not** decrement this counter — a query-path-dependent counter
  would drift under repeated queries against the same dead file. Those
  drops are observability (a `warn` log with the count) but not
  accounting. Persisted in `$FAISS_INDEX_PATH/stats.json` sidecar; see
  persistence rules below.
- **`chunk_count_on_disk_global` (top-level, not per-KB in v1).**
  `this.faissIndex.index.ntotal()` on the single global store.
  Divergence `sum(chunk_count_live) < chunk_count_on_disk_global`
  signals orphan vectors. When RFC 007 stage 4.1+4.2's per-KB layout
  lands, the top-level `chunk_count_on_disk_global` field is dropped
  and each `knowledge_bases.<kb>.chunk_count_on_disk` is added
  (sourced from that KB's per-KB store's `.ntotal()`). `kb_stats`'s
  return-shape revision is a minor-version bump at that point and is
  noted in `CHANGELOG.md` with a schema-drift warning.
- **`stats.json` persistence rules.**
  - Location: `$FAISS_INDEX_PATH/stats.json`.
  - Schema: `{ "version": 1, "kbs": { "<kbName>": { "chunks": <int> } } }`.
  - Write ordering within `updateIndex`'s post-save hook at
    `src/FaissIndexManager.ts:348-378`: (1) save FAISS index, (2) tmp+rename
    `stats.json` (atomic), (3) tmp+rename per-file hash sidecars. Ordering
    matters: if a crash loses `stats.json` between (1) and (2), next
    startup re-runs `updateIndex` which re-computes counts from the
    per-file sidecars (which now carry `{ hash, chunks }`), so the
    counter is rebuildable without re-embedding.
  - Load on cold start: strict schema validation (see below). Any
    failure → start counters at `null` until first `updateIndex` rebuilds
    them from per-file sidecars.
  - Strict validation: the loaded JSON MUST be an object with integer
    `version === 1`, an object `kbs`, and each `kbs[key]` must be an
    object with a non-negative integer `chunks`. Keys must match
    `KB_NAME_REGEX` (§5.1.2). Any other shape → treat as corrupt, log
    `warn`, reset to `null`. This prevents a corrupt or adversarial
    `stats.json` (e.g. `{"../../etc": 99999}`) from polluting the
    `kb_stats` response.

**Cold-start behaviour without `stats.json`:** return
`chunk_count_live: null` rather than `0`. Distinguishes "unknown, not
yet indexed" from "index is empty". Tested.

#### 5.7.5 `knowledge_base_name` narrowing

When `knowledge_base_name` is passed:

- If the KB directory does not exist: return an MCP error
  (`"knowledge base <name> does not exist"`), not an empty stats object.
  Matches the existing `handleRetrieveKnowledge` error convention.
- Otherwise: return the stats object narrowed to `{ knowledge_bases: { [name]: {…} }, embedding: {…}, index_path: …, server: {…} }`.

#### 5.7.6 Composition with RFC 006 (multi-shard)

If RFC 006 has shipped, the manager has multiple shards. v1 of `kb_stats`
reports **aggregated** `chunk_count_live` across shards — one `embedding`
block showing the first-listed provider, because exposing per-shard counts
confuses the "how big is my KB" question. For v2, `embedding` becomes an
array and each KB entry gets `chunks_per_shard`. Flagged in §7 as an open
question.

#### 5.7.7 Latency budget

Called out in §9 S3: `kb_stats` within **50 ms p95** on a 500-file KB.
Single-KB argument is O(files) walk + one `fs.stat` per file + O(1)
manager lookups. A 500-file walk with `fsp.readdir({ withFileTypes: true })`
+ `fsp.stat` per file is ~5 ms warm, ~30 ms cold. Headroom.

### 5.8 Composition with RFCs 006 / 007 (+ RFC 008 placeholder) — concrete interaction table

| Concern | RFC 006 says | RFC 007 says | This RFC (010) says |
| --- | --- | --- | --- |
| Per-KB index | Out of scope — defers to 007 | §6.4 / stage 4.1+4.2: `$FAISS_INDEX_PATH/<kb>/faiss.index` | Consumes 007's layout. If 007 stage 4.1+4.2 not shipped by (this RFC's) M3, `kb_stats.last_updated_at` falls back to the single-file mtime (as today). |
| Multi-shard | §5.1: `shards/<shard-id>/<kb>/…` | Shard-agnostic | `kb_stats` aggregates across shards in v1 (§5.7.6). Filters are shard-invariant. |
| Chunk metadata | M1.3: adds `chunkIndex`, `knowledgeBase` | §6.4.3: migration by `metadata.source` | (This RFC's) M1 is **authoritative** for the six-field shape (§5.1.3); any overlap with RFC 006 M1.3 is subsumed. |
| `refresh_knowledge_base` tool | — | §6.3 / stage 3.1 | Names match; (this RFC's) M6 consumes 007's tool if shipped, else adds it (§5.4.1 branches A/B/C). |
| Tombstones on delete | — | §6.4.1: tombstone marker | §5.4.4 cross-references; true vector-delete lands post-RFC-007 manifest (NG2). |
| File watcher | — | §6.6 / stage 5.1: on-by-default where supported | §5.3.4 `resources/subscribe` gates on the watcher. |
| Remote transport / auth | — | — | RFC 008 (TBD). New tools inherit future bearer-token auth; v1 operators who want the write surface off use `KB_INGEST_ENABLED=false` (§5.4.6). |

## 6. Alternatives considered

### 6.1 Five separate RFCs, one per issue

**Rejected.** The five issues share three cross-cutting concerns (path
traversal, KB-name validation, chunk metadata). Designing them separately
would produce three slightly-different `resolveKbPath` implementations, two
chunk-metadata shapes, and inconsistent KB-name rules. Most of the unifying
value is concentrated in §5.3 (Resources) and §5.4 (ingest); M2, M3 ride
along as drive-bys. Keeping one RFC preserves design coherence for the
heaviest consumers without forcing the lighter features into one PR — the
feature PRs split naturally into M1–M6.

### 6.2 Build metadata filters (§5.6) into FAISS's `similaritySearchWithScore` instead of post-filter

**Rejected.** `FaissStore.similaritySearchVectorWithScore` in
`@langchain/community` ignores its `filter` argument entirely today — not
even score filtering is honored (see §2.1 and §5.6.3). Pre-filtering via an
ID allow-list requires either rewriting the store or maintaining a parallel
document index; both are storage-layer changes orthogonal to the
user-visible feature. Post-filter with `overfetch = 4` (§5.6.3) solves 99%
of cases in 10 lines, and as a bonus fixes the pre-existing dead-threshold
bug.

### 6.3 Skip Resources (§5.3) in v1; ship only tools

**Rejected.** Resources is the most common client-integration path for MCP —
Claude Desktop's `@`-mention, Cursor's file picker, Continue's context
builder all hit `resources/list` first. Shipping the rest of v1 without it
leaves the "canonical MCP way to browse a KB" missing.

### 6.4 Fold `add_document` into `resources/write` (MCP spec's tentative addition)

**Rejected for v1.** `resources/write` is still a SHOULD in the MCP spec
and not all clients implement it (Claude Desktop at time of writing does
not). A bespoke `add_document` tool is implemented once in the server,
callable by any MCP-compliant client. If `resources/write` stabilises, a v2
can map our tool onto it.

### 6.5 Make `delete_document` purge vectors too, via `FaissStore.delete`

**Partially adopted** (round-1 correction). `FaissStore.delete({ ids })` IS
implemented in `@langchain/community`
(`@langchain/community/dist/vectorstores/faiss.js:150-177`) and
`faiss-node.removeIds()` is exposed. So this is not a library-level block.
It's a **sidecar-format** block: the per-file sidecar stores only a hash
today. Adding `ids: number[]` to the sidecar duplicates work that RFC 007
§6.2.1's manifest design already owns. §5.4.4 documents the one-line v2
upgrade once RFC 007's manifest lands.

### 6.6 Let `kb_stats` compute `chunk_count` by walking `docstore.json` on every call

**Rejected.** `docstore.json` can be hundreds of MB on large KBs. Reading +
parsing per call violates §9 S3. The in-memory counter with
`stats.json` sidecar persistence (§5.7.4) is O(1) at call time and O(K) at
startup where K = number of counters.

### 6.7 Introduce a full per-tool permission model in v1

**Partially adopted.** A complete per-tool auth model belongs with RFC
008's bearer-token / transport story. **But** v1 ships a single kill-switch
(`KB_INGEST_ENABLED=false`, §5.4.6) that hides all three ingest tools —
this covers the most common operational concern (prompt-injected agents
deleting user files) with one env var and zero code complexity.

### 6.8 Ship `extensions`/`path_glob`/`tags` as one combined `filter` JSON object (à la `chroma-mcp`'s `where`)

**Considered and partially adopted.** `chroma-mcp` takes
`where: { $and: [...] }` — flexible but opaque in a Zod schema. Three
explicit fields auto-document in the MCP schema and get rejected by Zod if
misused. AND-semantics across the three covers the common case. If complex
filters become important, v2 adds a generic `filter` alongside.

### 6.9 Ship `update_document` as a peer of add/delete

**Rejected for v1** (NG9). `chroma-mcp` ships `chroma_update_documents`;
we don't. Whole-file replace is covered by `add_document { overwrite: true }`;
true append / edit-in-place is a larger design (content-addressed versioning,
merge semantics). A v2 can add it if the agent UX demands it.

## 7. Risks, unknowns, open questions

### 7.1 Risks

- **R1 — Path-traversal guard misses a case.** §5.1.1 is load-bearing.
  Mitigation: 11 dedicated tests (a–k) including segment-aware `..foo.md`
  acceptance, Windows-separator-on-POSIX, null byte, filesystem-root
  edge case, and symlink-leaf-at-write.
- **R2 — TOCTOU on `add_document` write.** Closed by
  `O_NOFOLLOW | O_EXCL` (or `O_TRUNC` when `overwrite: true`) in §5.4.2.
  Regression-tested.
- **R3 — FAISS orphan vectors after `delete_document`.** Documented in
  §5.4.4; mitigated at retrieval time by the dead-source filter
  (§5.6.6) and at observability time by the
  `sum(chunk_count_live)` vs `chunk_count_on_disk_global` divergence
  in `kb_stats` (§5.7.4). True vector delete is a one-line v2 change
  once the per-file sidecar carries IDs.
- **R4 — YAML billion-laughs DoS via frontmatter.** Closed by FAILSAFE
  schema + 64 KiB frontmatter size cap (§5.1.4).
- **R5 — `resources/list` on a 1M-file KB.** Mitigated by soft
  cap `RESOURCES_LIST_MAX_ENTRIES` (default 10 000, §5.3.1). True
  pagination via MCP `cursor` is v2.
- **R6 — Large-file DoS on `resources/read`.** Closed by
  `RESOURCES_READ_MAX_BYTES` (default 10 MiB, §5.3.2).
- **R7 — Prompt-injected ingest calls.** Mitigated by the
  `KB_INGEST_ENABLED` kill-switch (§5.4.6). Full per-tool auth remains
  RFC 008.

### 7.2 Unknowns

- **U1 — `gray-matter` CRLF support.** Library claims support for
  `\r\n`-terminated frontmatter delimiters; M1 test matrix includes a CRLF
  fixture. If it misbehaves, we strip `\r` before delimiter detection.
- **U2 — `minimatch` leading-slash quirk.** §5.6.2 strips leading slashes
  from `path_glob` before matching. Tested.
- **U3 — `dim` discovery round-trip cost.** §5.7.3 "one-time embed of `.`
  on first `kb_stats` call" is ~30–200 ms first-call. If the operator
  cares, fallback is cached-on-initialize (still one round-trip, but moved
  off the `kb_stats` path).
- **U4 — `kb://` non-ASCII filename encoding.** `decodeURI` vs
  `decodeURIComponent` chosen per §5.3.2 with security rationale. CJK
  filename test in M5 confirms.

### 7.3 Open questions for Jean

- **Q1.** `add_document` size cap: v1 defaults `ADD_DOCUMENT_MAX_BYTES`
  to 10 MiB (§5.4.2) and `RESOURCES_READ_MAX_BYTES` to 10 MiB (§5.3.2).
  Agreed, or raise/lower?
- **Q2.** `resources/list` with PDFs in the KB: the current design hides
  them (§5.3.3). Alternative is emitting as `application/pdf` and refusing
  `resources/read` cleanly. Draft picks hide; confirm.
- **Q3.** `tags` AND semantics (§5.6.2). Matches Chroma's multi-predicate
  default; confirm AND > OR for v1.
- **Q4.** `KB_INGEST_ENABLED=false` (§5.4.6): ship as default `true`
  (write surface enabled, matching local-trust assumption) or default
  `false` (operator opt-in)? Draft picks `true`; confirm.
- **Q5.** RFC 008 assumption in NG1. Once drafted, does the bearer-token
  policy cover the new tools unchanged, or do ingest tools warrant a
  separate scope? Not a v1 concern; asking so RFC 008 knows what to
  expect.

## 8. Rollout plan

### 8.1 Milestones (in order, with per-milestone merge gates)

Each M is a separate PR against `main` referencing this RFC and the
implementation checklist in §10. **M2 has no dependency on M1** and can be
fast-tracked as a 10-line drive-by if convenient; the order below is the
recommended default, not a hard chain.

1. **M1 — Foundations** (no user-visible tool surface change). Ships
   `resolveKbPath`, `isValidKbName`, chunk-metadata enrichment at the four
   splitter call sites, `parseFrontmatter` + `gray-matter` dep, FAILSAFE
   YAML engine, size caps. **Merge gate:** `npm test` green; all 11
   `resolveKbPath` tests (§5.1.1) pass; behaviour observed from the MCP
   surface is unchanged.
2. **M2 — Tool description overrides (#52).** Two env-var lookups in
   `setupTools`. **Merge gate:** `npm test` green; env-var-respected
   regression test passes; documentation updated.
3. **M3 — `kb_stats` tool (#54).** Depends on M1's chunk metadata
   (`knowledgeBase` field) for per-KB counter routing. **Merge gate:**
   S3 (50 ms p95 on 500-file KB) passes in the benchmark scenario;
   `chunk_count_live` persists across restart; `kb_stats` on missing KB
   returns a clean error.
4. **M4 — Metadata filters + dead-source filter + threshold fix (#53).**
   Depends on M1. **Merge gate:** S6 (≤20% latency regression at p95
   with all filter args unset vs filter code present) passes; existing
   `threshold` test continues to pass (behaviour is now *stronger* — the
   cap is enforced); dead-source filter test (delete a file after ingest,
   query, assert row absent).
5. **M5 — Resources surface (#49).** Depends on M1. Adds `setupResources`,
   `resources/list` (with `RESOURCES_LIST_MAX_ENTRIES`) and
   `resources/read` (with `RESOURCES_READ_MAX_BYTES`). **Merge gate:**
   integration test over stdio lists and reads a known URI; symlink-escape
   URI returns a clean MCP error; `resources/subscribe` follow-up issue
   opened.
6. **M6 — Ingest tools (#51).** Last because mutation is the highest-risk
   surface. Depends on M1 and, for `refresh_knowledge_base`, either RFC
   007 stage 3.1 (consume it) or this PR adds it directly (§5.4.1
   branches). **Merge gate:** all ingest tests pass (add/overwrite, delete
   + sidecar cleanup, `KB_INGEST_ENABLED=false` hides the tools,
   symlink-leaf-at-write rejected); M4's dead-source filter verified end
   to end against a real `delete_document`.

### 8.2 Feature flag / back-compat

No runtime feature flag for the whole RFC — every new tool and schema
field is **additive at the protocol level**. The sole defensible opt-out
is `KB_INGEST_ENABLED=false` (§5.4.6) which hides the three ingest tools
from `tools/list` without affecting anything else.

The only potentially-breaking change is the chunk-metadata shape in M1,
which affects *future ingest* but does not rewrite existing sidecars or
indexes. Old chunks have `{ source }` only; new chunks have the full
shape; filters gracefully skip predicates when the metadata field is
missing (e.g. `tags: ["x"]` against an old chunk fails that chunk — AND
semantics, documented). Users who want old chunks filtered too: call
`refresh_knowledge_base` after M6 ships; re-ingest re-enriches.

### 8.3 Deprecation schedule

Nothing is deprecated by this RFC. `threshold` stays on `retrieve_knowledge`
(RFC 006 §8.3 deprecates it in its own milestone). M4 fixes the pre-existing
dead-threshold bug — behaviour becomes **more** correct, not less. The only
lifecycle pressure is on orphan vectors after `delete_document`, tracked
under RFC 007.

### 8.4 Cross-RFC coordination

- **With RFC 006:** M1 adds `tags`/`extension`/`relativePath` at four
  splitter sites (and `chunkIndex`/`knowledgeBase`, previously claimed by
  RFC 006 M1.3). Per §5.1.3, **this RFC's M1 is authoritative**; RFC 006
  M1.3 becomes a no-op for chunk metadata whether it lands before or
  after M1. PR descriptions of both state this explicitly to avoid
  ambiguity.
- **With RFC 007:** M6's `refresh_knowledge_base` consumes (007 stage 3.1
  shipped) or introduces (not shipped) the tool; Branch C (RFC 007
  decision-gate rejects §6.3) still ships it here because ingest needs
  the escape hatch. §5.7.4 `chunk_count_on_disk` per-KB reporting waits
  for RFC 007 stage 4.1+4.2.

## 9. Success metrics

Structural (enforced at CI / PR review):

- **S1.** Every new tool shows up in `tools/list` after server start
  (integration test over stdio, per milestone).
- **S2.** Every new tool accepts its documented Zod schema (schema
  snapshot test, per milestone).
- **S3.** `kb_stats` on a 500-file KB returns within **50 ms p95** —
  measured via a benchmark scenario added to RFC 007's `benchmarks/`
  harness in M3.5.
- **S4.** `resources/list` on a 500-file KB returns within 100 ms p95.
  Non-gating qualitative signal (clients call this ~once per session);
  demoted from hard gate to informational in round-1 review.
- **S5.** Path-traversal guard passes the full 11-case test matrix
  (§5.1.1 tests a–k). Enforced per M1 PR.
- **S6.** Metadata filters in M4 never increase `retrieve_knowledge`
  latency by more than 20% at p95 relative to a filter-code-present-but-
  all-args-unset baseline on the same query set. Baseline is captured
  in the same PR; regression is evaluated on a single commit-over-parent
  comparison, not against historical runs.

Qualitative:

- **S7.** README gains (a) an "MCP surface reference" section enumerating
  every tool + Resource, landed with M6, and (b) a "Describing your KB to
  the agent" section landed with M2 showing the env-var override pattern,
  and (c) a "Security posture" section covering `KB_INGEST_ENABLED`,
  `RESOURCES_READ_MAX_BYTES`, `ADD_DOCUMENT_MAX_BYTES`, and the
  orphan-vector rebuild rule-of-thumb.
- **S8.** CHANGELOG has one `Added` or `Fixed` entry per milestone under
  `[Unreleased]`. M4 in particular is `Fixed` because the threshold bug
  becomes honored.

## 10. Implementation checklist

Each item is one PR unless noted. File anchors resolve against `main` at
this RFC's base commit (`15f3f3b`).

### M1 — Foundations

- [ ] **M1.1** `src/paths.ts` — `resolveKbPath`, `isValidKbName`,
      `KB_NAME_REGEX`. Tests in `src/paths.test.ts` covering the 11 cases
      enumerated in §5.1.1 (a–k) + all KB-name edge cases in §5.1.2.
- [ ] **M1.2** `src/frontmatter.ts` — `parseFrontmatter` with FAILSAFE
      YAML engine and `FRONTMATTER_MAX_BYTES` cap. Add `gray-matter ^4.0.3`
      to `package.json` `dependencies`. Tests per §5.1.4 matrix.
- [ ] **M1.3** Chunk-metadata enrichment at the four splitter call sites:
      `src/FaissIndexManager.ts:267`, `:272`, `:324`, `:329`. All four
      get `{ source, knowledgeBase, relativePath, extension, tags,
      chunkIndex }` per §5.1.3. **PR description states "RFC 010 M1 is
      authoritative for chunk metadata; any prior RFC 006 M1.3 mention is
      subsumed"** per §5.8.
- [ ] **M1.4** Apply `parseFrontmatter` at the two `fsp.readFile` call
      sites (`src/FaissIndexManager.ts:254`, `:312`): use `body` as
      splitter input, attach `tags` to all resulting chunks.
- [ ] **M1.5** CHANGELOG `Added` entry flagging the KB-name validation
      back-compat note (§5.1.2).

### M2 — Tool description overrides (#52)

- [ ] **M2.1** In `src/KnowledgeBaseServer.ts:34-49` `setupTools`, read
      `process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION` and
      `process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION` with fallback to the
      current literal strings.
- [ ] **M2.2** Test in `src/KnowledgeBaseServer.test.ts` (new if absent)
      asserting each env var is respected and fallback works on empty.
- [ ] **M2.3** README "Describing your KB to the agent" section with the
      `qdrant-mcp` reference and one worked example per #52.
- [ ] **M2.4** CHANGELOG `Added` entry.

### M3 — `kb_stats` tool (#54)

- [ ] **M3.1** New public method `FaissIndexManager.stats(kbName?)` per
      §5.7.4 — per-KB in-memory counter `Map<kbName, number>` maintained
      at the three `addDocuments`/`fromTexts` call sites
      (`src/FaissIndexManager.ts:280`, `:286`, `:339`). Counter is
      **ingest-only** in M3 (decrement on `delete_document` lands in M6);
      the dead-source filter in §5.6.6 (M4) does **not** touch it.
- [ ] **M3.2** Extend the per-file sidecar format from plain-string hash
      to a two-field JSON record `{ hash: string, chunks: number }`.
      Back-compat read: if the sidecar is not valid JSON, treat it as the
      legacy hash-only format and rebuild the `chunks` field on next
      re-ingest of that file (counter reports `null` for affected KBs
      until then). M3 ships both the write-the-new-format side and the
      read-back-compat side.
- [ ] **M3.3** Persist counters via `$FAISS_INDEX_PATH/stats.json`
      sidecar per §5.7.4 persistence rules — tmp+rename atomic write
      after FAISS save, before per-file sidecar writes; strict schema
      validation on load; reset to `null` on corrupt. Reuse the
      post-save hook at `src/FaissIndexManager.ts:348-378`. Note:
      §5.7.4 earlier floated priming from `.ntotal()`; this was rejected
      after round 1 (`.ntotal()` is a method and global, not per-KB) —
      the sidecar approach is the v1 default.
- [ ] **M3.4** `kb_stats` tool registered in `setupTools`. Handler
      returns the JSON shape from §5.7.2 with the exact field names,
      top-level `chunk_count_on_disk_global` from
      `this.faissIndex.index.ntotal()`, and `Z`-suffixed ISO-8601 UTC
      `last_updated_at`.
- [ ] **M3.5** `dim` discovery: embed `"."` once, cache (§5.7.3).
- [ ] **M3.6** Benchmark scenario `benchmarks/scenarios/kb-stats.ts`
      added to RFC 007's harness; gate on S3 (50 ms p95 for 500-file KB).
- [ ] **M3.7** `kb_stats` on missing KB returns a clean MCP error (not
      empty object). Tested.
- [ ] **M3.8** Tests for stats.json persistence: (a) happy path — write,
      restart, counters loaded; (b) corrupt JSON → `null` counters;
      (c) schema violation (non-integer `chunks`, non-matching KB-name
      key) → `null` counters; (d) legacy plain-string hash sidecars read
      without error and reported as `null` chunks for the affected KB
      until re-ingest.
- [ ] **M3.9** README "MCP surface reference" stub listing `kb_stats`
      (full section in M6). CHANGELOG entry.

### M4 — Metadata filters + dead-source filter + threshold fix (#53)

- [ ] **M4.1** Add `minimatch` to `package.json` `dependencies`.
- [ ] **M4.2** Extend `retrieve_knowledge` Zod schema at
      `src/KnowledgeBaseServer.ts:43-47` with `extensions`, `path_glob`,
      `tags` per §5.6.1.
- [ ] **M4.3** Post-filter logic in `handleRetrieveKnowledge`
      (`src/KnowledgeBaseServer.ts:74-122`) per §5.6.3: overfetch ×4,
      score cap, extensions/tags/path_glob, and the dead-source filter
      (§5.6.6). Use `RETRIEVE_POST_FILTER_OVERFETCH` env.
- [ ] **M4.4** Remove the dead-code `{ score: { $lte: threshold } }`
      at `src/FaissIndexManager.ts:399` (§5.6.4). CHANGELOG `Fixed`
      entry ("threshold argument now honored; was previously a no-op").
- [ ] **M4.5** Tests: three filters independently, all-three-AND,
      empty-array tags, case-insensitive extension, `path_glob` with
      leading slash (stripped), under-filled result set logs + returns
      what we have, dead-source filter drops rows with missing source
      file, score cap honored.
- [ ] **M4.6** Benchmark: extend RFC 007's `retrieval-quality` scenario
      with a filtered variant; assert S6 (≤20% latency regression at p95).
- [ ] **M4.7** CHANGELOG entry (Added + Fixed) + README update in the
      `retrieve_knowledge` section.

### M5 — Resources surface (#49)

- [ ] **M5.1** New `setupResources()` method on `KnowledgeBaseServer`;
      wire from constructor at `src/KnowledgeBaseServer.ts:24`.
- [ ] **M5.2** `resources/list` handler: walk KBs, apply
      `isValidKbName`, `getFilesRecursively`, mimetype filter (§5.3.3),
      emit `kb://` URIs, enforce `RESOURCES_LIST_MAX_ENTRIES` soft cap
      with diagnostic truncation entry.
- [ ] **M5.3** `resources/read` handler per §5.3.2: protocol check,
      empty-hostname check, **explicit `isValidKbName` call**, `decodeURI`,
      `resolveKbPath`, `stat`-then-size-gate against
      `RESOURCES_READ_MAX_BYTES`, `readFile`, return.
- [ ] **M5.4** Mimetype map + "refused extension" error per §5.3.3.
- [ ] **M5.5** Tests: list returns expected URIs + truncation diagnostic
      over cap; read of a valid URI; read of a traversal URI is refused;
      read of a refused-extension URI returns a clean MCP error; read of
      an oversized file returns a clean error; URL-encoded `%2E%2E`
      traversal is rejected; CJK filename round-trips.
- [ ] **M5.6** CHANGELOG entry + README "MCP surface reference" section
      expanded to include Resources.
- [ ] **M5.7** Follow-up tracking issue opened for `resources/subscribe`
      gated on RFC 007 stage 5.1.

### M6 — Ingest tools (#51)

- [ ] **M6.1** `add_document` tool registered in `setupTools`, handler
      per §5.4.2: `resolveKbPath` → byte-length cap →
      `mkdir` → **intermediate-directory realpath re-check** (re-resolve
      `dirname(abs)` after `mkdir` and verify it's still under
      `realpath(kbRoot)`; defends against intermediate-symlink races
      that `O_NOFOLLOW` doesn't cover) →
      `fsp.open(abs, O_WRONLY|O_CREAT|O_NOFOLLOW|(EXCL|TRUNC))`
      → `writeFile` on the handle → close → `updateIndex`.
- [ ] **M6.2** `delete_document` tool registered per §5.4.3:
      `resolveKbPath` → read sidecar's `chunks` field →
      `faissManager.decrementChunkCount(kbName, chunks)` (new
      in-memory-counter method; persisted in stats.json on next save) →
      `rm` → best-effort sidecar rm using `basename(relative)` +
      `dirname(relative)` (NOT `basename(abs)`). Counter-decrement must
      be ordered before file removal so a crash between the two leaves
      the counter in a rebuildable state.
- [ ] **M6.3** `refresh_knowledge_base`: adopt RFC 007 stage 3.1 if
      shipped; add identical-semantics tool here if not. PR description
      states which of §5.4.1 branches A/B/C applies and cross-posts to
      both RFC PRs if relevant.
- [ ] **M6.4** `KB_INGEST_ENABLED` env gate per §5.4.6: when `false`,
      `setupTools` skips registering the three ingest tools — they do
      not appear in `tools/list`. Tested via integration.
- [ ] **M6.5** Tests: `add_document` happy path; overwrite refused
      without flag; overwrite allowed with flag but symlink-leaf still
      rejected; **intermediate-dir symlink race** — plant a symlink at
      an intermediate directory after `resolveKbPath` but before
      `mkdir`; verify the post-`mkdir` realpath re-check rejects it;
      traversal refused; null-byte refused;
      `add_document` over byte cap refused; `delete_document` happy
      path decrements the counter by the sidecar's `chunks` value;
      sidecar cleanup (with `basename(relative)`);
      `delete_document` of non-existent file errors; end-to-end
      `add_document` → `retrieve_knowledge` returns the new content;
      end-to-end `delete_document` → `retrieve_knowledge` no longer
      returns the deleted file (via M4's dead-source filter); after
      `delete_document`, `kb_stats` reports `chunk_count_live` dropped
      by the file's chunk count while `chunk_count_on_disk_global`
      stays the same (v1 orphan-vectors invariant).
- [ ] **M6.6** CHANGELOG entry + README "MCP surface reference" section
      completed (ingest tools + `KB_INGEST_ENABLED` + orphan-vectors
      rebuild note) + "Security posture" section covering the three
      byte caps.

---

*End of RFC 010.*
