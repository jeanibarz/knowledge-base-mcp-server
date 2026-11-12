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
  /** Present when the search ran on the last committed version, not the live writer index. */
  served_from?: 'committed_snapshot';
}

/**
 * Single-flight background runner keyed by model directory. A `trigger()` while
 * a run is in flight just joins it (no queued rerun); the next trigger after it
 * finishes starts a new run. Failures are logged, never thrown, so there are
 * no unhandled rejections.
 */
export class BackgroundRefreshCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();

  isRefreshing(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Starts a background run for `key` unless one is already in flight. */
  trigger(key: string, run: () => Promise<void>): void {
    if (this.inFlight.has(key)) return;
    const p = (async (): Promise<void> => {
      try {
        await run();
      } catch (err) {
        logger.warn(
          `Background retrieve refresh failed for ${key}: ${(err as Error)?.message ?? String(err)}`,
        );
      }
    })().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
  }

  /** Resolves when the in-flight run for `key` (if any) has settled. */
  async settled(key: string): Promise<void> {
    await this.inFlight.get(key);
  }

  /** Resolves when every in-flight run has settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
  }
}
