import { describe, expect, it } from '@jest/globals';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DaemonProtocolError,
  daemonUrlFromEnv,
  runDaemonCommand,
  tryRunDaemonCommand,
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
    const result = await tryRunDaemonCommand('search', ['q'], {
      env: { KB_DAEMON_URL: 'http://127.0.0.1:17798' },
      timeoutMs: 50,
    });
    expect(result).toBeNull();
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
});
