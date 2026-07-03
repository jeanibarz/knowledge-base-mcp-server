// src/transport/http.test.ts
//
// Stage 2 of RFC 008 / issue #48: streamable HTTP in stateful mode.

import * as http from 'node:http';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { AuthBackoffConfig } from '../transport-config.js';
import type { ReadinessPayload } from '../transport-readiness.js';
import { StreamableHttpHost } from './http.js';

const VALID_TOKEN = 'a-very-secret-token-for-test-use-only';

function freshFactory(): () => McpServer {
  return () => {
    const server = new McpServer({ name: 'kb-http-test', version: '0.0.0-test' });
    server.tool(
      'echo',
      'Echoes the supplied text',
      { text: z.string() },
      async ({ text }) => ({
        content: [{ type: 'text', text }],
      }),
    );
    return server;
  };
}

async function startHost(opts: {
  authToken?: string;
  allowedOrigins?: string[];
  authBackoff?: AuthBackoffConfig;
  metricsExporter?: () => Promise<string>;
  readinessProbe?: () => Promise<ReadinessPayload>;
}): Promise<{ host: StreamableHttpHost; port: number; stop: () => Promise<void> }> {
  const host = new StreamableHttpHost({
    config: {
      transport: 'http',
      port: 0,
      bindAddr: '127.0.0.1',
      authToken: opts.authToken ?? VALID_TOKEN,
      allowedOrigins: opts.allowedOrigins ?? [],
      authBackoff: opts.authBackoff,
    },
    createMcpServer: freshFactory(),
    metricsExporter: opts.metricsExporter,
    readinessProbe: opts.readinessProbe,
  });
  const server = await host.start();
  const addr = server.address() as AddressInfo;
  return {
    host,
    port: addr.port,
    stop: () => host.stop(),
  };
}

interface RawResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

