import { describe, it, expect, jest } from '@jest/globals';
import {
  OllamaFetchEmbeddings,
  OpenAIFetchEmbeddings,
  type FetchEmbeddingsOptions,
} from './embedding-http-client.js';
import { KBError } from './errors.js';

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: { input: string[]; [k: string]: unknown };
  signal: AbortSignal | null | undefined;
}

type Step = Response | Error | ((req: Recorded) => Response | Promise<Response>);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

/** Fake fetch: replays `steps` in order (the last repeats), records every call. */
function makeFetch(steps: Step[]) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const rec: Recorded = {
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? 'null')),
      signal: init?.signal,
    };
    const idx = calls.length;
    calls.push(rec);
    const step = steps[Math.min(idx, steps.length - 1)];
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(rec);
    return step.clone();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

interface Provider {
  name: string;
  make: (o: FetchEmbeddingsOptions) => {
    embedDocuments(t: string[]): Promise<number[][]>;
    embedQuery(t: string): Promise<number[]>;
  };
  baseUrl: string;
  path: string;
  /** Success body for the given vectors, in order. */
  ok: (vectors: number[][]) => Response;
}

const providers: Provider[] = [
  {
    name: 'Ollama',
    make: (o) => new OllamaFetchEmbeddings(o),
    baseUrl: 'http://127.0.0.1:11434',
    path: '/api/embed',
    ok: (v) => jsonResponse({ embeddings: v }),
  },
  {
    name: 'OpenAI',
    make: (o) => new OpenAIFetchEmbeddings(o),
    baseUrl: 'https://api.example.test/v1',
    path: '/embeddings',
    ok: (v) => jsonResponse({ data: v.map((embedding, index) => ({ index, embedding })) }),
  },
];

/** Vector derived from the request count so each input gets a distinct vector. */
function echoOk(p: Provider) {
  return (rec: Recorded) => p.ok(rec.body.input.map((t) => [t.length, t.charCodeAt(0)]));
}

