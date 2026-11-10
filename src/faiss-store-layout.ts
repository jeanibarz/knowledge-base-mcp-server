import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import * as path from 'path';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { FaissStore } from '@langchain/community/vectorstores/faiss';
import {
  dedupeDocstoreOnSave,
  gcDocstoreCas,
  type DedupOutcome,
} from './docstore-cas.js';
import { calculateSHA256, pathExists } from './file-utils.js';
import {
  backendForIndexType,
  HNSW_CAPACITY_POLICY,
  HNSW_METRIC,
  resolveFaissIndexType,
  type FaissIndexType,
  type HnswIndexConfig,
  type IndexBackend,
  type SearchIndexType,
} from './config/indexing.js';
import {
  HNSW_DOCSTORE_FILENAME,
  HNSW_INDEX_FILENAME,
  HnswIndexAdapter,
} from './hnsw-index-adapter.js';
import { KBError } from './errors.js';
import { logger } from './logger.js';

export const INDEX_VERSION_RETENTION_ENV = 'KB_INDEX_VERSION_RETENTION';
export const DEFAULT_PREVIOUS_INDEX_VERSION_RETENTION = 2;
const VERSION_DIR_PATTERN = /^index\.v(\d+)$/;
const SYMLINK_NAME = 'index';
const LEGACY_INDEX_NAME = 'faiss.index';
export const FAISS_INDEX_FILENAME = LEGACY_INDEX_NAME;
export const INDEX_INTEGRITY_MANIFEST_FILENAME = 'integrity.json';
export const INDEX_INTEGRITY_MANIFEST_SCHEMA_VERSION = 'kb.index-integrity.v1';
export const EMBEDDING_CANARY_TEXT =
  'kb embedding canary v1: stable fingerprint for detecting silent embedding model drift.';
export const EMBEDDING_CANARY_TEXT_SHA256 = crypto
  .createHash('sha256')
  .update(EMBEDDING_CANARY_TEXT, 'utf-8')
  .digest('hex');
export const EMBEDDING_CANARY_ID = `sha256:${EMBEDDING_CANARY_TEXT_SHA256}`;
export const EMBEDDING_CANARY_COSINE_WARN_THRESHOLD = 0.999;

export interface EmbeddingCanaryFingerprint {
  canary_id: typeof EMBEDDING_CANARY_ID;
  text_sha256: typeof EMBEDDING_CANARY_TEXT_SHA256;
  embedding_role: 'document';
  captured_at: string;
  dimensions: number;
  vector: number[];
}

export interface IndexIntegrityManifest {
  schema_version: typeof INDEX_INTEGRITY_MANIFEST_SCHEMA_VERSION;
  written_at: string;
  model_id: string;
  backend?: IndexBackend;
  index_type: SearchIndexType;
  hnsw?: {
    m: number;
    efConstruction: number;
    efSearch: number;
    metric: typeof HNSW_METRIC;
    capacity_policy: typeof HNSW_CAPACITY_POLICY;
    random_seed: number;
    dimensions: number;
    max_elements: number;
  };
  embedding_canary?: EmbeddingCanaryFingerprint;
  files: Record<string, { sha256: string }>;
}

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
  const n = Number.parseInt(match[1], 10);
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

/**
 * Issue #1179 — appended to every "this version cannot be loaded here" log.
 *
 * The loaders used to delete the `index` symlink in these cases so the next
 * update would rebuild. The symlink is shared by every process using the
 * model directory, so one process with a different index type, HNSW tuning,
 * or a transient load failure made a valid index look "not built" to all
 * of them. Loaders now leave the pointer alone: a writer that rebuilds
 * writes a new `index.vN+1/` and swaps the pointer atomically, which keeps
 * the old version as a rollback.
 */
const POINTER_KEPT_NOTE =
  'leaving the active index pointer in place; a rebuild by this process saves a new version.';

/** Pure: derive the next versioned directory name from the current target. */
export function nextVersionAfter(currentTarget: string | null): string {
  if (!currentTarget) return 'index.v0';
  const n = parseIndexVersionDirName(currentTarget);
  if (n === null) throw new Error(`atomicSave: unrecognized symlink target "${currentTarget}"`);
  return `index.v${n + 1}`;
}

/**
 * Issue #1179 — name of the next version directory to stage a save into.
 *
 * One higher than both the current pointer target and every `index.vN/`
 * already on disk. Deriving it from the pointer alone restarted at
 * `index.v0` whenever the pointer was missing, and the save then deleted
 * that existing, valid version as an "orphan staging dir".
 */
