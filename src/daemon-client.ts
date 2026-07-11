import { spawn } from 'node:child_process';
import * as http from 'node:http';

export interface DaemonRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type DaemonCommand = 'search' | 'list' | 'stats';
export type DaemonOwnership = 'manual' | 'autostart';

export interface DaemonPrewarmHealth {
  enabled: boolean;
  status: 'disabled' | 'ready' | 'failed';
  model_id?: string;
  lexical_kbs?: number;
  error?: string;
  updated_at?: string;
}

/**
 * Lifecycle snapshot returned by the daemon's `GET /health` endpoint and
 * surfaced verbatim by `kb serve status --json`. Every field beyond `status`
 * is optional so a newer client stays compatible with an older daemon that
 * only answers `{ status: 'ok' }`.
 */
export interface DaemonHealth {
  status: string;
  pid?: number;
  url?: string;
  idle_timeout_ms?: number;
  ownership?: DaemonOwnership;
  commands?: string[];
  uptime_ms?: number;
  prewarm?: DaemonPrewarmHealth;
}

export interface DaemonEndpoint {
  url: URL;
  socketPath?: string;
}

interface SpawnedDaemonProcess {
  once(event: 'error', listener: (err: Error) => void): SpawnedDaemonProcess;
  unref(): void;
}

export type SpawnDaemon = (
  command: string,
  args: string[],
  options: { detached: true; stdio: 'ignore'; env: NodeJS.ProcessEnv },
) => SpawnedDaemonProcess;

export interface DaemonClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  spawnImpl?: SpawnDaemon;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  notice?: (message: string) => void;
  autostartDeadlineMs?: number;
  autostartPollIntervalMs?: number;
}

const DEFAULT_AUTOSTART_DEADLINE_MS = 3_000;
const DEFAULT_AUTOSTART_POLL_INTERVAL_MS = 100;
export const DEFAULT_DAEMON_CLIENT_TIMEOUT_MS = 1_500;
export const DEFAULT_DAEMON_HEALTH_TIMEOUT_MS = 500;
export const MAX_DAEMON_CLIENT_TIMEOUT_MS = 300_000;
const MAX_UNIX_SOCKET_PATH_BYTES = 107;

export class DaemonUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DaemonUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonProtocolError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function daemonUrlFromEnv(env: NodeJS.ProcessEnv = process.env): URL {
  return daemonEndpointFromEnv(env).url;
}

export function daemonEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): DaemonEndpoint {
  if (env.KB_DAEMON_URL !== undefined && env.KB_DAEMON_URL.trim() !== '') {
    return { url: new URL(env.KB_DAEMON_URL) };
  }
  const socketPath = daemonSocketPathFromEnv(env);
  if (socketPath !== null) {
    return { url: daemonSocketUrl(socketPath), socketPath };
  }
  const host = env.KB_DAEMON_HOST?.trim() || '127.0.0.1';
  const portRaw = env.KB_DAEMON_PORT?.trim() || '17799';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DaemonProtocolError(`invalid KB_DAEMON_PORT: ${portRaw}`);
  }
  return { url: new URL(`http://${host}:${port}`) };
}

export async function tryRunDaemonCommand(
  command: DaemonCommand,
  args: string[],
  options: DaemonClientOptions = {},
): Promise<DaemonRunResult | null> {
  try {
    return await runDaemonCommand(command, args, options);
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      if (!daemonAutostartEnabled(options.env) || !isSafeNoListenerFailure(err)) return null;
      return runDaemonCommandAfterAutostart(command, args, options);
    }
    throw err;
  }
}

