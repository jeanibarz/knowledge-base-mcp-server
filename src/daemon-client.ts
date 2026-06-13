import { spawn } from 'node:child_process';

export interface DaemonRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type DaemonCommand = 'search' | 'list' | 'stats';
export type DaemonOwnership = 'manual' | 'autostart';

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
  if (env.KB_DAEMON_URL !== undefined && env.KB_DAEMON_URL.trim() !== '') {
    return new URL(env.KB_DAEMON_URL);
  }
  const host = env.KB_DAEMON_HOST?.trim() || '127.0.0.1';
  const portRaw = env.KB_DAEMON_PORT?.trim() || '17799';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DaemonProtocolError(`invalid KB_DAEMON_PORT: ${portRaw}`);
  }
  return new URL(`http://${host}:${port}`);
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
  const baseUrl = daemonUrlFromEnv(options.env);
  const endpoint = new URL('/v1/run', baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);
  try {
    const response = await fetchImpl(endpoint, {
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
    rethrowDaemonFetchError(err, endpoint.href);
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
  const endpoint = new URL('/health', daemonUrlFromEnv(options.env));
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);
  try {
    const response = await fetchImpl(endpoint, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new DaemonProtocolError(`daemon returned HTTP ${response.status}${text ? `: ${text}` : ''}`);
    }
    return parseDaemonHealth(await response.json());
  } catch (err) {
    rethrowDaemonFetchError(err, endpoint.href);
  } finally {
    clearTimeout(timeout);
  }
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
  return health;
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
      timeoutMs: Math.min(options.timeoutMs ?? 500, Math.max(1, deadlineAt - now())),
    });
    if (health !== null) return health;
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
  return null;
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
  return errorCode(err.cause) === 'ECONNREFUSED';
}

function errorCode(err: unknown): string | undefined {
  const direct = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof direct === 'string') return direct;
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  const causeCode = (cause as NodeJS.ErrnoException | undefined)?.code;
  return typeof causeCode === 'string' ? causeCode : undefined;
}
