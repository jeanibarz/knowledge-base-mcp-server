import { describe, expect, it, jest } from '@jest/globals';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DaemonProtocolError,
  DaemonUnavailableError,
  daemonUrlFromEnv,
  fetchDaemonHealth,
  runDaemonCommand,
  tryFetchDaemonHealth,
  tryRunDaemonCommand,
  type SpawnDaemon,
} from './daemon-client.js';

async function withServer(
  handler: http.RequestListener,
  fn: (url: URL) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  try {
    await fn(new URL(`http://127.0.0.1:${address.port}`));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('daemon client', () => {
  it('builds a default loopback URL from env overrides', () => {
    expect(daemonUrlFromEnv({ KB_DAEMON_PORT: '18888' }).href).toBe('http://127.0.0.1:18888/');
    expect(daemonUrlFromEnv({ KB_DAEMON_URL: 'http://127.0.0.1:19999' }).href).toBe('http://127.0.0.1:19999/');
  });

  it('posts command requests and parses daemon output', async () => {
    await withServer((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/v1/run');
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        expect(JSON.parse(Buffer.concat(chunks).toString('utf-8'))).toEqual({
          command: 'search',
          args: ['hello'],
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exitCode: 0, stdout: 'ok\n', stderr: '' }));
      });
    }, async (url) => {
      await expect(runDaemonCommand('search', ['hello'], { env: { KB_DAEMON_URL: url.href } }))
        .resolves.toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' });
    });
  });

  it('returns null from tryRunDaemonCommand when the daemon is unreachable', async () => {
    const spawnImpl = jest.fn<SpawnDaemon>();
    const result = await tryRunDaemonCommand('search', ['q'], {
      env: { KB_DAEMON_URL: 'http://127.0.0.1:17798' },
      timeoutMs: 50,
      spawnImpl,
    });
    expect(result).toBeNull();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('treats malformed daemon payloads as protocol errors', async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stdout: 'missing exitCode', stderr: '' }));
    }, async (url) => {
      await expect(runDaemonCommand('search', ['q'], { env: { KB_DAEMON_URL: url.href } }))
        .rejects.toBeInstanceOf(DaemonProtocolError);
    });
  });

  it('reads the daemon lifecycle snapshot from GET /health', async () => {
    await withServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/health');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        pid: 4242,
        url: 'http://127.0.0.1:17799/',
        idle_timeout_ms: 300_000,
        commands: ['search', 'list', 'stats'],
        uptime_ms: 1234,
      }));
    }, async (url) => {
      await expect(fetchDaemonHealth({ env: { KB_DAEMON_URL: url.href } })).resolves.toEqual({
        status: 'ok',
        pid: 4242,
        url: 'http://127.0.0.1:17799/',
        idle_timeout_ms: 300_000,
        commands: ['search', 'list', 'stats'],
        uptime_ms: 1234,
      });
    });
  });

  it('tolerates an older daemon that only answers { status }', async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    }, async (url) => {
      await expect(fetchDaemonHealth({ env: { KB_DAEMON_URL: url.href } }))
        .resolves.toEqual({ status: 'ok' });
    });
  });

  it('returns null from tryFetchDaemonHealth when no daemon is listening', async () => {
    const result = await tryFetchDaemonHealth({
      env: { KB_DAEMON_URL: 'http://127.0.0.1:17798' },
      timeoutMs: 50,
    });
    expect(result).toBeNull();
  });

  it('treats a malformed /health payload as a protocol error', async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ commands: ['search'] }));
    }, async (url) => {
      await expect(fetchDaemonHealth({ env: { KB_DAEMON_URL: url.href } }))
        .rejects.toBeInstanceOf(DaemonProtocolError);
    });
  });

  it('autostarts a detached daemon and reruns the command after health is ready', async () => {
    let call = 0;
    const child = { once: jest.fn(() => child), unref: jest.fn() };
    const spawnImpl = jest.fn<SpawnDaemon>(() => child);
    const fetchImpl = jest.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      call += 1;
      const pathname = new URL(String(url)).pathname;
      if (call === 1 && pathname === '/v1/run') {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }
      if (call === 2 && pathname === '/health') {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }
      if (call === 3 && pathname === '/health') {
        return jsonResponse({ status: 'ok', commands: ['search', 'list', 'stats'] });
      }
      if (call === 4 && pathname === '/v1/run') {
        expect(init?.method).toBe('POST');
        return jsonResponse({ exitCode: 0, stdout: 'warm\n', stderr: '' });
      }
      throw new Error(`unexpected fetch call ${call} ${pathname}`);
    });
    const notices: string[] = [];

    const result = await tryRunDaemonCommand('search', ['q'], {
      env: { KB_DAEMON_AUTOSTART: 'on', KB_DAEMON_URL: 'http://127.0.0.1:17799/' },
      fetchImpl,
      spawnImpl,
      sleep: async () => {},
      notice: (message) => notices.push(message),
      autostartDeadlineMs: 1000,
    });

    expect(result).toEqual({ exitCode: 0, stdout: 'warm\n', stderr: '' });
    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['serve', '--owner=autostart']),
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(child.once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.unref).toHaveBeenCalled();
    expect(notices).toEqual([
      'kb daemon autostart: started kb serve; daemon is ready at http://127.0.0.1:17799/\n',
    ]);
  });

  it('does not autostart when an existing listener has a protocol mismatch', async () => {
    const spawnImpl = jest.fn<SpawnDaemon>();
    const fetchImpl = jest.fn(async (url: URL | RequestInfo) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/v1/run') {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }
      return jsonResponse({ service: 'not-kb' });
    });

    await expect(tryRunDaemonCommand('search', ['q'], {
      env: { KB_DAEMON_AUTOSTART: 'on', KB_DAEMON_URL: 'http://127.0.0.1:17799/' },
      fetchImpl,
      spawnImpl,
    })).rejects.toBeInstanceOf(DaemonProtocolError);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('re-polls readiness when spawn itself loses a startup race', async () => {
    let call = 0;
    const spawnImpl = jest.fn<SpawnDaemon>(() => {
      throw Object.assign(new Error('spawn EADDRINUSE'), { code: 'EADDRINUSE' });
    });
    const fetchImpl = jest.fn(async (url: URL | RequestInfo) => {
      call += 1;
      const pathname = new URL(String(url)).pathname;
      if (call === 1 && pathname === '/v1/run') {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }
      if (call === 2 && pathname === '/health') {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }
      if (call === 3 && pathname === '/health') {
        return jsonResponse({ status: 'ok', commands: ['search'] });
      }
      if (call === 4 && pathname === '/v1/run') {
        return jsonResponse({ exitCode: 0, stdout: 'won\n', stderr: '' });
      }
      throw new Error(`unexpected fetch call ${call} ${pathname}`);
    });

    await expect(tryRunDaemonCommand('search', ['q'], {
      env: { KB_DAEMON_AUTOSTART: 'on', KB_DAEMON_URL: 'http://127.0.0.1:17799/' },
      fetchImpl,
      spawnImpl,
      sleep: async () => {},
      notice: () => undefined,
    })).resolves.toEqual({ exitCode: 0, stdout: 'won\n', stderr: '' });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back cold with a notice when autostart readiness times out', async () => {
    const child = { once: jest.fn(() => child), unref: jest.fn() };
    const fetchImpl = jest.fn(async () => {
      throw new DaemonUnavailableError('kb daemon is not reachable', { cause: { code: 'ECONNREFUSED' } });
    });
    const notices: string[] = [];
    let now = 0;

    const result = await tryRunDaemonCommand('search', ['q'], {
      env: { KB_DAEMON_AUTOSTART: 'on', KB_DAEMON_URL: 'http://127.0.0.1:17799/' },
      fetchImpl,
      spawnImpl: jest.fn<SpawnDaemon>(() => child),
      sleep: async (ms) => { now += ms; },
      now: () => now,
      notice: (message) => notices.push(message),
      autostartDeadlineMs: 250,
      autostartPollIntervalMs: 100,
    });

    expect(result).toBeNull();
    expect(notices).toEqual([
      'kb daemon autostart: kb serve was not ready after 250ms; running command directly.\n',
    ]);
  });
});

function jsonResponse(payload: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
