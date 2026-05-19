export interface DaemonRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type DaemonCommand = 'search' | 'list' | 'stats';

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
  commands?: string[];
  uptime_ms?: number;
}

export interface DaemonClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

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
    if (err instanceof DaemonUnavailableError) return null;
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
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
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
  if (Array.isArray(obj.commands) && obj.commands.every((item) => typeof item === 'string')) {
    health.commands = obj.commands as string[];
  }
  if (typeof obj.uptime_ms === 'number') health.uptime_ms = obj.uptime_ms;
  return health;
}