export async function runDaemonCommand(
  command: DaemonCommand,
  args: string[],
  options: DaemonClientOptions = {},
): Promise<DaemonRunResult> {
  const baseEndpoint = daemonEndpointFromEnv(options.env);
  const endpoint = new URL('/v1/run', baseEndpoint.url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), daemonRequestTimeoutMs(options));
  try {
    const response = await requestDaemonEndpoint(baseEndpoint, endpoint, {
      fetchImpl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, args }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new DaemonProtocolError(`daemon returned HTTP ${response.status}${text ? `: ${text}` : ''}`);
    }
    const payload = await response.json();
    return parseDaemonRunResult(payload);
  } catch (err) {
    rethrowDaemonFetchError(err, baseEndpoint.url.href);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Query the daemon's `GET /health` endpoint without running a command.
 *
 * Throws {@link DaemonUnavailableError} when nothing is listening and
 * {@link DaemonProtocolError} when a daemon answers with an unusable payload.
 */
export async function fetchDaemonHealth(
  options: DaemonClientOptions = {},
): Promise<DaemonHealth> {
  const baseEndpoint = daemonEndpointFromEnv(options.env);
  const endpoint = new URL('/health', baseEndpoint.url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), daemonHealthTimeoutMs(options));
  try {
    const response = await requestDaemonEndpoint(baseEndpoint, endpoint, {
      fetchImpl,
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new DaemonProtocolError(`daemon returned HTTP ${response.status}${text ? `: ${text}` : ''}`);
    }
    return parseDaemonHealth(await response.json());
  } catch (err) {
    rethrowDaemonFetchError(err, baseEndpoint.url.href);
  } finally {
    clearTimeout(timeout);
  }
}

function daemonSocketPathFromEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = env.KB_DAEMON_SOCKET?.trim();
  if (raw === undefined || raw === '') return null;
  assertDaemonSocketPath(raw, 'KB_DAEMON_SOCKET');
  return raw;
}

export function assertDaemonSocketPath(socketPath: string, source = 'socket path'): void {
  if (socketPath.trim() === '') {
    throw new DaemonProtocolError(`invalid ${source}: empty path`);
  }
  if (process.platform === 'win32') {
    throw new DaemonProtocolError(`${source} is not supported on Windows`);
  }
  if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new DaemonProtocolError(
      `invalid ${source}: path is too long for a Unix-domain socket (${Buffer.byteLength(socketPath)} > ${MAX_UNIX_SOCKET_PATH_BYTES} bytes)`,
    );
  }
}

function daemonSocketUrl(socketPath: string): URL {
  return new URL(`unix://${socketPath}`);
}

interface DaemonRequestOptions {
  fetchImpl: typeof fetch;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

interface DaemonResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

async function requestDaemonEndpoint(
  baseEndpoint: DaemonEndpoint,
  endpoint: URL,
  options: DaemonRequestOptions,
): Promise<DaemonResponse> {
  if (baseEndpoint.socketPath === undefined) {
    return options.fetchImpl(endpoint, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    });
  }

  return requestUnixSocketEndpoint(baseEndpoint.socketPath, endpoint, options);
}

function requestUnixSocketEndpoint(
  socketPath: string,
  endpoint: URL,
  options: DaemonRequestOptions,
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: options.method,
        path: `${endpoint.pathname}${endpoint.search}`,
        headers: options.headers,
        signal: options.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/**
 * Like {@link fetchDaemonHealth} but resolves to `null` when no daemon is
 * reachable, so callers can render a "not running" status without a try/catch.
 */
export async function tryFetchDaemonHealth(
  options: DaemonClientOptions = {},
): Promise<DaemonHealth | null> {
  try {
    return await fetchDaemonHealth(options);
  } catch (err) {
    if (err instanceof DaemonUnavailableError) return null;
    throw err;
  }
}

/**
 * Re-throw a `fetch` failure as a {@link DaemonUnavailableError} when it looks
 * like nothing is listening; pass {@link DaemonProtocolError} and anything
 * unexpected through unchanged.
 */
function rethrowDaemonFetchError(err: unknown, endpointHref: string): never {
  if (err instanceof DaemonProtocolError) throw err;
  const code = errorCode(err);
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    (err as Error | undefined)?.name === 'AbortError' ||
    (err as Error | undefined)?.name === 'TypeError'
  ) {
    throw new DaemonUnavailableError(`kb daemon is not reachable at ${endpointHref}`, { cause: err });
  }
  throw err;
}

