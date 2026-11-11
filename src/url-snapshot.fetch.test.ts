// Issue #1201 — socket-level tests for `fetchUrlSnapshot`, the production
// fetcher behind `kb import-url`.
//
// `url-snapshot.test.ts` covers the pure helpers and the CLI tests inject a
// fake fetcher, so neither opens a real socket. These tests drive the real
// axios + http.Agent wiring against a local HTTP server bound to
// 127.0.0.1:0, using the `lookup` seam to control what DNS returns. They pin
// the behaviours a dependency bump could silently break: the connection-time
// DNS-rebinding guard, the byte cap, the timeout mapping and the redirect
// limit.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import {
  fetchUrlSnapshot,
  UrlSnapshotError,
  type DnsLookupAll,
  type FetchUrlOptions,
} from './url-snapshot.js';

interface SeenRequest {
  url: string;
  host: string | undefined;
}

let server: http.Server;
let port: number;
let seen: SeenRequest[] = [];

const LOOPBACK: LookupAddress = { address: '127.0.0.1', family: 4 };
// TEST-NET-3 (RFC 5737): a public-looking address the classifier allows. It
// is only ever returned by the stubbed lookup and never connected to.
const PUBLIC: LookupAddress = { address: '203.0.113.7', family: 4 };

function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  seen.push({ url: req.url ?? '', host: req.headers.host });
  const url = req.url ?? '/';
  if (url === '/doc') {
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    res.end('# Hello\n\nbody text\n');
    return;
  }
  if (url === '/start') {
    res.writeHead(302, { Location: '/doc' });
    res.end();
    return;
  }
  const loop = /^\/loop\/(\d+)$/.exec(url);
  if (loop !== null) {
    res.writeHead(302, { Location: `/loop/${Number(loop[1]) + 1}` });
    res.end();
    return;
  }
  if (url === '/endless') {
    // Streams forever without a Content-Length: only the axios byte cap can
    // end this request before the (long) timeout does.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const chunk = Buffer.alloc(1024, 'a');
    const pump = (): void => {
      if (res.destroyed) return;
      res.write(chunk, () => setImmediate(pump));
    };
    pump();
    return;
  }
  if (url === '/stall') {
    // Accept the request and never answer.
    return;
  }
  res.writeHead(404);
  res.end();
}

beforeAll(async () => {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
});

function options(overrides: Partial<FetchUrlOptions> = {}): FetchUrlOptions {
  return {
    maxBytes: 1024 * 1024,
    timeoutMs: 5000,
    maxRedirects: 5,
    allowLocalNetwork: true,
    ...overrides,
  };
}

/** A lookup that returns the queued answers in order (the last one repeats). */
function scriptedLookup(...answers: LookupAddress[][]): DnsLookupAll & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (hostname: string): Promise<LookupAddress[]> => {
    calls.push(hostname);
    return answers[Math.min(calls.length - 1, answers.length - 1)];
  };
  return Object.assign(fn, { calls });
}

