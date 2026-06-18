import { describe, expect, it } from '@jest/globals';

import {
  parseProviderBreakerCooldownMs,
  parseProviderBreakerEnabled,
  parseProviderBreakerFailureThreshold,
  ProviderBreakerRegistry,
  ProviderCircuitOpenError,
} from './provider-breaker.js';

describe('ProviderBreakerRegistry', () => {
  it('opens after the configured consecutive failure threshold and fast-fails', async () => {
    let now = 1_000;
    const breaker = new ProviderBreakerRegistry({
      failureThreshold: 2,
      cooldownMs: 500,
      now: () => now,
    });
    const key = 'embedding:ollama:http://localhost:11434:nomic';

    await expect(breaker.run(key, async () => {
      throw new Error('down once');
    })).rejects.toThrow('down once');
    await expect(breaker.run(key, async () => {
      throw new Error('down twice');
    })).rejects.toThrow('down twice');

    await expect(breaker.run(key, async () => 'must not run')).rejects.toMatchObject({
      name: 'ProviderCircuitOpenError',
      code: 'PROVIDER_UNAVAILABLE',
      key,
      retryAfterMs: 500,
    });
    expect(breaker.snapshot()).toEqual([expect.objectContaining({
      key,
      state: 'open',
      consecutive_failures: 2,
      opened_at_ms: 1_000,
    })]);

    now += 499;
    await expect(breaker.run(key, async () => 'still blocked')).rejects.toBeInstanceOf(ProviderCircuitOpenError);
  });

  it('allows one half-open probe after cooldown and closes on success', async () => {
    let now = 1_000;
    const breaker = new ProviderBreakerRegistry({
      failureThreshold: 1,
      cooldownMs: 500,
      now: () => now,
    });
    const key = 'llm:local:http://127.0.0.1:8080/v1/chat/completions:qwen';

    await expect(breaker.run(key, async () => {
      throw new Error('unavailable');
    })).rejects.toThrow('unavailable');
    now += 500;

    await expect(breaker.run(key, async () => 'ok')).resolves.toBe('ok');
    expect(breaker.snapshot()).toEqual([expect.objectContaining({
      key,
      state: 'closed',
      consecutive_failures: 0,
      opened_at_ms: null,
    })]);
  });

  it('rejects a second concurrent half-open probe', async () => {
    let now = 1_000;
    const breaker = new ProviderBreakerRegistry({
      failureThreshold: 1,
      cooldownMs: 500,
      now: () => now,
    });
    const key = 'llm:local:http://127.0.0.1:8080/v1/chat/completions:qwen';

    await expect(breaker.run(key, async () => {
      throw new Error('unavailable');
    })).rejects.toThrow('unavailable');
    now += 500;

    let resolveProbe: (value: string) => void = () => {};
    const firstProbe = breaker.run(key, () => new Promise<string>((resolve) => {
      resolveProbe = resolve;
    }));

    await expect(breaker.run(key, async () => 'second probe')).rejects.toMatchObject({
      name: 'ProviderCircuitOpenError',
    });
    resolveProbe('ok');
    await expect(firstProbe).resolves.toBe('ok');
  });

  it('reopens when the half-open probe fails', async () => {
    let now = 1_000;
    const breaker = new ProviderBreakerRegistry({
      failureThreshold: 1,
      cooldownMs: 500,
      now: () => now,
    });
    const key = 'embedding:openai:https://api.openai.com/v1/embeddings:text-embedding-3-small';

    await expect(breaker.run(key, async () => {
      throw new Error('down');
    })).rejects.toThrow('down');
    now += 500;
    await expect(breaker.run(key, async () => {
      throw new Error('probe failed');
    })).rejects.toThrow('probe failed');

    expect(breaker.snapshot()).toEqual([expect.objectContaining({
      key,
      state: 'open',
      consecutive_failures: 2,
      opened_at_ms: 1_500,
    })]);
  });

  it('does not trip on failures the caller classifies as terminal', async () => {
    const breaker = new ProviderBreakerRegistry({
      failureThreshold: 1,
      cooldownMs: 500,
    });
    const key = 'llm:local:http://127.0.0.1:8080/v1/chat/completions:qwen';

    await expect(breaker.run(key, async () => {
      throw new Error('bad request');
    }, { shouldRecordFailure: () => false })).rejects.toThrow('bad request');

    await expect(breaker.run(key, async () => 'still allowed')).resolves.toBe('still allowed');
    expect(breaker.snapshot()).toEqual([expect.objectContaining({
      key,
      state: 'closed',
      consecutive_failures: 0,
    })]);
  });

  it('bypasses all state tracking when disabled', async () => {
    const breaker = new ProviderBreakerRegistry({
      enabled: false,
      failureThreshold: 1,
      cooldownMs: 500,
    });
    const key = 'llm:local:http://127.0.0.1:8080/v1/chat/completions:qwen';
    let calls = 0;

    for (let i = 0; i < 2; i += 1) {
      await expect(breaker.run(key, async () => {
        calls += 1;
        throw new Error('still called');
      })).rejects.toThrow('still called');
    }

    expect(calls).toBe(2);
    expect(breaker.snapshot()).toEqual([]);
  });
});

describe('provider breaker env parsing', () => {
  it('defaults on and accepts common off spellings', () => {
    expect(parseProviderBreakerEnabled(undefined)).toBe(true);
    expect(parseProviderBreakerEnabled('on')).toBe(true);
    expect(parseProviderBreakerEnabled('disabled')).toBe(false);
    expect(parseProviderBreakerEnabled('0')).toBe(false);
  });

  it('bounds numeric tuning values', () => {
    expect(parseProviderBreakerFailureThreshold(undefined)).toBe(3);
    expect(parseProviderBreakerFailureThreshold('2')).toBe(2);
    expect(parseProviderBreakerFailureThreshold('0')).toBe(1);
    expect(parseProviderBreakerCooldownMs(undefined)).toBe(30_000);
    expect(parseProviderBreakerCooldownMs('250')).toBe(250);
    expect(parseProviderBreakerCooldownMs('999999999')).toBe(3_600_000);
  });
});
