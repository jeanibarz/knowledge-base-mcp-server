# 0002 — Per-file hash sidecars

- **Status:** Accepted
- **Date:** 2026-04-24 (back-documented)
- **Deciders:** Repo owner

## Context and Problem Statement

On every `retrieve_knowledge` call the server must decide which files (if any) have changed since they were last indexed. The check needs to be correct (no false negatives — changed files must re-embed) and cheap (happens on the hot path, `src/KnowledgeBaseServer.ts:84`).

## Decision Drivers

- **Correctness.** False negatives (claiming a file is unchanged when it isn't) leave stale vectors in the index and silently break retrieval quality.
- **Crash safety.** A crash between "hash sidecar written" and "vectors persisted" should not claim-but-not-persist or persist-but-not-claim.
- **Human-debuggable.** Users poke into `$KNOWLEDGE_BASES_ROOT_DIR` with a file manager; the sidecar layout should not look like an opaque binary soup.
- **Rebuild locality.** Deleting `$FAISS_INDEX_PATH` to force a rebuild should not require also deleting the sha tree (or vice versa).

## Considered Options

1. **Per-file sha256 sidecar at `<kb>/.index/<relpath>/<basename>`** — current.
2. **Single `hashes.json` per KB** at `<kb>/.index/hashes.json`.
3. **Global `hashes.json`** keyed by absolute path, at `$FAISS_INDEX_PATH/hashes.json`.
4. **mtime + size** cache, no hash.
5. **No cache** — re-read and re-embed every file on every call.

## Decision Outcome

**Option 1 — per-file sha256 sidecar.** Implemented at `src/FaissIndexManager.ts:228-247` (read) and `:362-377` (atomic tmp+rename write). One text file per source, content is a 64-char hex digest of the source bytes.

## Pros and Cons

**Pros:**
- O(1) lookup per file — no parsing / no contention on a shared manifest.
- Each sidecar survives a partial write via tmp+rename; a crash mid-batch only leaves the unrenamed tail untouched (recovery at `src/FaissIndexManager.ts:369-373`).
- Stays colocated with the source: moving `<kb>/` between roots keeps its sidecar tree intact.
- Inspectable — `cat <kb>/.index/foo/bar.md` shows a hex digest; no JSON parser needed.

**Cons:**
- One inode per source file. On KBs with very large file counts this starts to matter (RFC 007 §7.4 flags for future attention).
- Reads twice per unchanged file (sha + sidecar read), instead of once (`stat`). RFC 007 §7.5 proposes an mtime+size short-circuit that adds a cheap pre-check without abandoning the hash.
- No atomic swap across the whole batch — only per-file. RFC 007 §6.2.1 tracks the `pending-manifest.json` protocol that makes the save-then-rename ordering crash-safe across files.

## More Information

- `calculateSHA256` at `src/file-utils.ts:6-11` (read once, hash once — no streaming chunk reader).
- Option 2 (single manifest) was rejected because contention on the manifest file makes batched writers trickier than per-file writers, and a corrupt manifest invalidates the whole KB where one corrupt sidecar invalidates one file.
- Option 4 (mtime+size) trades correctness for speed; the RFC 007 §7.5 proposal keeps it as a **short-circuit** on top of sha, not a replacement.
