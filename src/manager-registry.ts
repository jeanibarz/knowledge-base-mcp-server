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

import { parseModelId, readStoredModelName } from './active-model.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import type { EmbeddingProvider } from './model-id.js';

export class ManagerRegistry {
  private readonly cache: Map<string, FaissIndexManager> = new Map();
  private readonly initCache: Map<string, Promise<FaissIndexManager>> = new Map();

  /**
   * Resolve `modelId` to a `FaissIndexManager`, constructing on first
   * use. Throws if `model_name.txt` is missing for the (otherwise
   * registered) id — that means the model directory is half-built and
   * the caller should not pretend to have a usable manager.
   */
  async getOrCreate(modelId: string): Promise<FaissIndexManager> {
    const cached = this.cache.get(modelId);
    if (cached) return cached;
    const initializing = this.initCache.get(modelId);
    if (initializing) return initializing;
    const initPromise = (async () => {
      const { provider } = parseModelId(modelId);
      const modelName = await readStoredModelName(modelId);
      if (modelName === null) {
        throw new Error(`model_name.txt missing for registered model "${modelId}"`);
      }
      const manager = new FaissIndexManager({
        provider: provider as EmbeddingProvider,
        modelName,
      });
      await manager.initialize();
      this.cache.set(modelId, manager);
      return manager;
    })();
    this.initCache.set(modelId, initPromise);
    try {
      return await initPromise;
    } finally {
      this.initCache.delete(modelId);
    }
  }
}
