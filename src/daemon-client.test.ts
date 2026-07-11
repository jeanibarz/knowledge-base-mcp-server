import { describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_DAEMON_CLIENT_TIMEOUT_MS,
  DEFAULT_DAEMON_HEALTH_TIMEOUT_MS,
  DaemonProtocolError,
  DaemonUnavailableError,
  daemonEndpointFromEnv,
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

async function withUnixSocketServer(
  handler: http.RequestListener,
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-daemon-client-'));
  const socketPath = path.join(tempDir, 'daemon.sock');
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  try {
    await fn(socketPath);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

describe('daemon client', () => {
  const itUnix = process.platform === 'win32' ? it.skip : it;

  it('preserves the legacy request timeout default', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = pendingFetch();
      const request = runDaemonCommand('search', ['q'], {
        env: { KB_DAEMON_URL: 'http://127.0.0.1:17799/' },
        fetchImpl,
      });
      const rejection = expect(request).rejects.toBeInstanceOf(DaemonUnavailableError);
      await jest.advanceTimersByTimeAsync(DEFAULT_DAEMON_CLIENT_TIMEOUT_MS - 1);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await rejection;
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves the legacy health timeout default', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = pendingFetch();
      const health = fetchDaemonHealth({
        env: { KB_DAEMON_URL: 'http://127.0.0.1:17799/' },
        fetchImpl,
      });
      const rejection = expect(health).rejects.toBeInstanceOf(DaemonUnavailableError);
      await jest.advanceTimersByTimeAsync(DEFAULT_DAEMON_HEALTH_TIMEOUT_MS - 1);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await rejection;
    } finally {
      jest.useRealTimers();
    }
  });

  it('builds a default loopback URL from env overrides', () => {
    expect(daemonUrlFromEnv({ KB_DAEMON_PORT: '18888' }).href).toBe('http://127.0.0.1:18888/');
    expect(daemonUrlFromEnv({ KB_DAEMON_URL: 'http://127.0.0.1:19999' }).href).toBe('http://127.0.0.1:19999/');
  });

  itUnix('builds a Unix-domain socket endpoint from KB_DAEMON_SOCKET', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-daemon-client-'));
    const socketPath = path.join(tempDir, 'daemon.sock');
    try {
      expect(daemonUrlFromEnv({ KB_DAEMON_SOCKET: socketPath }).href).toBe(`unix://${socketPath}`);
      expect(daemonEndpointFromEnv({ KB_DAEMON_SOCKET: socketPath })).toEqual({
        url: new URL(`unix://${socketPath}`),
        socketPath,
      });
      expect(daemonUrlFromEnv({
        KB_DAEMON_URL: 'http://127.0.0.1:19999',
        KB_DAEMON_SOCKET: socketPath,
      }).href).toBe('http://127.0.0.1:19999/');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
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

  it('uses the configured daemon request timeout and preserves the explicit override', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = pendingFetch();
      const configured = runDaemonCommand('search', ['q'], {
        env: {
          KB_DAEMON_URL: 'http://127.0.0.1:17799/',
          KB_DAEMON_CLIENT_TIMEOUT_MS: '2400',
        },
        fetchImpl,
      });
      const configuredRejection = expect(configured).rejects.toBeInstanceOf(DaemonUnavailableError);
      await jest.advanceTimersByTimeAsync(2399);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await configuredRejection;

      const overridden = runDaemonCommand('search', ['q'], {
        env: {
          KB_DAEMON_URL: 'http://127.0.0.1:17799/',
          KB_DAEMON_CLIENT_TIMEOUT_MS: '2400',
        },
        fetchImpl,
        timeoutMs: 25,
      });
      const overriddenRejection = expect(overridden).rejects.toBeInstanceOf(DaemonUnavailableError);
      await jest.advanceTimersByTimeAsync(25);
      await overriddenRejection;
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects invalid configured daemon request timeouts', async () => {
    await expect(runDaemonCommand('search', ['q'], {
      env: {
        KB_DAEMON_URL: 'http://127.0.0.1:17799/',
        KB_DAEMON_CLIENT_TIMEOUT_MS: '300001',
      },
      fetchImpl: jest.fn<typeof fetch>(),
    })).rejects.toThrow('invalid KB_DAEMON_CLIENT_TIMEOUT_MS: 300001');
  });

  itUnix('posts command requests over a Unix-domain socket', async () => {
    await withUnixSocketServer((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/v1/run');
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        expect(JSON.parse(Buffer.concat(chunks).toString('utf-8'))).toEqual({
          command: 'stats',
          args: ['--format=json'],
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exitCode: 0, stdout: '{}\n', stderr: '' }));
      });
    }, async (socketPath) => {
      await expect(runDaemonCommand('stats', ['--format=json'], { env: { KB_DAEMON_SOCKET: socketPath } }))
        .resolves.toEqual({ exitCode: 0, stdout: '{}\n', stderr: '' });
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

  it('uses the configured health timeout independently of the request timeout', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = pendingFetch();
      const health = fetchDaemonHealth({
        env: {
          KB_DAEMON_URL: 'http://127.0.0.1:17799/',
          KB_DAEMON_CLIENT_TIMEOUT_MS: '2400',
          KB_DAEMON_HEALTH_TIMEOUT_MS: '700',
        },
        fetchImpl,
      });
      const healthRejection = expect(health).rejects.toBeInstanceOf(DaemonUnavailableError);
      await jest.advanceTimersByTimeAsync(699);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await healthRejection;
    } finally {
      jest.useRealTimers();
    }
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

  it('caps autostart preflight health by the outer readiness deadline', async () => {
    jest.useFakeTimers();
    try {
      const child = { once: jest.fn(() => child), unref: jest.fn() };
      const spawnImpl = jest.fn<SpawnDaemon>(() => child);
      const healthSignals: AbortSignal[] = [];
      const fetchImpl = jest.fn((url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        if (new URL(String(url)).pathname === '/v1/run') {
          return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
        }
        if (init?.signal != null) healthSignals.push(init.signal);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      });
      const result = tryRunDaemonCommand('search', ['q'], {
        env: {
          KB_DAEMON_AUTOSTART: 'on',
          KB_DAEMON_URL: 'http://127.0.0.1:17799/',
          KB_DAEMON_HEALTH_TIMEOUT_MS: '1000',
        },
        fetchImpl,
        spawnImpl,
        autostartDeadlineMs: 250,
        notice: () => undefined,
      });
      const resultExpectation = expect(result).resolves.toBeNull();
      await jest.advanceTimersByTimeAsync(249);
      expect(healthSignals[0]?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(2);
      await resultExpectation;
      expect(healthSignals[0]?.aborted).toBe(true);
      expect(spawnImpl).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

function jsonResponse(payload: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pendingFetch(): jest.MockedFunction<typeof fetch> {
  return jest.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as jest.MockedFunction<typeof fetch>;
}
