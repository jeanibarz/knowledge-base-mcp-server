// Issue #1228 — keeps the index refresh off the `retrieve_knowledge` request
// path. In `sync` mode (default) retrieval refreshes inline as before. In
// `async` mode the refresh runs in the background through this coordinator;
// in `off` mode it never runs on read. The trigger watcher, mutation tools,
// and `kb reindex` remain the index writers in every mode.
import { logger } from './logger.js';

export type { RetrieveRefreshMode } from './config/retrieval.js';

/** Staleness signal surfaced in `structuredContent.index_status`. */
export type RetrieveIndexState = 'fresh' | 'refreshing' | 'stale_unchecked';

export interface RetrieveIndexStatus {
  refresh_mode: 'async' | 'off';
  state: RetrieveIndexState;
}

/**
 * Single-flight background runner keyed by model directory. While a run is in
 * flight, further `trigger()` calls do not start another one; they set one
 * coalesced pending flag, and exactly one rerun follows the in-flight run
 * (same shape as `ReindexTriggerWatcher`: N triggers produce at most 2 runs).
 * Failures are logged, never thrown, so there are no unhandled rejections.
 */
export class BackgroundRefreshCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();

  isRefreshing(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Starts a background run for `key` unless one is already in flight. */
  trigger(key: string, run: () => Promise<void>): void {
    if (this.inFlight.has(key)) {
      this.pending.add(key);
      return;
    }
    const loop = async (): Promise<void> => {
      do {
        this.pending.delete(key);
        try {
          await run();
        } catch (err) {
          logger.warn(
            `Background retrieve refresh failed for ${key}: ${(err as Error)?.message ?? String(err)}`,
          );
        }
      } while (this.pending.has(key));
    };
    const p = loop().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
  }

  /** Resolves when every in-flight run (and its coalesced rerun) has settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
  }
}