describe.each(providers)('$name fetch embeddings (shared behaviour)', (p) => {
  const opts = (fetchImpl: typeof fetch, extra: Partial<FetchEmbeddingsOptions> = {}): FetchEmbeddingsOptions => ({
    baseUrl: p.baseUrl,
    model: 'm-1',
    fetchImpl,
    maxRetries: 2,
    ...extra,
  });

  it('POSTs to the exact endpoint URL with the model and input array', async () => {
    const { fetchImpl, calls } = makeFetch([p.ok([[1, 2]])]);
    await p.make(opts(fetchImpl)).embedDocuments(['hello']);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${p.baseUrl}${p.path}`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body.model).toBe('m-1');
    expect(calls[0].body.input).toEqual(['hello']);
  });

  it('tolerates trailing slashes on baseUrl', async () => {
    const { fetchImpl, calls } = makeFetch([p.ok([[1]])]);
    await p.make(opts(fetchImpl, { baseUrl: `${p.baseUrl}///` })).embedDocuments(['x']);
    expect(calls[0].url).toBe(`${p.baseUrl}${p.path}`);
  });

  it('sends text byte-for-byte unchanged, including newlines and surrounding whitespace', async () => {
    const texts = ['line one\nline two\n\nline four', '  padded \t', 'trailing newline\n'];
    const { fetchImpl, calls } = makeFetch([p.ok([[1], [2], [3]])]);
    await p.make(opts(fetchImpl)).embedDocuments(texts);
    expect(calls[0].body.input).toEqual(texts);
  });

  it('embedDocuments([]) returns [] and sends no request', async () => {
    const { fetchImpl, calls } = makeFetch([p.ok([])]);
    await expect(p.make(opts(fetchImpl)).embedDocuments([])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('splits into sequential batches of at most batchSize and preserves input order', async () => {
    const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];
    const { fetchImpl, calls } = makeFetch([echoOk(p)]);
    const out = await p.make(opts(fetchImpl, { batchSize: 2 })).embedDocuments(texts);
    expect(calls.map((c) => c.body.input)).toEqual([['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
    expect(out).toEqual(texts.map((t) => [t.length, t.charCodeAt(0)]));
  });

  it('does not split when the input count is within batchSize', async () => {
    const { fetchImpl, calls } = makeFetch([echoOk(p)]);
    await p.make(opts(fetchImpl, { batchSize: 5 })).embedDocuments(['a', 'b', 'c', 'd', 'e']);
    expect(calls).toHaveLength(1);
  });

  it('embedQuery sends one request with input [t] and returns that single vector', async () => {
    const { fetchImpl, calls } = makeFetch([p.ok([[0.5, 0.25, 0.125]])]);
    const v = await p.make(opts(fetchImpl)).embedQuery('what is x?\nreally');
    expect(calls).toHaveLength(1);
    expect(calls[0].body.input).toEqual(['what is x?\nreally']);
    expect(v).toEqual([0.5, 0.25, 0.125]);
  });

  it('throws when the response has fewer vectors than inputs, without retrying', async () => {
    const { fetchImpl, calls } = makeFetch([p.ok([[1]])]);
    await expect(p.make(opts(fetchImpl)).embedDocuments(['a', 'b'])).rejects.toBeInstanceOf(KBError);
    expect(calls).toHaveLength(1);
  });

  it('throws when the response has more vectors than inputs', async () => {
    const { fetchImpl } = makeFetch([p.ok([[1], [2], [3]])]);
    await expect(p.make(opts(fetchImpl)).embedDocuments(['a', 'b'])).rejects.toBeInstanceOf(KBError);
  });

  it('throws a non-retried KBError on a non-JSON 200 body', async () => {
    const { fetchImpl, calls } = makeFetch([textResponse('<html>not json</html>', 200)]);
    await expect(p.make(opts(fetchImpl)).embedDocuments(['a'])).rejects.toBeInstanceOf(KBError);
    expect(calls).toHaveLength(1);
  });

  it('throws a non-retried KBError on a JSON 200 body missing the vectors field', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ unexpected: true })]);
    await expect(p.make(opts(fetchImpl)).embedDocuments(['a'])).rejects.toBeInstanceOf(KBError);
    expect(calls).toHaveLength(1);
  });

  it('retries HTTP 503 and then succeeds', async () => {
    const { fetchImpl, calls } = makeFetch([textResponse('overloaded', 503), p.ok([[7]])]);
    const out = await p.make(opts(fetchImpl)).embedDocuments(['a']);
    expect(out).toEqual([[7]]);
    expect(calls).toHaveLength(2);
  });

  it('retries HTTP 429 and then succeeds', async () => {
    const { fetchImpl, calls } = makeFetch([textResponse('slow down', 429), p.ok([[8]])]);
    const out = await p.make(opts(fetchImpl)).embedDocuments(['a']);
    expect(out).toEqual([[8]]);
    expect(calls).toHaveLength(2);
  });

  it('retries a network failure (fetch rejects) and then succeeds', async () => {
    const { fetchImpl, calls } = makeFetch([new TypeError('fetch failed'), p.ok([[9]])]);
    const out = await p.make(opts(fetchImpl)).embedDocuments(['a']);
    expect(out).toEqual([[9]]);
    expect(calls).toHaveLength(2);
  });

  it('persistent 503 throws PROVIDER_UNAVAILABLE after maxRetries + 1 attempts', async () => {
    const { fetchImpl, calls } = makeFetch([textResponse('down', 503)]);
    const err = await p
      .make(opts(fetchImpl, { maxRetries: 1 }))
      .embedDocuments(['a'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KBError);
    expect((err as KBError).code).toBe('PROVIDER_UNAVAILABLE');
    expect(calls).toHaveLength(2);
  });

  it('persistent network failure throws PROVIDER_UNAVAILABLE after maxRetries + 1 attempts', async () => {
    const { fetchImpl, calls } = makeFetch([new TypeError('fetch failed')]);
    const err = await p
      .make(opts(fetchImpl, { maxRetries: 1 }))
      .embedDocuments(['a'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KBError);
    expect((err as KBError).code).toBe('PROVIDER_UNAVAILABLE');
    expect(calls).toHaveLength(2);
  });

  it('maxRetries: 0 makes exactly one attempt on a transient failure', async () => {
    const { fetchImpl, calls } = makeFetch([textResponse('down', 503)]);
    await expect(p.make(opts(fetchImpl, { maxRetries: 0 })).embedDocuments(['a'])).rejects.toBeInstanceOf(KBError);
    expect(calls).toHaveLength(1);
  });

  it.each([401, 403])('HTTP %i throws PROVIDER_AUTH and is not retried', async (status) => {
    const { fetchImpl, calls } = makeFetch([textResponse('nope', status)]);
    const err = await p.make(opts(fetchImpl)).embedDocuments(['a']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KBError);
    expect((err as KBError).code).toBe('PROVIDER_AUTH');
    expect(calls).toHaveLength(1);
  });

  it('HTTP 400 throws a non-retryable KBError (Ollama: PROVIDER_UNAVAILABLE, parity with the pre-fetch client; OpenAI: VALIDATION)', async () => {
    const { fetchImpl, calls } = makeFetch([textResponse('bad request: weird-server-text-42', 400)]);
    const err = await p.make(opts(fetchImpl)).embedDocuments(['a']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KBError);
    expect((err as KBError).code).toBe(p.name === 'Ollama' ? 'PROVIDER_UNAVAILABLE' : 'VALIDATION');
    expect(calls).toHaveLength(1);
  });

  it('HTTP 400 keeps the server error text in the message', async () => {
    const { fetchImpl } = makeFetch([textResponse('bad request: weird-server-text-42', 400)]);
    const err = await p.make(opts(fetchImpl)).embedDocuments(['a']).catch((e: unknown) => e);
    expect((err as Error).message).toContain('weird-server-text-42');
  });

  it('a later batch failing with 401 aborts without further requests', async () => {
    const { fetchImpl, calls } = makeFetch([p.ok([[1], [2]]), textResponse('nope', 401), p.ok([[3]])]);
    await expect(
      p.make(opts(fetchImpl, { batchSize: 2 })).embedDocuments(['a', 'b', 'c', 'd', 'e']),
    ).rejects.toBeInstanceOf(KBError);
    expect(calls).toHaveLength(2);
  });

  it('an already-aborted signal rejects promptly and is not retried', async () => {
    const ac = new AbortController();
    ac.abort();
    const { fetchImpl, calls } = makeFetch([
      () => {
        throw new DOMException('This operation was aborted', 'AbortError');
      },
    ]);
    const start = Date.now();
    await expect(
      p.make(opts(fetchImpl, { signal: ac.signal, maxRetries: 3 })).embedDocuments(['a']),
    ).rejects.toBeDefined();
    expect(Date.now() - start).toBeLessThan(200);
    expect(calls.length).toBeLessThanOrEqual(1);
  });

  it('aborting an in-flight request rejects promptly and is not retried', async () => {
    const ac = new AbortController();
    const { fetchImpl, calls } = makeFetch([
      (rec) =>
        new Promise<Response>((_resolve, reject) => {
          rec.signal?.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError')),
          );
        }),
    ]);
    const pending = p
      .make(opts(fetchImpl, { signal: ac.signal, maxRetries: 3 }))
      .embedDocuments(['a'])
      .catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));
    const start = Date.now();
    ac.abort();
    const err = await pending;
    expect(err).toBeDefined();
    expect(err).not.toBeNull();
    expect(Date.now() - start).toBeLessThan(200);
    expect(calls).toHaveLength(1);
  });
});

