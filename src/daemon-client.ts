export interface DaemonRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type DaemonCommand = 'search' | 'list' | 'stats';

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
      throw new DaemonUnavailableError(`kb daemon is not reachable at ${endpoint.href}`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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
