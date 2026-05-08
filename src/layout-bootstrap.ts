import * as fsp from 'fs/promises';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';
import { FAISS_INDEX_PATH } from './config.js';
import { writeActiveModelAtomic } from './active-model.js';
import { pathExists } from './file-utils.js';
import { logger } from './logger.js';
import { deriveModelId, type EmbeddingProvider } from './model-id.js';

/**
 * RFC 013 §4.8 — module-level cache for `bootstrapLayout()`. Ensures migration
 * runs at most once per Node process even when multiple FaissIndexManager
 * instances exist (tests, `kb models add` after `KnowledgeBaseServer` already
 * constructed one). Round-2 failure N1.
 */
let bootstrapPromise: Promise<void> | null = null;

const MIGRATION_LOCK_PATH = path.join(FAISS_INDEX_PATH, '.kb-migration.lock');

export class MigrationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationRefusedError';
  }
}

/**
 * RFC 013 §4.8 — auto-migrate 0.2.x single-model layout to 0.3.0 per-model
 * subtree. Idempotent: early-returns if `models/` already exists or no old
 * layout is present. Atomic per `fsp.rename`. ENOENT-tolerant for peer-races.
 *
 * Migration policy (was OQ3, promoted to RFC-level decision in v3 round-2
 * boundary F7): when `model_name.txt` is present but env is unset, trust the
 * file + `huggingface` default (config.ts:12). When `model_name.txt` is
 * MISSING (pre-RFC-012 indexes), refuse — round-1 failure F5: silently
 * deriving an id under the wrong provider creates permanent on-disk-shape bugs.
 */
async function maybeMigrateLayout(): Promise<void> {
  const oldIndexDir = path.join(FAISS_INDEX_PATH, 'faiss.index');
  const oldModelFile = path.join(FAISS_INDEX_PATH, 'model_name.txt');
  const newModelsDir = path.join(FAISS_INDEX_PATH, 'models');

  const hasOldIndex = await pathExists(oldIndexDir);
  const hasNewModels = await pathExists(newModelsDir);
  if (!hasOldIndex || hasNewModels) {
    // Cleanup: stray model_name.txt at root after a previous migration's
    // crash recovery (pseudo-code in §4.8).
    if (hasNewModels && (await pathExists(oldModelFile))) {
      logger.info(`Removing straggler ${oldModelFile} from a previous migration`);
      await fsp.unlink(oldModelFile).catch(() => {});
    }
    return;
  }

  // Pre-RFC-012 indexes — round-1 failure F5: refuse, don't silently mis-id.
  let oldModelName: string | null = null;
  try {
    oldModelName = (await fsp.readFile(oldModelFile, 'utf-8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (oldModelName === null || oldModelName === '') {
    throw new MigrationRefusedError(
      `Cannot determine which model built ${oldIndexDir} — model_name.txt is missing. ` +
      `Set EMBEDDING_PROVIDER + the model env vars to the values used when the index was built ` +
      `and re-run, OR delete ${oldIndexDir} and let 0.3.0 re-embed under the current env.`,
    );
  }

  const provider = (process.env.EMBEDDING_PROVIDER ?? 'huggingface') as EmbeddingProvider;
  const newModelId = deriveModelId(provider, oldModelName);
  const targetDir = path.join(newModelsDir, newModelId);
  await fsp.mkdir(targetDir, { recursive: true });

  // Two atomic renames. ENOENT-tolerant: peer process may have already moved.
  await renameIfPresent(oldIndexDir, path.join(targetDir, 'faiss.index'));
  await renameIfPresent(oldModelFile, path.join(targetDir, 'model_name.txt'));

  // Single-writer for active.txt (RFC §4.7 — bootstrap is permitted writer #1).
  await writeActiveModelAtomic(newModelId);

  logger.info(`Migrated single-model layout from ${oldIndexDir} to models/${newModelId}/`);
}

async function renameIfPresent(src: string, dst: string): Promise<void> {
  try {
    await fsp.rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/**
 * RFC 013 §4.8 — process-global, idempotent layout bootstrap. Runs migration
 * from 0.2.x layout to 0.3.0 per-model subtree at MOST ONCE per Node process
 * (module-level Promise cache, round-2 failure N1).
 *
 * Cross-process coordination: every caller acquires the brief
 * `.kb-migration.lock` (proper-lockfile, short retry budget) for the
 * duration of `maybeMigrateLayout`. Pre-RFC-014 the MCP server
 * piggybacked on its single-instance PID advisory; that advisory was
 * removed once atomic save (RFC 014) made it unnecessary for data
 * integrity, so MCP and CLI start paths now use the same migration-lock
 * primitive.
 */
export async function bootstrapLayout(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    // Cross-process serializer: short-lived migration lock at
    // ${FAISS_INDEX_PATH}/.kb-migration.lock. Pre-RFC-014 the MCP server
    // would piggyback on the single-instance advisory it held for its
    // lifetime; after the advisory was removed (post-RFC-014, atomic save
    // is sufficient for data integrity), every caller acquires the
    // migration lock for the brief duration of maybeMigrateLayout.
    await fsp.mkdir(FAISS_INDEX_PATH, { recursive: true });
    let release: (() => Promise<void>) | null = null;
    try {
      release = await properLockfile.lock(FAISS_INDEX_PATH, {
        lockfilePath: MIGRATION_LOCK_PATH,
        stale: 30_000,
        retries: { retries: 5, factor: 1.5, minTimeout: 100, maxTimeout: 1000 },
      });
    } catch (err) {
      // If we can't get the migration lock, a peer is migrating; wait for
      // them and re-check the layout. Falling through is safe because
      // `maybeMigrateLayout` is idempotent: it creates `models/<id>/` via
      // `mkdir({recursive:true})` BEFORE the renames, so a loser arriving
      // mid-migration sees `pathExists(models/)` and early-returns; the
      // winner's renames complete unaffected. The renames also use
      // `renameIfPresent` which swallows ENOENT.
      logger.warn(`Could not acquire migration lock; assuming peer migration: ${(err as Error).message}`);
    }
    try {
      await maybeMigrateLayout();
    } finally {
      if (release) {
        try { await release(); } catch { /* best-effort */ }
      }
    }
  })();
  return bootstrapPromise;
}

/* @internal */
/** Test-only: reset the bootstrap cache between tests. */
export function __resetBootstrapForTests(): void {
  bootstrapPromise = null;
}
