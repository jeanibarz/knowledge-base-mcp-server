// RFC 016 — Canonical Docstore Dedup Across Multi-Model Indexes.
//
// `@langchain/community`'s FaissStore.save writes `docstore.json` as
// `[entries, mapping]` where each entry is `[uuid.v4(), Document]`. Chunk
// content + metadata is byte-identical across embedding models for the same
// KB, but the random per-save UUIDs make the bytes differ — so M models on
// the same KB hold M near-duplicate ~1.81 MiB docstore files (RFC 013 §11 E5).
//
// This module rewrites the random UUIDs into content-addressed ones at save
// time, hashes the canonical bytes, and routes per-model `docstore.json`
// files through a shared content-addressed store via hardlinks. Faiss
// binaries stay per-model; only the docstore is deduplicated.
//
// Crash-safety contract — see RFC 016 §"Crash modes":
//   1. CAS payload writes use tmp + rename (atomic).
//   2. Per-model hardlink creation goes through a tmp link + rename.
//   3. The whole link / GC dance runs under `withCasLock`, so a GC pass
//      cannot delete a CAS payload between another save's "CAS hit" decision
//      and its hardlink call.
//
// The reader path (`FaissStore.load`) is unchanged — `fs.readFile` follows
// hardlinks transparently.

import { createHash } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';
import { pathExists } from './file-utils.js';
import { logger } from './logger.js';

const DOCSTORE_FILE = 'docstore.json';
const CAS_LOCK_FILE = '.lock';

// Heuristic upper bound — we log a warn if more entries than this would
// share an identical canonical hash (which means the salting fallback
// kicked in for that many entries). Single-digit hits are routine for
// chunks that share `(pageContent, metadata)` after the chunker's
// `chunkIndex` salt — kept low so genuine pathology surfaces.
const COLLISION_LOG_THRESHOLD = 5;

const CAS_LOCK_OPTS: Omit<properLockfile.LockOptions, 'lockfilePath'> = {
  stale: 30_000,
  retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
};

/** What FaissStore.save writes to `docstore.json`. */
type DocstoreEntry = [string, { pageContent: string; metadata: Record<string, unknown> }];
type DocstoreFile = [DocstoreEntry[], Record<string | number, string>];

export interface CanonicalizeResult {
  /** Canonical-form bytes ready to write to disk. */
  bytes: Buffer;
  /** sha256 of the canonical bytes — used as the CAS filename. */
  hash: string;
  /** Number of `(pageContent, metadata)` collisions that required positional salting. */
  collisions: number;
  /** Number of entries in the docstore. */
  entryCount: number;
}

export interface DedupOutcome {
  /** "hit" — CAS already had this hash; "miss" — we wrote it; "skipped" — disabled or unsupported FS. */
  status: 'hit' | 'miss' | 'skipped';
  /** sha256 of the canonical bytes, or null when skipped. */
  hash: string | null;
  /** Bytes of the canonical payload (helps operators measure savings). */
  bytes: number;
  /** Reason a skip happened (EXDEV, EOPNOTSUPP, etc.). null when not skipped. */
  skipReason: string | null;
}

export interface GcResult {
  removed: string[];
  kept: number;
}

/**
 * Test-only seam. Production code never sets these. The repo convention
 * (see `file-mutation.ts:atomicWriteFile`) is to swap fs primitives via an
 * optional `hooks` object rather than monkey-patching `fs/promises` exports
 * — ESM treats those exports as read-only, so `jest.spyOn` cannot redefine
 * them.
 */
export interface DedupTestHooks {
  link?: (existing: string, newPath: string) => Promise<void>;
}

