import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { runList } from './cli-list.js';
import { createRunSearchDeps, runSearch, type RunSearchDeps } from './cli-search.js';
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
  type DaemonOwnership,
  type DaemonPrewarmHealth,
  type DaemonRunResult,
} from './daemon-client.js';
import {
  DaemonAdmissionGate,
  DAEMON_RETRY_AFTER_SECONDS,
  resolveDaemonAdmissionConfig,
  type DaemonAdmissionConfig,
} from './daemon-admission.js';
import { formatKbStatsOpenMetrics } from './prometheus-export.js';
import { searchLatencyMetrics, type SearchLatencyMode } from './metrics.js';
import { searchStageDurationsFromTiming } from './timing-core.js';
import type { KbStatsPayload } from './kb-stats.js';
import { LexicalIndexCache } from './lexical-index-cache.js';
import type { LexicalIndex } from './lexical-index.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { modelDir, resolveActiveModel, resolveFaissIndexBinaryPath } from './active-model.js';
import { listKnowledgeBases } from './kb-fs.js';
import { logger } from './logger.js';

export const SERVE_HELP = `kb serve — resident local daemon for warm CLI reads

Usage:
  kb serve [--host=127.0.0.1] [--port=17799] [--idle-timeout-ms=300000] [--warm]
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
  --warm                    Pre-warm the active model, FAISS index, and
                            lexical indexes before the daemon reports ready.
  --json                    \`kb serve status\`: emit the daemon health JSON.
  --help, -h                Show this help.

Environment:
  KB_DAEMON_URL             Daemon URL queried by \`kb serve status\` and
                            \`kb search --daemon\` (default
                            http://127.0.0.1:17799).
  KB_METRICS_EXPORT         Set to \`on\` to expose OpenMetrics text at
                            \`GET /metrics\` on the loopback daemon.
  KB_DAEMON_MAX_CONCURRENCY Max requests the daemon runs at once before
                            queueing (default 8).
  KB_DAEMON_QUEUE_MAX       Max requests queued beyond the concurrency cap
                            before the daemon replies 429 + Retry-After
                            (default 128; 0 rejects immediately when full).
  KB_DAEMON_PREWARM         Set to \`on\` to enable the same startup pre-warm
                            as \`kb serve --warm\`.

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
  ownership: DaemonOwnership;
  warm: boolean;
}

export interface DaemonPrewarmResult {
  modelId: string;
  lexicalKbs: number;
}

export interface DaemonCommandHandlers {
  search: (args: string[]) => Promise<DaemonRunResult>;
  list: (args: string[]) => Promise<DaemonRunResult>;
  stats: (args: string[]) => Promise<DaemonRunResult>;
  prewarm?: () => Promise<DaemonPrewarmResult>;
}

export interface StartDaemonServerOptions extends Partial<ServeArgs> {
  handlers?: DaemonCommandHandlers;
  metricsHandler?: () => Promise<string>;
  /**
   * Admission-control bounds (issue #648). Defaults are resolved from
   * `KB_DAEMON_MAX_CONCURRENCY` / `KB_DAEMON_QUEUE_MAX`; tests pass an
   * explicit config so the cap/queue/429 behaviour is deterministic.
   */
  admission?: DaemonAdmissionConfig;
}

export interface DaemonCommandHandlerOptions {
  lexicalIndexLoader?: (kbName: string, kbPath: string) => Promise<LexicalIndex>;
  denseIndexMetadataReader?: (modelId: string) => Promise<DenseIndexMetadata>;
  knowledgeBasesRootDir?: string;
  listKnowledgeBasesImpl?: typeof listKnowledgeBases;
  resolveActiveModelImpl?: typeof resolveActiveModel;
  loadManagerForModel?: RunSearchDeps['loadManagerForModel'];
  loadWithJsonRetry?: RunSearchDeps['loadWithJsonRetry'];
  runSearchImpl?: typeof runSearch;
  runListImpl?: typeof runList;
  runStatsImpl?: typeof runStats;
}

interface DenseIndexMetadata {
  path: string | null;
  mtimeMs: number;
  size: number;
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
  ownership: 'manual',
  warm: false,
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
  if (health.ownership !== undefined) {
    lines.push(`  ownership:    ${health.ownership}`);
  }
  if (health.commands !== undefined) {
    lines.push(`  commands:     ${health.commands.join(', ')}`);
  }
  if (health.prewarm !== undefined) {
    lines.push(`  prewarm:      ${formatPrewarmStatus(health.prewarm)}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatPrewarmStatus(prewarm: DaemonPrewarmHealth): string {
  if (!prewarm.enabled || prewarm.status === 'disabled') return 'disabled';
  if (prewarm.status === 'ready') {
    return `ready${prewarm.model_id ? ` (${prewarm.model_id}, lexical_kbs=${prewarm.lexical_kbs ?? 0})` : ''}`;
  }
  if (prewarm.status === 'failed') {
    return `failed${prewarm.error ? ` (${prewarm.error})` : ''}`;
  }
  return prewarm.status;
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
    ownership: options.ownership ?? DEFAULT_SERVE_ARGS.ownership,
    warm: options.warm ?? DEFAULT_SERVE_ARGS.warm,
  };
  assertLoopbackHost(parsed.host);
  const handlers = options.handlers ?? createDaemonCommandHandlers();
  let prewarmHealth: DaemonPrewarmHealth = {
    enabled: parsed.warm,
    status: 'disabled',
  };
  if (parsed.warm) {
    prewarmHealth = await runDaemonPrewarm(handlers);
  }
  const baseMetricsHandler = options.metricsHandler ?? defaultMetricsHandler;
  const admission = new DaemonAdmissionGate(
    options.admission ?? resolveDaemonAdmissionConfig(),
  );
  // Always surface the daemon's admission gauge/counter on /metrics, even
  // when a custom metrics body is supplied, by splicing the lines in ahead
  // of the OpenMetrics `# EOF` terminator.
  const metricsHandler = async (): Promise<string> =>
    appendDaemonAdmissionMetrics(await baseMetricsHandler(), admission);
  let idleTimer: NodeJS.Timeout | undefined;
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
    ownership: parsed.ownership,
    commands: [...DAEMON_COMMANDS],
    uptime_ms: Date.now() - startedAt,
    prewarm: prewarmHealth,
  });

  const server = http.createServer((req, res) => {
    resetIdleTimer();
    void handleRequest(req, res, handlers, metricsHandler, buildHealth, admission);
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
  const out = { ...DEFAULT_SERVE_ARGS, warm: daemonPrewarmEnabledFromEnv(process.env) };
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
    if (raw.startsWith('--owner=')) {
      const ownership = raw.slice('--owner='.length);
      if (ownership !== 'manual' && ownership !== 'autostart') {
        throw new Error(`invalid --owner: ${raw}`);
      }
      out.ownership = ownership;
      continue;
    }
    if (raw === '--warm') {
      out.warm = true;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${raw}`);
  }
  assertLoopbackHost(out.host);
  return out;
}

function daemonPrewarmEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.KB_DAEMON_PREWARM?.trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes';
}

export function createDaemonCommandHandlers(options: DaemonCommandHandlerOptions = {}): DaemonCommandHandlers {
  const cache = new LexicalIndexCache();
  const loadLexicalIndex = options.lexicalIndexLoader ?? cache.load.bind(cache);
  const defaultSearchDeps = createRunSearchDeps();
  type SearchManager = Awaited<ReturnType<RunSearchDeps['loadManagerForModel']>>;
  const baseLoadManagerForModel = options.loadManagerForModel ?? defaultSearchDeps.loadManagerForModel;
  const baseLoadWithJsonRetry = options.loadWithJsonRetry ?? defaultSearchDeps.loadWithJsonRetry;
  const readDenseIndexMetadata = options.denseIndexMetadataReader ?? readCurrentDenseIndexMetadata;
  const managerCache = new Map<string, Promise<SearchManager>>();
  const loadedManagers = new WeakMap<object, DenseIndexMetadata>();
  const loadManagerForModel: RunSearchDeps['loadManagerForModel'] = async (modelId) => {
    const cached = managerCache.get(modelId);
    if (cached) return cached;
    const promise = baseLoadManagerForModel(modelId);
    managerCache.set(modelId, promise);
    try {
      return await promise;
    } catch (err) {
      if (managerCache.get(modelId) === promise) managerCache.delete(modelId);
      throw err;
    }
  };
  const loadWithJsonRetry: RunSearchDeps['loadWithJsonRetry'] = async (manager) => {
    const before = await readDenseIndexMetadata(manager.modelId);
    const loaded = loadedManagers.get(manager);
    if (loaded !== undefined && sameDenseIndexMetadata(loaded, before)) return;
    await baseLoadWithJsonRetry(manager);
    loadedManagers.set(manager, await readDenseIndexMetadata(manager.modelId));
  };
  const resolveActiveModelImpl = options.resolveActiveModelImpl ?? resolveActiveModel;
  const listKnowledgeBasesImpl = options.listKnowledgeBasesImpl ?? listKnowledgeBases;
  const knowledgeBasesRootDir = options.knowledgeBasesRootDir ?? KNOWLEDGE_BASES_ROOT_DIR;
  const searchDeps: RunSearchDeps = createRunSearchDeps({
    resolveActiveModel: resolveActiveModelImpl,
    loadManagerForModel,
    loadWithJsonRetry,
    loadLexicalIndex,
    onSearchTiming: (record) => {
      searchLatencyMetrics.record({
        mode: record.mode,
        status: record.status,
        totalMs: record.totalMs,
        stageDurationsMs: searchStageDurationsFromTiming(record.timing),
      });
    },
  });
  const runSearchImpl = options.runSearchImpl ?? runSearch;
  const runListImpl = options.runListImpl ?? runList;
  const runStatsImpl = options.runStatsImpl ?? runStats;
  return {
    search: async (args) => {
      const startedAt = Date.now();
      const result = await captureProcessOutput(() => runSearchImpl(args, searchDeps));
      if (result.exitCode !== 0) {
        searchLatencyMetrics.record({
          mode: requestedSearchModeFromArgs(args),
          status: 'error',
          totalMs: Date.now() - startedAt,
        });
      }
      return result;
    },
    list: async (args) => captureProcessOutput(() => runListImpl(args)),
    stats: async (args) => captureProcessOutput(() => runStatsImpl(args, undefined, { preferDaemon: false })),
    prewarm: async () => {
      const activeModelId = await resolveActiveModelImpl();
      const manager = await loadManagerForModel(activeModelId);
      await loadWithJsonRetry(manager);
      const kbNames = await listKnowledgeBasesImpl(knowledgeBasesRootDir);
      for (const kbName of kbNames) {
        await loadLexicalIndex(kbName, path.join(knowledgeBasesRootDir, kbName));
      }
      return { modelId: activeModelId, lexicalKbs: kbNames.length };
    },
  };
}

async function readCurrentDenseIndexMetadata(modelId: string): Promise<DenseIndexMetadata> {
  const activeVersionMetadata = await readActiveVersionIndexMetadata(modelId);
  if (activeVersionMetadata !== null) return activeVersionMetadata;
  const indexPath = await resolveFaissIndexBinaryPath(modelId);
  if (indexPath === null) return { path: null, mtimeMs: 0, size: 0 };
  try {
    const stat = await fsp.stat(indexPath);
    return { path: indexPath, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { path: null, mtimeMs: 0, size: 0 };
    throw err;
  }
}

async function readActiveVersionIndexMetadata(modelId: string): Promise<DenseIndexMetadata | null> {
  const symlinkPath = path.join(modelDir(modelId), 'index');
  let resolvedDir: string;
  try {
    const st = await fsp.lstat(symlinkPath);
    if (!st.isSymbolicLink()) return null;
    resolvedDir = await fsp.realpath(symlinkPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }

  for (const filename of ['faiss.index', 'hnsw.index']) {
    const indexPath = path.join(resolvedDir, filename);
    try {
      const stat = await fsp.stat(indexPath);
      return { path: indexPath, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
  }
  return null;
}

function sameDenseIndexMetadata(a: DenseIndexMetadata, b: DenseIndexMetadata): boolean {
  return a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

async function runDaemonPrewarm(handlers: DaemonCommandHandlers): Promise<DaemonPrewarmHealth> {
  if (handlers.prewarm === undefined) {
    return {
      enabled: true,
      status: 'failed',
      error: 'daemon handlers do not support prewarm',
      updated_at: new Date().toISOString(),
    };
  }
  try {
    const result = await handlers.prewarm();
    logger.info(
      `kb serve: prewarmed active model ${result.modelId} and ${result.lexicalKbs} lexical indexes`,
    );
    return {
      enabled: true,
      status: 'ready',
      model_id: result.modelId,
      lexical_kbs: result.lexicalKbs,
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    const error = (err as Error).message;
    logger.warn(`kb serve: startup prewarm failed; continuing with lazy loading: ${error}`);
    return {
      enabled: true,
      status: 'failed',
      error,
      updated_at: new Date().toISOString(),
    };
  }
}

function requestedSearchModeFromArgs(args: readonly string[]): SearchLatencyMode {
  const modeFlag = args.find((arg) => arg === '--mode' || arg.startsWith('--mode='));
  if (modeFlag === undefined) return 'dense';
  const raw = modeFlag === '--mode'
    ? args[args.indexOf(modeFlag) + 1]
    : modeFlag.slice('--mode='.length);
  if (raw === 'dense' || raw === 'lexical' || raw === 'hybrid' || raw === 'auto') {
    return raw;
  }
  return 'unknown';
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handlers: DaemonCommandHandlers,
  metricsHandler: () => Promise<string>,
  buildHealth: () => DaemonHealth,
  admission: DaemonAdmissionGate,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, buildHealth());
    return;
  }
  if (url.pathname === '/metrics') {
    // /metrics stays outside admission control: scraping must keep working
    // under load, which is exactly when the daemon_inflight / rejected
    // gauges matter most.
    await handleMetricsRequest(req, res, metricsHandler);
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

  const accepted = admission.run(async () => {
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
  if (accepted === null) {
    rejectOverloaded(res);
    return;
  }
  await accepted;
}

/**
 * Admission-control rejection (issue #648): the concurrency slots and the
 * bounded queue are both full, so shed load with a fast `429` and a
 * `Retry-After` hint rather than letting the backlog grow without limit.
 */
function rejectOverloaded(res: http.ServerResponse): void {
  res.setHeader('Retry-After', String(DAEMON_RETRY_AFTER_SECONDS));
  writeJson(res, 429, {
    error: 'too_many_requests',
    message: 'kb serve: daemon at capacity; retry after backoff',
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
}

/**
 * Splice the daemon admission-control metrics (issue #648) into an
 * OpenMetrics body ahead of its `# EOF` terminator. The counter family
 * name omits the `_total` suffix to match the convention in
 * prometheus-export.ts (`metricFamilyName`).
 */
export function appendDaemonAdmissionMetrics(
  body: string,
  gate: { inFlight: number; rejectedTotal: number },
): string {
  const lines = [
    '# HELP kb_daemon_inflight Admitted-but-incomplete kb serve daemon requests (running + queued).',
    '# TYPE kb_daemon_inflight gauge',
    `kb_daemon_inflight ${gate.inFlight}`,
    '# HELP kb_daemon_rejected Total kb serve daemon requests rejected by admission control.',
    '# TYPE kb_daemon_rejected counter',
    `kb_daemon_rejected_total ${gate.rejectedTotal}`,
  ];
  const eofMarker = '# EOF\n';
  if (body.endsWith(eofMarker)) {
    return `${body.slice(0, -eofMarker.length)}${lines.join('\n')}\n${eofMarker}`;
  }
  return `${body}${lines.join('\n')}\n`;
}

async function defaultMetricsHandler(): Promise<string> {
  const result = await createDaemonCommandHandlers().stats(['--format=json']);
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