export async function resolveNextIndexVersion(
  modelDir: string,
  currentTarget: string | null,
): Promise<string> {
  const fromPointer = parseIndexVersionDirName(nextVersionAfter(currentTarget)) ?? 0;
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(modelDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let next = fromPointer;
  for (const entry of entries) {
    const n = parseIndexVersionDirName(entry);
    if (n !== null && n + 1 > next) next = n + 1;
  }
  return `index.v${next}`;
}

export interface IndexVersionEntry {
  name: string;
  n: number;
  /** Epoch ms of integrity.json `written_at`, falling back to the directory mtime. */
  createdMs: number;
  /** True when the directory holds an integrity.json (i.e. a completed save). */
  hasManifest: boolean;
}

/**
 * Issue #1181 — every `index.vN/` directory under a model dir, newest first.
 *
 * Ordered by creation time (the later of integrity manifest `written_at` and
 * directory mtime) and only then by version number. A directory whose numbering
 * restarted before #1179 holds `index.v8` newer than `index.v38`; ordering by
 * N alone would call the stale one "newest".
 */
export async function listIndexVersionsNewestFirst(modelDir: string): Promise<IndexVersionEntry[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(modelDir);
  } catch {
    return [];
  }
  const out: IndexVersionEntry[] = [];
  for (const name of entries) {
    const n = parseIndexVersionDirName(name);
    if (n === null) continue;
    const dir = path.join(modelDir, name);
    let createdMs = 0;
    let hasManifest = false;
    try {
      const manifest = await readIndexIntegrityManifest(dir);
      if (manifest) {
        hasManifest = true;
        const written = Date.parse(manifest.written_at);
        if (Number.isFinite(written)) createdMs = written;
      }
    } catch {
      // unreadable manifest: fall through to mtime
    }
    // `kb restore` copies integrity.json verbatim, so written_at can predate
    // the restore; the directory mtime reflects when it was created here.
    try {
      createdMs = Math.max(createdMs, (await fsp.stat(dir)).mtimeMs);
    } catch {
      // keep what we have
    }
    out.push({ name, n, createdMs, hasManifest });
  }
  return out.sort((a, b) => b.createdMs - a.createdMs || b.n - a.n);
}

/**
 * Issue #1181 — true when `index.vN/` holds an `integrity.json` whose every
 * listed file exists and matches its recorded sha256.
 */
