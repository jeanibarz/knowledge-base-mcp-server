import { afterEach, describe, expect, it } from '@jest/globals';
import {
  callChatCompletion,
  deriveHealthUrl,
  LlmClientError,
  normalizeChatEndpoint,
  parseRetryAfterMs,
  probeLlmEndpoint,
} from './llm-client.js';

describe('llm-client', () => {
  const SAVED_KEYS = [
    'KB_LLM_FAKE', 'KB_LOG_FORMAT', 'KB_LLM_PROVIDER', 'KB_OPENROUTER_API_KEY',
    'OPENROUTER_API_KEY', 'KB_LLM_MODEL', 'KB_LLM_APP_TITLE', 'KB_LLM_HTTP_REFERER',
    'KB_LLM_MAX_RETRIES',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of SAVED_KEYS) saved[k] = process.env[k];

  afterEach(() => {
    for (const k of SAVED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
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

  it('probes health and chat completion', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/health')) {
        return new Response('{"status":"ok"}', { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await probeLlmEndpoint('http://127.0.0.1:8080', fetchMock as unknown as typeof fetch);
    expect(result.health_ok).toBe(true);
    expect(result.chat_ok).toBe(true);
  });
});
