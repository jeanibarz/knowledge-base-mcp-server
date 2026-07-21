import { afterEach, describe, expect, it } from '@jest/globals';

import {
  isOtelTracesEnabled,
  resetOtelForTesting,
  setOtelProviderForTesting,
  setOtelTracerForTesting,
  shutdownOtel,
  withSpan,
  type MinimalTracerProvider,
  type OtelSpanLike,
  type OtelTracerLike,
} from './otel-trace.js';

interface RecordedSpan {
  name: string;
  parent: string | null;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  exceptions: Error[];
  ended: boolean;
}

/**
 * In-memory tracer that records spans and approximates parent/child nesting via
 * a LIFO stack — valid for the sequential `withSpan` chains these tests drive.
 */
function makeFakeTracer(): { tracer: OtelTracerLike; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const stack: RecordedSpan[] = [];
  const tracer: OtelTracerLike = {
    startActiveSpan<T>(name: string, fn: (span: OtelSpanLike) => T): T {
      const span: RecordedSpan = {
        name,
        parent: stack.length > 0 ? stack[stack.length - 1].name : null,
        attributes: {},
        exceptions: [],
        ended: false,
      };
      spans.push(span);
      stack.push(span);
      const handle: OtelSpanLike = {
        setAttribute(key, value) {
          span.attributes[key] = value;
        },
        setStatus(status) {
          span.status = status;
        },
        recordException(exception) {
          span.exceptions.push(exception);
        },
        end() {
          span.ended = true;
          const index = stack.lastIndexOf(span);
          if (index >= 0) stack.splice(index, 1);
        },
      };
      return fn(handle);
    },
  };
  return { tracer, spans };
}

