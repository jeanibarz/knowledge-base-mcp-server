# RFC 016 — Canonical Docstore Dedup Across Multi-Model Indexes

**Status:** Draft (lifts RFC 013 §8.9 future-RFC seed)
**Depends on:** RFC 013 (per-model layout `models/<id>/`), RFC 014 (atomic save via `index.vN/` + symlink swap)
**Tracks:** issue #286

## Problem

Multi-model support (RFC 013) stores each embedding model under its own `${FAISS_INDEX_PATH}/models/<id>/` directory. Inside every `index.vN/`, `FaissStore.save()` writes:

- `faiss.index` — model-specific binary vectors (intentionally per-model)
- `docstore.json` — `[entries, mapping]` where `entries = [[uuid, {pageContent, metadata}], …]`

`docstore.json` is **byte-different across models for the same KB** even though its semantic content is byte-identical: chunk `pageContent` and `metadata` are produced by the same `buildChunkDocuments` pipeline (`src/file-ingest.ts`), but `@langchain/community/vectorstores/faiss` calls `uuid.v4()` per insertion, so:

```js
// langchain/.../faiss.js:94
const documentIds = options?.ids ?? documents.map(() => uuid.v4());
```

Two models register the same 1,294-chunk KB → two ~1.81 MiB `docstore.json` files with **the same chunks, different UUIDs**. RFC 013 §11 round-1 empirical probe E5 verified this directly. Cost grows linearly with M models and per-model retention `N` versioned dirs (RFC 014): on disk we hold `M × N × 1.81 MiB` of duplicated text/metadata.

## Goal

Make per-model `index.vN/docstore.json` files **hardlink to a shared content-addressed payload** when their semantic content is equal, so M models indexing the same KB collapse `M × N` docstore copies into one payload (plus M×N hardlinks, each 0 bytes on disk).

**Non-goals:**

- Deduping `faiss.index` (intentionally per-model; vectors differ).
- Cross-KB dedup (chunk content from different KBs is rarely byte-equal; complexity not worth it).
- Rewriting the upstream langchain `FaissStore.save()` ID assignment. We canonicalize the on-disk artifact only — the in-memory store keeps random UUIDs; the canonical UUIDs we write are picked up on the next load.
- Power-cut durability stronger than RFC 014's policy.

## Design

### 1. Canonical UUID derivation (save-time)

After `FaissStore.save(stagingDir)` writes `docstore.json`, we read it back, parse the tuple `[entries, mapping]`, and rewrite every UUID with a content-addressed derivative:

```ts
function canonicalUuid(entry: [string, Document]): string {
  const [, doc] = entry;
  const canonical = JSON.stringify({
    pageContent: doc.pageContent,
    metadata: sortObjectKeys(doc.metadata),
  });
  return formatAsUuid(sha256(canonical).slice(0, 32));
}
```

Two distinct entries with identical `(pageContent, metadata)` collide. This is unlikely in practice (the chunker emits `chunkIndex` in `metadata`, distinct per chunk in the same file), but a duplicate would silently overwrite. We **detect collisions** and append a positional salt:

```ts
if (seenUuids.has(uuid)) {
  uuid = formatAsUuid(sha256(canonical + `\x00${position}`).slice(0, 32));
}
```

Collisions are logged at `warn` once per save with a chunk count, so operators see the rare case.

### 2. CAS layout

```
${FAISS_INDEX_PATH}/
├── active.txt
├── .docstore-cas/                              # NEW
│   ├── .lock                                   # flock target for link + GC
│   └── <sha256-of-canonical-bytes>.json        # content-addressed payload
└── models/<model_id>/
    └── index.vN/
        ├── faiss.index
        └── docstore.json                       # hardlink to .docstore-cas/<sha>.json
```

CAS hash = `sha256(canonicalDocstoreBytes)`. Filename is the full 64-hex hash (no truncation; collision probability negligible, no need for variable-length).

### 3. Save sequence (per atomicSave invocation)

In `saveFaissStoreAtomic` (`src/faiss-store-layout.ts`), between `store.save(stagingDir)` and the symlink swap:

```
1. await store.save(stagingDir)
     // writes stagingDir/faiss.index, stagingDir/docstore.json (random UUIDs)
2. canonicalBytes = canonicalize(read(stagingDir/docstore.json))
3. sha = sha256(canonicalBytes)
4. casPath = `${casRoot}/${sha}.json`
5. with flock(`${casRoot}/.lock`):
     a. if !exists(casPath):
          atomicWrite(casPath, canonicalBytes)   // tmp + rename
     b. tmpLink = `${stagingDir}/.docstore.tmp.${pid}.${counter}`
     c. fs.link(casPath, tmpLink)
     d. fs.rm(stagingDir/docstore.json)
     e. fs.rename(tmpLink, stagingDir/docstore.json)
6. (release flock)
7. (existing) symlink swap: rename(tmpLink → index)
```

**Critical:** `link()` and `rename()` for the per-model `docstore.json` happen under the same flock to ensure GC cannot remove `casPath` between step 5a and step 5c when another concurrent save is racing.

### 4. Read path

No changes. `FaissStore.load()` calls `fs.readFile(directory/docstore.json)` which transparently follows hardlinks. The kernel sees one inode regardless of how many hardlink names point at it.

### 5. GC strategy (best-effort during prune)

`pruneInactiveIndexVersions` already runs after every successful save, under the per-model write lock. We extend it: after the per-model prune completes, walk `${casRoot}/*.json` and unlink any entry where `stat().nlink === 1` (only the CAS dir holds a reference → no live model points at it). The walk runs **under the same `.docstore-cas/.lock`** so it cannot race with a concurrent save's link step.

```ts
async function gcDocstoreCas(casRoot: string): Promise<{ removed: number }> {
  return withCasLock(casRoot, async () => {
    const entries = await readdir(casRoot);
    let removed = 0;
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      const p = path.join(casRoot, e);
      const st = await lstat(p);
      if (st.nlink === 1) {
        await rm(p, { force: true });
        removed += 1;
      }
    }
    return { removed };
  });
}
```

Cost: one `readdir` + N `lstat` per save. With dedup, N stays small (one entry per distinct docstore version held by any model). With M models × N retention each on the same KB, the CAS holds at most `N` entries, not `M × N`.

### 6. Telemetry

`saveFaissStoreAtomic` already logs the version swap (`atomicSave: <model> v3 -> v4`). We extend the log line with the dedup outcome:

```
atomicSave: ollama__nomic v3 -> v4 (docstore-cas: hit, sha=ab12…, bytes=1898421)
atomicSave: openai__text-3-small v3 -> v4 (docstore-cas: miss, sha=ab12…, wrote=1898421)
```

`hit` = CAS file already existed (true dedup). `miss` = first save for that content; CAS file written. Operators can grep the log to measure dedup ratio in the field.

## Crash modes

The atomic-save invariant from RFC 014 is: **after a crash, either the new versioned dir is fully present and the symlink points at it, or it's not and the symlink still points at the previous version**. RFC 016 extends this with:

| Crash point | State on disk | Recovery |
|---|---|---|
| Before step 5a finishes | `casPath` partially written via `.tmp` | Orphan `.tmp.<sha>.<pid>.json`; next save's flock acquisition + atomic rename overwrites cleanly. Periodic GC removes the orphan tmp file. |
| Between 5a and 5c (CAS exists, no hardlink yet) | `stagingDir/docstore.json` still the original random-UUID file | The symlink still points at the previous `index.v(N-1)/`. Next save retries from scratch. The orphan `stagingDir` (which RFC 014 already handles in `saveFaissStoreAtomic` via "clearing orphan staging dir") is cleaned. |
| Between 5c and 5e (tmpLink exists) | `stagingDir/docstore.json` is the *original* random-UUID copy; `tmpLink` is a 2nd hardlink to CAS | Same as previous row — staging dir is orphan, RFC 014 cleanup applies. |
| After 5e but before symlink swap | `stagingDir/docstore.json` is the CAS hardlink; `index` symlink still old | Next save will see staging in place. RFC 014's "orphan staging dir" cleanup `rm -rf`s the staging dir, which decrements the CAS hardlink count to (potentially) 1. Next GC tick removes the CAS payload if no other model needs it. **No data loss for the currently-active version.** |
| After symlink swap | Complete success | — |
| GC removes a CAS entry whose hardlink count just dropped to 1 | The CAS file is unlinked; no model has a live reference | The shared-docstore-reference-points-at-missing-payload hazard. **Prevented** because the GC walks under `.docstore-cas/.lock`, and any save that wants to `link(casPath, …)` acquires the same lock — there is no window in which a model needs `casPath` but hasn't yet linked to it. |

