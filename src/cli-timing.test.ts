import { describe, expect, it } from '@jest/globals';
import {
  compactTimingPayload,
  formatTimingFooter,
  recordFreshnessScanTiming,
  recordRefreshProgressTiming,
} from './cli-timing.js';

describe('compactTimingPayload', () => {
  it('drops undefined values and rounds numeric measurements', () => {
    expect(compactTimingPayload({
      total_ms: 12.6,
      fetch_k: 4,
      skipped: undefined,
      llm_first_token_ms: null,
    })).toEqual({
      total_ms: 13,
      fetch_k: 4,
      llm_first_token_ms: null,
    });
  });
});

describe('recordFreshnessScanTiming', () => {
  it('records freshness scan cost, counts, scope, and source as flat timing fields', () => {
    const timing = {};

    recordFreshnessScanTiming(timing, {
      elapsedMs: 12.6,
      scope: 'scoped',
      source: 'manifest',
      filesScanned: 7,
      globalFiles: 23,
      scopedFiles: 7,
      kbsScanned: 1,
    });

    expect(compactTimingPayload(timing)).toEqual({
      staleness_ms: 13,
      freshness_scan_ms: 13,
      freshness_scan_scope: 'scoped',
      freshness_scan_source: 'manifest',
      freshness_scan_files: 7,
      freshness_scan_global_files: 23,
      freshness_scan_scoped_files: 7,
      freshness_scan_kbs: 1,
    });
  });
});

describe('recordRefreshProgressTiming', () => {
  it('records refresh phase counters as flat timing fields', () => {
    const timing = {};
    recordRefreshProgressTiming(timing, {
      phase: 'embed',
      phaseStatus: 'progress',
      batchIndex: 3,
      batchCount: 4,
      batchSize: 8,
      processedChunks: 24,
      totalChunks: 31,
      phaseElapsedMs: 1250,
    });
    recordRefreshProgressTiming(timing, {
      phase: 'save',
      phaseStatus: 'completed',
      phaseElapsedMs: 80,
      saved: true,
    });

    expect(compactTimingPayload(timing)).toEqual({
      refresh_embed_chunks: 24,
      refresh_embed_chunks_total: 31,
      refresh_embed_batches: 3,
      refresh_embed_batches_total: 4,
      refresh_embed_batch_size: 8,
      refresh_embed_ms: 1250,
      refresh_save_ms: 80,
      refresh_saved: true,
    });
  });
});

describe('formatTimingFooter', () => {
  it('uses ms suffixes only for *_ms fields', () => {
    expect(formatTimingFooter('Timing', {
      requested_mode: 'auto',
      effective_mode: 'hybrid',
      total_ms: 42,
      fetch_k: 4,
    })).toBe('> _Timing (auto -> hybrid): total_ms=42ms, fetch_k=4._');
  });
});