/**
 * Parse the raw `docstore.json` payload (as written by FaissStore.save)
 * and re-emit it with content-addressed UUIDs. The output is byte-stable
 * given semantically identical input — that's the whole point.
 *
 * The canonicalization rules:
 *   1. Each entry's UUID becomes `sha256-128(canonical(doc))` formatted as
 *      `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
 *   2. If two entries hash to the same UUID (rare in practice, because the
 *      chunker emits a distinct `chunkIndex` per chunk in `metadata`), the
 *      second collider gets a positional salt suffix.
 *   3. `_mapping` is rebuilt with the new UUIDs in original insertion order.
 *   4. Object keys in `metadata` are sorted before hashing (otherwise an
 *      identical doc that happens to be serialized in a different key order
 *      would hash differently — that defeats the purpose).
 *   5. The final JSON.stringify uses no whitespace (matches FaissStore.save's
 *      output exactly except for the UUIDs).
 */
export function canonicalizeDocstore(raw: string): CanonicalizeResult {
  const parsed = JSON.parse(raw) as DocstoreFile;
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error(
      'canonicalizeDocstore: expected [entries, mapping] tuple from FaissStore.save',
    );
  }
  const [entries, oldMapping] = parsed;
  if (!Array.isArray(entries)) {
    throw new Error('canonicalizeDocstore: entries is not an array');
  }

  const seen = new Map<string, number>();
  const oldToNew = new Map<string, string>();
  let collisions = 0;

  const newEntries: DocstoreEntry[] = entries.map((entry, position) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`canonicalizeDocstore: entry ${position} is not a [uuid, doc] tuple`);
    }
    const [oldUuid, doc] = entry;
    if (typeof oldUuid !== 'string') {
      throw new Error(`canonicalizeDocstore: entry ${position} has non-string uuid`);
    }
    if (doc === null || typeof doc !== 'object') {
      throw new Error(`canonicalizeDocstore: entry ${position} has non-object doc`);
    }

    // We sort metadata keys for BOTH the hash input and the persisted doc,
    // so two semantically equal docstores emitted with different key orders
    // (langchain order is insertion-order-dependent) produce byte-identical
    // output. Without this the dedup still works in the common case but
    // breaks when metadata-key order differs.
    const sortedMetadata = sortObjectKeys(doc.metadata ?? {}) as Record<string, unknown>;
    const canonicalDoc = { pageContent: doc.pageContent ?? '', metadata: sortedMetadata };
    const canonicalInput = JSON.stringify(canonicalDoc);
    let newUuid = formatAsUuid(sha256Hex(canonicalInput));
    if (seen.has(newUuid)) {
      collisions += 1;
      newUuid = formatAsUuid(sha256Hex(`${canonicalInput}\x00${position}`));
    }
    seen.set(newUuid, position);
    oldToNew.set(oldUuid, newUuid);
    return [newUuid, canonicalDoc];
  });

  // Rebuild mapping with new UUIDs. Mapping keys can be string or number
  // — preserve original ordering (the FAISS internal id order) and only
  // remap the values.
  const newMapping: Record<string, string> = {};
  for (const [k, oldUuid] of Object.entries(oldMapping)) {
    const newUuid = oldToNew.get(oldUuid);
    if (newUuid === undefined) {
      throw new Error(
        `canonicalizeDocstore: mapping references uuid ${oldUuid} that is not in entries`,
      );
    }
    newMapping[k] = newUuid;
  }

  const canonicalJson = JSON.stringify([newEntries, newMapping]);
  const bytes = Buffer.from(canonicalJson, 'utf-8');
  const hash = sha256Hex(canonicalJson);

  if (collisions >= COLLISION_LOG_THRESHOLD) {
    logger.warn(
      `docstore-cas: ${collisions} of ${newEntries.length} chunks share ` +
        `identical (pageContent, metadata) — positional salt applied. ` +
        `Heavy collision counts suggest a chunker bug; expected near-zero.`,
    );
  }

  return { bytes, hash, collisions, entryCount: newEntries.length };
}

