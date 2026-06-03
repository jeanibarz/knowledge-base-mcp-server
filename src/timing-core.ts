export type TimingValue = number | string | boolean | null;

export type TimingPayload = Record<string, TimingValue | undefined>;
export type RefreshTimingPhase = 'embed' | 'save' | 'sidecar' | 'manifest';
export type FreshnessScanScope = 'global' | 'scoped';
export type FreshnessScanSource = 'filesystem' | 'manifest' | 'none';

export interface FreshnessScanTimingInput {
  elapsedMs: number;
  scope: FreshnessScanScope;
  source: FreshnessScanSource;
  filesScanned: number;
  globalFiles: number;
  scopedFiles?: number;
  kbsScanned: number;
  enumerationFailures?: number;
}

export interface RefreshProgressTimingInput {
  phase?: string;
  phaseStatus?: string;
  phaseElapsedMs?: number;
  processedChunks?: number;
  totalChunks?: number;
  batchIndex?: number;
  batchCount?: number;
  batchSize?: number;
  filesScanned?: number;
  filesChanged?: number;
  filesSkipped?: number;
  chunksDiscovered?: number;
  saved?: boolean;
  sidecarsWritten?: number;
}

export function nowMs(): number {
  return Date.now();
}

export function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

export function roundedMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value);
}

export function compactTimingPayload(timing: TimingPayload): Record<string, TimingValue> {
  const out: Record<string, TimingValue> = {};
  for (const [key, value] of Object.entries(timing)) {
    if (value !== undefined) out[key] = typeof value === 'number' ? Math.round(value) : value;
  }
  return out;
}

export function formatTimingFooter(label: string, timing: TimingPayload): string {
  const entries = Object.entries(compactTimingPayload(timing))
    .filter(([key]) => key !== 'requested_mode' && key !== 'effective_mode')
    .map(([key, value]) => `${key}=${formatTimingValue(key, value)}`);
  const modeText = formatModeText(timing);
  const body = entries.length > 0 ? entries.join(', ') : 'no timing data';
  return `> _${label}${modeText}: ${body}._`;
}

export function recordFreshnessScanTiming(
  timing: TimingPayload,
  scan: FreshnessScanTimingInput,
): void {
  const elapsed = roundedMs(scan.elapsedMs);
  timing.staleness_ms = elapsed;
  timing.freshness_scan_ms = elapsed;
  timing.freshness_scan_scope = scan.scope;
  timing.freshness_scan_source = scan.source;
  timing.freshness_scan_files = scan.filesScanned;
  timing.freshness_scan_global_files = scan.globalFiles;
  if (scan.scopedFiles !== undefined) {
    timing.freshness_scan_scoped_files = scan.scopedFiles;
  }
  timing.freshness_scan_kbs = scan.kbsScanned;
  if (scan.enumerationFailures !== undefined) {
    timing.freshness_scan_enumeration_failures = scan.enumerationFailures;
  }
}

export function recordRefreshProgressTiming(
  timing: TimingPayload,
  progress: RefreshProgressTimingInput,
): void {
  if (progress.filesScanned !== undefined) timing.refresh_files_scanned = progress.filesScanned;
  if (progress.filesChanged !== undefined) timing.refresh_files_changed = progress.filesChanged;
  if (progress.filesSkipped !== undefined) timing.refresh_files_skipped = progress.filesSkipped;
  if (progress.chunksDiscovered !== undefined) {
    timing.refresh_chunks_discovered = progress.chunksDiscovered;
  }

  if (progress.phase === 'embed') {
    if (progress.processedChunks !== undefined) {
      timing.refresh_embed_chunks = progress.processedChunks;
    }
    if (progress.totalChunks !== undefined) {
      timing.refresh_embed_chunks_total = progress.totalChunks;
    }
    if (progress.batchIndex !== undefined) {
      timing.refresh_embed_batches = progress.batchIndex;
    }
    if (progress.batchCount !== undefined) {
      timing.refresh_embed_batches_total = progress.batchCount;
    }
    if (progress.batchSize !== undefined) {
      timing.refresh_embed_batch_size = progress.batchSize;
    }
    if (progress.phaseElapsedMs !== undefined) {
      timing.refresh_embed_ms = progress.phaseElapsedMs;
    }
  }

  if (
    progress.phaseStatus === 'completed' &&
    progress.phaseElapsedMs !== undefined &&
    isRefreshTimingPhase(progress.phase)
  ) {
    timing[`refresh_${progress.phase}_ms`] = progress.phaseElapsedMs;
  }

  if (progress.saved !== undefined) timing.refresh_saved = progress.saved;
  if (progress.sidecarsWritten !== undefined) {
    timing.refresh_sidecars_written = progress.sidecarsWritten;
  }
}

function isRefreshTimingPhase(phase: string | undefined): phase is RefreshTimingPhase {
  return phase === 'embed' || phase === 'save' || phase === 'sidecar' || phase === 'manifest';
}

function formatModeText(timing: TimingPayload): string {
  const requested = timing.requested_mode;
  const effective = timing.effective_mode;
  if (typeof requested !== 'string' || typeof effective !== 'string') return '';
  if (requested === effective) return ` (${effective})`;
  return ` (${requested} -> ${effective})`;
}

function formatTimingValue(key: string, value: TimingValue): string {
  if (typeof value === 'number' && key.endsWith('_ms')) return `${value}ms`;
  return String(value);
}
