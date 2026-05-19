import * as fsp from 'fs/promises';
import * as path from 'path';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { FaissStore } from '@langchain/community/vectorstores/faiss';
import {
  dedupeDocstoreOnSave,
  gcDocstoreCas,
  type DedupOutcome,
} from './docstore-cas.js';
import { pathExists } from './file-utils.js';
import { logger } from './logger.js';

export const INDEX_VERSION_RETENTION_ENV = 'KB_INDEX_VERSION_RETENTION';
export const DEFAULT_PREVIOUS_INDEX_VERSION_RETENTION = 2;
const VERSION_DIR_PATTERN = /^index\.v(\d+)$/;
const SYMLINK_NAME = 'index';
const LEGACY_INDEX_NAME = 'faiss.index';

export interface IndexVersionPruneResult {
  active: string | null;
  retention: number;
  kept: string[];
  removed: string[];
  skipped: string | null;
}

export function parseIndexVersionDirName(name: string): number | null {
  const match = name.match(VERSION_DIR_PATTERN);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function resolveIndexVersionRetention(
  raw: string | undefined = process.env[INDEX_VERSION_RETENTION_ENV],
): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') {
    return DEFAULT_PREVIOUS_INDEX_VERSION_RETENTION;
  }
  if (!/^\d+$/.test(trimmed)) {
    logger.warn(
      `${INDEX_VERSION_RETENTION_ENV}=${JSON.stringify(raw)} is not a non-negative integer; ` +
        `using default ${DEFAULT_PREVIOUS_INDEX_VERSION_RETENTION}`,
    );
    return DEFAULT_PREVIOUS_INDEX_VERSION_RETENTION;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    logger.warn(
      `${INDEX_VERSION_RETENTION_ENV}=${JSON.stringify(raw)} is too large; ` +
        `using default ${DEFAULT_PREVIOUS_INDEX_VERSION_RETENTION}`,
    );
    return DEFAULT_PREVIOUS_INDEX_VERSION_RETENTION;
  }
  return parsed;
}

async function readSymlinkOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.readlink(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EINVAL') return null;
    throw err;
  }
}

/** Pure: derive the next versioned directory name from the current target. */
export function nextVersionAfter(currentTarget: string | null): string {
  if (!currentTarget) return 'index.v0';
  const n = parseIndexVersionDirName(currentTarget);
  if (n === null) throw new Error(`atomicSave: unrecognized symlink target "${currentTarget}"`);
  return `index.v${n + 1}`;
}

export async function pruneInactiveIndexVersions(
  modelDirPath: string,
  opts: { retention?: number } = {},
): Promise<IndexVersionPruneResult> {
  const rawRetention = opts.retention ?? resolveIndexVersionRetention();
  const retention = Number.isSafeInteger(rawRetention) && rawRetention > 0 ? rawRetention : 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(modelDirPath);
  } catch {
    return { active: null, retention, kept: [], removed: [], skipped: 'model directory unreadable' };
  }

  const versions = entries
    .map((e) => ({ name: e, n: parseIndexVersionDirName(e) }))
    .filter((v): v is { name: string; n: number } => v.n !== null)
    .sort((a, b) => b.n - a.n);
  const active = await readSymlinkOrNull(path.join(modelDirPath, SYMLINK_NAME));
  if (active === null) {
    return {
      active,
      retention,
      kept: versions.map((v) => v.name),
      removed: [],
      skipped: 'active index symlink is missing or not a symlink',
    };
  }
  if (parseIndexVersionDirName(active) === null) {
    logger.warn(
      `gc: skipping index version pruning in ${modelDirPath}; active symlink target ` +
        `${JSON.stringify(active)} is not an index.vN directory`,
    );
    return {
      active,
      retention,
      kept: versions.map((v) => v.name),
      removed: [],
      skipped: 'active index symlink target is not an index.vN directory',
    };
  }

  const kept = new Set<string>([active]);
  for (const v of versions) {
    if (v.name === active) continue;
    if (kept.size >= retention + 1) break;
    kept.add(v.name);
  }

  const removed: string[] = [];
  for (const v of versions) {
    if (kept.has(v.name)) continue;
    await fsp
      .rm(path.join(modelDirPath, v.name), { recursive: true, force: true })
      .then(() => removed.push(v.name))
      .catch((err) => {
        kept.add(v.name);
        logger.warn(`gc: failed to remove ${v.name} in ${modelDirPath}: ${(err as Error).message}`);
      });
  }
  if (removed.length > 0) {
    logger.info(
      `gc: pruned ${removed.length} inactive index version(s) in ${modelDirPath}; ` +
        `kept active ${active} plus ${Math.max(0, kept.size - 1)} inactive version(s)`,
    );
  }
  return { active, retention, kept: [...kept].sort(), removed, skipped: null };
}