/**
 * Run after `FaissStore.save(stagingDir)` to replace `stagingDir/docstore.json`
 * with a hardlink into the content-addressed store at `casRoot`.
 *
 * Behavior matrix:
 *   - `casRoot === null` → disabled (back-compat): no-op, returns "skipped".
 *   - Filesystem refuses `link()` (EXDEV/EPERM/EOPNOTSUPP) → first failure
 *     poisons dedup for the process; subsequent saves take the no-op path.
 *   - CAS already has this hash → "hit": atomic rename swaps in a 2nd hardlink.
 *   - CAS does not → "miss": atomic write to CAS, then atomic link into staging.
 *
 * Crash safety: every disk mutation in the dedup path is one of
 * `atomic-write-then-rename` or `link-then-rename`. A crash anywhere leaves
 * either (a) the original random-UUID `docstore.json` intact in the staging
 * dir, or (b) the new canonical hardlink in place — never a half-written
 * file or a dangling link.
 */
export async function dedupeDocstoreOnSave(opts: {
  stagingDir: string;
  casRoot: string | null;
  swapCounter: number;
  hooks?: DedupTestHooks;
}): Promise<DedupOutcome> {
  const { stagingDir, casRoot, swapCounter, hooks = {} } = opts;
  const linkFn = hooks.link ?? fsp.link;
  if (casRoot === null || dedupDisabled) {
    return { status: 'skipped', hash: null, bytes: 0, skipReason: 'disabled' };
  }

  const docstorePath = path.join(stagingDir, DOCSTORE_FILE);
  let raw: string;
  try {
    raw = await fsp.readFile(docstorePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // FaissStore.save writes docstore.json in production, but test mocks
      // may skip it. Treat missing docstore.json as "nothing to dedup" —
      // the downstream load path will detect any real corruption.
      return { status: 'skipped', hash: null, bytes: 0, skipReason: 'no-docstore' };
    }
    throw new Error(
      `dedupeDocstoreOnSave: ${docstorePath} unreadable after FaissStore.save: ` +
        `${(err as Error).message}`,
    );
  }

  let canonical: CanonicalizeResult;
  try {
    canonical = canonicalizeDocstore(raw);
  } catch (err) {
    // The docstore is not in the `[entries, mapping]` shape FaissStore.save
    // emits. Possible causes: a test that mocks FaissStore with a different
    // on-disk shape; a corrupt prior save; a future langchain version that
    // changes the format. Leave the file alone and let downstream loaders
    // decide whether to rebuild — silently corrupting a non-canonical
    // payload via a rewrite would be much worse than skipping dedup.
    logger.warn(
      `docstore-cas: skipping dedup for ${docstorePath} — payload is not a ` +
        `canonical FaissStore docstore tuple: ${(err as Error).message}`,
    );
    return { status: 'skipped', hash: null, bytes: 0, skipReason: 'not-canonical' };
  }
  await fsp.mkdir(casRoot, { recursive: true });
  const casPath = path.join(casRoot, `${canonical.hash}.json`);

  try {
    return await withCasLock(casRoot, async () => {
      let status: 'hit' | 'miss';
      if (await pathExists(casPath)) {
        status = 'hit';
      } else {
        await atomicWriteBytes(casPath, canonical.bytes);
        status = 'miss';
      }

      const tmpLink = path.join(
        stagingDir,
        `.${DOCSTORE_FILE}.tmp.${process.pid}.${swapCounter}`,
      );
      // Clear stale tmp from a prior crash before linking.
      await fsp.rm(tmpLink, { force: true });
      try {
        await linkFn(casPath, tmpLink);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (code === 'EXDEV' || code === 'EPERM' || code === 'EOPNOTSUPP') {
          dedupDisabled = true;
          logger.warn(
            `docstore-cas: link() failed with ${code} (cross-device or unsupported ` +
              `filesystem). Disabling dedup for this process; saves continue ` +
              `per-model. Repoint FAISS_INDEX_PATH at a single-mount filesystem ` +
              `that supports hardlinks to re-enable.`,
          );
          return {
            status: 'skipped',
            hash: canonical.hash,
            bytes: canonical.bytes.length,
            skipReason: code,
          };
        }
        throw err;
      }
      await fsp.rename(tmpLink, docstorePath);
      return {
        status,
        hash: canonical.hash,
        bytes: canonical.bytes.length,
        skipReason: null,
      };
    });
  } catch (err) {
    // Lock contention or unexpected filesystem errors fall through to a
    // skip — the per-model docstore.json that FaissStore.save wrote is
    // still in place, so the save is correct, just not deduplicated.
    logger.warn(
      `docstore-cas: dedup failed for ${stagingDir}, leaving per-model copy in place: ` +
        `${(err as Error).message}`,
    );
    return {
      status: 'skipped',
      hash: canonical?.hash ?? null,
      bytes: canonical?.bytes.length ?? 0,
      skipReason: 'error',
    };
  }
}

