import { KBError } from './errors.js';

export type ProviderCircuitState = 'closed' | 'open' | 'half-open';

export interface ProviderBreakerOptions {
  enabled?: boolean;
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export interface ProviderBreakerRunOptions {
  shouldRecordFailure?: (err: unknown) => boolean;
}

export interface ProviderCircuitSnapshot {
  key: string;
  state: ProviderCircuitState;
  consecutive_failures: number;
  opened_at_ms: number | null;
  half_open_probe_in_flight: boolean;
}

interface ProviderCircuitRecord {
  state: ProviderCircuitState;
  consecutiveFailures: number;
  openedAtMs: number | null;
  halfOpenProbeInFlight: boolean;
}

interface ProviderCircuitPermit {
  key: string;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

export class ProviderCircuitOpenError extends KBError {
  readonly key: string;
  readonly retryAfterMs: number;

  constructor(key: string, retryAfterMs: number) {
    super('PROVIDER_UNAVAILABLE', `provider circuit is open for ${key}; retry after ${retryAfterMs}ms`);
    this.name = 'ProviderCircuitOpenError';
    this.key = key;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderBreakerRegistry {
  private readonly records = new Map<string, ProviderCircuitRecord>();
  private readonly enabled: boolean;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: ProviderBreakerOptions = {}) {
    this.enabled = options.enabled ?? parseProviderBreakerEnabled(process.env.KB_PROVIDER_BREAKER);
    this.failureThreshold = boundedInteger(
      options.failureThreshold,
      parseProviderBreakerFailureThreshold(process.env.KB_PROVIDER_BREAKER_FAILURE_THRESHOLD),
      1,
      100,
    );
    this.cooldownMs = boundedInteger(
      options.cooldownMs,
      parseProviderBreakerCooldownMs(process.env.KB_PROVIDER_BREAKER_COOLDOWN_MS),
      1,
      3_600_000,
    );
    this.now = options.now ?? Date.now;
  }

  async run<T>(
    key: string,
    action: () => Promise<T>,
    options: ProviderBreakerRunOptions = {},
  ): Promise<T> {
    const permit = this.beforeCall(key);
    if (permit === null) return action();

    try {
      const result = await action();
      this.recordSuccess(permit.key);
      return result;
    } catch (err) {
      if (options.shouldRecordFailure?.(err) === false) {
        this.recordSuccess(permit.key);
      } else {
        this.recordFailure(permit.key);
      }
      throw err;
    }
  }

  snapshot(): ProviderCircuitSnapshot[] {
    return Array.from(this.records.entries())
      .map(([key, record]) => ({
        key,
        state: record.state,
        consecutive_failures: record.consecutiveFailures,
        opened_at_ms: record.openedAtMs,
        half_open_probe_in_flight: record.halfOpenProbeInFlight,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  reset(): void {
    this.records.clear();
  }

  private beforeCall(key: string): ProviderCircuitPermit | null {
    if (!this.enabled) return null;
    const record = this.recordFor(key);
    if (record.state === 'closed') return { key };

    const elapsedMs = record.openedAtMs === null ? 0 : this.now() - record.openedAtMs;
    const retryAfterMs = Math.max(0, this.cooldownMs - elapsedMs);
    if (record.state === 'open' && retryAfterMs > 0) {
      throw new ProviderCircuitOpenError(key, retryAfterMs);
    }

    if (record.state === 'open') {
      record.state = 'half-open';
      record.halfOpenProbeInFlight = false;
    }

    if (record.halfOpenProbeInFlight) {
      throw new ProviderCircuitOpenError(key, 0);
    }
    record.halfOpenProbeInFlight = true;
    return { key };
  }

  private recordSuccess(key: string): void {
    if (!this.enabled) return;
    const record = this.recordFor(key);
    record.state = 'closed';
    record.consecutiveFailures = 0;
    record.openedAtMs = null;
    record.halfOpenProbeInFlight = false;
  }

  private recordFailure(key: string): void {
    if (!this.enabled) return;
    const record = this.recordFor(key);
    record.halfOpenProbeInFlight = false;
    record.consecutiveFailures += 1;
    if (record.state === 'half-open' || record.consecutiveFailures >= this.failureThreshold) {
      record.state = 'open';
      record.openedAtMs = this.now();
    }
  }

  private recordFor(key: string): ProviderCircuitRecord {
    let record = this.records.get(key);
    if (record === undefined) {
      record = {
        state: 'closed',
        consecutiveFailures: 0,
        openedAtMs: null,
        halfOpenProbeInFlight: false,
      };
      this.records.set(key, record);
    }
    return record;
  }
}

export function parseProviderBreakerEnabled(raw: string | undefined): boolean {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === '') return true;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(normalized);
}

export function parseProviderBreakerFailureThreshold(raw: string | undefined): number {
  return boundedInteger(parseInteger(raw), DEFAULT_FAILURE_THRESHOLD, 1, 100);
}

export function parseProviderBreakerCooldownMs(raw: string | undefined): number {
  return boundedInteger(parseInteger(raw), DEFAULT_COOLDOWN_MS, 1, 3_600_000);
}

function parseInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export const providerBreakerRegistry = new ProviderBreakerRegistry();