type FsOperationErrorHandler = (action: string, targetPath: string, error: unknown) => never;

/**
 * RFC 017 M0c — load a specific `index.vN/` directory directly,
 * bypassing the `index` symlink. Used by `kb eval --compare-index` to
 * load two different historical versions of the same model's index for
 * a side-by-side recall comparison. Read-only (no symlink mutation, no
 * corruption-repair side effects). Throws if the directory or its
 * `faiss.index`/`docstore.json` contents are missing or corrupt.
 */
export async function loadFaissStoreFromVersionDir(options: {
  versionDir: string;
  embeddings: EmbeddingsInterface;
}): Promise<FaissStore> {
  const { versionDir, embeddings } = options;
  if (!(await pathExists(versionDir))) {
    throw new Error(`loadFromVersionDir: directory not found: ${versionDir}`);
  }
  return FaissStore.load(versionDir, embeddings);
}

export async function loadFaissStoreAtomic(options: {
  modelDir: string;
  modelId: string;
  embeddings: EmbeddingsInterface;
  handleFsOperationError: FsOperationErrorHandler;
  repairCorrupt?: boolean;
}): Promise<FaissStore | null> {
  const {
    modelDir,
    modelId,
    embeddings,
    handleFsOperationError,
    repairCorrupt = true,
  } = options;
  const symlinkPath = path.join(modelDir, SYMLINK_NAME);
  const legacyPath = path.join(modelDir, LEGACY_INDEX_NAME);

  const symStat = await fsp.lstat(symlinkPath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  });

  if (symStat?.isSymbolicLink()) {
    let resolved: string;
    try {
      resolved = await fsp.realpath(symlinkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `loadAtomic: symlink ${symlinkPath} target vanished between lstat and realpath - ` +
            `N=3 retention contract violated. Check for concurrent gc, manual filesystem ` +
            `surgery, or unexpected rmrf.`,
        );
      }
      throw err;
    }

    let store: FaissStore;
    try {
      logger.info(
        `Loading FAISS index for model ${modelId} from ${path.basename(resolved)}`,
      );
      store = await FaissStore.load(resolved, embeddings);
    } catch (err) {
      if (!repairCorrupt) {
        throw new Error(
          `Versioned FAISS index ${resolved} is corrupt or unreadable; ` +
            `read-only load will not repair it. Underlying error: ${(err as Error).message}`,
        );
      }
      logger.warn(
        `Versioned FAISS index ${resolved} is corrupt or unreadable - ` +
          `removing symlink and falling back to rebuild. Legacy faiss.index/ ` +
          `(if present) is preserved. Error:`,
        err,
      );
      try {
        await fsp.rm(symlinkPath, { force: true });
      } catch (unlinkErr) {
        handleFsOperationError('delete corrupt index symlink', symlinkPath, unlinkErr);
      }
      return null;
    }

    if (await pathExists(legacyPath)) {
      logger.warn(
        `model ${modelId} has both versioned (${path.basename(resolved)}) and legacy ` +
          `(faiss.index/) layouts present. Downgrading the npm package will silently ignore ` +
          `any embeddings added since the RFC 014 upgrade - they exist only in the versioned ` +
          `layout. To reclaim disk and remove the hazard once you're confident in the new ` +
          `layout: \`rm -rf "${legacyPath}"\`.`,
      );
    }

    return store;
  }

  if (await pathExists(legacyPath)) {
    try {
      logger.info(
        `Loading legacy FAISS index for model ${modelId} from faiss.index/. ` +
          `First save will create versioned layout (${SYMLINK_NAME} -> index.v0).`,
      );
      return await FaissStore.load(legacyPath, embeddings);
    } catch (err) {
      if (!repairCorrupt) {
        throw new Error(
          `Legacy FAISS index at ${legacyPath} is corrupt or unreadable; ` +
            `read-only load will not repair it. Underlying error: ${(err as Error).message}`,
        );
      }
      logger.warn(
        `Legacy FAISS index at ${legacyPath} is corrupt or unreadable - ` +
          `removing and falling back to rebuild. Error:`,
        err,
      );
      try {
        await fsp.rm(legacyPath, { recursive: true, force: true });
      } catch (unlinkErr) {
        handleFsOperationError('delete corrupt legacy FAISS index', legacyPath, unlinkErr);
      }
      return null;
    }
  }

  logger.info(
    `FAISS index not found for model ${modelId}. It will be created on the next updateIndex.`,
  );
  return null;
}