/**
 * Best-effort GC of orphan CAS entries. A CAS file is an orphan iff its
 * link count is 1 — only the CAS directory itself holds a reference, so no
 * live `models/<id>/index.vN/docstore.json` points at it.
 *
 * Runs under `withCasLock`, so it cannot race with a concurrent
 * `dedupeDocstoreOnSave` that's about to link a fresh hardlink to the same
 * inode: any save that wants to link must first acquire the same lock.
 */
export async function gcDocstoreCas(casRoot: string): Promise<GcResult> {
  if (!(await pathExists(casRoot))) {
    return { removed: [], kept: 0 };
  }
  return withCasLock(casRoot, async () => {
    let entries: string[];
    try {
      entries = await fsp.readdir(casRoot);
    } catch (err) {
      logger.warn(
        `docstore-cas: gc readdir failed at ${casRoot}: ${(err as Error).message}`,
      );
      return { removed: [], kept: 0 };
    }
    const removed: string[] = [];
    let kept = 0;
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(casRoot, name);
      let st;
      try {
        st = await fsp.lstat(filePath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.nlink <= 1) {
        try {
          await fsp.rm(filePath, { force: true });
          removed.push(name);
        } catch (err) {
          logger.warn(
            `docstore-cas: gc could not remove ${filePath}: ${(err as Error).message}`,
          );
          kept += 1;
        }
      } else {
        kept += 1;
      }
    }
    if (removed.length > 0) {
      logger.info(
        `docstore-cas: gc removed ${removed.length} orphan payload(s), kept ${kept}`,
      );
    }
    return { removed, kept };
  });
}

/**
 * Resolve the CAS root for a given `FAISS_INDEX_PATH`. The CAS lives as a
 * sibling of `models/` so all per-model indexes under the same index path
 * can share it.
 */
export function casRootForIndexPath(faissIndexPath: string): string {
  return path.join(faissIndexPath, '.docstore-cas');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

let dedupDisabled = false;

/**
 * Reset the process-wide dedup-disabled poison flag. Tests use this to
 * exercise EXDEV / EPERM paths without leaking state into other test cases.
 */
export function resetDedupDisabledForTests(): void {
  dedupDisabled = false;
}

export async function withCasLock<T>(
  casRoot: string,
  action: () => Promise<T>,
): Promise<T> {
  await fsp.mkdir(casRoot, { recursive: true });
  const lockfilePath = path.join(casRoot, CAS_LOCK_FILE);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await properLockfile.lock(casRoot, {
      ...CAS_LOCK_OPTS,
      lockfilePath,
    });
  } catch (err) {
    // Same fail-open policy as withSidecarLock: a runaway peer should not
    // poison the caller. The crash-safety story degrades to "best-effort"
    // for this one save, which still leaves a valid (un-deduped) docstore.
    logger.warn(
      `docstore-cas: could not acquire ${lockfilePath}, proceeding without serialization: ` +
        `${(err as Error).message}`,
    );
  }
  try {
    return await action();
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // best-effort release
      }
    }
  }
}

async function atomicWriteBytes(targetPath: string, data: Buffer): Promise<void> {
  const tmpPath = `${targetPath}.kb-tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}`;
  const handle = await fsp.open(tmpPath, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(tmpPath, targetPath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

function formatAsUuid(hex: string): string {
  // Slice to 32 hex chars (128 bits), format as a UUID-shaped string. We
  // don't claim conformance to RFC 4122 variant/version bits — FaissStore
  // doesn't check those either; it treats UUIDs as opaque keys.
  const h = hex.slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortObjectKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
