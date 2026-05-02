// src/transport/http.test.ts
//
// Stage 2 of RFC 008 / issue #48: streamable HTTP in stateful mode.

import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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
}): Promise<{ host: StreamableHttpHost; port: number; stop: () => Promise<void> }> {
  const host = new StreamableHttpHost({
    config: {
      transport: 'http',
      port: 0,
      bindAddr: '127.0.0.1',
      authToken: opts.authToken ?? VALID_TOKEN,
      allowedOrigins: opts.allowedOrigins ?? [],
    },
    createMcpServer: freshFactory(),
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
  throw new Error('condition was not met before timeout');
}

describe('StreamableHttpHost — endpoints', () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = undefined;
    }
  });

  it('GET /health returns 200 JSON {"status":"ok"} without auth', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, { path: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('request without Authorization gets 401 with WWW-Authenticate', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, { method: 'POST', path: '/mcp' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
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
    await waitFor(() => started.host.getConnectedMcpServers().length === 1);
    await client.close();
    await waitFor(() => started.host.getConnectedMcpServers().length === 0);
  });
});

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