export async function saveFaissStoreAtomic(options: {
  store: FaissStore;
  modelDir: string;
  modelId: string;
  swapCounter: number;
  /**
   * RFC 016 — when provided, the per-model `docstore.json` written by
   * `FaissStore.save` is canonicalized and hardlinked to a shared payload
   * under `casRoot` before the symlink swap. `null` disables dedup (the
   * existing behavior pre-RFC-016, retained for unit tests and any caller
   * that does not have a stable shared root to use).
   */
  casRoot?: string | null;
  /**
   * Called immediately after the active `index` symlink has been swapped to
   * the new version, before best-effort pruning/GC. Callers use this as the
   * durable commit point for sidecar recovery records.
   */
  onCommitted?: () => Promise<void>;
}): Promise<void> {
  const {
    store,
    modelDir,
    modelId,
    swapCounter,
    casRoot = null,
    onCommitted,
  } = options;
  const symlinkPath = path.join(modelDir, SYMLINK_NAME);
  const currentTarget = await readSymlinkOrNull(symlinkPath);
  const nextVersion = nextVersionAfter(currentTarget);
  const stagingDir = path.join(modelDir, nextVersion);

  if (await pathExists(stagingDir)) {
    logger.warn(`atomicSave: clearing orphan staging dir ${stagingDir} from prior crash`);
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }
  await store.save(stagingDir);

  // RFC 016 — canonicalize + hardlink docstore into the CAS before we swap
  // the symlink. A crash between save and dedup leaves a complete (but
  // un-deduped) staging dir; RFC 014's orphan-staging cleanup on the next
  // save handles it.
  let dedup: DedupOutcome | null = null;
  if (casRoot !== null) {
    dedup = await dedupeDocstoreOnSave({ stagingDir, casRoot, swapCounter });
  }

  const tmpLink = path.join(
    modelDir,
    `.${SYMLINK_NAME}.tmp.${process.pid}.${swapCounter}`,
  );
  await fsp.symlink(nextVersion, tmpLink);
  await fsp.rename(tmpLink, symlinkPath);
  await onCommitted?.();
  logger.info(
    `atomicSave: ${modelId} ${currentTarget ?? '(none)'} -> ${nextVersion}` +
      (dedup
        ? ` (docstore-cas: ${dedup.status}` +
          (dedup.hash ? `, sha=${dedup.hash.slice(0, 12)}` : '') +
          (dedup.bytes ? `, bytes=${dedup.bytes}` : '') +
          (dedup.skipReason ? `, reason=${dedup.skipReason}` : '') +
          ')'
        : ''),
  );

  await pruneInactiveIndexVersions(modelDir, {
    retention: resolveIndexVersionRetention(),
  });
  if (casRoot !== null) {
    // Best-effort orphan reclamation. Runs under withCasLock so it cannot
    // race with a concurrent save's link step. See RFC 016 §5.
    await gcDocstoreCas(casRoot).catch((err) => {
      logger.warn(`atomicSave: docstore-cas gc failed: ${(err as Error).message}`);
    });
  }
}

export async function resolveActiveIndexFilePath(modelDir: string): Promise<string | null> {
  const symlinkPath = path.join(modelDir, SYMLINK_NAME);
  try {
    const symStat = await fsp.lstat(symlinkPath);
    if (symStat.isSymbolicLink()) {
      const resolved = await fsp.realpath(symlinkPath);
      const candidate = path.join(resolved, LEGACY_INDEX_NAME);
      if (await pathExists(candidate)) return candidate;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const legacyFile = path.join(modelDir, LEGACY_INDEX_NAME, LEGACY_INDEX_NAME);
  if (await pathExists(legacyFile)) return legacyFile;
  return null;
}
