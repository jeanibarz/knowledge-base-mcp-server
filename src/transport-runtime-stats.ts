import type { LatencyHistogramSnapshot, ResponseStatusBucket } from './metrics-recording.js';

// Re-exported for backward compatibility: callers (e.g. `base-http-host.ts`)
// import `ResponseStatusBucket` from this module. Issue #1007 moved the
// type's definition into `metrics-recording.ts` to break a two-way
// type-only import cycle between this file and the old `metrics.ts`.
export type { ResponseStatusBucket };

export type RemoteTransportKind = 'http' | 'sse';

export interface TransportRuntimeErrorSnapshot {
  at: string;
  message: string;
}

export interface TransportRuntimeStatsSnapshot {
  transport: RemoteTransportKind;
  sessions_opened: number;
  sessions_closed: number;
  current_sessions: number;
  in_flight_requests: number;
  requests_total: number;
  response_status_buckets: Record<ResponseStatusBucket, number>;
  auth_failures: number;
  origin_denials: number;
  host_denials: number;
  last_error: TransportRuntimeErrorSnapshot | null;
  /**
   * Issue #892 — per-request latency histograms keyed by response status
   * class. Absent for hand-built fixtures and older snapshots; a serving
   * `BaseHttpHost` always populates it (empty until the first request).
   */
  request_duration_ms?: Partial<Record<ResponseStatusBucket, LatencyHistogramSnapshot>>;
}

export function emptyResponseStatusBuckets(): Record<ResponseStatusBucket, number> {
  return {
    '1xx': 0,
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
  };
}

export function responseStatusBucket(status: number): ResponseStatusBucket {
  if (status >= 100 && status < 200) return '1xx';
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  return '5xx';
}