async function expectSnapshotError(promise: Promise<unknown>): Promise<UrlSnapshotError> {
  const err = await promise.then(
    () => {
      throw new Error('expected fetchUrlSnapshot to reject');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UrlSnapshotError);
  return err as UrlSnapshotError;
}

describe('fetchUrlSnapshot against a local HTTP server', () => {
  it('returns the body, status, content type and final URL', async () => {
    const snapshot = await fetchUrlSnapshot(`http://127.0.0.1:${port}/doc`, options());

    expect(snapshot.httpStatus).toBe(200);
    expect(snapshot.contentType).toBe('text/markdown; charset=utf-8');
    expect(snapshot.body.toString('utf8')).toBe('# Hello\n\nbody text\n');
    expect(snapshot.finalUrl).toBe(`http://127.0.0.1:${port}/doc`);
    expect(seen).toEqual([{ url: '/doc', host: `127.0.0.1:${port}` }]);
  });

  it('follows a redirect and reports the final URL', async () => {
    const snapshot = await fetchUrlSnapshot(`http://127.0.0.1:${port}/start`, options());

    expect(snapshot.httpStatus).toBe(200);
    expect(snapshot.finalUrl).toBe(`http://127.0.0.1:${port}/doc`);
    expect(seen.map((r) => r.url)).toEqual(['/start', '/doc']);
  });

  it('connects through the agent lookup, pinning a named host to the address it returns', async () => {
    // `kb-fixture.invalid` does not resolve in real DNS, so reaching the
    // server proves the socket was opened through the injected lookup.
    const lookup = scriptedLookup([LOOPBACK]);
    const snapshot = await fetchUrlSnapshot(`http://kb-fixture.invalid:${port}/doc`, options(), {
      lookup,
    });

    expect(snapshot.httpStatus).toBe(200);
    expect(seen).toEqual([{ url: '/doc', host: `kb-fixture.invalid:${port}` }]);
    expect(lookup.calls).toEqual(['kb-fixture.invalid']);
  });
});

describe('fetchUrlSnapshot connection-time DNS-rebinding guard', () => {
  it('rejects a host that resolves public at pre-flight and loopback at connect', async () => {
    // First answer feeds the pre-flight check (passes), the second feeds the
    // http.Agent lookup at connect time (must be rejected).
    const lookup = scriptedLookup([PUBLIC], [LOOPBACK]);

    const err = await expectSnapshotError(
      fetchUrlSnapshot(
        `http://rebind.invalid:${port}/doc`,
        options({ allowLocalNetwork: false }),
        { lookup },
      ),
    );

    expect(err.message).toBe(
      'host rebind.invalid resolves to a private/loopback address: 127.0.0.1',
    );
    // The pre-flight message carries the `--allow-local-network` hint; the
    // connect-time guard's does not, so this pins which check fired.
    expect(err.message).not.toContain('--allow-local-network');
    expect(lookup.calls).toEqual(['rebind.invalid', 'rebind.invalid']);
    expect(seen).toHaveLength(0);
  });

  it('rejects at pre-flight when the host already resolves to loopback', async () => {
    const lookup = scriptedLookup([LOOPBACK]);

    const err = await expectSnapshotError(
      fetchUrlSnapshot(
        `http://private.invalid:${port}/doc`,
        options({ allowLocalNetwork: false }),
        { lookup },
      ),
    );

    expect(err.message).toContain('--allow-local-network');
    expect(lookup.calls).toEqual(['private.invalid']);
    expect(seen).toHaveLength(0);
  });
});

describe('fetchUrlSnapshot limits', () => {
  it('aborts an endless response at the byte cap instead of waiting for the timeout', async () => {
    const started = Date.now();
    const err = await expectSnapshotError(
      fetchUrlSnapshot(
        `http://127.0.0.1:${port}/endless`,
        options({ maxBytes: 64 * 1024, timeoutMs: 20_000 }),
      ),
    );

    expect(err.message).toBe(
      `response from http://127.0.0.1:${port}/endless exceeds the --max-bytes limit (65536 bytes)`,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('maps a stalled response to the timeout error', async () => {
    const err = await expectSnapshotError(
      fetchUrlSnapshot(`http://127.0.0.1:${port}/stall`, options({ timeoutMs: 200 })),
    );

    expect(err.message).toBe(`request to http://127.0.0.1:${port}/stall timed out after 200ms`);
    expect(seen.map((r) => r.url)).toEqual(['/stall']);
  });

  it('stops following redirects at the redirect limit', async () => {
    const err = await expectSnapshotError(
      fetchUrlSnapshot(`http://127.0.0.1:${port}/loop/0`, options({ maxRedirects: 2 })),
    );

    expect(err.message).toBe(
      `too many redirects (limit 2) starting from http://127.0.0.1:${port}/loop/0`,
    );
    // The original request plus exactly two followed hops.
    expect(seen.map((r) => r.url)).toEqual(['/loop/0', '/loop/1', '/loop/2']);
  });
});
