# 0002 — Per-file hash sidecars

- **Status:** Accepted; crash-safety notes updated by pending sidecar manifests
- **Date:** 2026-04-24 (back-documented)
- **Deciders:** Repo owner

## Context and Problem Statement

On every refresh-before-query `retrieve_knowledge` call the server must decide
which files, if any, have changed since they were last indexed. The check needs
to be correct (no false negatives — changed files must re-embed) and cheap
because it runs on the hot path.

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

**Option 1 — per-file sha256 sidecar.** One text file per source stores a
64-character hex digest of the source bytes under `<kb>/.index/<relpath>`.
Chunk manifests sit next to those hash sidecars to detect chunk-boundary drift.

## Pros and Cons

**Pros:**
- O(1) lookup per file — no parsing / no contention on a shared manifest.
- Each sidecar survives a partial write via tmp+rename; pending sidecar commit
  recovery in `src/pending-sidecar-commit.ts` handles crashes between FAISS save
  and sidecar persistence.
- Stays colocated with the source: moving `<kb>/` between roots keeps its sidecar tree intact.
- Inspectable — `cat <kb>/.index/foo/bar.md` shows a hex digest; no JSON parser needed.

**Cons:**
- One inode per source file. On KBs with very large file counts this starts to matter (RFC 007 §7.4 flags for future attention).
- Reads twice per unchanged file (sha + sidecar read), instead of once (`stat`). RFC 007 §7.5 proposes an mtime+size short-circuit that adds a cheap pre-check without abandoning the hash.
- No single atomic swap across the whole KB sidecar tree. Current code mitigates
  the FAISS-save/sidecar-write gap with a per-model `pending-manifest.json` that
  rolls forward `save-complete` sidecar commits or purges ambiguous
  `save-started` state.

## More Information

- `calculateSHA256` lives in `src/file-utils.ts` (read once, hash once — no
  streaming chunk reader).
- Option 2 (single manifest) was rejected because contention on the manifest file makes batched writers trickier than per-file writers, and a corrupt manifest invalidates the whole KB where one corrupt sidecar invalidates one file.
- Option 4 (mtime+size) trades correctness for speed; the RFC 007 §7.5 proposal keeps it as a **short-circuit** on top of sha, not a replacement.
