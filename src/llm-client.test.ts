import { afterEach, describe, expect, it } from '@jest/globals';
import {
  callChatCompletion,
  deriveHealthUrl,
  normalizeChatEndpoint,
  probeLlmEndpoint,
} from './llm-client.js';

describe('llm-client', () => {
  const savedFake = process.env.KB_LLM_FAKE;
  const savedLogFormat = process.env.KB_LOG_FORMAT;

  afterEach(() => {
    if (savedFake === undefined) delete process.env.KB_LLM_FAKE;
    else process.env.KB_LLM_FAKE = savedFake;
    if (savedLogFormat === undefined) delete process.env.KB_LOG_FORMAT;
    else process.env.KB_LOG_FORMAT = savedLogFormat;
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