## Migration

Existing indexes have `docstore.json` files written by `FaissStore.save` without canonicalization. On first save after upgrade:

- The store loads the existing `docstore.json` with random UUIDs into memory (via `FaissStore.load`).
- On the next `atomicSave`, the new save sequence writes a canonical-UUID copy to CAS and hardlinks the new `index.v(N+1)/docstore.json` to it.
- The old `index.vN/docstore.json` (random UUIDs) is left alone; it gets reclaimed when `pruneInactiveIndexVersions` removes `index.vN/` per the existing retention policy.

After `KB_INDEX_VERSION_RETENTION + 1` saves, all live versions point at CAS hardlinks. No explicit migration step; no operator action.

## Failure-mode discussion

- **`fs.link` cross-device failure (EXDEV).** `casRoot` and `modelDir/index.vN/` live under the same `$FAISS_INDEX_PATH`, so they're on the same filesystem by construction. If an operator points `FAISS_INDEX_PATH` at an overlay that splits across mounts, `link()` fails with EXDEV. Detect once at startup (write a probe file in `casRoot`, attempt link into a model dir, then unlink); on EXDEV log a single `warn` and **disable dedup** for that runtime — saves continue to write per-model copies, no functional regression vs today.
- **Filesystem doesn't support hardlinks (FAT, some network mounts).** Same probe catches `EOPNOTSUPP`/`EPERM` and disables dedup with a single warn line.
- **CAS payload corruption.** A bit-rot of `.docstore-cas/<sha>.json` corrupts every model that hardlinks to it. Probability is no higher than docstore corruption today (one file vs M files). When `FaissStore.load` throws on parse, the existing `loadFaissStoreAtomic` `repairCorrupt` path removes the symlink and falls back to rebuild — same recovery as the legacy single-file case. We accept this trade.
- **Operator runs `find $FAISS_INDEX_PATH -name docstore.json -delete`.** The hardlinked variant breaks per-model loads but leaves the CAS payload alive; the rebuild path repopulates. Same blast radius as today's per-model layout: one operator footgun, one rebuild.

## Out of scope (future-RFC seeds)

- **CAS sharding** for very large operator setups (`<casRoot>/ab/cd/<sha>.json`). Not needed below ~10⁴ entries; `readdir` stays cheap.
- **`fsync` after CAS write.** Matches RFC 014 — durability is best-effort.
- **CAS shared across `FAISS_INDEX_PATH` roots.** Operator multi-tenancy concern; not in scope.

## Validation plan (issue #286 acceptance)

1. **Disk savings.** Register two models over the operator's `/home/jean/knowledge_bases/` (RFC 013 E1 measured at 1,294 chunks, ~1.81 MiB per docstore). Measure `du -h` of `${FAISS_INDEX_PATH}/models/` and `${FAISS_INDEX_PATH}/.docstore-cas/` before this change and after. Expected: before-after diff ≈ `(M-1) × 1.81 MiB`.
2. **Crash-safety unit tests** in `src/docstore-cas.test.ts`:
   - canonicalization is deterministic across two independent runs;
   - canonicalization is stable across key-order permutations in `metadata`;
   - collision salt fires when two entries share `(pageContent, metadata)`;
   - simulated crash after step 5a leaves orphan tmp that next save replaces;
   - simulated crash after step 5e leaves a hardlinked docstore that loads correctly;
   - GC of a CAS entry with `nlink > 1` is rejected; GC with `nlink == 1` removes it;
   - EXDEV / EOPNOTSUPP from `link()` disables dedup gracefully (no save failure).
3. **Integration test** in `src/FaissIndexManager.test.ts`: spin up two FaissIndexManagers with different `(provider, modelName)` over the same temp KB, run `updateIndex` on both, assert `lstat(modelA/index.vN/docstore.json).ino === lstat(modelB/index.vN/docstore.json).ino`.

## Open questions

- **OQ1.** Should `kb stats` / `list_models` surface the CAS dedup ratio? Yes — useful operator signal. Defer the schema to the implementation PR.
- **OQ2.** Best-effort GC on every save vs every-Nth save (sampling)? Every-save GC is O(CAS size) which stays small. Start with every-save; revisit if profiling shows it on the hot path.
