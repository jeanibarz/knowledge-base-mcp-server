export type RemoteTransportKind = 'http' | 'sse';

export type ResponseStatusBucket = '1xx' | '2xx' | '3xx' | '4xx' | '5xx';

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
