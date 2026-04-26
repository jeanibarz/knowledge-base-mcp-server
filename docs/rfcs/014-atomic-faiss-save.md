# RFC 014 — Atomic FAISS Save

**Status:** Draft (lifts RFC 013 §11 N4)
**Depends on:** RFC 013 (per-model layout, write locks, instance advisory)
**Unblocks:** removal of single-instance enforcement (`src/instance-lock.ts`) — separate follow-up PR

## Problem

`FaissStore.save(directory)` from `@langchain/community` is non-atomic:

```js
async save(directory) {
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    this.index.write(path.join(directory, "faiss.index")),
    fs.writeFile(path.join(directory, "docstore.json"), JSON.stringify(...)),
  ]);
}
```

Two failure modes:
1. **Read-during-write torn data** — partial JSON, or N-vector index paired with N±k-doc store → silent retrieval bugs.
2. **Write-during-write corruption** — two writers interleave bytes; no retry recovers.

The codebase compensates with per-model write locks (solves #2), the single-instance advisory (closes the cross-process write hazard), and `loadWithJsonRetry` (catches torn JSON only, not docid mismatch). The single-instance advisory is the user-visible pain — only one MCP server per `$FAISS_INDEX_PATH` means concurrent Claude sessions queue.

## Goal

Make save+load directory-atomic at the **caller** level so:

- Any reader sees a consistent `(faiss.index, docstore.json)` pair — never the partial or mixed-version state.
- The single-instance advisory becomes redundant overhead, removable in a follow-up PR.
- `loadWithJsonRetry` becomes redundant for the versioned layout (kept one release as defensive belt with corrected comment that names which layout still uses it).

**Non-goals:**
- Power-cut durability stronger than the existing repo policy. The codebase doesn't `fsync` today (per-file hash sidecars rely on `tmp+rename` for atomicity but not durability — `src/FaissIndexManager.ts:807-822`). RFC 014 matches this: atomicity guaranteed, durability is best-effort. A power-cut may lose the most recent save; no save is ever observed half-written.
- Migration / rewrite of the legacy `faiss.index/` layout. v3 is purely additive.

## Design

### Layout — additive, no migration

```
${FAISS_INDEX_PATH}/
├── active.txt
└── models/<model_id>/
    ├── faiss.index/                 # legacy directory (preserved on upgrade)
    ├── index → index.v3             # NEW: stable symlink, atomically swapped
    ├── index.v3/                    # current data
    │   ├── faiss.index
    │   └── docstore.json
    ├── index.v2/                    # previous (kept by GC)
    ├── index.v1/                    # one more for GC slack
    └── model_name.txt
```

**Key choice: never touch the legacy `faiss.index/`.** Old server versions reading it after a downgrade still find their data (slightly stale by saves the new server made — documented). The new server only writes through `index.vN/` + the `index` symlink.

After a release cycle of stability post-advisory-removal, a future PR adds a one-time `legacy-cleanup` that removes `faiss.index/`.

### Save algorithm

```typescript
// Inside FaissIndexManager — file-private. Per-model write lock is held by
// every caller of updateIndex (verified: KnowledgeBaseServer.ts:216,374 and
// cli.ts:436,646 all wrap updateIndex in withWriteLock(manager.modelDir, ...)).
// atomicSave's precondition: caller holds withWriteLock(this.modelDir).
private async atomicSave(): Promise<void> {
  const symlinkPath = path.join(this.modelDir, 'index');
  const currentTarget = await readSymlinkOrNull(symlinkPath);   // 'index.v3' | null
  const nextVersion = nextVersionAfter(currentTarget);          // 'index.v4'
  const stagingDir = path.join(this.modelDir, nextVersion);

  // 1. Write the new version into a fresh dir. FaissStore.save is
  //    non-atomic but isolated — staging is exclusive (write lock + unique
  //    version number). EEXIST recovery: rmrf+retry once for orphan staging.
  try {
    await this.faissIndex!.save(stagingDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    logger.warn(`atomicSave: orphan staging dir ${stagingDir} — clearing and retrying`);
    await fsp.rm(stagingDir, { recursive: true, force: true });
    await this.faissIndex!.save(stagingDir);                    // throws if still failing
  }

  // 2. Atomic symlink swap. POSIX rename(2) replaces an existing symlink
  //    atomically. Tmp name includes pid + monotonic counter to prevent
  //    cross-process collision under the (impossible-given-the-write-lock)
  //    case of concurrent same-modelDir saves.
  const tmpLink = path.join(this.modelDir, `.index.tmp.${process.pid}.${++this.swapCounter}`);
  await fsp.symlink(nextVersion, tmpLink);                      // relative target
  await fsp.rename(tmpLink, symlinkPath);                       // atomic on POSIX

  logger.info(`atomicSave: ${this.modelId} ${currentTarget ?? '(none)'} → ${nextVersion}`);

  // 3. Best-effort GC of versions older than N=3. Synchronous (inside the
  //    write lock) so the write-lock release happens AFTER GC completes,
  //    which makes the contract simple: when withWriteLock returns, the
  //    on-disk state is "current = vN, plus up to 2 immediately prior
  //    versions kept; everything else is gone."
  await gcOldVersions(this.modelDir, { keep: 3, current: nextVersion });
}
```

**No fsync.** Matches the existing per-file-hash sidecar pattern (`src/FaissIndexManager.ts:807-822` does `tmp+rename` without fsync). Atomicity comes from `rename(2)`; durability is best-effort across the whole codebase. Power-cut during save: staging dir possibly partial → next save's EEXIST recovery cleans it. Power-cut during rename: symlink either reverts or commits; no partial state. Power-cut after rename but before page cache flush: rename reverts to v3 on reboot, staging v4 survives → next save uses v5. **No torn data ever; no special platform handling needed.**

### Load algorithm — pre-resolve at the caller

```typescript
// Replaces FaissIndexManager.initialize()'s load step (src/FaissIndexManager.ts:539-557).
private async loadAtomic(): Promise<FaissStore | null> {
  const symlinkPath = path.join(this.modelDir, 'index');
  const legacyPath = path.join(this.modelDir, 'faiss.index');

  // lstat (NOT stat / pathExists) so we detect symlink presence regardless
  // of whether the target resolves. pathExists follows symlinks
  // (FaissIndexManager.ts:206-216) and would silently return false if the
  // target was GC'd, falsely falling through to the legacy branch with
  // STALE data. lstat avoids that hazard.
  const symStat = await fsp.lstat(symlinkPath).catch(err => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  });

  if (symStat?.isSymbolicLink()) {
    // realpath dereferences the symlink ONCE here. The resolved absolute
    // path is then passed to FaissStore.load, whose internal Promise.all
    // opens both files via the absolute path — no symlink in the open
    // path → no race with a concurrent swap. (Round-2 review confirmed
    // this against @langchain/community/dist/vectorstores/faiss.js:215-228.)
    let resolved: string;
    try {
      resolved = await fsp.realpath(symlinkPath);
    } catch (err) {
      // realpath ENOENT here means the symlink target was GC'd between our
      // lstat and realpath. With N=3 retention, this requires ≥3 writes
      // completed in the JS-event-loop microsecond gap between lstat and
      // realpath while THIS reader was paused — impossible under the
      // existing write-lock cadence. Surface loudly: it indicates the
      // retention contract was somehow violated and the operator should
      // investigate (concurrent rmrf? manual filesystem surgery?).
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `loadAtomic: symlink ${symlinkPath} target vanished between lstat and realpath — ` +
          `N=3 retention contract violated. Check for concurrent gc, manual surgery, or filesystem issues.`,
        );
      }
      throw err;
    }
    return FaissStore.load(resolved, this.embeddings);
  }

  // Legacy path — pre-RFC-014 layout. Read directly. Keeps existing
  // (non-atomic) behavior for users who haven't yet saved under v014.
  // The torn-read hazard described in the threat model still applies to
  // THIS branch until the first updateIndex migrates the model to
  // versioned layout.
  if (await pathExists(legacyPath)) {
    logger.info(`loadAtomic: ${this.modelId} loading legacy faiss.index/ — first save will create versioned layout`);
    return FaissStore.load(legacyPath, this.embeddings);
  }

  return null;
}
```

### Reader-vs-writer concurrency analysis

| t | Reader | Writer | Effect |
|---|---|---|---|
| 0 | `lstat(index)` → `isSymbolicLink: true` | — | |
| 1 | `realpath(index)` → `/abs/.../index.v3` | — | Reader pinned to v3 |
| 2 | `Promise.all([open(/abs/.../index.v3/faiss.index), open(/abs/.../index.v3/docstore.json)])` | `store.save(index.v4)` running | Both opens hit v3 directly. No symlink in the open path. |
| 3 | reads continue from v3 fds | `rename(.tmp, index)` → symlink now points at v4 | Reader's fds continue to reference v3. New readers see v4. |
| 4 | reads complete from v3 | `gcOldVersions` runs synchronously inside write lock | GC keeps v4 (current), v3, v2; deletes v1 and earlier. No reader holds a fd to a deleted file. |

The earlier F1 hazard ("v3 docstore + v4 index → docid mismatch") is structurally eliminated because the symlink is dereferenced exactly once, before any file open.

**GC race window analysis.** The reader is between t=1 (`realpath`) and t=2 (`open(2)`). To make GC delete v3 in that window requires THREE consecutive writes (advancing current to v(N+3), making v3 the (N-2) GC target) while the reader is paused between two adjacent JS-event-loop syscalls. Each write requires acquiring the per-model write lock + running `FaissStore.save` (multi-second on real models). Reader resolution between syscalls is microseconds. **Not a real-world hazard.** N=3 retention is the safety margin; the explicit `realpath`-ENOENT throw above is the loud detection mechanism if the assumption ever breaks.

### Migration — none

No two-step rename; no migration lock; no peer-process race. The new layout is **additive**:

- Existing installs keep `faiss.index/` untouched.
- The first `updateIndex` after upgrade writes `index.v0/`, creates the `index` symlink. Atomic. No prior state is mutated.
- `faiss.index/` is preserved as rollback-safety. A user who downgrades the npm package finds their pre-upgrade data intact (any saves the new code made are in `index.vN/` and ignored by the old code).

### Downgrade-hazard surface

A `logger.warn` alone is not enough — operators commonly miss MCP server stderr. So the discoverability is two-tier:

1. **Marker file.** When `loadAtomic` finds BOTH a versioned symlink AND a non-empty legacy `faiss.index/`, write `${modelDir}/.downgrade-hazard` containing the timestamp and a one-line reason. Idempotent (overwrite). Removed automatically by `loadAtomic` when only one layout remains. This file is the durable signal.

2. **`kb models list` surfaces it.** The existing CLI command iterates models; v014 adds a column or trailing flag (e.g., a `[downgrade-hazard]` suffix) when `.downgrade-hazard` is present for that model. One-line code change in `src/active-model.ts` model-listing path.

3. **Log warning** at `initialize` time as belt-and-suspenders:
   ```typescript
   if (await pathExists(legacyPath)) {
     logger.warn(
       `model ${this.modelId} has both versioned (${path.basename(resolved)}) and legacy ` +
       `(faiss.index/) layouts present. Downgrading the npm package will silently ignore ` +
       `any embeddings added since the RFC 014 upgrade — they exist only in the versioned ` +
       `layout. To reclaim disk and remove the hazard once you're confident in the new layout: ` +
       `\`rm -rf "${this.modelDir}/faiss.index"\`.`,
     );
   }
   ```

The warning gives a runnable shell command users can act on immediately (no reference to an unimplemented `kb models migrate` CLI). The `kb models migrate` follow-up PR will wrap this in an idempotent helper, but is not a precondition for users to act on the hazard today.

### `nextVersionAfter` and `gcOldVersions`

```typescript
// Pure function. Idempotent across processes that read the same currentTarget.
function nextVersionAfter(currentTarget: string | null): string {
  if (!currentTarget) return 'index.v0';
  const m = currentTarget.match(/^index\.v(\d+)$/);
  if (!m) throw new Error(`atomicSave: unrecognized symlink target: ${currentTarget}`);
  return `index.v${parseInt(m[1], 10) + 1}`;
}