describe('OllamaFetchEmbeddings wire format', () => {
  it('sends truncate:false and Content-Type JSON, with exactly the documented body keys', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ embeddings: [[1]] })]);
    await new OllamaFetchEmbeddings({ baseUrl: 'http://h:1', model: 'qwen', fetchImpl }).embedDocuments(['t']);
    expect(calls[0].body).toEqual({ model: 'qwen', input: ['t'], truncate: false });
    expect(calls[0].headers.get('content-type')).toMatch(/application\/json/);
  });

  it('reads vectors from the embeddings field in order', async () => {
    const { fetchImpl } = makeFetch([jsonResponse({ embeddings: [[1, 2], [3, 4]] })]);
    const out = await new OllamaFetchEmbeddings({ baseUrl: 'http://h:1', model: 'm', fetchImpl }).embedDocuments(['a', 'b']);
    expect(out).toEqual([[1, 2], [3, 4]]);
  });

  it('does not send an Authorization header', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ embeddings: [[1]] })]);
    await new OllamaFetchEmbeddings({ baseUrl: 'http://h:1', model: 'm', fetchImpl }).embedDocuments(['a']);
    expect(calls[0].headers.get('authorization')).toBeNull();
  });
});

describe('OpenAIFetchEmbeddings wire format', () => {
  const base = 'https://api.example.test/v1';

  it('sends encoding_format:float, Content-Type JSON and a Bearer header when apiKey is set', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ data: [{ index: 0, embedding: [1] }] })]);
    await new OpenAIFetchEmbeddings({ baseUrl: base, model: 'te3', apiKey: 'sk-test', fetchImpl }).embedDocuments(['t']);
    expect(calls[0].body).toEqual({ model: 'te3', input: ['t'], encoding_format: 'float' });
    expect(calls[0].headers.get('content-type')).toMatch(/application\/json/);
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-test');
  });

  it('sends no Authorization header when apiKey is unset', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ data: [{ index: 0, embedding: [1] }] })]);
    await new OpenAIFetchEmbeddings({ baseUrl: base, model: 'm', fetchImpl }).embedDocuments(['t']);
    expect(calls[0].headers.get('authorization')).toBeNull();
  });

  it('reorders a shuffled data[] by index', async () => {
    const { fetchImpl } = makeFetch([
      jsonResponse({
        data: [
          { index: 2, embedding: [2, 2] },
          { index: 0, embedding: [0, 0] },
          { index: 1, embedding: [1, 1] },
        ],
      }),
    ]);
    const out = await new OpenAIFetchEmbeddings({ baseUrl: base, model: 'm', fetchImpl }).embedDocuments(['a', 'b', 'c']);
    expect(out).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it('reorders each batch independently when batching', async () => {
    const { fetchImpl } = makeFetch([
      jsonResponse({ data: [{ index: 1, embedding: [11] }, { index: 0, embedding: [10] }] }),
      jsonResponse({ data: [{ index: 0, embedding: [20] }] }),
    ]);
    const out = await new OpenAIFetchEmbeddings({ baseUrl: base, model: 'm', batchSize: 2, fetchImpl }).embedDocuments(['a', 'b', 'c']);
    expect(out).toEqual([[10], [11], [20]]);
  });

  it('throws when an index is missing (duplicate index, right count)', async () => {
    const { fetchImpl } = makeFetch([
      jsonResponse({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }),
    ]);
    await expect(
      new OpenAIFetchEmbeddings({ baseUrl: base, model: 'm', fetchImpl }).embedDocuments(['a', 'b']),
    ).rejects.toBeInstanceOf(KBError);
  });

  it('throws when an index is out of range', async () => {
    const { fetchImpl } = makeFetch([
      jsonResponse({ data: [{ index: 0, embedding: [1] }, { index: 5, embedding: [2] }] }),
    ]);
    await expect(
      new OpenAIFetchEmbeddings({ baseUrl: base, model: 'm', fetchImpl }).embedDocuments(['a', 'b']),
    ).rejects.toBeInstanceOf(KBError);
  });
});

