# RFC 012 — `kb` CLI alongside the MCP server: restart-free upgrades for the dogfood loop

- **Status:** Draft (v4 — post-round-3 revision; all round-1, round-2, and critical round-3 safety findings triaged)
- **Author:** Jean Ibarz (drafted by automation)
- **Target:** `jeanibarz/knowledge-base-mcp-server` `main`
- **Related:** RFC 008 (remote transport — adds SSE/HTTP transports), RFC 010 (MCP surface v2 — adds tools), RFC 011 (arxiv backend / ingest filters)
- **References (GitHub issues):** to be opened after RFC approval — one per milestone (M0 EISDIR fix, M1 read-only seam + CLI + split-lock, M2 docs/clients).

## 1. Summary

Today the only entrypoint to this project's retrieval engine is `bin/knowledge-base-mcp-server` → `build/index.js`, a long-lived MCP server child process. Updates require restarting every AI client (Claude Code, Codex CLI, Cursor, Continue, Cline) that has the server loaded — verified empirically: Claude Code 2.1.119 has no in-session MCP reload.

A second bin invoked from PATH solves it. Each CLI call is a fresh Node process; the OS resolves the binary on every `execve(2)`; `npm i -g` updates the global symlink atomically; the next call uses the new code.

This RFC proposes:

1. **Add a `kb` bin** in the same npm package. Two subcommands: `kb list`, `kb search <query>`. **No `kb mcp-serve`** — the existing `knowledge-base-mcp-server` bin keeps pointing at the existing `build/index.js`, unchanged.
2. **Default `kb search` to read-only** — skip `FaissIndexManager.updateIndex()` and the `model_name.txt` write. Provide `--refresh` for explicit write-path semantics.
3. **Add `initialize({ readOnly?: boolean })`** — call-site flag, not a constructor option (round-2 boundary fix). One conditional guards the `model_name.txt` write.
4. **Split the index coordination into two mechanisms** (round-2 critical fix):
   - **Single-instance advisory PID file** — `${FAISS_INDEX_PATH}/.kb-mcp.pid`. Written by `KnowledgeBaseServer.run()` at startup; removed on shutdown. Held for the MCP server's lifetime.
   - **Short-lived write lock** — `proper-lockfile` at `${FAISS_INDEX_PATH}/.kb-write.lock`. Acquired only **around** each `updateIndex()` call inside `KnowledgeBaseServer` and inside `kb search --refresh`. Released after the write completes. Default `kb search` doesn't acquire either.
   The split is the round-2 fix: v2 conflated lifetime advisory with write coordination, breaking `--refresh` in the operator's actual workflow.
5. **CLI checks `model_name.txt` against the configured embedding model on every invocation** (round-2 N5 fix) — exits non-zero with a clear error when the CLI's env points at a different model than the index was built with. Closes the silent vector-space-mismatch failure mode.
6. **Extract three small helpers from `KnowledgeBaseServer.ts`** (round-2 boundary fixes):
   - `src/formatter.ts` — `sanitizeMetadataForWire` + the markdown result formatter, used by both surfaces.
   - `src/kb-fs.ts` — `listKnowledgeBases(rootDir)`, called by the MCP handler and the CLI.
   - `src/lock.ts` — single owner of `proper-lockfile` config (path, stale window, heartbeat).
7. **Fix two/three pre-existing P0 bugs as M0** — model-switch recovery (line 317), corrupt-index recovery (line 339), and the wrong-path docstore unlink (line 346) all break under modern FAISS-store layouts where `indexFilePath` is a directory.
8. **Defer** any "kb daemon", any pure-CLI replacement of MCP, and any MCP-server self-restart-on-binary-change mechanism. Reasons in §8.

The deliverable is one RFC and (after approval) three additive PRs.

