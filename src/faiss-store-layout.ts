import * as fsp from 'fs/promises';
import * as path from 'path';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { FaissStore } from '@langchain/community/vectorstores/faiss';
import { logger } from './logger.js';

const VERSION_DIR_PATTERN = /^index\.v(\d+)$/;
const SYMLINK_NAME = 'index';
const LEGACY_INDEX_NAME = 'faiss.index';

type FsError = NodeJS.ErrnoException & { code?: string };

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch (error) {
    const code = (error as FsError | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
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
  const m = currentTarget.match(VERSION_DIR_PATTERN);
  if (!m) throw new Error(`atomicSave: unrecognized symlink target "${currentTarget}"`);
  return `index.v${parseInt(m[1], 10) + 1}`;
}

async function gcOldVersions(
  modelDirPath: string,
  opts: { keep: number; current: string },
): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(modelDirPath);
  } catch {
    return;
  }

  const versions = entries
    .map((e) => ({ name: e, n: parseInt(e.match(VERSION_DIR_PATTERN)?.[1] ?? '', 10) }))
    .filter((v) => Number.isFinite(v.n))
    .sort((a, b) => b.n - a.n);

  for (const v of versions.slice(opts.keep)) {
    if (v.name === opts.current) continue;
    await fsp
      .rm(path.join(modelDirPath, v.name), { recursive: true, force: true })
      .catch((err) =>
        logger.warn(`gc: failed to remove ${v.name} in ${modelDirPath}: ${(err as Error).message}`),
      );
  }
}

type FsOperationErrorHandler = (action: string, targetPath: string, error: unknown) => never;

export async function loadFaissStoreAtomic(options: {
  modelDir: string;
  modelId: string;
  embeddings: EmbeddingsInterface;
  handleFsOperationError: FsOperationErrorHandler;
}): Promise<FaissStore | null> {
  const { modelDir, modelId, embeddings, handleFsOperationError } = options;
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
}): Promise<void> {
  const { store, modelDir, modelId, swapCounter } = options;
  const symlinkPath = path.join(modelDir, SYMLINK_NAME);
  const currentTarget = await readSymlinkOrNull(symlinkPath);
  const nextVersion = nextVersionAfter(currentTarget);
  const stagingDir = path.join(modelDir, nextVersion);

  if (await pathExists(stagingDir)) {
    logger.warn(`atomicSave: clearing orphan staging dir ${stagingDir} from prior crash`);
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }
  await store.save(stagingDir);

  const tmpLink = path.join(
    modelDir,
    `.${SYMLINK_NAME}.tmp.${process.pid}.${swapCounter}`,
  );
  await fsp.symlink(nextVersion, tmpLink);
  await fsp.rename(tmpLink, symlinkPath);
  logger.info(
    `atomicSave: ${modelId} ${currentTarget ?? '(none)'} -> ${nextVersion}`,
  );

  await gcOldVersions(modelDir, { keep: 3, current: nextVersion });
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
