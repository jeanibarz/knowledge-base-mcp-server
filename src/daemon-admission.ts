// src/daemon-admission.ts
//
// Issue #648 — admission control for the `kb serve` daemon.
//
// The daemon (`startDaemonServer` in cli-serve.ts) amortizes index/model
// load across bursty, concurrent agent CLI calls (RFC 015 / #615). Each
// in-flight read can drive an embedding call, a FAISS scan, and a
// cross-encoder rerank; without a bound, a burst of parallel reads
// oversubscribes CPU/memory and lets the request backlog grow without
// limit.
//
// This gate caps how many requests run at once
// (KB_DAEMON_MAX_CONCURRENCY), queues a bounded backlog
// (KB_DAEMON_QUEUE_MAX), and rejects the rest so callers get a fast
// `429 Too Many Requests` + `Retry-After` instead of unbounded latency. It
// mirrors the worker-pool admission shape of `bounded-concurrency.ts`
// (mapBounded) but for inbound requests, where the work-list is open-ended
// rather than a fixed array.

export const DAEMON_MAX_CONCURRENCY_ENV = 'KB_DAEMON_MAX_CONCURRENCY';
export const DAEMON_QUEUE_MAX_ENV = 'KB_DAEMON_QUEUE_MAX';

/**
 * Default concurrent-request cap. Matches DEFAULT_FS_CONCURRENCY (8) so the
 * daemon's inbound admission and its internal fan-out share one mental
 * model; tune with KB_DAEMON_MAX_CONCURRENCY on smaller boxes.
 */
export const DEFAULT_DAEMON_MAX_CONCURRENCY = 8;

/**
 * Default bounded backlog beyond the concurrency cap. Generous enough to
 * absorb an agent firing a parallel batch of `kb search` calls while still
 * shedding load once the daemon is genuinely saturated.
 */
export const DEFAULT_DAEMON_QUEUE_MAX = 128;

/** Advisory `Retry-After` (seconds) returned with a rejection. */
export const DAEMON_RETRY_AFTER_SECONDS = 1;

export interface DaemonAdmissionConfig {
  maxConcurrency: number;
  queueMax: number;
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

export function resolveDaemonAdmissionConfig(
  env: NodeJS.ProcessEnv = process.env,
): DaemonAdmissionConfig {
  return {
    maxConcurrency: parseBoundedInt(
      env[DAEMON_MAX_CONCURRENCY_ENV],
      DEFAULT_DAEMON_MAX_CONCURRENCY,
      1,
    ),
    // queueMax of 0 is valid — it makes the daemon reject immediately once
    // the concurrency slots are full (immediate-429 mode).
    queueMax: parseBoundedInt(
      env[DAEMON_QUEUE_MAX_ENV],
      DEFAULT_DAEMON_QUEUE_MAX,
      0,
    ),
  };
}

/**
 * Bounded admission gate for inbound daemon requests.
 *
 * `running` counts the slots currently held (≤ maxConcurrency); `waiters`
 * is the bounded queue. A freed slot is handed directly to the next waiter
 * — `running` is not decremented and re-incremented across the handoff — so
 * the concurrency cap can never be transiently exceeded by an interleaving
 * `run()` call racing a queued waiter for the slot.
 */
export class DaemonAdmissionGate {
  private readonly maxConcurrency: number;
  private readonly queueMax: number;
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  private rejectedTotalCount = 0;

  constructor(config: DaemonAdmissionConfig) {
    this.maxConcurrency = Math.max(1, Math.floor(config.maxConcurrency));
    this.queueMax = Math.max(0, Math.floor(config.queueMax));
  }

  /** Admitted-but-incomplete requests (running + queued). */
  get inFlight(): number {
    return this.running + this.waiters.length;
  }

  /** Total requests rejected because both the cap and the queue were full. */
  get rejectedTotal(): number {
    return this.rejectedTotalCount;
  }

  /**
   * Run `job` under the admission bound. Returns the job's settle promise
   * when admitted (immediately or after queueing), or `null` when both the
   * concurrency slots and the queue are full — the caller should then reply
   * `429` + `Retry-After`. Rejection is decided synchronously, so the
   * counter and the returned value never disagree.
   */
  run<T>(job: () => Promise<T>): Promise<T> | null {
    if (this.running >= this.maxConcurrency && this.waiters.length >= this.queueMax) {
      this.rejectedTotalCount += 1;
      return null;
    }
    return this.execute(job);
  }

  private async execute<T>(job: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await job();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      // Hand the just-freed slot straight to the next waiter: `running`
      // stays put (one job left, one starts), so the cap holds.
      next();
      return;
    }
    this.running -= 1;
  }
}
