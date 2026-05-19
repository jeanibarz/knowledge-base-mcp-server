import { afterEach, describe, expect, it } from '@jest/globals';
import * as http from 'node:http';
import { parseServeArgs, runServeStatus, startDaemonServer } from './cli-serve.js';
import type { DaemonRunResult } from './daemon-client.js';

interface RawResponse {
  statusCode: number;
  body: string;
}

function request(
  url: URL,
  options: { method?: string; path: string; body?: unknown },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
        }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

describe('kb serve daemon', () => {
  it('serves health and dispatches read-only commands through handlers', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const ok = (stdout: string): DaemonRunResult => ({ exitCode: 0, stdout, stderr: '' });
    const daemon = await startDaemonServer({
      port: 0,
      idleTimeoutMs: 0,
      handlers: {
        search: async (args) => {
          calls.push({ command: 'search', args });
          return ok('search output\n');
        },
        list: async (args) => {
          calls.push({ command: 'list', args });
          return ok('list output\n');
        },
        stats: async (args) => {
          calls.push({ command: 'stats', args });
          return ok('stats output\n');
        },
      },
    });
    try {
      const health = await request(daemon.url, { path: '/health' });
      expect(health.statusCode).toBe(200);
      const healthBody = JSON.parse(health.body);
      expect(healthBody).toMatchObject({
        status: 'ok',
        pid: process.pid,
        url: daemon.url.href,
        idle_timeout_ms: 0,
        commands: ['search', 'list', 'stats'],
      });
      expect(typeof healthBody.uptime_ms).toBe('number');
      expect(healthBody.uptime_ms).toBeGreaterThanOrEqual(0);

      const run = await request(daemon.url, {
        method: 'POST',
        path: '/v1/run',
        body: { command: 'search', args: ['hello', '--format=json'] },
      });
      expect(run.statusCode).toBe(200);
      expect(JSON.parse(run.body)).toEqual({ exitCode: 0, stdout: 'search output\n', stderr: '' });
      expect(calls).toEqual([{ command: 'search', args: ['hello', '--format=json'] }]);
    } finally {
      await daemon.stop();
    }
  });

  it('rejects mutating search refresh requests', async () => {
    const daemon = await startDaemonServer({ port: 0, idleTimeoutMs: 0 });
    try {
      const res = await request(daemon.url, {
        method: 'POST',
        path: '/v1/run',
        body: { command: 'search', args: ['q', '--refresh'] },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'read_only_daemon' });
    } finally {
      await daemon.stop();
    }
  });

  it('keeps serve binding loopback-only', () => {
    expect(() => parseServeArgs(['--host=0.0.0.0'])).toThrow(/non-loopback/);
  });
});

describe('kb serve status', () => {
  const originalDaemonUrl = process.env.KB_DAEMON_URL;

  afterEach(() => {
    if (originalDaemonUrl === undefined) delete process.env.KB_DAEMON_URL;
    else process.env.KB_DAEMON_URL = originalDaemonUrl;
  });

  async function captureStatus(args: string[]): Promise<{ code: number; stdout: string }> {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(String(chunk));
      const callback = rest.find((arg): arg is (err?: Error) => void => typeof arg === 'function');
      if (callback) callback();
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runServeStatus(args);
      return { code, stdout: chunks.join('') };
    } finally {
      process.stdout.write = originalWrite;
    }
  }

  it('reports a reachable daemon with its lifecycle details', async () => {
    const daemon = await startDaemonServer({ port: 0, idleTimeoutMs: 0 });
    process.env.KB_DAEMON_URL = daemon.url.href;
    try {
      const result = await captureStatus([]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('daemon running');
      expect(result.stdout).toContain(`pid:          ${process.pid}`);
      expect(result.stdout).toContain('commands:     search, list, stats');
    } finally {
      await daemon.stop();
    }
  });

  it('emits a machine-readable envelope with --json', async () => {
    const daemon = await startDaemonServer({ port: 0, idleTimeoutMs: 0 });
    process.env.KB_DAEMON_URL = daemon.url.href;
    try {
      const result = await captureStatus(['--json']);
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        reachable: true,
        url: daemon.url.href,
        daemon: { status: 'ok', commands: ['search', 'list', 'stats'] },
      });
    } finally {
      await daemon.stop();
    }
  });

  it('exits 3 and reports when no daemon is reachable', async () => {
    const daemon = await startDaemonServer({ port: 0, idleTimeoutMs: 0 });
    const url = daemon.url.href;
    await daemon.stop();
    process.env.KB_DAEMON_URL = url;

    const result = await captureStatus([]);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain(`no daemon reachable at ${url}`);

    const jsonResult = await captureStatus(['--json']);
    expect(jsonResult.code).toBe(3);
    expect(JSON.parse(jsonResult.stdout)).toEqual({ reachable: false, url });
  });

  it('rejects unknown arguments with exit code 2', async () => {
    const result = await captureStatus(['--bogus']);
    expect(result.code).toBe(2);
  });
});
