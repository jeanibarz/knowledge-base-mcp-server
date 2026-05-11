export const DEFAULT_FS_CONCURRENCY = 8;
export const FS_CONCURRENCY_ENV = 'KB_FS_CONCURRENCY';

export interface BoundedConcurrencyFailure<T> {
  index: number;
  item: T;
  error: unknown;
}

export class BoundedConcurrencyError<T> extends AggregateError {
  readonly failures: Array<BoundedConcurrencyFailure<T>>;

  constructor(failures: Array<BoundedConcurrencyFailure<T>>) {
    super(
      failures.map((failure) => failure.error),
      `mapBounded failed for ${failures.length} item(s)`,
    );
    this.name = 'BoundedConcurrencyError';
    this.failures = failures;
  }
}

export function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError('concurrency must be a finite number');
  }
  return Math.max(1, Math.floor(value));
}

export function resolveFsConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FS_CONCURRENCY_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_FS_CONCURRENCY;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_FS_CONCURRENCY;
  }
  return Math.floor(parsed);
}

export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const workerCount = Math.min(normalizeConcurrency(concurrency), items.length);
  const results = new Array<R>(items.length);
  const failures: Array<BoundedConcurrencyFailure<T>> = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await mapper(items[index], index);
      } catch (error: unknown) {
        failures.push({ index, item: items[index], error });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failures.length > 0) {
    failures.sort((a, b) => a.index - b.index);
    throw new BoundedConcurrencyError(failures);
  }

  return results;
}
