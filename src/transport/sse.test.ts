// src/transport/sse.test.ts
//
// Stage 1 of RFC 008. The required cases per the implementation brief:
//   (a) missing MCP_AUTH_TOKEN under MCP_TRANSPORT=sse → loadTransportConfig throws
//   (b) valid token → request reaches the SSE endpoint
//   (c) invalid token → 401
//   (d) disallowed origin → 403
//   (e) /health → 200 JSON without auth
//
// The McpServer factory used in these tests builds a minimal server with no
// tools — the tests target the HTTP/auth/CORS surface, not the MCP protocol.

import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  loadTransportConfig,
  TransportConfigError,
  DEFAULT_MCP_PORT,
} from '../config.js';
import { SseHost } from './sse.js';

const VALID_TOKEN = 'a-very-secret-token-for-test-use-only';

function freshFactory(): () => McpServer {
  return () =>
    new McpServer({ name: 'kb-test', version: '0.0.0-test' });
}

async function startHost(opts: {
  authToken?: string;
  allowedOrigins?: string[];
}): Promise<{ host: SseHost; port: number; stop: () => Promise<void> }> {
  const host = new SseHost({
    config: {
      transport: 'sse',
      port: 0, // ephemeral
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
    req.end();
  });
}

/**
 * Open an SSE GET stream and resolve once the SDK has sent the `endpoint`
 * preamble (which carries the new sessionId in the query string). The caller
 * must explicitly close the returned `req` to release the connection.
 */
function openSseStream(
  port: number,
  headers: Record<string, string>,
): Promise<{
  statusCode: number;
  resHeaders: http.IncomingHttpHeaders;
  sessionId?: string;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/sse',
        headers,
      },
      (res) => {
        if ((res.statusCode || 0) >= 400) {
          // Error path — drain and resolve so caller can assert.
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              statusCode: res.statusCode || 0,
              resHeaders: res.headers,
              close: () => req.destroy(),
            }),
          );
          return;
        }
        let buf = '';
        const onData = (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          // SSE preamble looks like:
          //   event: endpoint
          //   data: /messages?sessionId=<uuid>
          //   \n\n
          const match = buf.match(/data: (\/messages\?[^\n]+)/);
          if (match) {
            const url = new URL(match[1], 'http://placeholder');
            const sessionId = url.searchParams.get('sessionId') || undefined;
            res.removeListener('data', onData);
            resolve({
              statusCode: res.statusCode || 200,
              resHeaders: res.headers,
              sessionId,
              close: () => req.destroy(),
            });
          }
        };
        res.on('data', onData);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('loadTransportConfig validation', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to stdio when MCP_TRANSPORT is unset', () => {
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_AUTH_TOKEN;
    const cfg = loadTransportConfig();
    expect(cfg.transport).toBe('stdio');
    expect(cfg.port).toBe(DEFAULT_MCP_PORT);
    expect(cfg.bindAddr).toBe('127.0.0.1');
  });

  it('refuses startup when MCP_TRANSPORT=sse but MCP_AUTH_TOKEN is unset', () => {
    process.env.MCP_TRANSPORT = 'sse';
    delete process.env.MCP_AUTH_TOKEN;
    expect(() => loadTransportConfig()).toThrow(TransportConfigError);
    expect(() => loadTransportConfig()).toThrow(/MCP_AUTH_TOKEN/);
  });

  it('rejects MCP_TRANSPORT=http (stage 2 not yet implemented)', () => {
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_AUTH_TOKEN = VALID_TOKEN;
    expect(() => loadTransportConfig()).toThrow(/Invalid MCP_TRANSPORT/);
  });

  it('rejects MCP_ALLOWED_ORIGINS=*', () => {
    process.env.MCP_TRANSPORT = 'sse';
    process.env.MCP_AUTH_TOKEN = VALID_TOKEN;
    process.env.MCP_ALLOWED_ORIGINS = '*';
    expect(() => loadTransportConfig()).toThrow(/MCP_ALLOWED_ORIGINS/);
  });

  it('rejects MCP_PORT outside [1, 65535]', () => {
    process.env.MCP_TRANSPORT = 'sse';
    process.env.MCP_AUTH_TOKEN = VALID_TOKEN;
    process.env.MCP_PORT = '70000';
    expect(() => loadTransportConfig()).toThrow(/MCP_PORT/);
  });

  // Regression for #77: operators routinely type trailing slashes and mixed-
  // case hostnames into env config, but browsers send the RFC 6454 form
  // (lowercased scheme+host, no trailing slash). Normalize at parse time so
  // the stored set matches what any real browser will send.
  it('normalizes allowed origins (case + single trailing slash) at parse time', () => {
    process.env.MCP_TRANSPORT = 'sse';
    process.env.MCP_AUTH_TOKEN = VALID_TOKEN;
    process.env.MCP_ALLOWED_ORIGINS =
      'HTTPS://App.Example.com/,  http://localhost:8080';
    const cfg = loadTransportConfig();
    expect(cfg.allowedOrigins).toEqual([
      'https://app.example.com',
      'http://localhost:8080',
    ]);
  });
});

