// search-latency-metrics.ts — issue #1007 split of metrics.ts.
//
// Process-lifetime search request latency registry for daemon-scrapeable
// search paths. This is the one slice of the old `metrics.ts` grab-bag that
// has a real, unavoidable dependency on `search-core.ts` (via
// `DenseDegradationReason`), so it stays its own module rather than folding
// into `metrics-recording.ts`: `metrics-recording.ts` must stay free of any
// `search-core.ts` dependency, direct or transitive, or the
// `metrics.ts > search-core.ts > active-model.ts > ... > canonical-log.ts >
// metrics.ts` cycle this split was meant to close would simply reappear
// through this module instead.
//
// Labels are intentionally bounded to mode/status/stage: no query text, KB
// name, path, request id, or error message is recorded.

import type { SearchLatencyStage } from './timing-core.js';
import type { DenseDegradationReason } from './search-core.js';
import {
  emptyHistogramState,
  recordHistogramSample,
  snapshotHistogram,
  type HistogramState,
  type LatencyHistogramSnapshot,
} from './metrics-recording.js';

export type SearchLatencyMode = 'dense' | 'lexical' | 'hybrid' | 'auto' | 'unknown';
export type SearchLatencyStatus = 'success' | 'error';

export interface SearchLatencyRecord {
  mode: SearchLatencyMode;
  status: SearchLatencyStatus;
  totalMs: number;
  stageDurationsMs?: Partial<Record<SearchLatencyStage, number>>;
}

export interface SearchLatencyMetricsSnapshot {
  requests: Partial<Record<SearchLatencyMode, Partial<Record<SearchLatencyStatus, LatencyHistogramSnapshot>>>>;
  stages: Partial<Record<
    SearchLatencyMode,
    Partial<Record<SearchLatencyStage, Partial<Record<SearchLatencyStatus, LatencyHistogramSnapshot>>>>
  >>;
  degraded: Partial<Record<SearchLatencyMode, Partial<Record<DenseDegradationReason, number>>>>;
}

export class SearchLatencyMetrics {
  private readonly requestStates = new Map<string, HistogramState>();
  private readonly stageStates = new Map<string, HistogramState>();
  private readonly degradedCounts = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  record(sample: SearchLatencyRecord): void {
    const requestState = this.getRequestState(sample.mode, sample.status);
    recordHistogramSample(requestState, sample.totalMs);

    for (const [stage, value] of Object.entries(sample.stageDurationsMs ?? {}) as Array<[SearchLatencyStage, number]>) {
      if (typeof value !== 'number') continue;
      const stageState = this.getStageState(sample.mode, stage, sample.status);
      recordHistogramSample(stageState, value);
    }
  }

  recordDegraded(mode: SearchLatencyMode, reason: DenseDegradationReason): void {
    const key = `${mode}|${reason}`;
    this.degradedCounts.set(key, (this.degradedCounts.get(key) ?? 0) + 1);
  }

  snapshot(): SearchLatencyMetricsSnapshot {
    const requests: SearchLatencyMetricsSnapshot['requests'] = {};
    for (const [key, state] of this.requestStates.entries()) {
      const [mode, status] = key.split('|') as [SearchLatencyMode, SearchLatencyStatus];
      requests[mode] ??= {};
      requests[mode]![status] = snapshotHistogram(state);
    }

    const stages: SearchLatencyMetricsSnapshot['stages'] = {};
    for (const [key, state] of this.stageStates.entries()) {
      const [mode, stage, status] = key.split('|') as [SearchLatencyMode, SearchLatencyStage, SearchLatencyStatus];
      stages[mode] ??= {};
      stages[mode]![stage] ??= {};
      stages[mode]![stage]![status] = snapshotHistogram(state);
    }

    const degraded: SearchLatencyMetricsSnapshot['degraded'] = {};
    for (const [key, count] of this.degradedCounts.entries()) {
      const [mode, reason] = key.split('|') as [SearchLatencyMode, DenseDegradationReason];
      degraded[mode] ??= {};
      degraded[mode]![reason] = count;
    }

    return { requests, stages, degraded };
  }

  reset(): void {
    this.requestStates.clear();
    this.stageStates.clear();
    this.degradedCounts.clear();
  }

  private getRequestState(mode: SearchLatencyMode, status: SearchLatencyStatus): HistogramState {
    const key = `${mode}|${status}`;
    let state = this.requestStates.get(key);
    if (state === undefined) {
      state = emptyHistogramState(this.now());
      this.requestStates.set(key, state);
    }
    return state;
  }

  private getStageState(
    mode: SearchLatencyMode,
    stage: SearchLatencyStage,
    status: SearchLatencyStatus,
  ): HistogramState {
    const key = `${mode}|${stage}|${status}`;
    let state = this.stageStates.get(key);
    if (state === undefined) {
      state = emptyHistogramState(this.now());
      this.stageStates.set(key, state);
    }
    return state;
  }
}

/**
 * Process-wide singleton. Tests that need isolation should construct a
 * fresh `SearchLatencyMetrics` or call `reset()`.
 */
export const searchLatencyMetrics = new SearchLatencyMetrics();
