import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runList } from './cli-list.js';
import { runSearch } from './cli-search.js';
import { captureProcessOutput } from './cli-shared.js';
import { runStats } from './cli-stats.js';
import {
  isMetricsExportEnabled,
  OPENMETRICS_CONTENT_TYPE,
} from './config/metrics-export.js';
import {
  daemonUrlFromEnv,
  tryFetchDaemonHealth,
  type DaemonCommand,
  type DaemonHealth,
  type DaemonRunResult,
} from './daemon-client.js';
import { formatKbStatsOpenMetrics } from './prometheus-export.js';
import type { KbStatsPayload } from './kb-stats.js';

export const SERVE_HELP = `kb serve — resident local daemon for warm CLI reads

Usage:
  kb serve [--host=127.0.0.1] [--port=17799] [--idle-timeout-ms=300000]
  kb serve status [--json]

Starts a localhost-only JSON HTTP daemon used by \`kb search --daemon\`.
The daemon accepts read-only search/list/stats requests and exits after the
idle timeout.

\`kb serve status\` reports whether a daemon is reachable at the configured
URL along with its PID, idle timeout, supported commands, and uptime. It
never starts or stops a daemon. When \`kb search --daemon\` cannot reach a
daemon it prints a one-line notice to stderr and runs the search directly.

Options:
  --host=<host>             Loopback host to bind (default: 127.0.0.1).
  --port=<port>             TCP port to bind (default: 17799; 0 for tests).
  --idle-timeout-ms=<ms>    Stop after this much idle time (default: 300000).
  --json                    \`kb serve status\`: emit the daemon health JSON.
  --help, -h                Show this help.

Environment:
  KB_DAEMON_URL             Daemon URL queried by \`kb serve status\` and
                            \`kb search --daemon\` (default
                            http://127.0.0.1:17799).
  KB_METRICS_EXPORT         Set to \`on\` to expose OpenMetrics text at
                            \`GET /metrics\` on the loopback daemon.

Exit codes:
  0   daemon started, or \`kb serve status\` found a reachable daemon
  1   runtime error
  2   invalid arguments or environment
  3   \`kb serve status\`: no daemon reachable at the configured URL
`;

/** Read-only commands the daemon accepts, advertised by \`GET /health\`. */
const DAEMON_COMMANDS: readonly DaemonCommand[] = ['search', 'list', 'stats'];

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
  metricsHandler?: () => Promise<string>;
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
  if (rest[0] === 'status') {
    return runServeStatus(rest.slice(1));
  }

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

/**
 * `kb serve status` — a read-only lifecycle probe for the resident daemon.
 *
 * Queries `GET /health` at the configured `KB_DAEMON_URL` and reports
 * reachability without ever starting or stopping a daemon. Exit codes: 0
 * reachable, 2 bad argument/environment, 3 no daemon listening, 1 a daemon
 * answered with an unusable payload.
 */
export async function runServeStatus(args: string[]): Promise<number> {
  let json = false;
  for (const raw of args) {
    if (raw === '--json') {
      json = true;
      continue;
    }
    process.stderr.write(`kb serve status: unexpected argument: ${raw}\n`);
    return 2;
  }

  let url: URL;
  try {
    url = daemonUrlFromEnv();
  } catch (err) {
    process.stderr.write(`kb serve status: ${(err as Error).message}\n`);
    return 2;
  }

  let health: DaemonHealth | null;
  try {
    health = await tryFetchDaemonHealth();
  } catch (err) {
    // A daemon answered but its /health payload was unusable.
    process.stderr.write(`kb serve status: ${(err as Error).message}\n`);
    return 1;
  }

  if (health === null) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ reachable: false, url: url.href })}\n`);
    } else {
      process.stdout.write(`kb serve: no daemon reachable at ${url.href}\n`);
      process.stdout.write('  start one with: kb serve\n');
    }
    return 3;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ reachable: true, url: url.href, daemon: health })}\n`);
  } else {
    process.stdout.write(formatServeStatus(health, url));
  }
  return 0;
}

function formatServeStatus(health: DaemonHealth, queriedUrl: URL): string {
  const lines = [`kb serve: daemon running at ${health.url ?? queriedUrl.href}`];
  if (health.pid !== undefined) lines.push(`  pid:          ${health.pid}`);
  if (health.uptime_ms !== undefined) {
    lines.push(`  uptime:       ${formatDuration(health.uptime_ms)}`);
  }
  if (health.idle_timeout_ms !== undefined) {
    lines.push(
      `  idle timeout: ${health.idle_timeout_ms === 0 ? 'disabled' : formatDuration(health.idle_timeout_ms)}`,
    );
  }
  if (health.commands !== undefined) {
    lines.push(`  commands:     ${health.commands.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
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
  const metricsHandler = options.metricsHandler ?? defaultMetricsHandler;
  let idleTimer: NodeJS.Timeout | undefined;
  let queue: Promise<void> = Promise.resolve();
  const startedAt = Date.now();
  let boundUrl = '';

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const buildHealth = (): DaemonHealth => ({
    status: 'ok',
    pid: process.pid,
    url: boundUrl,
    idle_timeout_ms: parsed.idleTimeoutMs,
    commands: [...DAEMON_COMMANDS],
    uptime_ms: Date.now() - startedAt,
  });

  const server = http.createServer((req, res) => {
    resetIdleTimer();
    void handleRequest(req, res, handlers, metricsHandler, buildHealth, (job) => {
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
  const url = new URL(`http://${hostForUrl}:${address.port}`);
  boundUrl = url.href;
  return {
    server,
    url,
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
  metricsHandler: () => Promise<string>,
  buildHealth: () => DaemonHealth,
  enqueue: (job: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, buildHealth());
    return;
  }
  if (url.pathname === '/metrics') {
    await handleMetricsRequest(req, res, metricsHandler, enqueue);
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/run') {
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

async function handleMetricsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  metricsHandler: () => Promise<string>,
  enqueue: (job: () => Promise<void>) => Promise<void>,
): Promise<void> {
  if (!isMetricsExportEnabled()) {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    writeJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  await enqueue(async () => {
    try {
      const body = await metricsHandler();
      res.writeHead(200, {
        'Content-Type': OPENMETRICS_CONTENT_TYPE,
        'Cache-Control': 'no-store',
      });
      if (method === 'GET') res.end(body);
      else res.end();
    } catch (err) {
      writeJson(res, 500, {
        error: 'metrics_unavailable',
        message: (err as Error).message,
      });
    }
  });
}

async function defaultMetricsHandler(): Promise<string> {
  const result = await defaultHandlers().stats(['--format=json']);
  return formatStatsRunResultAsOpenMetrics(result);
}

export function formatStatsRunResultAsOpenMetrics(result: DaemonRunResult): string {
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || 'kb stats failed');
  }
  const payload = JSON.parse(result.stdout) as KbStatsPayload;
  return formatKbStatsOpenMetrics(payload);
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

function assertLoopbackHost(host: string): void {
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return;
  throw new Error(`refusing to bind non-loopback host: ${host}`);
}