function parseDaemonRunResult(payload: unknown): DaemonRunResult {
  if (typeof payload !== 'object' || payload === null) {
    throw new DaemonProtocolError('daemon returned a non-object payload');
  }
  const obj = payload as Partial<DaemonRunResult>;
  const exitCode = obj.exitCode;
  if (!Number.isInteger(exitCode)) {
    throw new DaemonProtocolError('daemon response missing integer exitCode');
  }
  if (typeof obj.stdout !== 'string' || typeof obj.stderr !== 'string') {
    throw new DaemonProtocolError('daemon response missing stdout/stderr strings');
  }
  return {
    exitCode: exitCode as number,
    stdout: obj.stdout,
    stderr: obj.stderr,
  };
}

function parseDaemonHealth(payload: unknown): DaemonHealth {
  if (typeof payload !== 'object' || payload === null) {
    throw new DaemonProtocolError('daemon /health returned a non-object payload');
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.status !== 'string') {
    throw new DaemonProtocolError('daemon /health response missing status string');
  }
  const health: DaemonHealth = { status: obj.status };
  if (typeof obj.pid === 'number') health.pid = obj.pid;
  if (typeof obj.url === 'string') health.url = obj.url;
  if (typeof obj.idle_timeout_ms === 'number') health.idle_timeout_ms = obj.idle_timeout_ms;
  if (obj.ownership === 'manual' || obj.ownership === 'autostart') health.ownership = obj.ownership;
  if (Array.isArray(obj.commands) && obj.commands.every((item) => typeof item === 'string')) {
    health.commands = obj.commands as string[];
  }
  if (typeof obj.uptime_ms === 'number') health.uptime_ms = obj.uptime_ms;
  const prewarm = parseDaemonPrewarmHealth(obj.prewarm);
  if (prewarm !== null) health.prewarm = prewarm;
  return health;
}

function parseDaemonPrewarmHealth(payload: unknown): DaemonPrewarmHealth | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.enabled !== 'boolean') return null;
  if (
    obj.status !== 'disabled' &&
    obj.status !== 'ready' &&
    obj.status !== 'failed'
  ) {
    return null;
  }
  const out: DaemonPrewarmHealth = {
    enabled: obj.enabled,
    status: obj.status,
  };
  if (typeof obj.model_id === 'string') out.model_id = obj.model_id;
  if (typeof obj.lexical_kbs === 'number') out.lexical_kbs = obj.lexical_kbs;
  if (typeof obj.error === 'string') out.error = obj.error;
  if (typeof obj.updated_at === 'string') out.updated_at = obj.updated_at;
  return out;
}

async function runDaemonCommandAfterAutostart(
  command: DaemonCommand,
  args: string[],
  options: DaemonClientOptions,
): Promise<DaemonRunResult | null> {
  let preflight: DaemonHealth | null;
  try {
    preflight = await tryFetchDaemonHealth(options);
  } catch (err) {
    // Something is already answering at the URL, but not with the kb daemon
    // health contract. Do not start another process into a foreign listener.
    throw err;
  }

  if (preflight === null) {
    const started = startDetachedDaemon(options);
    const health = await pollDaemonReady(options);
    if (health === null) {
      writeNotice(options, autostartTimeoutNotice(options));
      return null;
    }
    writeNotice(
      options,
      started
        ? `kb daemon autostart: started kb serve; daemon is ready at ${health.url ?? daemonUrlFromEnv(options.env).href}\n`
        : `kb daemon autostart: daemon is ready at ${health.url ?? daemonUrlFromEnv(options.env).href}\n`,
    );
  }

  try {
    return await runDaemonCommand(command, args, options);
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      writeNotice(options, 'kb daemon autostart: daemon became unavailable after readiness; running command directly.\n');
      return null;
    }
    throw err;
  }
}

function daemonAutostartEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.KB_DAEMON_AUTOSTART?.trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes';
}

function startDetachedDaemon(options: DaemonClientOptions): boolean {
  try {
    const spawnImpl = options.spawnImpl ?? spawnDetachedDaemon;
    const command = daemonServeCommand();
    const child = spawnImpl(command.bin, command.args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...options.env },
    });
    ignoreSpawnError(child);
    child.unref();
    return true;
  } catch {
    // A concurrent caller may have won the bind/start race. Poll anyway.
    return false;
  }
}

function daemonServeCommand(): { bin: string; args: string[] } {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined || entrypoint.trim() === '') {
    return { bin: 'kb', args: ['serve', '--owner=autostart'] };
  }
  return { bin: process.execPath, args: [entrypoint, 'serve', '--owner=autostart'] };
}

function spawnDetachedDaemon(
  command: string,
  args: string[],
  options: { detached: true; stdio: 'ignore'; env: NodeJS.ProcessEnv },
): SpawnedDaemonProcess {
  return spawn(command, args, options);
}

function ignoreSpawnError(child: SpawnedDaemonProcess): void {
  child.once('error', () => undefined);
}

async function pollDaemonReady(options: DaemonClientOptions): Promise<DaemonHealth | null> {
  const deadlineMs = options.autostartDeadlineMs ?? DEFAULT_AUTOSTART_DEADLINE_MS;
  const pollIntervalMs = options.autostartPollIntervalMs ?? DEFAULT_AUTOSTART_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadlineAt = now() + deadlineMs;
  while (now() <= deadlineAt) {
    const health = await tryFetchDaemonHealth({
      ...options,
      timeoutMs: Math.min(daemonHealthTimeoutMs(options), Math.max(1, deadlineAt - now())),
    });
    if (health !== null) return health;
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
  return null;
}

function daemonRequestTimeoutMs(options: DaemonClientOptions): number {
  return options.timeoutMs ?? daemonTimeoutFromEnv(
    options.env,
    'KB_DAEMON_CLIENT_TIMEOUT_MS',
    DEFAULT_DAEMON_CLIENT_TIMEOUT_MS,
  );
}

function daemonHealthTimeoutMs(options: DaemonClientOptions): number {
  return options.timeoutMs ?? daemonTimeoutFromEnv(
    options.env,
    'KB_DAEMON_HEALTH_TIMEOUT_MS',
    DEFAULT_DAEMON_HEALTH_TIMEOUT_MS,
  );
}

function daemonTimeoutFromEnv(
  env: NodeJS.ProcessEnv | undefined,
  name: 'KB_DAEMON_CLIENT_TIMEOUT_MS' | 'KB_DAEMON_HEALTH_TIMEOUT_MS',
  fallback: number,
): number {
  const raw = (env ?? process.env)[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new DaemonProtocolError(`invalid ${name}: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DAEMON_CLIENT_TIMEOUT_MS) {
    throw new DaemonProtocolError(`invalid ${name}: ${raw}`);
  }
  return value;
}

function autostartTimeoutNotice(options: DaemonClientOptions): string {
  const deadlineMs = options.autostartDeadlineMs ?? DEFAULT_AUTOSTART_DEADLINE_MS;
  return `kb daemon autostart: kb serve was not ready after ${deadlineMs}ms; running command directly.\n`;
}

function writeNotice(options: DaemonClientOptions, message: string): void {
  if (options.notice !== undefined) {
    options.notice(message);
    return;
  }
  process.stderr.write(message);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSafeNoListenerFailure(err: DaemonUnavailableError): boolean {
  const code = errorCode(err.cause);
  return code === 'ECONNREFUSED' || code === 'ENOENT';
}

function errorCode(err: unknown): string | undefined {
  const direct = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof direct === 'string') return direct;
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  const causeCode = (cause as NodeJS.ErrnoException | undefined)?.code;
  return typeof causeCode === 'string' ? causeCode : undefined;
}
