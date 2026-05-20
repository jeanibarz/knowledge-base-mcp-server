export interface TransportRuntimeStats {
  transport: 'http' | 'sse';
  current_sessions: number;
  sessions_opened: number;
  sessions_closed: number;
  in_flight_requests: number;
  response_status_buckets: Record<string, number>;
  auth_failures: number;
  origin_denials: number;
  last_transport_error: {
    at: string;
    message: string;
  } | null;
}