// Review follow-ups on #1257: error classification parity with the pre-fetch
// clients, retry window, vector validation and OpenAI org/project headers.
describe('status classification and validation', () => {
  const oll = (fetchImpl: typeof fetch, extra: Partial<FetchEmbeddingsOptions> = {}) =>
    new OllamaFetchEmbeddings({ baseUrl: 'http://127.0.0.1:11434', model: 'm', fetchImpl, maxRetries: 1, ...extra });
  const oai = (fetchImpl: typeof fetch, extra: Partial<FetchEmbeddingsOptions> = {}) =>
    new OpenAIFetchEmbeddings({ baseUrl: 'https://api.example.test/v1', model: 'm', fetchImpl, maxRetries: 1, ...extra });
  const code = async (p: Promise<unknown>): Promise<unknown> => ((await p.catch((e: unknown) => e)) as KBError).code;

  it('Ollama 404 (model not pulled) is PROVIDER_UNAVAILABLE and not retried', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ error: 'model "x" not found' }, 404)]);
    const err = await oll(fetchImpl).embedDocuments(['a']).catch((e: unknown) => e);
    expect((err as KBError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((err as Error).message).toContain('model "x" not found');
    expect(calls).toHaveLength(1);
  });

  it('Ollama context-length 400 is VALIDATION after exactly one call', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ error: 'the input length exceeds the context length' }, 400)]);
    expect(await code(oll(fetchImpl).embedDocuments(['a']))).toBe('VALIDATION');
    expect(calls).toHaveLength(1);
  });

  it('Ollama 403 is PROVIDER_AUTH', async () => {
    const { fetchImpl } = makeFetch([textResponse('forbidden', 403)]);
    expect(await code(oll(fetchImpl).embedDocuments(['a']))).toBe('PROVIDER_AUTH');
  });

  it.each([
    ['Ollama', oll, jsonResponse({ embeddings: [[1]] })],
    ['OpenAI', oai, jsonResponse({ data: [{ index: 0, embedding: [1] }] })],
  ])('%s retries HTTP 408', async (_n, make, ok) => {
    const { fetchImpl, calls } = makeFetch([textResponse('timeout', 408), ok]);
    expect(await make(fetchImpl).embedDocuments(['a'])).toEqual([[1]]);
    expect(calls).toHaveLength(2);
  });

  it('OpenAI 404 is PROVIDER_UNAVAILABLE and not retried', async () => {
    const { fetchImpl, calls } = makeFetch([textResponse('no such route', 404)]);
    expect(await code(oai(fetchImpl).embedDocuments(['a']))).toBe('PROVIDER_UNAVAILABLE');
    expect(calls).toHaveLength(1);
  });

  it.each([400, 413, 422])('OpenAI %i is VALIDATION and not retried', async (status) => {
    const { fetchImpl, calls } = makeFetch([textResponse('bad', status)]);
    expect(await code(oai(fetchImpl).embedDocuments(['a']))).toBe('VALIDATION');
    expect(calls).toHaveLength(1);
  });

  it('rejects an empty vector (both protocols)', async () => {
    const o = makeFetch([jsonResponse({ embeddings: [[]] })]);
    const a = makeFetch([jsonResponse({ data: [{ index: 0, embedding: [] }] })]);
    await expect(oll(o.fetchImpl).embedDocuments(['x'])).rejects.toBeInstanceOf(KBError);
    await expect(oai(a.fetchImpl).embedDocuments(['x'])).rejects.toBeInstanceOf(KBError);
    expect(o.calls).toHaveLength(1);
    expect(a.calls).toHaveLength(1);
  });

  it('rejects vectors of differing length within one response (both protocols)', async () => {
    const o = makeFetch([jsonResponse({ embeddings: [[1, 2], [3]] })]);
    const a = makeFetch([jsonResponse({ data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3] }] })]);
    await expect(oll(o.fetchImpl).embedDocuments(['x', 'y'])).rejects.toBeInstanceOf(KBError);
    await expect(oai(a.fetchImpl).embedDocuments(['x', 'y'])).rejects.toBeInstanceOf(KBError);
  });

  it('sends extraHeaders (OpenAI-Organization / OpenAI-Project) alongside the bearer token', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ data: [{ index: 0, embedding: [1] }] })]);
    await oai(fetchImpl, {
      apiKey: 'k',
      extraHeaders: { 'OpenAI-Organization': 'org-1', 'OpenAI-Project': 'proj-1' },
    }).embedQuery('q');
    expect(calls[0].headers.get('authorization')).toBe('Bearer k');
    expect(calls[0].headers.get('openai-organization')).toBe('org-1');
    expect(calls[0].headers.get('openai-project')).toBe('proj-1');
  });

  it('defaults to 5 retries with exponential backoff capped at 4 s', async () => {
    jest.useFakeTimers();
    try {
      const { fetchImpl, calls } = makeFetch([textResponse('down', 503)]);
      const result = new OllamaFetchEmbeddings({ baseUrl: 'http://127.0.0.1:11434', model: 'm', fetchImpl })
        .embedDocuments(['a'])
        .catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      for (const [delay, total] of [[250, 2], [500, 3], [1000, 4], [2000, 5], [4000, 6]] as const) {
        await jest.advanceTimersByTimeAsync(delay - 1);
        expect(calls).toHaveLength(total - 1);
        await jest.advanceTimersByTimeAsync(1);
        expect(calls).toHaveLength(total);
      }
      await jest.advanceTimersByTimeAsync(10_000);
      expect(calls).toHaveLength(6);
      expect(((await result) as KBError).code).toBe('PROVIDER_UNAVAILABLE');
    } finally {
      jest.useRealTimers();
    }
  });
});