async function connectClient(port: number): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const client = new Client({ name: 'kb-http-test-client', version: '0.0.0-test' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      },
    },
  );
  await client.connect(transport);
  return { client, transport };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition was not met before ${timeoutMs}ms timeout`);
}

function sendMalformedHttpRequest(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write('not an HTTP request\r\n\r\n');
    });
    socket.on('data', () => {
      socket.destroy();
    });
    socket.on('close', () => resolve());
    socket.on('error', reject);
  });
}

function readyPayload(
  status: 'ok' | 'error',
  failingChecks: ReadinessPayload['failing_checks'] = [],
): ReadinessPayload {
  return {
    status,
    checks: [
      {
        name: 'active_model',
        status: failingChecks.includes('active_model') ? 'error' : 'ok',
      },
      {
        name: 'index',
        status: failingChecks.includes('index') ? 'error' : 'ok',
      },
      {
        name: 'backend',
        status: failingChecks.includes('backend') ? 'error' : 'ok',
      },
    ],
    failing_checks: failingChecks,
  };
}

describe('StreamableHttpHost — endpoints', () => {
  let stop: (() => Promise<void>) | undefined;
  const originalMetricsExport = process.env.KB_METRICS_EXPORT;

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = undefined;
    }
    if (originalMetricsExport === undefined) delete process.env.KB_METRICS_EXPORT;
    else process.env.KB_METRICS_EXPORT = originalMetricsExport;
  });

  it('GET /health returns 200 JSON {"status":"ok"} without auth', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, { path: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('requires bearer auth for GET /ready', async () => {
    const started = await startHost({
      readinessProbe: async () => readyPayload('ok'),
    });
    stop = started.stop;

    const missing = await request(started.port, { path: '/ready' });
    expect(missing.statusCode).toBe(401);

    const wrong = await request(started.port, {
      path: '/ready',
      headers: { Authorization: 'Bearer not-the-real-token-not-the-real-tok' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('serves authenticated readiness JSON when model, index, and backend are ready', async () => {
    const started = await startHost({
      readinessProbe: async () => readyPayload('ok'),
    });
    stop = started.stop;

    const res = await request(started.port, {
      path: '/ready',
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body)).toEqual(readyPayload('ok'));
  });

  it('returns 503 readiness JSON with failing check names when a dependency is not ready', async () => {
    const started = await startHost({
      readinessProbe: async () => readyPayload('error', ['backend']),
    });
    stop = started.stop;

    const res = await request(started.port, {
      path: '/ready',
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual(readyPayload('error', ['backend']));
  });

  it('applies the same origin gate to /ready as MCP routes', async () => {
    const started = await startHost({
      allowedOrigins: ['https://app.example'],
      readinessProbe: async () => readyPayload('ok'),
    });
    stop = started.stop;

    const res = await request(started.port, {
      path: '/ready',
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        Origin: 'https://evil.example',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('serves authenticated OpenMetrics text at GET /metrics when enabled', async () => {
    process.env.KB_METRICS_EXPORT = 'on';
    const started = await startHost({
      metricsExporter: async () => '# TYPE kb_server_uptime_ms gauge\nkb_server_uptime_ms 5\n# EOF\n',
    });
    stop = started.stop;

    const unauthenticated = await request(started.port, { path: '/metrics' });
    expect(unauthenticated.statusCode).toBe(401);

    const authenticated = await request(started.port, {
      path: '/metrics',
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.headers['content-type']).toMatch(/openmetrics-text/);
    expect(authenticated.body).toContain('kb_server_uptime_ms 5');
  });

  it('request without Authorization gets 401 with WWW-Authenticate', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, { method: 'POST', path: '/mcp' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
  });

  it('returns Retry-After when repeated failed auth enters backoff', async () => {
    const started = await startHost({
      authBackoff: {
        failureThreshold: 1,
        backoffMs: 1_000,
        maxEntries: 4,
      },
    });
    stop = started.stop;

    const first = await request(started.port, { method: 'POST', path: '/mcp' });
    expect(first.statusCode).toBe(401);
    expect(first.headers['retry-after']).toBe('1');

    const blocked = await request(started.port, { method: 'POST', path: '/mcp' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('1');
    expect(blocked.body).toBe('Too Many Authentication Attempts');

    const authenticated = await request(started.port, {
      method: 'POST',
      path: '/mcp',
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(authenticated.statusCode).toBe(400);
    expect(authenticated.body).toContain('Parse error');
  });

  it('exposes process-lifetime HTTP transport counters', async () => {
    const started = await startHost({
      allowedOrigins: ['https://app.example'],
    });
    stop = started.stop;

    const initial = started.host.getRuntimeStats();
    expect(initial).toMatchObject({
      transport: 'http',
      sessions_opened: 0,
      sessions_closed: 0,
      current_sessions: 0,
      in_flight_requests: 0,
      requests_total: 0,
      auth_failures: 0,
      origin_denials: 0,
      last_error: null,
    });

    await request(started.port, { path: '/health' });
    await request(started.port, { method: 'POST', path: '/mcp' });
    await request(started.port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        Origin: 'https://evil.example',
      },
    });

    const { client } = await connectClient(started.port);
    await expect(client.listTools()).resolves.toEqual(
      expect.objectContaining({ tools: expect.any(Array) }),
    );
    await waitFor(() => started.host.sessionCount === 1);
    await client.close();
    await waitFor(() => started.host.sessionCount === 0, 20000);

    await sendMalformedHttpRequest(started.port);
    await waitFor(() => started.host.getRuntimeStats().last_error !== null);

    const stats = started.host.getRuntimeStats();
    expect(stats.transport).toBe('http');
    expect(stats.sessions_opened).toBe(1);
    expect(stats.sessions_closed).toBe(1);
    expect(stats.current_sessions).toBe(0);
    expect(stats.in_flight_requests).toBe(0);
    expect(stats.requests_total).toBeGreaterThanOrEqual(4);
    expect(stats.response_status_buckets['2xx']).toBeGreaterThanOrEqual(2);
    expect(stats.response_status_buckets['4xx']).toBeGreaterThanOrEqual(2);
    expect(stats.auth_failures).toBe(1);
    expect(stats.origin_denials).toBe(1);
    expect(stats.last_error?.message).toEqual(expect.any(String));
  });

  it('preflight OPTIONS from listed origin gets streamable HTTP CORS headers', async () => {
    const started = await startHost({
      allowedOrigins: ['http://localhost:5173'],
    });
    stop = started.stop;
    const res = await request(started.port, {
      method: 'OPTIONS',
      path: '/mcp',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-methods']).toMatch(/DELETE/);
    expect(res.headers['access-control-allow-headers']).toMatch(/Mcp-Session-Id/);
  });

  it('absent Mcp-Session-Id with non-initialize POST returns 400', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('No valid session id');
  });

  it('malformed JSON returns a JSON-RPC parse error instead of 500', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0",',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32700);
  });

  it('supports a stateful streamable HTTP session across multiple requests', async () => {
    const started = await startHost({});
    stop = started.stop;
    const { client, transport } = await connectClient(started.port);
    try {
      const sessionId = transport.sessionId;
      expect(sessionId).toMatch(UUID_REGEX);
      const first = await client.listTools();
      const second = await client.listTools();
      expect(first.tools.map((tool) => tool.name)).toContain('echo');
      expect(second.tools.map((tool) => tool.name)).toContain('echo');
      expect(transport.sessionId).toBe(sessionId);
    } finally {
      await client.close();
    }
  });

  it('second client initialize mints an independent session', async () => {
    const started = await startHost({});
    stop = started.stop;
    const first = await connectClient(started.port);
    const second = await connectClient(started.port);
    try {
      expect(first.transport.sessionId).toMatch(UUID_REGEX);
      expect(second.transport.sessionId).toMatch(UUID_REGEX);
      expect(second.transport.sessionId).not.toBe(first.transport.sessionId);
      await expect(first.client.listTools()).resolves.toEqual(
        expect.objectContaining({ tools: expect.any(Array) }),
      );
      await expect(second.client.listTools()).resolves.toEqual(
        expect.objectContaining({ tools: expect.any(Array) }),
      );
    } finally {
      await first.client.close();
      await second.client.close();
    }
  });

  it('cleans up the session map when a client disconnects without DELETE', async () => {
    const started = await startHost({});
    stop = started.stop;
    const { client } = await connectClient(started.port);
    await expect(client.listTools()).resolves.toEqual(
      expect.objectContaining({ tools: expect.any(Array) }),
    );
    await waitFor(() => started.host.sessionCount === 1);
    await client.close();
    await waitFor(() => started.host.sessionCount === 0, 20000);
  });

  // ---------------------------------------------------------------------
  // Issue #157 step 4 — host-owned warm-up fanout. Same shape as
  // SseHost.notify; tests directly populate the private sessions map so
  // the assertions don't need a live MCP roundtrip.
  // ---------------------------------------------------------------------

  it('notify is a no-op when no HTTP sessions are connected', async () => {
    const started = await startHost({});
    stop = started.stop;
    expect(started.host.sessionCount).toBe(0);
    await expect(started.host.notify('info', 'kb-test', 'hello')).resolves.toBeUndefined();
  });

  it('notify fans out sendLoggingMessage to every live session McpServer', async () => {
    const started = await startHost({});
    stop = started.stop;
    const sessionA = { sendLoggingMessage: jest.fn().mockResolvedValue(undefined) };
    const sessionB = { sendLoggingMessage: jest.fn().mockResolvedValue(undefined) };
    const sessions: Map<string, { transport: unknown; mcp: unknown }> =
      (started.host as unknown as { sessions: Map<string, { transport: unknown; mcp: unknown }> }).sessions;
    sessions.set('a', { transport: {}, mcp: sessionA });
    sessions.set('b', { transport: {}, mcp: sessionB });
    expect(started.host.sessionCount).toBe(2);

    await started.host.notify('info', 'kb-test', 'embedded 5/10 files');
    const expected = { level: 'info', logger: 'kb-test', data: 'embedded 5/10 files' };
    expect(sessionA.sendLoggingMessage).toHaveBeenCalledWith(expected);
    expect(sessionB.sendLoggingMessage).toHaveBeenCalledWith(expected);

    sessions.clear();
  });

  it('notify swallows per-session errors so one bad client cannot poison the rest', async () => {
    const started = await startHost({});
    stop = started.stop;
    const happy = { sendLoggingMessage: jest.fn().mockResolvedValue(undefined) };
    const sad = {
      sendLoggingMessage: jest.fn().mockRejectedValue(new Error('client gone')),
    };
    const sessions: Map<string, { transport: unknown; mcp: unknown }> =
      (started.host as unknown as { sessions: Map<string, { transport: unknown; mcp: unknown }> }).sessions;
    sessions.set('happy', { transport: {}, mcp: happy });
    sessions.set('sad', { transport: {}, mcp: sad });

    await expect(
      started.host.notify('warning', 'kb-test', 'partial failure ok'),
    ).resolves.toBeUndefined();
    expect(happy.sendLoggingMessage).toHaveBeenCalled();
    expect(sad.sendLoggingMessage).toHaveBeenCalled();

    sessions.clear();
  });

  it('notifyResourceListChanged fans out to every live session McpServer', async () => {
    const started = await startHost({});
    stop = started.stop;
    const sessionA = { server: { sendResourceListChanged: jest.fn().mockResolvedValue(undefined) } };
    const sessionB = { server: { sendResourceListChanged: jest.fn().mockResolvedValue(undefined) } };
    const sessions: Map<string, { transport: unknown; mcp: unknown }> =
      (started.host as unknown as { sessions: Map<string, { transport: unknown; mcp: unknown }> }).sessions;
    sessions.set('a', { transport: {}, mcp: sessionA });
    sessions.set('b', { transport: {}, mcp: sessionB });

    await expect(started.host.notifyResourceListChanged()).resolves.toBeUndefined();
    expect(sessionA.server.sendResourceListChanged).toHaveBeenCalledTimes(1);
    expect(sessionB.server.sendResourceListChanged).toHaveBeenCalledTimes(1);

    sessions.clear();
  });

  it('notifyResourceListChanged no-ops when there are no live sessions', async () => {
    const started = await startHost({});
    stop = started.stop;

    await expect(started.host.notifyResourceListChanged()).resolves.toBeUndefined();
  });

  it('notifyResourceListChanged swallows per-session errors so one bad client cannot poison the rest', async () => {
    const started = await startHost({});
    stop = started.stop;
    const happy = { server: { sendResourceListChanged: jest.fn().mockResolvedValue(undefined) } };
    const sad = {
      server: { sendResourceListChanged: jest.fn().mockRejectedValue(new Error('client gone')) },
    };
    const sessions: Map<string, { transport: unknown; mcp: unknown }> =
      (started.host as unknown as { sessions: Map<string, { transport: unknown; mcp: unknown }> }).sessions;
    sessions.set('happy', { transport: {}, mcp: happy });
    sessions.set('sad', { transport: {}, mcp: sad });

    await expect(started.host.notifyResourceListChanged()).resolves.toBeUndefined();
    expect(happy.server.sendResourceListChanged).toHaveBeenCalledTimes(1);
    expect(sad.server.sendResourceListChanged).toHaveBeenCalledTimes(1);

    sessions.clear();
  });
});

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
