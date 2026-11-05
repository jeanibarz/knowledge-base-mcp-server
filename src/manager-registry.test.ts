import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ManagerRegistry } from './manager-registry.js';
import { logger } from './logger.js';
import type { FaissIndexManager } from './FaissIndexManager.js';

/** Flush pending microtasks/macrotasks so fire-and-forget disposal settles. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * Minimal manager stand-in. `getOrCreate` only ever hands the value back to
 * the caller and (now) tracks it for LRU eviction, so a tagged object with an
 * optional `dispose` spy is enough to exercise the registry without building a
 * real FAISS-backed manager.
 */
interface FakeManager {
  readonly modelId: string;
  readonly dispose: ReturnType<typeof jest.fn>;
}

function makeFakeManager(modelId: string): FakeManager {
  return { modelId, dispose: jest.fn() };
}

/**
 * Build a registry whose factory returns a fresh fake per modelId and records
 * every constructed manager, so a test can assert which were evicted/disposed.
 */
function registryWith(maxEntries?: number): {
  registry: ManagerRegistry;
  created: Map<string, FakeManager>;
  createCount: () => number;
} {
  const created = new Map<string, FakeManager>();
  let createCount = 0;
  const registry = new ManagerRegistry({
    maxEntries,
    createManager: async (modelId: string) => {
      createCount += 1;
      const manager = makeFakeManager(modelId);
      created.set(modelId, manager);
      return manager as unknown as FaissIndexManager;
    },
  });
  return { registry, created, createCount: () => createCount };
}

describe('ManagerRegistry', () => {
  it('constructs once per model and reuses the warm manager', async () => {
    const { registry, createCount } = registryWith(4);

    const first = await registry.getOrCreate('openai/text-embedding-3-small');
    const second = await registry.getOrCreate('openai/text-embedding-3-small');

    expect(second).toBe(first);
    expect(createCount()).toBe(1);
  });

  it('coalesces concurrent getOrCreate calls for the same model', async () => {
    const { registry, createCount } = registryWith(4);

    const [a, b] = await Promise.all([
      registry.getOrCreate('m'),
      registry.getOrCreate('m'),
    ]);

    expect(a).toBe(b);
    expect(createCount()).toBe(1);
  });

  it('keeps every manager and disposes none when distinct models stay within the cap', async () => {
    const { registry, created } = registryWith(3);

    const m1 = await registry.getOrCreate('model-1');
    const m2 = await registry.getOrCreate('model-2');
    const m3 = await registry.getOrCreate('model-3');

    // All three remain warm (no reconstruction on re-fetch) and untouched.
    expect(await registry.getOrCreate('model-1')).toBe(m1);
    expect(await registry.getOrCreate('model-2')).toBe(m2);
    expect(await registry.getOrCreate('model-3')).toBe(m3);
    for (const manager of created.values()) {
      expect(manager.dispose).not.toHaveBeenCalled();
    }
  });

  it('evicts and disposes the least-recently-used manager past the cap', async () => {
    const { registry, created, createCount } = registryWith(2);

    await registry.getOrCreate('model-1'); // LRU
    await registry.getOrCreate('model-2');
    await registry.getOrCreate('model-3'); // inserts past cap -> evicts model-1

    // The coldest manager's resources were released exactly once.
    expect(created.get('model-1')!.dispose).toHaveBeenCalledTimes(1);
    expect(created.get('model-2')!.dispose).not.toHaveBeenCalled();
    expect(created.get('model-3')!.dispose).not.toHaveBeenCalled();

    // Re-fetching the evicted model reconstructs it (a 4th construction).
    await registry.getOrCreate('model-1');
    expect(createCount()).toBe(4);
  });

  it('treats a cache hit as a use, protecting the touched manager from eviction', async () => {
    const { registry, created, createCount } = registryWith(2);

    await registry.getOrCreate('model-1');
    await registry.getOrCreate('model-2');
    // Touch model-1 so model-2 becomes the least-recently-used.
    await registry.getOrCreate('model-1');
    await registry.getOrCreate('model-3'); // evicts model-2, not model-1

    expect(created.get('model-2')!.dispose).toHaveBeenCalledTimes(1);
    expect(created.get('model-1')!.dispose).not.toHaveBeenCalled();

    // model-1 is still warm (no reconstruction); model-2 is gone.
    const createdSoFar = createCount();
    await registry.getOrCreate('model-1');
    expect(createCount()).toBe(createdSoFar); // served from cache
  });

  it('clamps a non-positive cap to one and still evicts the older manager', async () => {
    const { registry, created } = registryWith(0);

    await registry.getOrCreate('model-1');
    await registry.getOrCreate('model-2'); // cap of 1 -> evicts model-1

    expect(created.get('model-1')!.dispose).toHaveBeenCalledTimes(1);
    expect(created.get('model-2')!.dispose).not.toHaveBeenCalled();
  });

  it('evicts and tolerates managers that do not expose a dispose hook', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    let createCount = 0;
    const registry = new ManagerRegistry({
      maxEntries: 1,
      createManager: async (modelId: string) => {
        createCount += 1;
        // No `dispose` method at all.
        return { modelId } as unknown as FaissIndexManager;
      },
    });

    await registry.getOrCreate('model-1');
    // Evicting a non-disposable manager must not throw...
    await expect(registry.getOrCreate('model-2')).resolves.toBeDefined();
    await flush();
    // ...and the eviction really happened: model-1 must be reconstructed.
    await registry.getOrCreate('model-1');
    expect(createCount).toBe(3);
    // A missing dispose hook is not an error — nothing is logged.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('swallows and logs a dispose failure without breaking the triggering insert', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const failing = {
      modelId: 'model-1',
      dispose: jest.fn(() => Promise.reject(new Error('boom'))),
    };
    const registry = new ManagerRegistry({
      maxEntries: 1,
      createManager: async (modelId: string) =>
        (modelId === 'model-1'
          ? failing
          : { modelId }) as unknown as FaissIndexManager,
    });

    await registry.getOrCreate('model-1');
    // The insert that evicts the rejecting manager still resolves normally.
    const second = await registry.getOrCreate('model-2');
    expect(second).toBeDefined();
    await flush();

    expect(failing.dispose).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('model-1');
  });
});
