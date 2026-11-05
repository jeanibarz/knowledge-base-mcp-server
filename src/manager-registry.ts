// manager-registry.ts — RFC 013 M1 per-model FaissIndexManager cache.
//
// Issue #157 step 3 — extracted out of `KnowledgeBaseServer` so the cache
// is its own object: swappable in tests, reusable from a future CLI that
// wants the same warm-cache semantics, and free of accidental reach-ins
// from elsewhere on the server class.
//
// Concurrency: a per-`modelId` init-promise coalesces simultaneous
// `getOrCreate` calls so two readers cannot race-construct two managers
// for the same model. The init-promise lives in a separate map from the
// resolved cache so a hard failure on first init doesn't poison
// subsequent retries (the entry is removed in the `finally`).
//
// Bounding (issue #1128): each resolved manager pins a full in-memory
// FAISS/HNSW index, an embeddings client, and per-manager caches — the
// warmest object in a `kb serve` process. Left unbounded, every distinct
// model ever made active (promotion/rollback, benchmarking, A/B) stayed
// resident forever. The cache is now an LRU with a generous cap, mirroring
// the sibling `LexicalIndexCache`: on insert past the cap the
// least-recently-used manager is evicted and its resources released. The
// `getOrCreate` return value is a live JS reference the caller holds for
// the duration of its operation, so eviction only unlinks the cold manager
// from the registry — an in-flight request keeps its manager alive, never
// losing it mid-use.

import { parseModelId } from './model-id.js';
import { readStoredIndexType, readStoredModelName } from './model-storage-layout.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import { logger } from './logger.js';
import type { EmbeddingProvider } from './model-id.js';

/**
 * Generous default so the common 1–2 model case — and a modest round of
 * benchmarking or A/B switching — is entirely unaffected. The cap exists
 * only to stop unbounded RSS growth over a long-lived daemon that cycles
 * through many distinct models.
 */
const DEFAULT_MAX_MANAGERS = 8;

/** A manager may optionally expose a `dispose` hook to release resources. */
type DisposableManager = FaissIndexManager & {
  dispose?: () => void | Promise<void>;
};

export interface ManagerRegistryOptions {
  /**
   * Maximum number of distinct-model managers kept warm at once. Values
   * below 1 are clamped to 1 — the cache always holds at least the manager
   * it was just asked for. Defaults to {@link DEFAULT_MAX_MANAGERS}.
   */
  maxEntries?: number;
  /**
   * Factory for a manager given a `modelId`. Injectable so tests can supply
   * lightweight fakes instead of constructing real FAISS-backed managers.
   * Defaults to the production path (read stored layout, construct, init).
   */
  createManager?: (modelId: string) => Promise<FaissIndexManager>;
}

export class ManagerRegistry {
  private readonly cache: Map<string, FaissIndexManager> = new Map();
  private readonly initCache: Map<string, Promise<FaissIndexManager>> = new Map();
  private readonly maxEntries: number;
  private readonly createManager: (modelId: string) => Promise<FaissIndexManager>;

  constructor(options: ManagerRegistryOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_MANAGERS);
    this.createManager = options.createManager ?? defaultCreateManager;
  }

  /**
   * Resolve `modelId` to a `FaissIndexManager`, constructing on first
   * use. Throws if `model_name.txt` is missing for the (otherwise
   * registered) id — that means the model directory is half-built and
   * the caller should not pretend to have a usable manager.
   *
   * A cache hit marks the manager most-recently-used so a steadily-queried
   * model is never the eviction victim.
   */
  async getOrCreate(modelId: string): Promise<FaissIndexManager> {
    const cached = this.cache.get(modelId);
    if (cached) {
      // Refresh recency: re-insert so this id becomes the newest entry.
      this.cache.delete(modelId);
      this.cache.set(modelId, cached);
      return cached;
    }
    const initializing = this.initCache.get(modelId);
    if (initializing) return initializing;
    const initPromise = (async () => {
      const manager = await this.createManager(modelId);
      this.cache.set(modelId, manager);
      this.evictColdManagers();
      return manager;
    })();
    this.initCache.set(modelId, initPromise);
    try {
      return await initPromise;
    } finally {
      this.initCache.delete(modelId);
    }
  }

  /**
   * Evict least-recently-used managers until the cache is within its cap,
   * called right after inserting the manager just produced. Because
   * `maxEntries` is clamped to at least 1, the loop runs only when the cache
   * holds two or more entries, so the oldest key is never the newest entry
   * just inserted — a steadily-produced model is never evicted on its own
   * insert. Each evicted manager is unlinked from the registry (making it
   * eligible for GC once no in-flight caller still references it) and, if it
   * exposes a `dispose` hook, asked to release its resources best-effort.
   */
  private evictColdManagers(): void {
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const evicted = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      if (evicted) void disposeManager(oldestKey, evicted);
    }
  }
}

async function defaultCreateManager(modelId: string): Promise<FaissIndexManager> {
  const { provider } = parseModelId(modelId);
  const modelName = await readStoredModelName(modelId);
  if (modelName === null) {
    throw new Error(`model_name.txt missing for registered model "${modelId}"`);
  }
  const manager = new FaissIndexManager({
    provider: provider as EmbeddingProvider,
    modelName,
    indexType: await readStoredIndexType(modelId),
  });
  await manager.initialize();
  return manager;
}

/**
 * Release an evicted manager's resources best-effort. A manager is not
 * required to expose `dispose`; when it does not, unlinking it from the
 * registry is the whole release (GC reclaims the resident index once no
 * caller holds it). Disposal failures are logged, never thrown — eviction
 * must not break the insert that triggered it.
 */
async function disposeManager(modelId: string, manager: DisposableManager): Promise<void> {
  if (typeof manager.dispose !== 'function') return;
  try {
    await manager.dispose();
  } catch (error) {
    logger.warn(`ManagerRegistry: dispose failed for evicted model "${modelId}": ${String(error)}`);
  }
}
