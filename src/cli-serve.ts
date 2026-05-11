import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runList } from './cli-list.js';
import { runSearch } from './cli-search.js';
import { runStats } from './cli-stats.js';
import type { DaemonCommand, DaemonRunResult } from './daemon-client.js';

export const SERVE_HELP = `kb serve — resident local daemon for warm CLI reads

Usage:
  kb serve [--host=127.0.0.1] [--port=17799] [--idle-timeout-ms=300000]

Starts a localhost-only JSON HTTP daemon used by \`kb search --daemon\`.
The daemon accepts read-only search/list/stats requests and exits after the
idle timeout.

Options:
  --host=<host>             Loopback host to bind (default: 127.0.0.1).
  --port=<port>             TCP port to bind (default: 17799; 0 for tests).
  --idle-timeout-ms=<ms>    Stop after this much idle time (default: 300000).
  --help, -h                Show this help.
`;

interface ServeArgs {
  host: string;
  port: number;
  idleTimeoutMs: number;
}

export interface DaemonCommandHandlers {
  search: (args: string[]) => Promise<DaemonRunResult>;
  list: (args: string[]) => Promise<DaemonRunResult>;
  stats: (args: string[]) => Promise<DaemonRunResult>;
}

export interface StartDaemonServerOptions extends Partial<ServeArgs> {
  handlers?: DaemonCommandHandlers;
}

export interface ResidentDaemon {
  server: http.Server;
  url: URL;
  stop: () => Promise<void>;
  closed: Promise<void>;
}

const DEFAULT_SERVE_ARGS: ServeArgs = {
  host: '127.0.0.1',
  port: 17799,
  idleTimeoutMs: 300_000,
};

export async function runServe(rest: string[]): Promise<number> {
  let parsed: ServeArgs;
  try {
    parsed = parseServeArgs(rest);
  } catch (err) {
    process.stderr.write(`kb serve: ${(err as Error).message}\n`);
    return 2;
  }

  let daemon: ResidentDaemon;
  try {
    daemon = await startDaemonServer(parsed);
  } catch (err) {
    process.stderr.write(`kb serve: ${(err as Error).message}\n`);
    return 1;
  }

  process.stdout.write(`kb serve: listening on ${daemon.url.href}\n`);
  const stop = () => {
    void daemon.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await daemon.closed;
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  return 0;
}

export async function startDaemonServer(
  options: StartDaemonServerOptions = {},
): Promise<ResidentDaemon> {
  const parsed: ServeArgs = {
    host: options.host ?? DEFAULT_SERVE_ARGS.host,
    port: options.port ?? DEFAULT_SERVE_ARGS.port,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_SERVE_ARGS.idleTimeoutMs,
  };
  assertLoopbackHost(parsed.host);
  const handlers = options.handlers ?? defaultHandlers();
  let idleTimer: NodeJS.Timeout | undefined;
  let queue: Promise<void> = Promise.resolve();

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const server = http.createServer((req, res) => {
    resetIdleTimer();
    void handleRequest(req, res, handlers, (job) => {
      queue = queue.then(job, job);
      return queue;
    });
  });

  server.on('close', () => {
    if (idleTimer) clearTimeout(idleTimer);
    resolveClosed();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(parsed.port, parsed.host);
  });

  resetIdleTimer();
  const address = server.address() as AddressInfo;
  const hostForUrl = parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host;
  return {
    server,
    url: new URL(`http://${hostForUrl}:${address.port}`),
    stop: () => new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
    closed,
  };

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (parsed.idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      void new Promise<void>((resolve) => server.close(() => resolve()));
    }, parsed.idleTimeoutMs);
  }
}

export function parseServeArgs(rest: string[]): ServeArgs {
  const out = { ...DEFAULT_SERVE_ARGS };
  for (const raw of rest) {
    if (raw.startsWith('--host=')) {
      out.host = raw.slice('--host='.length);
      continue;
    }
    if (raw.startsWith('--port=')) {
      const port = Number(raw.slice('--port='.length));
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid --port: ${raw}`);
      }
      out.port = port;
      continue;
    }
    if (raw.startsWith('--idle-timeout-ms=')) {
      const idleTimeoutMs = Number(raw.slice('--idle-timeout-ms='.length));
      if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 0) {
        throw new Error(`invalid --idle-timeout-ms: ${raw}`);
      }
      out.idleTimeoutMs = idleTimeoutMs;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${raw}`);
  }
  assertLoopbackHost(out.host);
  return out;
}

function defaultHandlers(): DaemonCommandHandlers {
  return {
    search: async (args) => captureProcessOutput(() => runSearch(args)),
    list: async (args) => captureProcessOutput(() => runList(args)),
    stats: async (args) => captureProcessOutput(() => runStats(args)),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handlers: DaemonCommandHandlers,
  enqueue: (job: () => Promise<void>) => Promise<void>,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    writeJson(res, 200, { status: 'ok' });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/run') {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    writeJson(res, 400, { error: 'invalid_json' });
    return;
  }

  const command = readDaemonCommand(payload);
  const args = readArgs(payload);
  if (command === null || args === null) {
    writeJson(res, 400, { error: 'invalid_request' });
    return;
  }
  if (command === 'search' && args.includes('--refresh')) {
    writeJson(res, 400, { error: 'read_only_daemon', message: 'kb serve does not run search --refresh' });
    return;
  }

  await enqueue(async () => {
    try {
      writeJson(res, 200, await handlers[command](args));
    } catch (err) {
      writeJson(res, 500, {
        exitCode: 1,
        stdout: '',
        stderr: `kb serve: ${(err as Error).message}\n`,
      });
    }
  });
}

function readDaemonCommand(payload: unknown): DaemonCommand | null {
  const command = (payload as { command?: unknown } | null)?.command;
  if (command === 'search' || command === 'list' || command === 'stats') return command;
  return null;
}

function readArgs(payload: unknown): string[] | null {
  const args = (payload as { args?: unknown } | null)?.args;
  if (!Array.isArray(args) || !args.every((item) => typeof item === 'string')) return null;
  return args;
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(`${JSON.stringify(payload)}\n`);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
      if (Buffer.concat(chunks).byteLength > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function captureProcessOutput(fn: () => Promise<number>): Promise<DaemonRunResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    stdoutChunks.push(String(chunk));
    const callback = args.find((arg): arg is (err?: Error) => void => typeof arg === 'function');
    if (callback) callback();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    stderrChunks.push(String(chunk));
    const callback = args.find((arg): arg is (err?: Error) => void => typeof arg === 'function');
    if (callback) callback();
    return true;
  }) as typeof process.stderr.write;
  try {
    const exitCode = await fn();
    return {
      exitCode,
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
    };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function assertLoopbackHost(host: string): void {
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return;
  throw new Error(`refusing to bind non-loopback host: ${host}`);
}