async function gcOldVersions(modelDir: string, opts: {keep: number, current: string}): Promise<void> {
  const entries = await fsp.readdir(modelDir);
  const versions = entries
    .map(e => ({ name: e, n: parseInt(e.match(/^index\.v(\d+)$/)?.[1] ?? '', 10) }))
    .filter(v => Number.isFinite(v.n))
    .sort((a, b) => b.n - a.n);                 // newest first

  const toDelete = versions.slice(opts.keep);   // keep top N
  for (const v of toDelete) {
    if (v.name === opts.current) continue;      // never delete what symlink points at (defensive)
    await fsp.rm(path.join(modelDir, v.name), { recursive: true, force: true })
      .catch(err => logger.warn(`gc: failed to remove ${v.name}: ${err.message}`));
  }
}
```

**Concurrent same-modelDir saves are prevented by the per-model write lock** (`withWriteLock(manager.modelDir, ...)` at each `updateIndex` call site, verified above). `nextVersionAfter` reads the symlink AFTER lock acquisition, so two writers cannot pick the same version number.

**Orphan staging dirs from prior crashes** do NOT shift `nextVersionAfter` (it reads the symlink, not the directory listing). On EEXIST during `store.save(stagingDir)`, recovery is rmrf+retry-once. If rmrf fails, the error propagates — operator must investigate. Documented.

### File placement

All of `atomicSave`, `loadAtomic`, `nextVersionAfter`, `gcOldVersions`, `readSymlinkOrNull` are **file-private inside `src/FaissIndexManager.ts`**. No new module. They operate on the manager's private layout and are not callable from outside.

### `loadWithJsonRetry` and threat-model.md updates IN this PR

Doc updates are conditional on layout: the versioned path is safe; the legacy path retains the prior hazard until the model is rewritten under v014.

- **`src/cli.ts:842-849`** — replace the comment to read:
  > "Pre-RFC-014 defensive belt for the LEGACY `faiss.index/` load path only. The versioned `index → index.vN/` layout pre-resolves the symlink before any file open, so torn-JSON is structurally impossible there. Legacy reads still go through `FaissStore.load(legacyPath)` directly and CAN race with a concurrent legacy writer (extremely rare since new code never writes to the legacy path). Slated for removal in the same follow-up PR that drops the single-instance advisory, after the legacy-cleanup task confirms no remaining users on legacy layout."
- **`docs/architecture/threat-model.md §4`** — replace the "Known limitation" paragraph and the "single MCP server" requirement statement with:
  > "**Atomic save** (RFC 014, landed in 0.x.y). New per-model layout `index → index.vN/` makes save+load directory-atomic via symlink-swap with reader-side pre-resolution. Torn reads are eliminated for the versioned layout. The legacy `faiss.index/` load path retains the prior hazard until and unless a write under v014 (`updateIndex`, `kb search --refresh`, or `kb models add`) creates the versioned layout for that model. Single-instance advisory is now an operational preference (not a safety requirement) and will be removed in the next release."

The advisory itself stays in `src/instance-lock.ts`. Removing it is the explicit follow-up PR (one-line change + threat-model update); keeping it for one release cycle gives time to detect any field issues with atomic save.

## Test plan

1. **Atomicity smoke.** Two saves; assert symlink advances `index.v0 → index.v1`; legacy `faiss.index/` untouched.
2. **F1 invariant — reader-during-writer.** Spawn N=20 reader workers; one writer doing `updateIndex` repeatedly. Each reader, after `FaissStore.load`, asserts `index.ntotal() === store.docstore._docs.size` AND every mapping id in `_mapping` resolves. **Use jest mocks for both the embedder and `FaissStore.load`/`fromTexts`** — the existing `FaissIndexManager.test.ts:49-61` pattern (`jest.mock('@langchain/community/embeddings/hf', ...)`) is the template. Mocking lets us return controllable counters for `index.ntotal()` and `docstore._docs.size`, so a docid mismatch is a deterministic test failure. Target wall-clock <30s for 1000 iterations; **validate empirically during implementation** before merging — this is the load-bearing test for F1, and an unstable timing budget would mask its signal. (v1's test would have passed even with the F1 bug because docid mismatch doesn't raise; this invariant is the assertion that catches it.)
3. **GC retention.** Save 6 times; assert exactly `index.v3, v4, v5` remain.
4. **Crash recovery — partial save.** Use a test hook to throw between `store.save(staging)` and `rename`. Restart, verify symlink unchanged, verify next save's EEXIST recovery clears the orphan and proceeds.
5. **Lazy migration.** Build a 0.3.0-layout fixture (real `faiss.index/` directory, no `index` symlink). Call `loadAtomic` — verify it loads from legacy. Call one `updateIndex` — verify `index.v0/` and `index` symlink exist, `faiss.index/` untouched.
6. **Downgrade compatibility.** After step 5, point a stub "old reader" (just `FaissStore.load(faiss.index)`) at the model dir — verify it still loads the original data.
7. **Two-process write contention.** Spawn two processes, each call `updateIndex` against the same model dir. Verify per-model write lock serializes; both saves succeed; final symlink points at the second writer's version; no orphan dirs leaked.
8. **`pathExists` vs `lstat` regression test.** Build a fixture with a dangling `index` symlink (target dir manually rm'd). Call `loadAtomic` — verify it throws the documented error, NOT silently falls through to legacy.
9. **Startup warning.** Build a fixture with both versioned + legacy. Call `initialize`. Assert the warn log line is emitted exactly once.

## Documentation updates IN this PR

- `docs/architecture/threat-model.md §4`: update text per above.
- `src/cli.ts:842` comment: update text per above.
- `docs/rfcs/013-multimodel-support.md §11`: strike N4, link to RFC 014.
- `CHANGELOG.md`: entry: "Atomic FAISS save (RFC 014). New per-model layout: `index → index.vN/` symlink. Old `faiss.index/` directory preserved untouched for downgrade safety; will be removed in a future release after the single-instance advisory is dropped. No migration step required. Disk usage temporarily ~2x per model until the future cleanup; embed a `kb models migrate` (planned) to reclaim space sooner. Power-cut durability is unchanged from prior releases (best-effort, matches existing repo policy); torn reads are now structurally impossible for the versioned layout."

## Out of scope (separate follow-up PRs)

- **Remove `src/instance-lock.ts`** — one release after this lands.
- **Remove `loadWithJsonRetry`** — same.
- **`kb models migrate` CLI** — manual migration tool that re-saves under v014, removes legacy `faiss.index/`. Lets users reclaim disk and bound their downgrade-loss window.
- **Remove legacy `faiss.index/` load path entirely** — after `kb models migrate` proves stable.

## Risks

- **Symlink portability.** Linux + macOS only (matches repo CI matrix). Windows symlinks need admin/dev mode — not supported.
- **Backup tools may double-count `faiss.index/` and `index.vN/`.** CHANGELOG note. Reasonable for users to add `index.v[0-9]*/` to backup excludes once the legacy path is dropped in a future release.
- **Disk usage doubles temporarily** (legacy `faiss.index/` + new `index.vN/`). Bounded by the future `kb models migrate` and `legacy-cleanup` PRs.
- **Downgrade silent data loss** — saves made under v014 are not visible to a downgraded server. Mitigated by the startup warning emitted when both layouts coexist.
- **Per-model write lock acquisition is a precondition of `atomicSave`.** Any future caller that bypasses `updateIndex` must wrap in `withWriteLock(manager.modelDir, ...)`. Documented in the function's preamble. A test-mode runtime check uses `properLockfile.check(modelDir, { lockfilePath })` (cheap — single `fs.stat`) to assert the lock is held when `process.env.NODE_ENV === 'test'`. Production builds skip the check to avoid the syscall on the hot path; the four verified call sites in `KnowledgeBaseServer.ts` and `cli.ts` are the contract surface.