describe('isOtelTracesEnabled', () => {
  it.each(['on', 'true', '1', 'yes', 'ON', ' Yes '])('is true for %p', (raw) => {
    expect(isOtelTracesEnabled({ KB_OTEL_TRACES: raw } as NodeJS.ProcessEnv)).toBe(true);
  });

  it.each([undefined, '', 'off', 'false', '0', 'no', 'maybe'])('is false for %p', (raw) => {
    expect(isOtelTracesEnabled({ KB_OTEL_TRACES: raw } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('withSpan', () => {
  afterEach(() => {
    resetOtelForTesting();
  });

  describe('disabled / no-op path', () => {
    it('invokes fn and returns its value without any tracer', async () => {
      setOtelTracerForTesting(null);
      let ran = false;
      const result = await withSpan('kb.ask', { 'kb.k': 8 }, async (span) => {
        ran = true;
        // No-op span handle must accept late attributes without throwing.
        span.setAttribute('kb.result_count', 3);
        return 'value';
      });
      expect(ran).toBe(true);
      expect(result).toBe('value');
    });

    it('propagates thrown errors unchanged', async () => {
      setOtelTracerForTesting(null);
      await expect(
        withSpan('kb.ask', {}, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });
  });

  describe('enabled path', () => {
    it('opens a span, applies attributes, drops null/undefined, marks OK', async () => {
      const { tracer, spans } = makeFakeTracer();
      setOtelTracerForTesting(tracer);

      const result = await withSpan('kb.ask', {
        'kb.k': 8,
        'kb.scope': 'ops',
        'kb.flag': false,
        'kb.missing': null,
        'kb.absent': undefined,
      }, async () => 'ok');

      expect(result).toBe('ok');
      expect(spans).toHaveLength(1);
      const [span] = spans;
      expect(span.name).toBe('kb.ask');
      expect(span.attributes).toEqual({ 'kb.k': 8, 'kb.scope': 'ops', 'kb.flag': false });
      expect(span.status).toEqual({ code: 1 });
      expect(span.ended).toBe(true);
    });

    it('nests child spans under the active parent', async () => {
      const { tracer, spans } = makeFakeTracer();
      setOtelTracerForTesting(tracer);

      await withSpan('kb.ask', {}, async () => {
        await withSpan('kb.ask.retrieve', {}, async () => {
          await withSpan('kb.ask.dense', {}, async () => undefined);
        });
        await withSpan('kb.ask.llm', {}, async () => undefined);
      });

      const byName = new Map(spans.map((s) => [s.name, s]));
      expect(byName.get('kb.ask')?.parent).toBeNull();
      expect(byName.get('kb.ask.retrieve')?.parent).toBe('kb.ask');
      expect(byName.get('kb.ask.dense')?.parent).toBe('kb.ask.retrieve');
      expect(byName.get('kb.ask.llm')?.parent).toBe('kb.ask');
      expect(spans.every((s) => s.ended)).toBe(true);
    });

    it('records the exception, marks ERROR, ends the span, and rethrows', async () => {
      const { tracer, spans } = makeFakeTracer();
      setOtelTracerForTesting(tracer);

      await expect(
        withSpan('kb.ask.llm', {}, async () => {
          throw new Error('llm down');
        }),
      ).rejects.toThrow('llm down');

      expect(spans).toHaveLength(1);
      const [span] = spans;
      expect(span.status?.code).toBe(2);
      expect(span.status?.message).toBe('llm down');
      expect(span.exceptions).toHaveLength(1);
      expect(span.exceptions[0].message).toBe('llm down');
      expect(span.ended).toBe(true);
    });

    it('only records the attributes passed in — never arbitrary payloads', async () => {
      const { tracer, spans } = makeFakeTracer();
      setOtelTracerForTesting(tracer);

      const secretQuery = 'super secret user question';
      await withSpan('kb.ask', { 'kb.k': 8 }, async (span) => {
        span.setAttribute('kb.result_count', 2);
        return undefined;
      });
      // The query text is never handed to withSpan, so it can never appear.
      const allValues = spans.flatMap((s) => Object.values(s.attributes).map(String));
      expect(allValues).not.toContain(secretQuery);
      expect(spans[0].attributes).toEqual({ 'kb.k': 8, 'kb.result_count': 2 });
    });
  });
});

/**
 * Fake provider that records forceFlush / shutdown order for issue #879.
 */
function makeFakeProvider(opts?: {
  /** forceFlush hangs forever (no timer — no open-handle risk). */
  hangFlush?: boolean;
  flushError?: Error;
  shutdownError?: Error;
}): {
  provider: MinimalTracerProvider;
  calls: string[];
} {
  const calls: string[] = [];
  const provider: MinimalTracerProvider = {
    register() { /* unused */ },
    getTracer() {
      throw new Error('getTracer not used in shutdown tests');
    },
    async forceFlush() {
      calls.push('forceFlush:start');
      if (opts?.hangFlush) {
        // Never settles — exercises the timeout bound without leaving a timer.
        await new Promise<void>(() => { /* hang */ });
      }
      if (opts?.flushError) throw opts.flushError;
      calls.push('forceFlush:done');
    },
    async shutdown() {
      calls.push('shutdown:start');
      if (opts?.shutdownError) throw opts.shutdownError;
      calls.push('shutdown:done');
    },
  };
  return { provider, calls };
}

describe('shutdownOtel (issue #879)', () => {
  afterEach(() => {
    resetOtelForTesting();
  });

  it('is a no-op when no provider was installed', async () => {
    await expect(shutdownOtel()).resolves.toBeUndefined();
  });

  it('awaits forceFlush then shutdown on the teardown path', async () => {
    const { provider, calls } = makeFakeProvider();
    setOtelProviderForTesting(provider);

    await shutdownOtel(1000);

    expect(calls).toEqual([
      'forceFlush:start',
      'forceFlush:done',
      'shutdown:start',
      'shutdown:done',
    ]);
  });

  it('does not hang when forceFlush never resolves (timeout-bounded)', async () => {
    const { provider, calls } = makeFakeProvider({ hangFlush: true });
    setOtelProviderForTesting(provider);

    const started = Date.now();
    // Leave residual budget after the 50ms flush timeout so shutdown still runs.
    await shutdownOtel(80);
    const elapsed = Date.now() - started;

    // Must return near the bound; allow some CI slack.
    expect(elapsed).toBeLessThan(500);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(calls[0]).toBe('forceFlush:start');
    // forceFlush did not complete before the deadline.
    expect(calls).not.toContain('forceFlush:done');
    // Teardown continues to shutdown with remaining budget.
    expect(calls).toContain('shutdown:start');
    expect(calls).toContain('shutdown:done');
  });

  it('swallows forceFlush errors and still attempts shutdown', async () => {
    const { provider, calls } = makeFakeProvider({
      flushError: new Error('collector unreachable'),
    });
    setOtelProviderForTesting(provider);

    await expect(shutdownOtel(1000)).resolves.toBeUndefined();
    expect(calls).toEqual([
      'forceFlush:start',
      'shutdown:start',
      'shutdown:done',
    ]);
  });

  it('is idempotent after a successful flush', async () => {
    const { provider, calls } = makeFakeProvider();
    setOtelProviderForTesting(provider);

    await shutdownOtel(1000);
    await shutdownOtel(1000);

    // Second call must not re-invoke the provider.
    expect(calls.filter((c) => c === 'forceFlush:start')).toHaveLength(1);
    expect(calls.filter((c) => c === 'shutdown:start')).toHaveLength(1);
  });
});
