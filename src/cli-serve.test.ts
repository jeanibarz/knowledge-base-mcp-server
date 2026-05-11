import { describe, expect, it } from '@jest/globals';
import * as http from 'node:http';
import { parseServeArgs, startDaemonServer } from './cli-serve.js';
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
      expect(JSON.parse(health.body)).toEqual({ status: 'ok' });

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
