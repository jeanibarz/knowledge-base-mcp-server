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

export type RefreshOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * Single-flight background runner keyed by model directory. A `trigger()` while
 * a run is in flight just joins it (no queued rerun); the next trigger after it
 * finishes starts a new run. Failures are logged and recorded in the run's
 * outcome (see `settled`), never thrown, so there are no unhandled rejections.
 */
export class BackgroundRefreshCoordinator {
  private readonly inFlight = new Map<string, Promise<RefreshOutcome>>();
  private readonly lastOutcome = new Map<string, RefreshOutcome>();

  isRefreshing(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Starts a background run for `key` unless one is already in flight. */
  trigger(key: string, run: () => Promise<void>): void {
    if (this.inFlight.has(key)) return;
    const p = (async (): Promise<RefreshOutcome> => {
      try {
        await run();
        return { ok: true };
      } catch (err) {
        logger.warn(
          `Background retrieve refresh failed for ${key}: ${(err as Error)?.message ?? String(err)}`,
        );
        return { ok: false, error: err };
      }
    })().then((outcome) => {
      this.lastOutcome.set(key, outcome);
      this.inFlight.delete(key);
      return outcome;
    });
    this.inFlight.set(key, p);
  }

  /**
   * Resolves with the outcome of the in-flight run for `key`, or, if it already
   * finished, of the most recent run. `{ ok: true }` when none ever ran.
   */
  async settled(key: string): Promise<RefreshOutcome> {
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    return this.lastOutcome.get(key) ?? { ok: true };
  }

  /** Resolves when every in-flight run has settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
  }
}