export async function verifyIndexVersionIntegrity(versionDir: string): Promise<boolean> {
  let manifest: IndexIntegrityManifest | null;
  try {
    manifest = await readIndexIntegrityManifest(versionDir);
  } catch {
    return false;
  }
  if (manifest === null || manifest.files === undefined) return false;
  const names = Object.keys(manifest.files);
  if (names.length === 0) return false;
  for (const file of names) {
    // Manifest file names are bare (faiss.index, docstore.json, ...).
    if (file !== path.basename(file)) return false;
    try {
      const actual = await calculateSHA256(path.join(versionDir, file));
      if (actual !== manifest.files[file]?.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface RepairIndexPointerResult {
  status: 'repaired' | 'pointer_present' | 'no_versions' | 'no_verified_version';
  target: string | null;
  candidates: string[];
}

/**
 * Issue #1181 — re-point a missing `index` symlink at the newest version
 * whose integrity manifest verifies. Never touches an existing pointer or any
 * version directory. Callers must hold the model's write lock.
 */
export async function repairIndexPointer(modelDir: string): Promise<RepairIndexPointerResult> {
  const symlinkPath = path.join(modelDir, SYMLINK_NAME);
  const existing = await fsp.lstat(symlinkPath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  });
  const versions = await listIndexVersionsNewestFirst(modelDir);
  const candidates = versions.map((v) => v.name);
  if (existing !== null) return { status: 'pointer_present', target: null, candidates };
  if (versions.length === 0) return { status: 'no_versions', target: null, candidates };
  for (const v of versions) {
    if (!(await verifyIndexVersionIntegrity(path.join(modelDir, v.name)))) continue;
    const tmp = path.join(modelDir, `.${SYMLINK_NAME}.repair-${process.pid}`);
    await fsp.rm(tmp, { force: true });
    await fsp.symlink(v.name, tmp);
    await fsp.rename(tmp, symlinkPath);
    logger.warn(`Re-pointed missing ${SYMLINK_NAME} at ${v.name} in ${modelDir}`);
    return { status: 'repaired', target: v.name, candidates };
  }
  return { status: 'no_verified_version', target: null, candidates };
}

/**
 * Issue #1181 — the `index` pointer is gone while versioned directories
 * remain: a built index that would otherwise read as "not built".
 */
export async function assertPointerNotMissing(modelDir: string): Promise<void> {
  const existing = await fsp.lstat(path.join(modelDir, SYMLINK_NAME)).catch(() => null);
  if (existing !== null) return;
  // Only completed saves count: a crashed first save leaves a manifest-less
  // index.v0/ with nothing worth protecting, and a rebuild is the right answer.
  const versions = (await listIndexVersionsNewestFirst(modelDir)).filter((v) => v.hasManifest);
  if (versions.length === 0) return;
  throw new KBError(
    'INDEX_POINTER_MISSING',
    `The ${SYMLINK_NAME} pointer is missing in ${modelDir} but ${versions.length} index version(s) ` +
      `exist on disk (newest: ${versions[0].name}). Run \`kb verify --integrity --repair\` to re-point it ` +
      `(manual: \`ln -sfn ${versions[0].name} ${path.join(modelDir, SYMLINK_NAME)}\`), or \`kb reindex\` to rebuild.`,
  );
}

function configMismatch(message: string, allowRebuild: boolean): null {
  if (!allowRebuild) {
    throw new KBError(
      'INDEX_CONFIG_MISMATCH',
      `${message}; refusing to rebuild over it. Restore the original configuration or run \`kb reindex\` to rebuild with the current one.`,
    );
  }
  logger.warn(`${message}; ${POINTER_KEPT_NOTE}`);
  return null;
}

export async function pruneInactiveIndexVersions(
  modelDirPath: string,
  opts: { retention?: number } = {},
): Promise<IndexVersionPruneResult> {
  const rawRetention = opts.retention ?? resolveIndexVersionRetention();
  const retention = Number.isSafeInteger(rawRetention) && rawRetention > 0 ? rawRetention : 0;
  try {
    await fsp.readdir(modelDirPath);
  } catch {
    return { active: null, retention, kept: [], removed: [], skipped: 'model directory unreadable' };
  }

  // Issue #1181: newest by creation time, not version number — a directory
  // whose numbering restarted holds a newer index.v8 than its stale index.v38.
  const versions = await listIndexVersionsNewestFirst(modelDirPath);
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
  return { active, retention, kept: [...kept].sort((a, b) => a.localeCompare(b)), removed, skipped: null };
}

type FsOperationErrorHandler = (action: string, targetPath: string, error: unknown) => never;

function manifestBackend(manifest: IndexIntegrityManifest | null): IndexBackend {
  return manifest?.backend ?? 'faiss';
}

function mismatchMessage(
  versionDir: string,
  expectedBackend: IndexBackend,
  actualBackend: IndexBackend,
): string {
  return `Versioned index ${versionDir} was written for backend ${actualBackend}, ` +
    `but the current configuration expects ${expectedBackend}`;
}

async function readManifestForLoad(versionDir: string): Promise<IndexIntegrityManifest | null> {
  try {
    return await readIndexIntegrityManifest(versionDir);
  } catch (err) {
    throw new Error(
      `Versioned index ${versionDir} has a malformed integrity manifest: ${(err as Error).message}`,
    );
  }
}

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
  expectedIndexType?: FaissIndexType;
  repairCorrupt?: boolean;
  /**
   * Issue #1181 — a writer may rebuild over a version it cannot use only when
   * explicitly allowed (`kb reindex`). Otherwise a configuration mismatch
   * throws INDEX_CONFIG_MISMATCH and an unreadable version throws
   * CORRUPT_INDEX, so the caller never silently re-embeds the corpus.
   */
  allowRebuild?: boolean;
}): Promise<FaissStore | null> {
  const {
    modelDir,
    modelId,
    embeddings,
    handleFsOperationError,
    expectedIndexType = resolveFaissIndexType(),
    repairCorrupt = true,
    allowRebuild = false,
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

    const manifest = await readManifestForLoad(resolved);
    const actualBackend = manifestBackend(manifest);
    if (actualBackend !== 'faiss') {
      const message = mismatchMessage(resolved, 'faiss', actualBackend);
      return configMismatch(message, allowRebuild);
    }
    if (
      manifest !== null &&
      manifest.index_type !== undefined &&
      manifest.index_type !== expectedIndexType
    ) {
      const message = `Versioned FAISS index ${resolved} was written as ` +
        `${manifest.index_type}, but the current configuration expects ${expectedIndexType}`;
      return configMismatch(message, allowRebuild);
    }

    let store: FaissStore;
    try {
      logger.info(
        `Loading FAISS index for model ${modelId} from ${path.basename(resolved)}`,
      );
      store = await FaissStore.load(resolved, embeddings);
    } catch (err) {
      if (!repairCorrupt) {
        throw new KBError(
          'CORRUPT_INDEX',
          `Versioned FAISS index ${resolved} is corrupt or unreadable; ` +
            `read-only load will not repair it. Underlying error: ${(err as Error).message}`,
          err,
        );
      }
      if (!allowRebuild) {
        throw new KBError(
          'CORRUPT_INDEX',
          `Versioned FAISS index ${resolved} is corrupt or unreadable; refusing to ` +
            `rebuild over it (the pointer and hash sidecars are left intact). Run ` +
            `\`kb verify --integrity --repair\` or \`kb reindex\`. Underlying error: ${(err as Error).message}`,
          err,
        );
      }
      logger.warn(
        `Versioned FAISS index ${resolved} is corrupt or unreadable - ` +
          `${POINTER_KEPT_NOTE} Error:`,
        err,
      );
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

  if (repairCorrupt && !allowRebuild) await assertPointerNotMissing(modelDir);

  if (await pathExists(legacyPath)) {
    if (backendForIndexType(expectedIndexType) !== 'faiss') {
      if (!repairCorrupt) {
        throw new Error(
          `Legacy FAISS index at ${legacyPath} cannot satisfy backend hnsw; ` +
            `read-only load will not rebuild it.`,
        );
      }
      logger.warn(
        `Legacy FAISS index at ${legacyPath} ignored because current backend is hnsw. ` +
          `The next updateIndex will rebuild into the versioned HNSW layout.`,
      );
      return null;
    }
    try {
      logger.info(
        `Loading legacy FAISS index for model ${modelId} from faiss.index/. ` +
          `First save will create versioned layout (${SYMLINK_NAME} -> index.v0).`,
      );
      return await FaissStore.load(legacyPath, embeddings);
    } catch (err) {
      if (!repairCorrupt) {
        throw new KBError(
          'CORRUPT_INDEX',
          `Legacy FAISS index at ${legacyPath} is corrupt or unreadable; ` +
            `read-only load will not repair it. Underlying error: ${(err as Error).message}`,
          err,
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

export async function loadHnswIndexAtomic(options: {
  modelDir: string;
  modelId: string;
  config: HnswIndexConfig;
  handleFsOperationError: FsOperationErrorHandler;
  repairCorrupt?: boolean;
  /** See `loadFaissStoreAtomic`. */
  allowRebuild?: boolean;
}): Promise<HnswIndexAdapter | null> {
  const {
    modelDir,
    modelId,
    config,
    repairCorrupt = true,
    allowRebuild = false,
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

    const manifest = await readManifestForLoad(resolved);
    const actualBackend = manifestBackend(manifest);
    if (actualBackend !== 'hnsw') {
      const message = mismatchMessage(resolved, 'hnsw', actualBackend);
      return configMismatch(message, allowRebuild);
    }
    if (manifest?.index_type !== 'hnsw' || manifest.hnsw === undefined) {
      const message = `Versioned HNSW index ${resolved} is missing HNSW manifest metadata`;
      return configMismatch(message, allowRebuild);
    }
    if (
      manifest.hnsw.m !== config.m ||
      manifest.hnsw.efConstruction !== config.efConstruction ||
      manifest.hnsw.metric !== config.metric ||
      manifest.hnsw.random_seed !== config.randomSeed
    ) {
      const message = `Versioned HNSW index ${resolved} was built with ` +
        `m=${manifest.hnsw.m}, efConstruction=${manifest.hnsw.efConstruction}, ` +
        `metric=${manifest.hnsw.metric}, randomSeed=${manifest.hnsw.random_seed}; ` +
        `current configuration expects m=${config.m}, ` +
        `efConstruction=${config.efConstruction}, metric=${config.metric}, ` +
        `randomSeed=${config.randomSeed}`;
      return configMismatch(message, allowRebuild);
    }

    try {
      logger.info(
        `Loading HNSW index for model ${modelId} from ${path.basename(resolved)} ` +
          `(m=${config.m}, efConstruction=${config.efConstruction}, efSearch=${config.efSearch})`,
      );
      return await HnswIndexAdapter.load(resolved, config, manifest.hnsw.dimensions);
    } catch (err) {
      if (!repairCorrupt) {
        throw new KBError(
          'CORRUPT_INDEX',
          `Versioned HNSW index ${resolved} is corrupt or unreadable; ` +
            `read-only load will not repair it. Underlying error: ${(err as Error).message}`,
          err,
        );
      }
      if (!allowRebuild) {
        throw new KBError(
          'CORRUPT_INDEX',
          `Versioned HNSW index ${resolved} is corrupt or unreadable; refusing to ` +
            `rebuild over it (the pointer and hash sidecars are left intact). Run ` +
            `\`kb verify --integrity --repair\` or \`kb reindex\`. Underlying error: ${(err as Error).message}`,
          err,
        );
      }
      logger.warn(
        `Versioned HNSW index ${resolved} is corrupt or unreadable - ` +
          `${POINTER_KEPT_NOTE} Error:`,
        err,
      );
      return null;
    }
  }

  if (repairCorrupt && !allowRebuild) await assertPointerNotMissing(modelDir);

  if (await pathExists(legacyPath)) {
    if (!repairCorrupt) {
      throw new Error(
        `Legacy FAISS index at ${legacyPath} cannot satisfy backend hnsw; ` +
          `read-only load will not rebuild it.`,
      );
    }
    logger.warn(
      `Legacy FAISS index at ${legacyPath} ignored because current backend is hnsw. ` +
        `The next updateIndex will rebuild into the versioned HNSW layout.`,
    );
  } else {
    logger.info(
      `HNSW index not found for model ${modelId}. It will be created on the next updateIndex.`,
    );
  }
  return null;
}

export async function saveFaissStoreAtomic(options: {
  store: FaissStore;
  modelDir: string;
  modelId: string;
  swapCounter: number;
  indexType?: FaissIndexType;
  embeddingCanary?: EmbeddingCanaryFingerprint | null;
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
    indexType = resolveFaissIndexType(),
    embeddingCanary = null,
    casRoot = null,
    onCommitted,
  } = options;
  const symlinkPath = path.join(modelDir, SYMLINK_NAME);
  const currentTarget = await readSymlinkOrNull(symlinkPath);
  const nextVersion = await resolveNextIndexVersion(modelDir, currentTarget);
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
  await writeIndexIntegrityManifest(stagingDir, modelId, indexType, {
    backend: 'faiss',
    embeddingCanary,
  });

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

export async function saveHnswIndexAtomic(options: {
  adapter: HnswIndexAdapter;
  modelDir: string;
  modelId: string;
  swapCounter: number;
  config: HnswIndexConfig;
  embeddingCanary?: EmbeddingCanaryFingerprint | null;
  onCommitted?: () => Promise<void>;
}): Promise<void> {
  const {
    adapter,
    modelDir,
    modelId,
    swapCounter,
    config,
    embeddingCanary = null,
    onCommitted,
  } = options;
  const symlinkPath = path.join(modelDir, SYMLINK_NAME);
  const currentTarget = await readSymlinkOrNull(symlinkPath);
  const nextVersion = await resolveNextIndexVersion(modelDir, currentTarget);
  const stagingDir = path.join(modelDir, nextVersion);

  if (await pathExists(stagingDir)) {
    logger.warn(`atomicSave: clearing orphan staging dir ${stagingDir} from prior crash`);
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }
  await adapter.save(stagingDir);
  await writeIndexIntegrityManifest(stagingDir, modelId, 'hnsw', {
    backend: 'hnsw',
    hnsw: {
      ...config,
      dimensions: adapter.vectorDimension(),
      maxElements: adapter.totalVectors(),
    },
    embeddingCanary,
  });

  const tmpLink = path.join(
    modelDir,
    `.${SYMLINK_NAME}.tmp.${process.pid}.${swapCounter}`,
  );
  await fsp.symlink(nextVersion, tmpLink);
  await fsp.rename(tmpLink, symlinkPath);
  await onCommitted?.();
  logger.info(
    `atomicSave: ${modelId} ${currentTarget ?? '(none)'} -> ${nextVersion} ` +
      `(hnsw m=${config.m}, efConstruction=${config.efConstruction}, efSearch=${config.efSearch})`,
  );

  await pruneInactiveIndexVersions(modelDir, {
    retention: resolveIndexVersionRetention(),
  });
}

export async function writeIndexIntegrityManifest(
  versionDir: string,
  modelId: string,
  indexType: SearchIndexType = resolveFaissIndexType(),
  opts: {
    backend?: IndexBackend;
    hnsw?: HnswIndexConfig & {
      dimensions: number;
      maxElements: number;
    };
    embeddingCanary?: EmbeddingCanaryFingerprint | null;
  } = {},
): Promise<IndexIntegrityManifest> {
  const backend = opts.backend ?? backendForIndexType(indexType);
  let files: Record<string, { sha256: string }>;
  if (backend === 'hnsw') {
    files = {
        [HNSW_INDEX_FILENAME]: {
          sha256: await calculateSHA256(path.join(versionDir, HNSW_INDEX_FILENAME)),
        },
        [HNSW_DOCSTORE_FILENAME]: {
          sha256: await calculateSHA256(path.join(versionDir, HNSW_DOCSTORE_FILENAME)),
        },
      };
  } else {
    files = {
        [FAISS_INDEX_FILENAME]: {
          sha256: await calculateSHA256(path.join(versionDir, FAISS_INDEX_FILENAME)),
        },
        'docstore.json': {
          sha256: await calculateSHA256(path.join(versionDir, 'docstore.json')),
        },
      };
  }
  const manifest: IndexIntegrityManifest = {
    schema_version: INDEX_INTEGRITY_MANIFEST_SCHEMA_VERSION,
    written_at: new Date().toISOString(),
    model_id: modelId,
    backend,
    index_type: indexType,
    ...(opts.hnsw ? {
      hnsw: {
        m: opts.hnsw.m,
        efConstruction: opts.hnsw.efConstruction,
        efSearch: opts.hnsw.efSearch,
        metric: opts.hnsw.metric,
        capacity_policy: opts.hnsw.capacityPolicy,
        random_seed: opts.hnsw.randomSeed,
        dimensions: opts.hnsw.dimensions,
        max_elements: opts.hnsw.maxElements,
      },
    } : {}),
    ...(opts.embeddingCanary ? { embedding_canary: opts.embeddingCanary } : {}),
    files,
  };
  await fsp.writeFile(
    path.join(versionDir, INDEX_INTEGRITY_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf-8', mode: 0o600 },
  );
  return manifest;
}

export async function createEmbeddingCanaryFingerprint(
  embeddings: Pick<EmbeddingsInterface, 'embedDocuments'>,
  capturedAt: Date = new Date(),
): Promise<EmbeddingCanaryFingerprint> {
  const vectors = await embeddings.embedDocuments([EMBEDDING_CANARY_TEXT]);
  const vector = vectors[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Embedding canary provider returned no vector');
  }
  if (!vector.every((value) => Number.isFinite(value))) {
    throw new Error('Embedding canary provider returned a non-finite vector value');
  }
  return {
    canary_id: EMBEDDING_CANARY_ID,
    text_sha256: EMBEDDING_CANARY_TEXT_SHA256,
    embedding_role: 'document',
    captured_at: capturedAt.toISOString(),
    dimensions: vector.length,
    vector,
  };
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return null;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return null;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export async function readIndexIntegrityManifest(
  versionDir: string,
): Promise<IndexIntegrityManifest | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(
      path.join(versionDir, INDEX_INTEGRITY_MANIFEST_FILENAME),
      'utf-8',
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as IndexIntegrityManifest;
  return parsed;
}

export async function resolveActiveIndexFilePath(
  modelDir: string,
  backend: IndexBackend = 'faiss',
): Promise<string | null> {
  const symlinkPath = path.join(modelDir, SYMLINK_NAME);
  const indexFilename = backend === 'hnsw' ? HNSW_INDEX_FILENAME : FAISS_INDEX_FILENAME;
  try {
    const symStat = await fsp.lstat(symlinkPath);
    if (symStat.isSymbolicLink()) {
      const resolved = await fsp.realpath(symlinkPath);
      const candidate = path.join(resolved, indexFilename);
      if (await pathExists(candidate)) return candidate;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (backend === 'hnsw') return null;
  const legacyFile = path.join(modelDir, LEGACY_INDEX_NAME, LEGACY_INDEX_NAME);
  if (await pathExists(legacyFile)) return legacyFile;
  return null;
}