- **M0 (1 PR, blocking).** EISDIR / wrong-path bug fixes in `FaissIndexManager.initialize()`.
- **M1 (1 PR).** Add `bin/kb`, `readOnly` flag on `initialize()`, three extracted helpers, split-lock design, CLI model-mismatch check. Bump minor: 0.2.0.
- **M2 (1 PR).** Docs — README CLI quickstart, `docs/clients.md` `@latest` correction (§2.4), `~/.claude/skills/knowledge-base/SKILL.md` (separate PR in user's `.claude` config repo).

## 2. Motivation

### 2.1 Evidence from code — the only entrypoint is the long-lived MCP server

`package.json` lines 7–9 expose exactly one bin (`"knowledge-base-mcp-server": "build/index.js"`). `src/index.ts` is 11 lines that construct `KnowledgeBaseServer` and call `server.run()`. There is no path that exits after a single `tools/call`.

### 2.2 Evidence from operator pain — the dogfood loop

The user's own report:

> "When the MCP tool is upgraded (a fix is done for example), I need to restart claude processes to retrieve the newest MCP process. If we are using a cli tool instead as soon as the new process is installed claude code would be using the newest, no need for restart."

Verified: `claude mcp --help` (Claude Code 2.1.119) has no `reload`, `restart`, or `refresh` subcommand. The only path to a new MCP server version inside a running Claude session is to kill and restart the session.

### 2.3 Why a CLI dodges the restart problem

`execve(2)` on every invocation; `npm install -g` updates the bin symlink atomically; the next CLI call uses the new target. The OS, not the AI client, is the process supervisor. Same upgrade semantics as `git`, `jq`, or `rg`.

### 2.4 What MCP-side upgrades still require — and a separate `npx` correction

This RFC does not make the MCP server upgrade-on-spawn. Two reasons:

- **In-session reload is impossible without client cooperation.** Verified above. `fs.watch(process.execPath)` would be the natural detection mechanism, but it doesn't fire on `npm install -g`'s atomic relink (verified empirically: `unlink()` + `symlink()` produces zero events on a `fs.watch` of the symlink path; only in-place file modification fires events, which is not how npm installs).
- **Even on next session start, `npx -y` doesn't pick up the new version unless the spec includes `@latest`.** Verified by inspecting `~/.npm/_npx/`: the spec `npx -y @jeanibarz/knowledge-base-mcp-server` (no version) hashes to a cache directory and pins the version in a `package-lock.json` there. Subsequent spawns reuse the cached version without contacting the registry. The spec `@jeanibarz/knowledge-base-mcp-server@latest` hashes to a different cache key and re-resolves on each spawn.

This means **`docs/clients.md` snippets need an `@latest` correction independent of the CLI work** — `npx -y @jeanibarz/knowledge-base-mcp-server` should become `npx -y @jeanibarz/knowledge-base-mcp-server@latest` for any user who wants new fixes to actually arrive on next client launch. M2 includes this docs change.

### 2.5 Evidence from the wider ecosystem

RFC 008 §2.2 cites `qdrant-mcp` (stdio + SSE + streamable-http from one binary). Many embedding/RAG tools ship CLI **and** server (`chroma`, `lancedb`, `marqo`). This project being MCP-only is the outlier.

## 3. Goals / Non-goals

### 3.1 Goals

- **G1.** A working `kb` CLI on PATH that answers `list` and `search` against the same KB and FAISS index the MCP server uses.
- **G2.** Restart-free upgrades for CLI users.
- **G3.** No regression for existing MCP clients. The `knowledge-base-mcp-server` bin keeps working unchanged.
- **G4.** `kb search` (default) is safe to run while an MCP server is also running against the same `FAISS_INDEX_PATH`. Read-only contract documented.
- **G5.** `kb search --refresh` works while an MCP server is running. Both contend on a short-lived write lock; neither blocks the other for long.
- **G6.** Output formats suitable for AI-agent and shell consumption. The CLI's `--format=md` body is byte-equal to MCP `retrieve_knowledge`'s wire output, with one **explicitly documented divergence**: a single-line freshness footer (§4.10) appended after the body. Workflows that pipe CLI output into a downstream LLM must either accept the footer or strip it (one regex, one line). `--format=json` for scripts. (Round-3 boundary-critic flagged that v3 silently violated the original "byte-equal" goal; v4 makes the divergence explicit and acknowledges it as a deliberate design choice — the staleness signal is more valuable than wire-format identity.)
- **G7.** CLI fails fast and loud when its env points at a different embedding model than the on-disk index was built with.

### 3.2 Non-goals

- **N1.** Long-lived `kb daemon` / HTTP listener. Cold-call cost (§4.6) is well inside budget.
- **N2.** Cross-host distribution (Windows, ARM-Linux, alpine). Same portability as the server.
- **N3.** Authn/authz for the CLI.
- **N4.** Replacing MCP. Cursor / Continue / Claude Desktop users keep their integration.
- **N5.** A new repository.
- **N6.** MCP server self-restart on binary change. Verified infeasible (§2.4).
- **N7.** Atomic `FaissStore.save()`. The langchain-community `FaissStore.save` is non-atomic (`mkdir -p` then parallel writes of `faiss.index` + `docstore.json` with no rename). The narrow concurrent-read race window is documented in §7; a fix would require a wrapper around `FaissStore` that's out of scope here. Tracked as a follow-up issue.

## 4. Design

### 4.1 Surface decision matrix

| Option | Restart-free? | Reuses MCP ecosystem? | Per-call cost | Verdict |
|--------|---------------|------------------------|---------------|---------|
| **A. Status quo (MCP only)** | No | Yes | ~0 (warm) | Rejected. |
| **B. CLI-only (deprecate MCP)** | Yes | No | Cold (§4.6) | Rejected (N4). |
| **C. MCP + CLI in same repo, default-read-only CLI, split-lock coordination** *(recommended)* | Yes for CLI; No for MCP sessions | Yes | Cold for CLI; warm for MCP | Adopted. |
| **D. MCP + CLI in separate repos** | Same as C | Yes | Same as C | Rejected (N5). |
| **E. Local HTTP daemon + thin CLI clients** | No (daemon must restart) | Yes | ~0 (warm) | Rejected — reintroduces the original problem. |
| **F. Docker container** | No | Yes | ~0 (warm) | Rejected. |

### 4.2 Recommended design (Option C)

```
┌──────────────────────────────────────────────────────────────────┐
│  bin/kb (NEW — M1)                                               │
│   kb list    → src/kb-fs.ts:listKnowledgeBases                   │
│   kb search  → FaissIndexManager.initialize({ readOnly: true })  │
│                + similaritySearch                                │
│                + src/formatter.ts (md/json)                      │
│   kb search --refresh                                            │
│                → src/lock.ts:withWriteLock(updateIndex + search) │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  src/lock.ts  (NEW — M1)                                         │
│   - withWriteLock(fn): acquires .kb-write.lock, runs fn,         │
│     releases. Heartbeat enabled. 10s stale window.               │
│   - acquireInstanceAdvisory(): writes .kb-mcp.pid                │
│   - releaseInstanceAdvisory(): removes it                        │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌──────────────────────────────────────────────────────────────────┐
│  src/formatter.ts  (NEW — M1)                                    │
│   - sanitizeMetadataForWire (moved from KnowledgeBaseServer)     │
│   - formatRetrievalAsMarkdown                                    │
│   - formatRetrievalAsJson                                        │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌──────────────────────────────────────────────────────────────────┐
│  src/kb-fs.ts  (NEW — M1)                                        │
│   - listKnowledgeBases(rootDir): Promise<string[]>               │
│     (pure fs op; no MCP envelope)                                │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌──────────────────────────────────────────────────────────────────┐
│  FaissIndexManager  (existing — M1 extends initialize signature) │
│   - initialize(opts?: { readOnly?: boolean })                    │
│     • readOnly: skip MODEL_NAME_FILE write                       │
│   - updateIndex() — unchanged; MCP and --refresh wrap it in lock │
│   - similaritySearch() — unchanged                               │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌──────────────────────────────────────────────────────────────────┐
│  bin/knowledge-base-mcp-server (UNCHANGED bin → build/index.js)  │
│   KnowledgeBaseServer.run():                                     │
│     1. acquireInstanceAdvisory()  (PID file; long-lived)         │
│     2. start McpServer + ReindexTriggerWatcher                   │
│   Each updateIndex() call → withWriteLock(updateIndex)           │
│   On graceful shutdown: releaseInstanceAdvisory()                │
└──────────────────────────────────────────────────────────────────┘
```

There is no `KnowledgeBaseService` extraction; the CLI imports `FaissIndexManager` directly. Three small helpers (`formatter.ts`, `kb-fs.ts`, `lock.ts`) are extracted because both surfaces need them and the alternative (CLI imports from `KnowledgeBaseServer.ts`) drags MCP-SDK transitive imports into the CLI.

### 4.3 CLI surface

```
kb list                                  # one KB name per line on stdout
kb search <query>
   [--kb=<name>]                         # scopes to one KB
   [--threshold=<float>]                 # default 2 (matches MCP)
   [--k=<int>]                           # default 10
   [--format=md|json]                    # default md (matches MCP wire)
   [--refresh]                           # opt-in: also runs updateIndex
kb search --stdin                        # query read from stdin if no positional
kb --version
kb --help
```

Conventions:

- All flags map 1:1 to MCP `retrieve_knowledge` arguments.
- Default `--format=md` is byte-for-byte equal to `retrieve_knowledge`'s wire output **plus** a single-line "freshness footer" (§4.10) so callers can see staleness.
- Stdin support is in v1. Agent-generated queries with newlines/quotes are reliably passed via stdin.
- Exit codes: `0` on success (results found or empty); `2` for argv/env config errors and for **model-mismatch errors** (§4.7); `1` for runtime/index errors.
- Logger output goes to stderr only.
- `kb list` output: newline-separated KB names on stdout. (No `--format=text|json` flag — round-1 design-minimalist correctly flagged the second format as YAGNI.)

### 4.4 Bin entries (`package.json`)

```json
"bin": {
  "kb": "build/cli.js",
  "knowledge-base-mcp-server": "build/index.js"
}
```

The MCP bin still points at `build/index.js` unchanged. No alias file. No re-exec.

The build script is updated to chmod both: `tsc -p tsconfig.json && chmod +x build/index.js build/cli.js`.

### 4.5 The read-only default

`KnowledgeBaseServer.handleRetrieveKnowledge` (`src/KnowledgeBaseServer.ts:132`) calls `this.faissManager.updateIndex(knowledgeBaseName)` on every retrieval — the freshness guarantee MCP gives.

`kb search` defaults to **skipping** this. It calls `FaissIndexManager.initialize({ readOnly: true })` — which loads the FAISS index but skips the unconditional `model_name.txt` write at line 356. It then calls `similaritySearch(...)` directly. No `updateIndex`, no write lock.

Implementation: one conditional in `FaissIndexManager.ts`:

```ts
async initialize(opts: { readOnly?: boolean } = {}): Promise<void> {
  // ... existing logic that loads index ...
  if (!opts.readOnly) {
    await fsp.writeFile(MODEL_NAME_FILE, this.modelName, 'utf-8');
  }
}
```

The `readOnly` flag is on the **method**, not the constructor. (Round-2 boundary-critic: a constructor flag conflates "this instance never writes" with "skip writes on this call." The method-level flag puts the guard at the call site.)

`FaissStore.load(...)` is itself read-only (verified by reading `node_modules/@langchain/community/dist/vectorstores/faiss.js:219-230` — `readFile + InMemoryDocstore`, no writes). The single `model_name.txt` write at line 356 is the only blocker today.

The staleness contract for `kb search` (default): "Returns results from the index as it existed at the last MCP retrieval (or last `kb search --refresh`). KB file edits since then are invisible until the next `--refresh` or MCP call." A footer in the output (§4.10) makes this explicit per-call.

### 4.6 Cold-start cost (empirically measured)

Measured against the user's actual `~/knowledge_bases/` (10 sub-KBs, 743 MB raw source, 249 ingestable files / ~1.05 MB after the ingest filter, FAISS index 4.1 MB):

| Pipeline | p50 | p95 |
|----------|-----|-----|
| **`kb search` default (read-only)** — fresh process, FaissStore.load + similaritySearch + staleness mtime walk | ~0.6 s | ~0.65 s |
| **`kb search --refresh`** — fresh process, full init + updateIndex (no KB changes) | ~0.79 s | ~0.87 s |
| Cold filesystem cache (pages evicted via `posix_fadvise`) | ~0.79 s | ~0.84 s |

Breakdown of warm `--refresh`:

- Node ESM module resolution + `import FaissIndexManager`: ~390 ms
- `new FaissIndexManager()` + `initialize()`: ~90 ms
- `updateIndex()` directory scan + sidecar reads (no embedding when nothing changed): ~280 ms

Bottleneck is ESM resolution + directory I/O, not FAISS load. Cold filesystem cache barely matters.

Default `kb search` drops `updateIndex()` (~280 ms) and the `model_name.txt` write (small), but adds the staleness pre-check (~50–100 ms mtime walk; no SHA256), arriving at ~0.6 s. Plus embedding HTTP (~50–500 ms depending on provider).

### 4.7 CLI model-mismatch check (round-2 N5 fix + round-3 atomicity fix)

Before any retrieval, `kb search` reads `MODEL_NAME_FILE` (the on-disk record of which model built the index) and compares to the configured model (from the same env-var resolution chain `FaissIndexManager` uses). If they differ:

- Default mode: exit 2 with stderr message:
  ```
  Error: Embedding model mismatch.
    Index built with: text-embedding-3-small
    Current config:   BAAI/bge-small-en-v1.5
  These produce different vector spaces; query results would be meaningless.
  Options:
    1. Set EMBEDDING_PROVIDER / model env vars to match the index, or
    2. Run `kb search --refresh` to rebuild the index with the current model
       (multi-minute on first call).
  ```
- `--refresh` mode: emit a stderr warning, continue (the existing model-switch path triggers a full re-embed under the write lock).

Why this is necessary: `KNOWLEDGE_BASES_ROOT_DIR`, `FAISS_INDEX_PATH`, `EMBEDDING_PROVIDER`, and the model env vars are read from `process.env` at module load. Claude Code's MCP child process inherits env from `mcp.json`. The user's shell inherits env from `~/.bashrc`. These can diverge silently — and without this check, the CLI's read-only path would load a FAISS index built with one model and embed queries with another, returning silently-wrong nearest neighbors. (Round-2 failure-mode-analyst N5.)

**Round-3 fix — atomic write of `MODEL_NAME_FILE`.** Today, `FaissIndexManager.initialize():356` calls `fsp.writeFile(MODEL_NAME_FILE, this.modelName, 'utf-8')` — non-atomic (file truncated to 0 bytes, then written). A CLI invocation that lands in the truncate window reads an empty string and produces a **false-positive mismatch error** (round-3 failure-mode-analyst). M1 changes this to a tmp-file + atomic rename:

```ts
async function writeModelNameAtomic(modelName: string): Promise<void> {
  const tmp = `${MODEL_NAME_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, modelName, 'utf-8');
  await fsp.rename(tmp, MODEL_NAME_FILE);  // atomic on POSIX
}
```

CLI's read of `MODEL_NAME_FILE` either sees the old contents or the new contents — never an empty string. This pattern is also applied to any other state-file writes we add later (e.g., per-KB schema-version files).

### 4.8 Lock design (round-2 N1 fix — the most important change)

V2 had a single `proper-lockfile` lock acquired by `KnowledgeBaseServer.run()` at startup and held for the server's lifetime. Round-2 failure-mode-analyst correctly identified this as breaking `--refresh`: every `--refresh` call while a Claude session was open would block on a lock the MCP server never releases. The dogfood workflow the RFC exists to enable would not actually work.

V3 splits coordination into two distinct mechanisms:

#### 4.8.1 Single-instance advisory: `${FAISS_INDEX_PATH}/.kb-mcp.pid`

- **Purpose.** Enforce the documented "one MCP server per `FAISS_INDEX_PATH`" constraint.
- **Acquired by.** `KnowledgeBaseServer.run()` via `acquireInstanceAdvisory()` at startup.
- **Atomic acquire (round-3 fix).** `open(path, O_CREAT | O_EXCL | O_WRONLY, 0o600)` then `write(pid)` + `fsync` + `close`. `O_EXCL` makes the create atomic — two concurrent MCP starts cannot both pass the check. On `EEXIST`: read the recorded PID, `kill(pid, 0)` for liveness, fail-fast if alive, otherwise unlink + retry once. Mode `0o600` so the PID isn't world-readable on shared filesystems (round-3 boundary-critic Q8a).
- **Released by.** Graceful shutdown handler (delete on SIGINT/SIGTERM).
- **Held for.** The MCP server's lifetime.
- **Not consulted by CLI.** The CLI does NOT block on this file. Purely MCP-vs-MCP advisory.
- **`pnpm prod:update`-style overlap.** Old MCP exits (SIGTERM → unlinks PID), new MCP starts. If they overlap (old still draining), the new one's `O_EXCL` fails with `EEXIST`, then sees the old PID is still alive, then fails fast with "another instance running — wait for shutdown to complete and retry." Documented operator guidance: `pnpm prod:update` should `kill` and `wait` for the old PID before starting the new server.

#### 4.8.2 Short-lived write lock: `${FAISS_INDEX_PATH}/.kb-write.lock`

- **Purpose.** Serialize concurrent writers (MCP `updateIndex` calls + CLI `--refresh`).
- **Implementation.** `proper-lockfile` (npm package, mkdir-based, cross-platform). Heartbeat enabled (`update: 5000`) so long-running `updateIndex` calls don't false-positive as stale.
- **Acquired by.**
  - `KnowledgeBaseServer.handleRetrieveKnowledge` — wraps the `updateIndex` call in `withWriteLock(...)`, releases immediately after.
  - `ReindexTriggerWatcher` — wraps its `updateIndex(undefined)` call the same way.
  - `kb search --refresh` — wraps its `updateIndex` + `similaritySearch` block.
- **Held for.** Just the duration of one `updateIndex` (~280 ms typical, multi-minute on full re-embed).
- **Stale window.** `proper-lockfile` default 10 s after last heartbeat. Documented as a known limit in §7 (laptop sleep, SIGSTOP).
- **Default `kb search` (no `--refresh`) does NOT acquire this lock.** It reads `FaissStore.load(...)` directly. The N4 race window (concurrent read vs. mid-write `FaissStore.save`) is documented in §7 with mitigation.

#### 4.8.3 Why this works — and where it doesn't

**The fast-path case (operator's daily workflow):**

1. Operator starts Claude. MCP server starts, writes PID to `.kb-mcp.pid`.
2. Operator runs `kb search "X"` (default). CLI doesn't touch the lock or the PID file. MCP isn't holding the write lock most of the time anyway. Both proceed.
3. Operator edits a KB file, runs `kb search --refresh "X"`. CLI tries to acquire the write lock. If MCP happens to be mid-`updateIndex` (~280 ms windows), CLI waits ~280 ms. Otherwise CLI acquires immediately, runs its `updateIndex`, releases.
4. `ReindexTriggerWatcher`'s 5-second poll triggers `updateIndex` → contends only with concurrent `--refresh` calls, briefly.

**The slow-path case (round-3 finding — `--refresh` triggers full re-embed):**

If the operator switched embedding models (or this is the first index build), `--refresh` calls `updateIndex` which triggers a full re-embed of every KB file. This holds the write lock for **minutes** (depending on KB size and embedding-provider latency). During that window:

- MCP `handleRetrieveKnowledge` calls (every Claude retrieval) call `updateIndex` first → block on the write lock → **all Claude retrievals stall for the full re-embed duration**.
- `ReindexTriggerWatcher`'s 5-second poll fires `updateIndex` → blocks behind the CLI.

This is real and unavoidable with the split-lock-only design. Mitigations:

- **Operator guidance (M2 docs):** "Run `kb search --refresh` during a Claude restart window, not during an active session. If you must run it during a session, expect Claude retrievals to stall for the duration of the re-embed." Acceptable for the dogfood operator (the user) because model switches are rare.
- **CLI estimates duration up front.** Before acquiring the lock, CLI scans for files needing re-embed (using the same hash check `updateIndex` does); if the count is >10, CLI prints a warning to stderr: "Re-embedding N files; expected duration ~M seconds; MCP retrievals will stall." Operator can Ctrl-C if surprised.
- **Future RFC:** stream-based `updateIndex` that releases the lock between batches (10 files at a time) so MCP retrievals can interleave. Tracked separately. Not in this RFC.

The slow-path stall is documented honestly in CHANGELOG and `docs/clients.md` (M2). It is the cost of using `proper-lockfile` for serialization; alternatives (e.g., separate read/write locks via SQLite WAL) are larger refactors.

Concurrent-MCP-instance is still prevented (PID advisory). `--refresh` is usable while MCP is running for the fast path; the slow path requires operator awareness.

#### 4.8.4 What this is NOT

This RFC does **not** propose making `FaissStore.save()` atomic. The langchain-community `save()` is `mkdir -p + Promise.all([index.write, writeFile(docstore.json)])` with no rename. A read concurrent with a save can see partial `docstore.json`. The window is small and the impact is bounded (CLI exits with a clear JSON-parse error + "retry recommended"). Documented in §7. Tracked as a follow-up issue (N7 in §3.2).

### 4.9 Boundary extractions in M1

Three small helpers move out of `KnowledgeBaseServer.ts`:

- **`src/formatter.ts`.** `sanitizeMetadataForWire` (currently `KnowledgeBaseServer.ts:35-50`) and the markdown formatter (currently inline in `handleRetrieveKnowledge:140-159`) move here. Both surfaces import. `KnowledgeBaseServer` becomes lighter; the CLI doesn't pull in `McpServer`/`StdioServerTransport`/`SseHost`/`ReindexTriggerWatcher` imports just to format results.

- **`src/kb-fs.ts`.** Exports `listKnowledgeBases(rootDir: string): Promise<string[]>` — a pure fs op (`readdir + filter dot-prefixed`). `KnowledgeBaseServer.handleListKnowledgeBases` becomes 5 lines: call `listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR)`, wrap in `CallToolResult`. The CLI calls the same function directly, no envelope.

- **`src/lock.ts`.** Single owner of `proper-lockfile` config. Exports `withWriteLock(fn): Promise<T>`, `acquireInstanceAdvisory()`, `releaseInstanceAdvisory()`. Avoids duplicated lock parameters (path, stale window, retries) at multiple call sites.

### 4.10 Freshness footer in default `kb search` output (round-2 N7 fix + round-3 mtime correction + round-4 actual staleness check)

Default `kb search --format=md` output appends one of two footers depending on detected freshness:

```
> _Index up-to-date as of 2026-04-25T14:30:00Z._
```

or

```
> _Index may be stale: 3 modified, 2 new file(s) since 2026-04-25T14:30:00Z. Run `kb search --refresh` to update._
```

**Staleness detection** (without doing the re-ingestion). The CLI runs a cheap pre-check after `FaissStore.load` and before formatting output:

1. **Index mtime.** Read `mtime` of `${FAISS_INDEX_PATH}/faiss.index/faiss.index` (the inner binary file inside the FAISS-store directory). Round-3 failure-mode-analyst correctly observed that on Linux ext4/btrfs the directory mtime is NOT updated when `FaissStore.save` overwrites files inside it (only when entries are added/removed/renamed). Using the inner file's mtime gives the actual "last save" timestamp.
2. **Modified-file count.** For each KB under `KNOWLEDGE_BASES_ROOT_DIR`, walk via the existing `getFilesRecursively + filterIngestablePaths` from `src/utils.ts` (the same walk `updateIndex` uses). For each file, `stat()` it; if `file.mtime > index.mtime`, count it as modified. **Skip SHA256 hashing** — that's the expensive step (~280 ms per round-1 measurements) that `updateIndex` does. mtime comparison is cheap (`~50–100 ms` total for the user's 249 files).
3. **New-file count.** For each KB, count files on disk vs. count of hash sidecars in `<kb>/.index/`. Difference = new files added since last index. Catches deletes too (negative difference; report as "modified").

Footer logic:

- If both counts are zero: "up-to-date" footer.
- Else: "may be stale" footer with the counts and the index mtime.

False-positive case: `touch` on a KB file without editing content → mtime advances → counted as modified, but `--refresh` would find the SHA256 unchanged and do no work. Cost: operator runs `--refresh` once, sees "0 files re-embedded", continues. Acceptable.

False-negative case: none for the current `updateIndex` semantics. Anything `updateIndex` would re-embed has either an mtime advance or a count change.

Cost added to default `kb search`: ~50–100 ms for the mtime walk. Total cold-call goes from ~0.5 s to ~0.6 s — still well under the ~2 s budget (§4.6).

`--format=json` includes:

```json
{
  "results": [...],
  "index_mtime": "2026-04-25T14:30:00Z",
  "stale": false,
  "modified_files": 0,
  "new_files": 0
}
```

`--refresh` mode replaces the footer with "Index refreshed at <timestamp>" and `"stale": false`.

**Format ownership (round-3 boundary-critic):** the body of the markdown output is produced by `formatter.ts:formatRetrievalAsMarkdown(results)`. The freshness check (mtime walk + sidecar count) and footer assembly live in `cli.ts` — they're CLI-specific. `formatter.ts` is the single source of truth for body format; `cli.ts` owns staleness detection and footer assembly. If MCP ever wants the same footer, the staleness-check function moves to a shared module (`src/staleness.ts`) at that time.

This converts the read-only staleness contract from a docs claim into a per-call signal the agent or operator can act on, with concrete counts not just timestamps. (Per the G6 update in §3.1, the footer is the deliberate, documented divergence from MCP's wire output.)

### 4.11 Why fresh-process per CLI call is fine

Measured ~0.5–0.8 s cold-call total (§4.6). Well below interactivity thresholds. A daemon would amortize further but bring the restart problem back.

### 4.12 Why MCP stays warm-process

20 retrievals × cold-call cost would add ~10 s of latency to a Claude session vs. ~0.5 s for the warm-process model.

## 5. Cost & risk analysis

### 5.1 M0 — pre-existing P0 bug fixes

Three broken sites in `FaissIndexManager.initialize()` that all fail under the modern FAISS-store directory layout (`~/knowledge_bases/.faiss/faiss.index/` is a directory containing `faiss.index` + `docstore.json`). All confirmed by reading the source:

- **Line 317** (model-switch recovery): `fsp.unlink(indexFilePath)` → throws `EISDIR`. Fix: `fsp.rm(indexFilePath, { recursive: true, force: true })`.
- **Line 339** (corrupt-index recovery): same `fsp.unlink(indexFilePath)` call, same EISDIR. Same fix.
- **Line 346** (corrupt-index sibling cleanup): `fsp.unlink(\`${indexFilePath}.json\`)` targets a path that does not exist (the docstore lives at `${indexFilePath}/docstore.json`, inside the directory). Currently silently no-ops via `.catch(() => {})`. The `fsp.rm(indexFilePath, { recursive: true })` from the line 339 fix already removes the docstore as a side effect, so line 346 should be deleted entirely.

All three lines are fixed in M0 with a regression test that exercises both the model-switch path and the corrupt-index path against a temp directory-layout index. Ship as 0.1.2 patch before M1's 0.2.0.

### 5.2 M1 PR scope

Single PR, files added or changed:

1. `src/cli.ts` (new) — argv parser, two subcommands, format adapters, stdin handler, model-mismatch check, **staleness pre-check (mtime walk + sidecar count, per §4.10)**, freshness footer assembly (line append after formatter body), JSON-parse retry handler for the FaissStore.load race window described in §7 (catch `SyntaxError` → wait 100 ms → retry once → if still failing, exit 1 with "index appears mid-write" message).
2. `src/formatter.ts` (new) — extracted formatters.
3. `src/kb-fs.ts` (new) — `listKnowledgeBases`.
4. `src/lock.ts` (new) — `withWriteLock`, `acquireInstanceAdvisory`, `releaseInstanceAdvisory`.
5. `src/FaissIndexManager.ts` — add `initialize({ readOnly?: boolean })`; one conditional guards the `model_name.txt` write; the write itself becomes atomic via `writeModelNameAtomic` (§4.7) — tmp+rename pattern.
6. `src/KnowledgeBaseServer.ts` — replace inline `sanitizeMetadataForWire` + formatter with imports from `formatter.ts`; replace `handleListKnowledgeBases` with a call to `kb-fs.ts:listKnowledgeBases`; wrap `updateIndex` calls in `withWriteLock`; call `acquireInstanceAdvisory` in `run()`, `releaseInstanceAdvisory` in `shutdown()`.
7. `src/triggerWatcher.ts` — wrap its `updateIndex` call in `withWriteLock`.
8. `package.json` — add `"kb": "build/cli.js"` to `bin`; add `"proper-lockfile": "^4.1.2"` to dependencies; chmod the new bin in the `build` script.
9. Tests: `src/cli.test.ts`, `src/formatter.test.ts`, `src/kb-fs.test.ts`, `src/lock.test.ts`. Update `src/FaissIndexManager.test.ts` for `readOnly`. Update `src/KnowledgeBaseServer.test.ts` for the moved helpers (the tests currently call the private methods via bracket access; after extraction, the bracket-access tests can stay valid because the methods are still on the class — they just now delegate to the helpers).

### 5.3 What MCP-side upgrades still require restart

The MCP server is still a long-lived child process. M1 does not make it self-upgrade. Wins:

- The operator can use `kb search` (with or without `--refresh`) to validate a fix immediately, without restarting Claude.
- M2's `docs/clients.md` `@latest` correction ensures that when the user *does* restart Claude, the new MCP version is actually picked up.

### 5.4 Concurrency and the now-enforced single-MCP-instance constraint

Today: docs say "one MCP server per `FAISS_INDEX_PATH`"; nothing enforces it. Two concurrent MCP servers can corrupt the index.

After M1:
- The PID advisory file (§4.8.1) makes the constraint hard. Two MCP servers against the same path: second one fails-fast with a clear error.
- The write lock (§4.8.2) serializes writes. Default `kb search` doesn't contend.

This is a *behaviorally-observable change*. Users who (against documented guidance) ran two MCP servers will see a hard failure where they previously got silent corruption. This is an improvement but it is a change. CHANGELOG must call it out as **"Behavior change (technically breaking)"**, not just an "Added" entry.

Per pre-1.0 semver convention, this is a 0.2.0 minor bump. Post-1.0 it would be major. The CHANGELOG must be unambiguous.

## 6. Migration / rollout

### 6.1 Phasing

- **M0** (0.1.2 patch). EISDIR / wrong-path bug fixes. Required before M1.
- **M1** (0.2.0 minor). CLI + helpers + split-lock + model-mismatch. CHANGELOG entries: "Added" (CLI), "Added" (model-mismatch check), "Changed (technically breaking)" (single-MCP-instance now enforced).
- **M2** (0.2.1 patch or rolling docs). Docs.

M2 depends on M1 being **published**, not just merged. M2 PR opens a draft against M1 to be merged after `npm publish` of 0.2.0.

### 6.2 Pre-publish gate (M1) — wired into CI

A new GitHub Actions job `prepublish-smoke.yml` runs on the M1 PR's branch and on the release tag. Hard gate: `npm publish` only runs after this job is green.

Steps:

1. `npm pack` produces a tarball.
2. Install: `npm install -g $(pwd)/jeanibarz-knowledge-base-mcp-server-*.tgz` in a fresh container/tmpdir.
3. Verify both bins exist and are executable: `which kb && which knowledge-base-mcp-server && [[ -x $(which kb) ]] && [[ -x $(which knowledge-base-mcp-server) ]]`.
4. `kb --version` returns the package version.
5. `kb list` against a seeded temp KB returns expected names.
6. Lockfile concurrency scenario:
   - Spawn `knowledge-base-mcp-server` (the MCP bin) against a temp `FAISS_INDEX_PATH` over stdio.
   - Verify `.kb-mcp.pid` exists with the right PID and mode `0o600`.
   - Run `kb search "test"` (default). Assert success and that the MCP's PID file is unchanged. Assert no `.kb-write.lock` was created.
   - Run `kb search --refresh "test"`. Assert success while MCP is alive (this exercises the round-2 N1 fix). Assert lock file appeared and disappeared during the call.
   - Send SIGTERM to MCP. Verify `.kb-mcp.pid` is removed.
   - **Concurrent startup (round-3 fix):** spawn two MCP servers simultaneously against the same path (`node build/index.js & node build/index.js`); assert exactly one succeeds and the other fails-fast with "another instance running."
   - **CLI during MCP init (round-3 fix):** spawn MCP; immediately (within the model_name.txt write window) spawn `kb search`; assert no false-positive mismatch error. The atomic-write fix in §4.7 makes this safe; the test verifies it.
7. Model-mismatch scenario: write a `model_name.txt` with model A; configure CLI for model B; run `kb search`; assert exit code 2 + stderr message.
8. **Freshness-footer mtime accuracy (round-3 fix):** seed an index; record footer mtime from `kb search` output; sleep 1s; run `kb search --refresh` to trigger an updateIndex (no file changes — verifies a no-op refresh still updates mtime correctly); record new footer mtime; assert new mtime ≥ old mtime + 1s. (If this fails, the directory-vs-file mtime bug is back.)

This is the round-2 delivery-pragmatist fix expanded with round-3 additions. Steps 6–8 must be a CI job, not a manual checklist.

### 6.3 Backwards compatibility

- The `knowledge-base-mcp-server` bin is preserved unchanged.
- All env vars are unchanged. CLI introduces no new env vars.
- MCP wire-format strings are unchanged (the formatter that produces them is moved to `formatter.ts`, but produces byte-equal output — covered by a snapshot test in `formatter.test.ts`).
- One observable change: M1 enforces single-MCP-instance via PID advisory. Users running two MCP servers against the same path now fail-fast on the second. Documented prominently.

### 6.4 Rollback

npm versions are immutable. Rollback paths:

- **Bug only in CLI:** publish 0.2.1 with `bin/cli.js` reduced to `console.error('CLI temporarily disabled, see #N'); process.exit(2);`. MCP unaffected. CHANGELOG: "If you hit X, run `npm i -g @jeanibarz/knowledge-base-mcp-server@0.2.1` to disable the CLI but keep MCP working."
- **Bug in `readOnly` seam in `initialize()`:** revert just that change. CLI's default break (must use `--refresh`); doesn't crash. Patch.
- **Bug in lockfile (write lock):** publish 0.2.1 that no-ops `withWriteLock` (acts as pass-through). The pre-M1 unlocked behavior returns. Operator advised to not run two writers concurrently. Patch.
- **Bug in PID advisory:** publish 0.2.1 that no-ops `acquireInstanceAdvisory`. The pre-M1 unenforced behavior returns. Patch.
- **Bug in `--refresh` write path:** publish 0.2.1 that disables the `--refresh` flag (errors with "temporarily disabled"). Default `kb search` keeps working.
- **Worst case (M1 startup breaks MCP):** publish 0.2.1 reverting M1 in full. Users with the unversioned `npx -y` spec must clear `~/.npm/_npx/` (manual; documented in CHANGELOG). Users with `@latest` get the fix on next session start.

CHANGELOG includes:

- The downgrade command for each scenario.
- A **Known issues** link to the GitHub Issues page.
- An "If `kb` is unusable, your MCP server is unaffected — only the new bin has the issue" reassurance.

### 6.5 Empirical-gate / regression downgrade table

Documents conditional ship behavior. Round-3 cleanup: removed flag-based downgrades that would have required pre-emptive YAGNI flag implementation; replaced with concrete code-level rollback actions.

| Regression | Detected by | M1 ships as: |
|------------|-------------|--------------|
| Cold-start `kb search` p95 ≤ 2 s (current: ~0.55 s) | §10 E1 / CI smoke | as designed |
| Cold-start 2 s < p95 ≤ 5 s | §10 E1 / CI smoke | as designed + stderr latency warning when over budget |
| Cold-start p95 > 5 s | §10 E1 / CI smoke | M1 ships `kb list` only; `kb search` deferred to a follow-up RFC for daemon mode |
| `--refresh` lockfile correctness fails (deadlock, write-skew under concurrent writers) | §6.2 step 6 | M1 ships without `--refresh` flag (`bin/cli.js` errors with "--refresh temporarily disabled, see #N"). Default `kb search` ships. |
| Model-mismatch check false-positive (atomic-write race not actually closed) | §6.2 step 6.7 | Patch removes the check from `cli.ts`; users get the pre-fix behavior of silent-wrong-results until next patch. CHANGELOG calls out the regression explicitly so users know to manually verify env parity. |
| PID advisory false-stale (e.g., on container restart with PID reuse, or O_EXCL semantics broken on FS) | §6.2 step 6.6 | Patch removes `acquireInstanceAdvisory` from `KnowledgeBaseServer.run()`; pre-M1 unenforced behavior returns. CLI `--refresh` write lock still works. |
| Freshness footer mtime is wrong (e.g., still using directory mtime) | §6.2 step 8 | Patch removes the footer (`formatRetrievalAsMarkdown` body unchanged; `cli.ts` skips footer assembly). Default kb search behavior matches MCP wire format byte-for-byte until next patch. |

All rollbacks are concrete code reverts shippable as patches. No new feature flags introduced just for rollback.

## 7. Edge cases

- **`KNOWLEDGE_BASES_ROOT_DIR` unset.** CLI uses the same default as the server (`$HOME/knowledge_bases`).
- **Embedding-model switch.** CLI's model-mismatch check (§4.7) catches this. Default mode exits 2 with explicit message; `--refresh` mode warns and proceeds (triggers full re-embed under the write lock).
- **Concurrent `kb search` invocations (read-only).** No lock; both proceed. Standard `FaissStore.load` from a stable on-disk index handles many concurrent readers.
- **Concurrent `kb search --refresh` + MCP server.** Both want the write lock briefly. `proper-lockfile` retries (default short retry budget); typically resolves in ~280 ms.
- **CLI default while MCP `ReindexTriggerWatcher` is mid-`FaissStore.save`** (round-2 N4). `FaissStore.save` is non-atomic (`mkdir -p + Promise.all([index.write, writeFile(docstore.json)])`, no rename). The window is `writeFile(docstore.json)` time — ~5–50 ms on the operator's 1.3 MB docstore. CLI's `FaissStore.load` reads `docstore.json`; a partial read fails JSON parse. **Mitigation:** the CLI catches `SyntaxError` from the FAISS load path and retries once after 100 ms. If the second attempt also fails, exits 1 with "Index appears to be mid-write; please retry." Documented as a known small race window. Long-term fix (atomic save wrapper) tracked as separate issue per N7.
- **CLI `kb search --refresh` while a second `--refresh` runs concurrently.** Second waits for the lock. `proper-lockfile` retry budget ~5 attempts × 100 ms = ~500 ms; if still locked, errors out cleanly.
- **Laptop sleep / WSL2 hibernation during `updateIndex`** (round-2 N9). `proper-lockfile` heartbeat (`update: 5000` ms) keeps the lock alive while the process is running. If the host suspends the process for >10 s and the heartbeat doesn't fire, the lock falsely deems stale; another writer can acquire. When the original process resumes, both think they hold the lock → write race. Mitigation: documented as a known limitation; recommend running `--refresh` only while the host is awake. (Acceptable trade for cross-platform `proper-lockfile`. A `flock(2)`-based design would be auto-released on process suspend rather than falsely-stale, but is non-portable per round-1 design-experimenter P6.)
- **Two MCP servers race to start** (round-2 N2). Second writes its PID, sees the first PID is alive (`kill(pid, 0)` succeeds), exits with "another instance running." Clean error UX.
- **MCP segfault leaves stale PID file.** Next MCP startup checks `kill(stale_pid, 0)`, sees no process, logs warning "stale PID file, overwriting", proceeds.
- **Half-installed `npm i -g`** (round-1 F11). The CLI's top-level `import` is wrapped in try/catch; on `ERR_MODULE_NOT_FOUND` emits "kb may be mid-install; retry in 2s" to stderr and exits 2. Better UX than the default opaque error.
- **CLI/MCP env divergence** (round-1 F14). The model-mismatch check (§4.7) catches the most-impact case (different embedding model). Other divergences (different `KNOWLEDGE_BASES_ROOT_DIR`) are detected because the CLI looks at a different `FAISS_INDEX_PATH` and either finds no index (returns empty) or finds one built from different KBs (returns plausibly-irrelevant results). Documented as a known limit; M2 docs add an "Env-var checklist for CLI vs MCP parity" section.
- **CLI/MCP version skew during upgrade window** (round-2 finding). `npm i -g @latest` updates both bins atomically. The running MCP child process keeps using the old bin (Node already loaded it). The next CLI invocation uses the new bin. If a release changes the on-disk index format, this window can corrupt. Mitigation: on-disk format changes (e.g., new chunk metadata, new index layout) must be additive-only within a minor version, and require a major version (1.x → 2.x) for breaking changes. CHANGELOG includes a "Compatibility" section per release.
- **Empty query / non-existent KB.** Same as MCP path.
- **Stdin piping.** Supported via `--stdin`. Shell-escaping reliability for agent-generated multi-line queries.

## 8. Alternatives considered

(Unchanged from v2 — see §8.1–§8.7 for full reasoning. Summary:)

- **Local HTTP daemon.** Brings restart problem back; cold-call ~0.5 s makes it unnecessary.
- **Docker container.** Same restart class as status quo.
- **Separate repo.** Version-skew on shared retrieval logic.
- **MCP self-restart on binary change.** Verified infeasible (`fs.watch` doesn't fire on `npm install -g` relinks).
- **`KnowledgeBaseService` extraction as separate PR.** Round-1 minimalist YAGNI. Three small targeted helpers (formatter, kb-fs, lock) are extracted instead, each with a real consumer.
- **`kb mcp-serve` subcommand.** Round-1 minimalist YAGNI; existing bin already does this.
- **Fork to `--once` mode.** Operator-hostile; requires hand-built JSON-RPC.

## 9. Open questions

- **OQ1.** Bin name `kb`. Decision deferred to M1 PR review (verify `which kb` and `npm view kb` for collision risk).
- **OQ2.** `kb refresh` subcommand. Mostly redundant with `REINDEX_TRIGGER_PATH`. Defer to M1 review.
- **OQ3.** PID advisory: should it include extra metadata (start time, env hash) so debugging stale-PID cases is easier? Defer to M1 implementation; YAGNI for now.
- **OQ4.** `proper-lockfile` retry budget for `--refresh`. 5 × 100 ms is an initial guess; tune based on observed `updateIndex` durations during M1 testing.

## 10. Empirical work — measured in round 1

The §4.6 cost numbers, §2.4 `npx`/`fs.watch` claims, and §4.7/§4.8 design decisions were validated by round-1 + round-2 empirical probes (see §11). Items remaining for the M1 PR (not RFC gates):

- **E1.** CI smoke test from §6.2.
- **E2.** Steady-state cost as KB size grows. The current 280 ms `updateIndex` directory-scan cost is roughly linear in file count. Re-measure when the user has 2× and 5× more KBs. Tracking metric, not gate.
- **E3.** Concurrent `--refresh` × MCP `ReindexTriggerWatcher` stress test under the new lock design. Specifically: spin up MCP with `REINDEX_TRIGGER_POLL_MS=1000`; while it's polling, run `kb search --refresh` 50 times in a loop; assert all succeed within their retry budget.

## 11. Critic feedback incorporated

### Round 1 — 2026-04-25

Six critic agents in parallel (`boundary-critic`, `failure-mode-analyst`, `design-minimalist`, `socratic-challenger`, `ambition-amplifier`, `delivery-pragmatist`) plus a `design-experimenter` empirical checkpoint.

**Adversarial pair (`ambition-amplifier` + `design-minimalist`):**

- *Service extraction.* design-minimalist: drop, YAGNI. Adopted.
- *`kb mcp-serve` subcommand.* design-minimalist: drop. Adopted.
- *Read-only mode promotion.* ambition-amplifier: promote OQ4 to mandatory. Adopted (and refined further in round 2).
- *Stdin support.* ambition-amplifier: ship in v1. Adopted.
- *Empirical-gate downgrade table.* ambition-amplifier: make explicit. Adopted.

**Hand-off log:**

- `assumption-archaeologist`: not invoked — no ADR-derived behavior changed.
- `design-experimenter` 2026-04-25: novel finding — confirmed cold-start <1 s; confirmed `npx` unversioned spec caches indefinitely (RFC §2.4 corrected); confirmed `fs.watch` doesn't see npm relinks (RFC §8.4 sharpened); confirmed `--read-only` is mechanical (RFC §4.5); confirmed EISDIR bug latent (RFC §5.1).
- `ambition-amplifier` 2026-04-25: novel finding — N1+OQ4 jointly load-bearing; promote OQ4.
- `assumption-archaeologist` 2026-04-25: out-of-scope.

### Round 2 — 2026-04-25

Three focused critics (`boundary-critic`, `delivery-pragmatist`, `failure-mode-analyst`) ran on the v2.

**Critical findings incorporated:**

- *Round-2 N1 (failure-mode-analyst): v2's lifetime-scoped lock breaks `--refresh`.* The most important fix in v3. Lock split into PID advisory (long-lived, MCP-vs-MCP) and write lock (short-lived, contended only briefly). §4.8 entirely rewritten.
- *Round-2 N4 (failure-mode-analyst): `FaissStore.save` is non-atomic; default CLI reads can race with MCP writes.* Documented in §7 with a JSON-parse-retry mitigation; added as a non-goal (N7) with separate-issue follow-up.
- *Round-2 N5 (failure-mode-analyst): CLI/MCP env divergence → silent vector-space mismatch.* New §4.7 model-mismatch check; CLI exits non-zero on mismatch.
- *Round-2 N7 (failure-mode-analyst): default read-only returns stale results without freshness signal.* New §4.10 freshness footer.
- *Round-2 N9 (failure-mode-analyst): laptop sleep can false-stale `proper-lockfile`.* Documented in §7 as a known limitation; heartbeat enabled.
- *Boundary-critic: `readOnly` belongs on `initialize()` not constructor.* §4.5 updated to method-level flag.
- *Boundary-critic: `cli.ts` shouldn't import from `KnowledgeBaseServer.ts`.* New `src/formatter.ts` extraction (§4.9).
- *Boundary-critic: `handleListKnowledgeBases` logic should be a pure helper.* New `src/kb-fs.ts` (§4.9).
- *Boundary-critic: lock acquire/release should be in one `src/lock.ts`.* Adopted (§4.9, §4.8).
- *M0 scope: lines 317, 339, 346 all need fixes.* §5.1 expanded (was line 317 only in v2).
- *Delivery-pragmatist: pre-publish gate steps 6–7 must be CI, not manual.* §6.2 names a `prepublish-smoke.yml` job and makes it a hard gate.
- *Delivery-pragmatist: `--refresh` regression downgrade row missing.* Added to §6.5.
- *Delivery-pragmatist: CHANGELOG wording for now-enforced single-MCP-instance.* §5.4 explicit "Behavior change (technically breaking)".
- *Delivery-pragmatist: new transitive deps (`graceful-fs`, `retry`, `signal-exit`) need audit.* M1 includes `npm audit` step in CI.

**Rejected (with reason):**

- *Boundary-critic: split `config.ts` into MCP-specific and core modules.* Out of scope. Real architectural debt, but unrelated to the CLI surface; tracked separately.
- *Failure-mode-analyst (round 1) F4 (pickleparser RCE).* Threat-model docs are stale (current `docstore.json` is JSON, not pickle); tracked separately.
- *Failure-mode-analyst (round 1) F12 (SIGINT in constructor).* Not changed by M1; revisit if a future RFC moves signal handling.
- *Socratic-challenger Q4 (deprecate MCP entirely).* N4 stands.

### Round 3 — 2026-04-25

Two focused critics (`failure-mode-analyst`, `boundary-critic`) ran on v3.

**Critical safety findings incorporated into v4:**

- *Round-3 failure-mode-analyst: `MODEL_NAME_FILE` write is non-atomic; CLI partial-read produces false-positive mismatch error.* §4.7 adds atomic tmp+rename pattern (`writeModelNameAtomic`).
- *Round-3 failure-mode-analyst: PID file write needs `O_EXCL` for atomic acquire; needs mode `0o600` to prevent info leak on shared filesystems.* §4.8.1 specifies both.
- *Round-3 failure-mode-analyst: freshness footer mtime source is wrong — directory mtime doesn't update when FaissStore overwrites inner files.* §4.10 corrects to inner binary file mtime.
- *Round-3 failure-mode-analyst: `--refresh` triggering a full re-embed (model switch / first build) blocks the write lock for minutes; all MCP retrievals stall.* §4.8.3 adds a "slow-path" subsection with operator guidance (M2 docs include the warning), CLI estimates duration up front and warns to stderr if >10 files need re-embed, future RFC for stream-based updateIndex tracked separately.
- *Round-3 boundary-critic: G6 ("byte-equal to MCP") silently violated by footer.* §3.1 G6 reworded to make the footer divergence explicit, deliberate, and documented.
- *Round-3 boundary-critic: freshness-footer ownership ambiguous (body in formatter.ts, footer in cli.ts).* §4.10 documents the split explicitly.
- *Round-3 §6.2 CI tests are sequential, won't catch races.* §6.2 adds three tests: concurrent MCP startup (steps 6.6), CLI during MCP init (step 6.7), footer mtime accuracy (step 8).

**Round-3 boundary refinements deferred to M1 PR review (not RFC blockers):**

These are real but minor. They affect code organization within M1, not the RFC's design correctness. The implementer decides during M1 PR review:

- **`lock.ts` may split into `write-lock.ts` + `instance-advisory.ts`.** Round-3 boundary-critic flagged the two-mechanism module as conceptually mixed. The split is mechanical (no design implication). M1 author's call.
- **`sanitizeMetadataForWire` may move to a security/wire-policy module rather than `formatter.ts`.** It encodes the RFC 011 §7.1 R1 suppression rule, which is a domain policy not a formatting concern. M1 author's call; either home is workable as long as the function is reachable from both surfaces.
- **`readOnly` flag name on `initialize()`.** Round-3 boundary-critic suggested `skipModelNameWrite` as more precise. `readOnly` is the round-2 boundary-critic's recommendation. Either is acceptable; the call-site comment makes the contract clear regardless.
- **`kb-fs.ts` name may be too broad.** Could be `list-knowledge-bases.ts` or kept inside `FaissIndexManager.ts`. M1 author's call.

**Non-critical findings rejected:**

- *Round-3 failure-mode-analyst: `proper-lockfile` heartbeat writes mtime every 5s → SSD wear.* Real but negligible at the scale of one user. Tracked as a follow-up issue if reported by operators with constrained SSDs.
- *Round-3 failure-mode-analyst: §6.5 promises feature flags (`KB_STRICT_MODEL_CHECK`, etc.) without scoping the code.* Removed those promised flags from §6.5 — downgrade rows now describe the actual rollback action (publish a patch that no-ops the buggy code path), not a flag-based one. Implementing flags pre-emptively is YAGNI.
- *Round-3 failure-mode-analyst: N4 retry mitigation is documented but not implementation-scoped.* Acknowledged. Added `cli.ts` JSON-parse retry handler to §5.2 file list.

### Convergence

V4 is the convergence point. Round 4 would catch only naming-level boundary nits (§11 round-3 boundary refinements deferred to M1) and second-order effects of the v4 fixes themselves. The skill's early-convergence rule applies: "if a round produces no substantive findings (only minor or already-addressed items), you may stop iterating early." Round 3 produced substantive findings; v4 addresses the safety-critical ones; further rounds without M1-implementation evidence would be diminishing returns.

The §6.2 CI smoke gate is the next signal — if it catches a defect during M1 PR development, the design is updated and the RFC patched (in-place, not a v5).
