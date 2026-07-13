import { afterEach, describe, expect, it } from '@jest/globals';
import {
  callChatCompletion,
  deriveHealthUrl,
  llmProviderBreakerKey,
  LlmClientError,
  normalizeChatEndpoint,
  parseRetryAfterMs,
  probeLlmEndpoint,
} from './llm-client.js';
import { llmCallMetrics } from './metrics.js';
import { providerBreakerRegistry } from './provider-breaker.js';

describe('llm-client', () => {
  const SAVED_KEYS = [
    'KB_LLM_FAKE', 'KB_LOG_FORMAT', 'KB_LLM_PROVIDER', 'KB_OPENROUTER_API_KEY',
    'OPENROUTER_API_KEY', 'KB_LLM_MODEL', 'KB_LLM_APP_TITLE', 'KB_LLM_HTTP_REFERER',
    'KB_LLM_MAX_RETRIES', 'KB_PROVIDER_BREAKER', 'KB_PROVIDER_BREAKER_FAILURE_THRESHOLD',
    'KB_PROVIDER_BREAKER_COOLDOWN_MS',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of SAVED_KEYS) saved[k] = process.env[k];

  afterEach(() => {
    for (const k of SAVED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    providerBreakerRegistry.reset();
    llmCallMetrics.reset();
  });

  it('normalizes base URLs to chat-completions endpoints', () => {
    expect(normalizeChatEndpoint('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(normalizeChatEndpoint('http://127.0.0.1:8080/v1/chat/completions')).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(deriveHealthUrl('http://127.0.0.1:8080/v1/chat/completions')).toBe('http://127.0.0.1:8080/health');
  });

  it('extracts assistant content from an OpenAI-compatible response', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      model: 'local-model',
      choices: [{ message: { content: ' answer ' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
    }, fetchMock as unknown as typeof fetch);

    expect(result.content).toBe('answer');
    expect(result.model).toBe('local-model');
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe('http://127.0.0.1:8080/v1/chat/completions');
  });

  it('records bounded operation metrics and parses prompt/completion usage', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      model: 'local-model',
      choices: [{ message: { content: 'answer' } }],
      usage: { prompt_tokens: 17, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      operation: 'gate',
      messages: [{ role: 'user', content: 'q' }],
    }, fetchMock as unknown as typeof fetch);

    expect(result.usage).toEqual({ promptTokens: 17, completionTokens: 5 });
    expect(llmCallMetrics.snapshot().gate).toMatchObject({
      count: 1,
      errors: 0,
      prompt_tokens: 17,
      completion_tokens: 5,
    });
  });

  it('records failed calls in the selected operation without swallowing the error', async () => {
    const fetchMock = jest.fn(async () => new Response(
      JSON.stringify({ error: { message: 'unavailable' } }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      operation: 'preface',
      messages: [{ role: 'user', content: 'q' }],
      retry: false,
    }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({ status: 503 });

    expect(llmCallMetrics.snapshot().preface).toMatchObject({ count: 1, errors: 1 });
  });

  it('retries a transient network failure and returns the later success', async () => {
    const delays: number[] = [];
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: 'local-model',
        choices: [{ message: { content: ' recovered ' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
      retry: {
        maxRetries: 2,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        maxTotalDelayMs: 1_000,
        random: () => 0.5,
        sleep: async (ms) => { delays.push(ms); },
      },
    }, fetchMock as unknown as typeof fetch);

    expect(result.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([50]);
    expect(llmCallMetrics.snapshot().ask).toMatchObject({ count: 1, errors: 0, attempts: 2, retries: 1 });
    expect(llmCallMetrics.snapshot().ask?.attribution).toEqual([
      expect.objectContaining({ provider: 'local', model: 'local', count: 1, attempts: 2, retries: 1 }),
    ]);
  });

  it('runs the boundary guard before every retry attempt', async () => {
    const fetchMock = jest.fn(async () => new Response(
      JSON.stringify({ error: { message: 'warming up' } }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    ));
    let guardCalls = 0;

    await expect(callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'protected prompt' }],
      beforeAttempt: () => {
        guardCalls += 1;
        if (guardCalls === 2) throw new Error('policy changed');
      },
      retry: {
        maxRetries: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        maxTotalDelayMs: 1,
        sleep: async () => {},
      },
    }, fetchMock as unknown as typeof fetch)).rejects.toThrow('policy changed');

    expect(guardCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams OpenAI-compatible SSE deltas and returns the final content', async () => {
    const tokens: string[] = [];
    const events: string[] = [];
    const fetchMock = jest.fn(async () => new Response(streamBody([
      'data: {"model":"local-model","choices":[{"delta":{"content":"hello "}}]}\n\n',
      'data: {"model":"local-model","choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: {"model":"local-model","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

    const result = await callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
      stream: {
        onFirstToken: () => { events.push('first'); },
        onToken: (token) => {
          tokens.push(token);
          events.push(token);
        },
      },
    }, fetchMock as unknown as typeof fetch);

    expect(result.content).toBe('hello world');
    expect(result.model).toBe('local-model');
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 2 });
    expect(llmCallMetrics.snapshot().ask).toMatchObject({
      count: 1,
      errors: 0,
      prompt_tokens: 11,
      completion_tokens: 2,
    });
    expect(tokens).toEqual(['hello ', 'world']);
    expect(events).toEqual(['first', 'hello ', 'world']);
    const body = JSON.parse((fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1].body as string) as {
      stream?: boolean;
    };
    expect(body.stream).toBe(true);
  });

  it('handles CRLF SSE delimiters split across network chunks', async () => {
    const tokens: string[] = [];
    const fetchMock = jest.fn(async () => new Response(streamBody([
      'data: {"model":"local-model","choices":[{"delta":{"content":"split"}}]}\r\n\r',
      '\n',
      'data: [DONE]\r\n\r\n',
    ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

    const result = await callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
      stream: {
        onToken: (token) => { tokens.push(token); },
      },
    }, fetchMock as unknown as typeof fetch);

    expect(result.content).toBe('split');
    expect(tokens).toEqual(['split']);
  });

  it('retries streaming failures before the first emitted token', async () => {
    const tokens: string[] = [];
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(streamBody([
        'data: {"choices":[{"delta":{"content":',
      ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(streamBody([
        'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n',
        'data: [DONE]\n\n',
      ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

    const result = await callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
      stream: { onToken: (token) => { tokens.push(token); } },
      retry: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        maxTotalDelayMs: 1,
        sleep: async () => {},
      },
    }, fetchMock as unknown as typeof fetch);

    expect(result.content).toBe('recovered');
    expect(tokens).toEqual(['recovered']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry streaming failures after a token has been emitted', async () => {
    const tokens: string[] = [];
    const fetchMock = jest.fn(async () => new Response(streamBody([
      'data: {"choices":[{"delta":{"content":"partial "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":',
    ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

    await expect(callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
      stream: { onToken: (token) => { tokens.push(token); } },
      retry: {
        maxRetries: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        maxTotalDelayMs: 1,
        sleep: async () => {},
      },
    }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({
      name: 'LlmClientError',
      message: expect.stringContaining('malformed streaming event'),
    });

    expect(tokens).toEqual(['partial ']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not open the provider circuit for streaming callback failures', async () => {
    const fetchMock = jest.fn(async () => new Response(streamBody([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: [DONE]\n\n',
    ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

    for (let i = 0; i < 3; i += 1) {
      await expect(callChatCompletion({
        endpoint: 'http://127.0.0.1:8080',
        messages: [{ role: 'user', content: 'q' }],
        stream: {
          onToken: () => {
            throw new Error('consumer failed');
          },
        },
        retry: false,
      }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({
        name: 'LlmClientError',
        transient: false,
        message: expect.stringContaining('stream callback failed'),
      });
    }

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
      retry: false,
    }, fetchMock as unknown as typeof fetch)).resolves.toMatchObject({ content: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry terminal auth failures', async () => {
    const delays: number[] = [];
    const fetchMock = jest.fn(async () => new Response(
      JSON.stringify({ error: { message: 'bad key' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
      retry: {
        maxRetries: 2,
        sleep: async (ms) => { delays.push(ms); },
      },
    }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({
      name: 'LlmClientError',
      status: 401,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('surfaces the final transient error after the retry budget is exhausted', async () => {
    const delays: number[] = [];
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: 'warming up' } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: 'still down' } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ));

    await expect(callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
      retry: {
        maxRetries: 1,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        maxTotalDelayMs: 1_000,
        random: () => 1,
        sleep: async (ms) => { delays.push(ms); },
      },
    }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({
      name: 'LlmClientError',
      status: 503,
      message: expect.stringContaining('still down'),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([100]);
    expect(llmCallMetrics.snapshot().ask).toMatchObject({ count: 1, errors: 1 });
  });

  it('opens the provider circuit after repeated transient failures and skips retries while open', async () => {
    process.env.KB_PROVIDER_BREAKER = 'on';
    process.env.KB_PROVIDER_BREAKER_FAILURE_THRESHOLD = '3';
    process.env.KB_PROVIDER_BREAKER_COOLDOWN_MS = '30000';
    jest.resetModules();
    const {
      callChatCompletion: freshCallChatCompletion,
      llmProviderBreakerKey: freshLlmProviderBreakerKey,
    } = await import('./llm-client.js');
    const { providerBreakerRegistry: freshProviderBreakerRegistry } = await import('./provider-breaker.js');
    const fetchMock = jest.fn(async () => new Response(
      JSON.stringify({ error: { message: 'down' } }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    ));

    for (let i = 0; i < 3; i += 1) {
      await expect(freshCallChatCompletion({
        endpoint: 'http://127.0.0.1:8080',
        messages: [{ role: 'user', content: 'q' }],
        retry: false,
      }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({
        name: 'LlmClientError',
        status: 503,
      });
    }

    await expect(freshCallChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
      retry: {
        maxRetries: 2,
        sleep: async () => {
          throw new Error('retry sleep must be skipped while circuit is open');
        },
      },
    }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({
      name: 'ProviderCircuitOpenError',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(freshProviderBreakerRegistry.snapshot()).toEqual([expect.objectContaining({
      key: freshLlmProviderBreakerKey('local', 'http://127.0.0.1:8080/v1/chat/completions', 'local-model'),
      state: 'open',
      consecutive_failures: 3,
    })]);
  });

  it('honors Retry-After for retry delay while capping total wait', async () => {
    const delays: number[] = [];
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: 'rate limited' } }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: 'local-model',
        choices: [{ message: { content: 'ok' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
      retry: {
        maxRetries: 1,
        baseDelayMs: 100,
        maxDelayMs: 100,
        maxTotalDelayMs: 2_500,
        random: () => 0,
        sleep: async (ms) => { delays.push(ms); },
      },
    }, fetchMock as unknown as typeof fetch);

    expect(result.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2_500]);
  });

  it('uses the in-process fake LLM and skips fetch when KB_LLM_FAKE is on', async () => {
    process.env.KB_LLM_FAKE = 'on';
    process.env.KB_LOG_FORMAT = 'text';
    const fetchMock = jest.fn();

    const result = await callChatCompletion({
      endpoint: 'http://127.0.0.1:9',
      messages: [
        { role: 'system', content: 'Reply with exactly: ok' },
        { role: 'user', content: 'health check' },
      ],
    }, fetchMock as unknown as typeof fetch);

    expect(result.content).toBe('ok');
    expect(result.model).toBe('kb-fake-llm');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends OpenRouter auth headers, drops chat_template_kwargs, and defaults the model when KB_LLM_PROVIDER=openrouter', async () => {
    delete process.env.KB_LLM_FAKE;
    process.env.KB_LLM_PROVIDER = 'openrouter';
    process.env.KB_OPENROUTER_API_KEY = 'sk-or-test-key';
    process.env.KB_LLM_APP_TITLE = 'knowledge-base-mcp';
    delete process.env.KB_LLM_MODEL;
    delete process.env.OPENROUTER_API_KEY;

    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      choices: [{ message: { content: 'hi' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await callChatCompletion({
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      messages: [{ role: 'user', content: 'q' }],
    }, fetchMock as unknown as typeof fetch);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const init = calls[0][1];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or-test-key');
    expect(headers['X-Title']).toBe('knowledge-base-mcp');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('deepseek/deepseek-v4-flash');
    expect(body).not.toHaveProperty('chat_template_kwargs');
  });

  it('keeps the local path auth-free with chat_template_kwargs when provider is local', async () => {
    delete process.env.KB_LLM_FAKE;
    delete process.env.KB_LLM_PROVIDER;
    delete process.env.KB_OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
    }, fetchMock as unknown as typeof fetch);

    const init = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toHaveProperty('chat_template_kwargs');
  });

  it('skips the /health GET for a remote provider during probe', async () => {
    delete process.env.KB_LLM_FAKE;
    process.env.KB_LLM_PROVIDER = 'openrouter';
    process.env.KB_OPENROUTER_API_KEY = 'sk-or-test-key';

    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/health')) throw new Error('health endpoint must not be called for remote');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await probeLlmEndpoint('https://openrouter.ai/api/v1/chat/completions', fetchMock as unknown as typeof fetch);
    expect(result.health_ok).toBe(true);
    expect(result.chat_ok).toBe(true);
    expect(result.detail).toContain('health check skipped');
    expect(llmCallMetrics.snapshot()).toEqual({});
    const urls = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map((c) => c[0]);
    expect(urls.some((u) => u.endsWith('/health'))).toBe(false);
  });

  it('parses Retry-After as delta-seconds and HTTP-date', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('garbage')).toBeUndefined();
    const now = 1_000_000;
    const httpDate = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfterMs(httpDate, now)).toBe(30_000);
  });

  it('surfaces HTTP status and Retry-After on a 429', async () => {
    delete process.env.KB_LLM_FAKE;
    delete process.env.KB_LLM_PROVIDER;
    const fetchMock = jest.fn(async () => new Response(
      JSON.stringify({ error: { message: 'rate limited' } }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' } },
    ));

    await expect(callChatCompletion({
      endpoint: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'q' }],
      retry: false,
    }, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({
      name: 'LlmClientError',
      status: 429,
      retryAfterMs: 7000,
    });
    expect(LlmClientError).toBeDefined();
  });

  it('probes health and chat completion with an explicit model', async () => {
    process.env.KB_LLM_PROVIDER = 'local';
    process.env.KB_LLM_FAKE = 'off';
    const healthTimeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    const chatTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/health')) {
        return new Response('{"status":"ok"}', { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await probeLlmEndpoint(
      'http://127.0.0.1:8080',
      fetchMock as unknown as typeof fetch,
      { model: 'gate-model', healthTimeoutMs: 456, chatTimeoutMs: 123 },
    );
    expect(healthTimeoutSpy).toHaveBeenCalledWith(456);
    expect(chatTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 123);
    healthTimeoutSpy.mockRestore();
    chatTimeoutSpy.mockRestore();
    expect(result.health_ok).toBe(true);
    expect(result.chat_ok).toBe(true);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const chatRequest = calls.find(([url]) => !url.endsWith('/health'))!;
    expect(JSON.parse(chatRequest[1].body as string)).toMatchObject({ model: 'gate-model' });
    expect(llmCallMetrics.snapshot()).toEqual({});
  });
});

function streamBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