describe('SseHost — endpoints', () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = undefined;
    }
  });

  it('(e) GET /health returns 200 JSON {"status":"ok"} without auth (RFC 008 §6.8: no fingerprinting)', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, { path: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ status: 'ok' });
    // Explicitly ensure the endpoint does not leak version / uptime / index
    // path to unauthenticated callers (RFC 008 §6.8).
    expect(body.version).toBeUndefined();
    expect(body.uptime_ms).toBeUndefined();
    expect(body.index_path).toBeUndefined();
  });

  it('HEAD /health returns 200 with no body', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, { method: 'HEAD', path: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('POST /health returns 405', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, { method: 'POST', path: '/health' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
  });

  it('(c) request without Authorization gets 401 with WWW-Authenticate', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, { path: '/sse' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
  });

  it('(c) request with wrong bearer token gets 401', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, {
      path: '/sse',
      headers: { Authorization: 'Bearer not-the-real-token-not-the-real-tok' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('(c) bearer token that differs in length gets 401', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, {
      path: '/sse',
      headers: { Authorization: 'Bearer short' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('(d) preflight OPTIONS from disallowed origin gets 403', async () => {
    const started = await startHost({
      allowedOrigins: ['http://localhost:5173'],
    });
    stop = started.stop;
    const res = await request(started.port, {
      method: 'OPTIONS',
      path: '/sse',
      headers: {
        Origin: 'http://evil.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('(d) non-preflight request from disallowed origin gets 403 (auth not even checked)', async () => {
    const started = await startHost({
      allowedOrigins: ['http://localhost:5173'],
    });
    stop = started.stop;
    const res = await request(started.port, {
      path: '/sse',
      headers: {
        Origin: 'http://evil.example.com',
        Authorization: `Bearer ${VALID_TOKEN}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('OPTIONS preflight from listed origin gets 204 with CORS headers', async () => {
    const started = await startHost({
      allowedOrigins: ['http://localhost:5173'],
    });
    stop = started.stop;
    const res = await request(started.port, {
      method: 'OPTIONS',
      path: '/sse',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    expect(res.headers['access-control-allow-methods']).toMatch(/GET/);
    expect(res.headers['vary']).toBe('Origin');
  });

  // Regression for #77: the allow-list lookup now normalizes the incoming
  // Origin header (lowercase scheme+host, single trailing slash stripped)
  // before compare, so operator config that is case- or slash-divergent from
  // what a browser sends still matches.
  it('(#77) OPTIONS from mixed-case Origin matches a lowercase allow-list entry', async () => {
    const started = await startHost({
      allowedOrigins: ['http://localhost'],
    });
    stop = started.stop;
    const res = await request(started.port, {
      method: 'OPTIONS',
      path: '/sse',
      headers: {
        Origin: 'HTTP://LOCALHOST',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.statusCode).toBe(204);
    // The echo reflects the raw header the browser sent — that is what the
    // browser byte-compares against its own Origin for CORS validation.
    expect(res.headers['access-control-allow-origin']).toBe('HTTP://LOCALHOST');
  });

  it('(#77) OPTIONS from Origin with trailing slash matches a no-slash allow-list entry', async () => {
    const started = await startHost({
      allowedOrigins: ['https://app.example.com'],
    });
    stop = started.stop;
    const res = await request(started.port, {
      method: 'OPTIONS',
      path: '/sse',
      headers: {
        // Real browsers never send a trailing slash, but embedded/non-browser
        // callers sometimes do — accept it so the allow-list is the single
        // source of truth for what's permitted.
        Origin: 'https://app.example.com/',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.statusCode).toBe(204);
  });

  it('(#77) normalization does NOT widen the allow-list — unrelated origin still 403', async () => {
    const started = await startHost({
      allowedOrigins: ['https://app.example.com'],
    });
    stop = started.stop;
    const res = await request(started.port, {
      path: '/sse',
      headers: {
        Origin: 'https://other.example.com',
        Authorization: `Bearer ${VALID_TOKEN}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('unknown route returns 404 (after auth)', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, {
      path: '/does-not-exist',
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('(b) valid token reaches /sse and SDK writes the endpoint preamble', async () => {
    const started = await startHost({});
    stop = started.stop;
    const stream = await openSseStream(started.port, {
      Authorization: `Bearer ${VALID_TOKEN}`,
    });
    try {
      expect(stream.statusCode).toBe(200);
      expect(stream.resHeaders['content-type']).toMatch(/text\/event-stream/);
      expect(stream.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      stream.close();
    }
  });

  it('POST /messages with unknown sessionId returns 404', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, {
      method: 'POST',
      path: '/messages?sessionId=00000000-0000-0000-0000-000000000000',
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /messages without sessionId returns 400', async () => {
    const started = await startHost({});
    stop = started.stop;
    const res = await request(started.port, {
      method: 'POST',
      path: '/messages',
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
  });

  // Pin the "missing Origin = treated as non-browser, allowed past CORS"
  // contract. This is the most security-load-bearing branch: a regression
  // that tightens it would silently break every non-browser MCP client
  // (curl, native CLI, Codex), and a regression that loosens it would
  // open browser cross-origin bypass when allowed_origins is non-empty.
  it('GET /sse with valid bearer and no Origin succeeds even with non-empty allow-list', async () => {
    const started = await startHost({
      allowedOrigins: ['http://localhost:5173'],
    });
    stop = started.stop;
    const stream = await openSseStream(started.port, {
      Authorization: `Bearer ${VALID_TOKEN}`,
    });
    try {
      expect(stream.statusCode).toBe(200);
      expect(stream.sessionId).toBeDefined();
    } finally {
      stream.close();
    }
  });

  it('OPTIONS preflight with no Origin gets 403', async () => {
    const started = await startHost({
      allowedOrigins: ['http://localhost:5173'],
    });
    stop = started.stop;
    const res = await request(started.port, {
      method: 'OPTIONS',
      path: '/sse',
      headers: { 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.statusCode).toBe(403);
  });

  // Lock down the access-log contract: the bearer token must NEVER appear
  // in any stderr line, regardless of whether the request was accepted,
  // rejected for auth, or rejected for origin. A future refactor that
  // started logging req.headers in full would have to defeat this test.
  it('access logs never contain the bearer token (happy + 401 + 403 paths)', async () => {
    const TOKEN = 'sentinel-token-do-not-leak-me-into-logs-please';
    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (
      chunk: string | Buffer,
      ...rest: any[]
    ): boolean => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stderrChunks.push(s);
      return origStderrWrite(chunk, ...rest);
    };
    const started = await startHost({
      authToken: TOKEN,
      allowedOrigins: ['http://localhost:5173'],
    });
    stop = started.stop;
    try {
      // (i) happy path
      const stream = await openSseStream(started.port, {
        Authorization: `Bearer ${TOKEN}`,
      });
      stream.close();
      // (ii) 401 — wrong token
      await request(started.port, {
        path: '/sse',
        headers: { Authorization: 'Bearer wrong-token-of-equal-length-to-real' },
      });
      // (iii) 403 — disallowed origin
      await request(started.port, {
        path: '/sse',
        headers: {
          Origin: 'http://evil.example.com',
          Authorization: `Bearer ${TOKEN}`,
        },
      });
    } finally {
      (process.stderr as any).write = origStderrWrite;
    }
    const captured = stderrChunks.join('');
    expect(captured).not.toContain(TOKEN);
    // Belt-and-braces: the token substring must not appear under any
    // partial-encoding or quoting either.
    expect(captured).not.toMatch(/sentinel-token/);
  });
});
