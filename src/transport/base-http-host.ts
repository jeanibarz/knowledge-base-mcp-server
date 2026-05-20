// src/transport/base-http-host.ts
//
// Issue #158 — shared HTTP host for `SseHost` and `StreamableHttpHost`.
// Both transports own a `node:http` server with the same shape:
//
//   1. CORS preflight short-circuits before auth.
//   2. /health is unauthenticated and origin-unchecked.
//   3. Origin allow-list (optional, present-only enforcement).
//   4. Bearer-token auth (constant-time compare).
//   5. Shutdown gate.
//   6. CORS response headers for accepted cross-origin calls.
//   7. Subclass-specific path routing (the actually-different bit).
//
// Plus identical lifecycle (start / stop with drain), session bookkeeping
// (`sessionCount`, `notify` fanout), and observability (per-request access
// log line). The pre-extraction `sse.ts` and `http.ts` were ~70%
// byte-identical — every divergence now sits in a small set of subclass
// hooks rather than two parallel copies that drift.

import * as http from 'node:http';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { normalizeOrigin, type TransportConfig } from '../transport-config.js';
import { logger } from '../logger.js';
import type { TransportRuntimeStats } from '../transport-runtime-stats.js';

const HEALTH_ENDPOINT = '/health';
const SHUTDOWN_DRAIN_DEADLINE_MS = 10_000;
const SHUTDOWN_POLL_INTERVAL_MS = 50;

export interface BaseHttpHostOptions {
  config: TransportConfig;
  createMcpServer: () => McpServer;
}

export interface BaseSessionEntry<TTransport> {
  transport: TTransport;
  mcp: McpServer;
}

interface AccessLog {
  ts: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  origin: string | null;
  auth_present: boolean;
}

export abstract class BaseHttpHost<TTransport extends { close(): Promise<void> }> {
  protected readonly options: BaseHttpHostOptions;
  protected readonly sessions = new Map<string, BaseSessionEntry<TTransport>>();
  protected readonly originAllowList: ReadonlySet<string>;
  private readonly authTokenBuf: Buffer;
  private readonly responseStatusBuckets: Record<string, number> = {};
  private sessionsOpened = 0;
  private sessionsClosed = 0;
  private authFailures = 0;
  private originDenials = 0;
  private lastTransportError: TransportRuntimeStats['last_transport_error'] = null;
  protected server?: http.Server;
  protected inFlight = 0;
  protected shuttingDown = false;

  constructor(options: BaseHttpHostOptions) {
    this.options = options;
    this.originAllowList = new Set(options.config.allowedOrigins);
    // RFC 008 §6.3: compare as latin1 (1 byte == 1 codeunit) so an
    // attacker-supplied `Authorization` header is not silently re-encoded
    // via UTF-8 substitution (U+FFFD is 3 bytes and mutates length) before
    // the constant-time compare. The presence of a token under
    // `MCP_TRANSPORT=sse|http` is enforced at config load time; the
    // empty-string fallback here is defence-in-depth for refactor accidents.
    const token = options.config.authToken ?? '';
    this.authTokenBuf = Buffer.from(token, 'latin1');
  }

  // ---------------------------------------------------------------------------
  // Subclass hooks — the pieces that differ between SSE and streamable HTTP.
  // ---------------------------------------------------------------------------

  /** Short tag used in log lines (`sse`, `http`). */
  protected abstract get logPrefix(): 'http' | 'sse';

  /** Human-readable transport label used in the start banner. */
  protected abstract get bannerLabel(): string;

  /** Comma-separated value for the preflight `Access-Control-Allow-Methods` header. */
  protected abstract corsAllowedMethods(): string;

  /** Comma-separated value for the preflight `Access-Control-Allow-Headers` header. */
  protected abstract corsAllowedHeaders(): string;

  /**
   * Subclass-extension point for non-default CORS response headers. The
   * common `Access-Control-Allow-Origin` + `Vary: Origin` pair is set by
   * the base class; HTTP additionally exposes `Mcp-Session-Id` so the
   * client can read it.
   */
  protected setExtraCorsResponseHeaders(_res: http.ServerResponse): void {
    // Default: no extras.
  }

  /**
   * Path-routing for authenticated, origin-allowed, not-shutting-down
   * requests. The `handlePreflight` / `handleHealth` short-circuits ran
   * first; this method owns everything from `inFlight` accounting through
   * the per-route handler. Returns the HTTP status used for the access log.
   *
   * Long-lived routes (SSE GET /sse) MUST NOT increment `inFlight` —
   * doing so would block `stop()`'s drain indefinitely. Each subclass
   * decides per-route.
   */
  protected abstract handleAuthenticatedRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<number>;

  // ---------------------------------------------------------------------------
  // Public surface — shared lifecycle, observability, fanout.
  // ---------------------------------------------------------------------------

  /**
   * Number of live sessions. Read-only — narrower than a session-list
   * export so callers cannot reach in to fan notifications out by hand.
   * Use `notify(...)` for that.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  getRuntimeStats(): TransportRuntimeStats {
    return {
      transport: this.logPrefix,
      current_sessions: this.sessions.size,
      sessions_opened: this.sessionsOpened,
      sessions_closed: this.sessionsClosed,
      in_flight_requests: this.inFlight,
      response_status_buckets: { ...this.responseStatusBuckets },
      auth_failures: this.authFailures,
      origin_denials: this.originDenials,
      last_transport_error: this.lastTransportError === null
        ? null
        : { ...this.lastTransportError },
    };
  }

  /**
   * Issue #157 step 4 — fan a logging notification out across every live
   * session. The host owns the iteration so callers never see the session
   * list. Per-session errors are swallowed at debug level so a single
   * misbehaving client cannot poison the broadcast for the rest. Operates
   * against a snapshot of the values map to defend against
   * `transport.onclose` deletes mid-iteration.
   */
  async notify(
    level: 'info' | 'warning' | 'error',
    logger_: string,
    data: string,
  ): Promise<void> {
    const targets = [...this.sessions.values()].map((entry) => entry.mcp);
    if (targets.length === 0) return;
    await Promise.all(
      targets.map(async (target) => {
        try {
          await target.sendLoggingMessage({ level, logger: logger_, data });
        } catch (err) {
          logger.debug(`[${this.logPrefix}] notify error: ${(err as Error).message}`);
        }
      }),
    );
  }

  async start(): Promise<http.Server> {
    if (this.server) {
      throw new Error(`${this.constructor.name} already started`);
    }
    const server = http.createServer((req, res) => {
      void this.dispatch(req, res);
    });
    server.on('clientError', (err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {
        // best-effort
      }
      this.recordTransportError(err);
      logger.warn(`[${this.logPrefix}] clientError: ${err.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.config.port, this.options.config.bindAddr);
    });

    this.server = server;
    logger.info(
      `Knowledge Base MCP server running on ${this.bannerLabel} at http://${this.options.config.bindAddr}:${this.options.config.port} ` +
        `(allowed_origins=${this.options.config.allowedOrigins.length})`,
    );
    return server;
  }

  /**
   * Graceful shutdown:
   *   1. stop accepting new connections (server.close)
   *   2. poll-wait in-flight non-long-lived requests for up to
   *      SHUTDOWN_DRAIN_DEADLINE_MS
   *   3. close all active sessions (transport.close + mcp.close)
   *
   * Closing snapshots the entries map first to defend against concurrent
   * `transport.onclose` mutations. transport.close() chains into
   * Protocol._onclose, which nulls the protocol's _transport reference —
   * so the subsequent mcp.close() call routes through Protocol.close →
   * undefined?.close() = no-op. That keeps us safe from the recursion
   * pitfall while still giving the SDK a chance to run any future cleanup
   * that lives on McpServer rather than Protocol.
   */
  async stop(): Promise<void> {
    if (!this.server) return;
    this.shuttingDown = true;

    const server = this.server;
    const closePromise = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    const deadline = Date.now() + SHUTDOWN_DRAIN_DEADLINE_MS;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SHUTDOWN_POLL_INTERVAL_MS));
    }
    if (this.inFlight > 0) {
      logger.warn(
        `[${this.logPrefix}] shutdown drain exceeded ${SHUTDOWN_DRAIN_DEADLINE_MS}ms with ${this.inFlight} in-flight; forcing close`,
      );
    }

    const live = [...this.sessions.entries()];
    for (const [sessionId, entry] of live) {
      await this.closeEntry(sessionId, entry);
    }
    this.sessions.clear();
    await closePromise;
    this.server = undefined;
  }

  // ---------------------------------------------------------------------------
  // Dispatch pipeline — pre-auth gates, then delegates to the subclass.
  // ---------------------------------------------------------------------------

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const path = url.pathname;
    const originHeader = headerValue(req.headers.origin);
    // Allow-list is normalized at config-parse time (parseAllowedOrigins);
    // normalize the incoming Origin too so operator-friendly input like a
    // trailing slash or mixed-case scheme matches the browser-sent form.
    // The raw header is kept for the access log and the CORS echo because
    // browsers compare Access-Control-Allow-Origin against their sent
    // Origin byte-exactly.
    const normalizedOrigin =
      originHeader !== null ? normalizeOrigin(originHeader) : null;
    const authPresent = Boolean(req.headers.authorization);

    const finalize = (status: number) => {
      this.recordResponseStatus(status);
      this.writeAccessLog({
        ts: new Date(startedAt).toISOString(),
        method,
        path,
        status,
        duration_ms: Date.now() - startedAt,
        origin: originHeader,
        auth_present: authPresent,
      });
    };

    // 1. CORS preflight short-circuits before auth.
    if (method === 'OPTIONS') {
      finalize(this.handlePreflight(res, originHeader, normalizedOrigin));
      return;
    }

    // 2. /health is unauthenticated and origin-unchecked.
    if (path === HEALTH_ENDPOINT) {
      finalize(this.handleHealth(method, res));
      return;
    }

    // 3. Origin allow-list. Missing Origin is treated as a non-browser
    //    caller and accepted; if Origin is present it must be in the
    //    allow-list (after normalization).
    if (normalizedOrigin !== null && !this.originAllowList.has(normalizedOrigin)) {
      this.originDenials += 1;
      respond(res, 403, 'Origin not allowed');
      finalize(403);
      return;
    }

    // 4. Bearer-token auth.
    if (!this.verifyBearer(req.headers.authorization)) {
      this.authFailures += 1;
      res.setHeader('WWW-Authenticate', 'Bearer realm="knowledge-base-mcp"');
      respond(res, 401, 'Unauthorized');
      finalize(401);
      return;
    }

    // 5. Shutdown gate — refuse new dispatch once stop() was called.
    if (this.shuttingDown) {
      res.setHeader('Retry-After', '0');
      respond(res, 503, 'Shutting down');
      finalize(503);
      return;
    }

    // 6. Apply CORS response headers for accepted cross-origin calls.
    if (originHeader !== null) {
      this.setCorsResponseHeaders(res, originHeader);
    }

    // 7. Subclass routing.
    const status = await this.handleAuthenticatedRequest(req, res, url);
    finalize(status);
  }

  // ---------------------------------------------------------------------------
  // Pre-auth gate handlers — shared shape; CORS bits parameterized by hooks.
  // ---------------------------------------------------------------------------

  private handlePreflight(
    res: http.ServerResponse,
    originHeader: string | null,
    normalizedOrigin: string | null,
  ): number {
    // originHeader and normalizedOrigin are null together (see dispatch);
    // this guard short-circuits both cases — including a preflight with no
    // Origin header, which gets a 403.
    if (originHeader === null || normalizedOrigin === null ||
        !this.originAllowList.has(normalizedOrigin)) {
      this.originDenials += 1;
      respond(res, 403, 'Origin not allowed');
      return 403;
    }
    this.setCorsResponseHeaders(res, originHeader);
    res.setHeader('Access-Control-Allow-Methods', this.corsAllowedMethods());
    res.setHeader('Access-Control-Allow-Headers', this.corsAllowedHeaders());
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204).end();
    return 204;
  }

  private handleHealth(method: string, res: http.ServerResponse): number {
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      respond(res, 405, 'Method Not Allowed');
      return 405;
    }
    // RFC 008 §6.8: /health is unauthenticated and origin-unchecked; it
    // therefore must not leak any fingerprintable operator state (version,
    // uptime, or file-system paths). Detailed status is available through
    // the authenticated MCP channel.
    const body = JSON.stringify({ status: 'ok' });
    const buf = Buffer.from(body, 'utf8');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200);
    if (method === 'GET') {
      res.end(buf);
    } else {
      res.end();
    }
    return 200;
  }

  protected setCorsResponseHeaders(res: http.ServerResponse, origin: string): void {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    this.setExtraCorsResponseHeaders(res);
  }

  /**
   * Constant-time bearer comparison. Length-mismatched tokens
   * short-circuit (the Node crypto API throws on unequal-length inputs);
   * the wrapper try/catch is belt-and-braces against a future refactor
   * losing the length check.
   */
  private verifyBearer(authHeader: string | undefined): boolean {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }
    if (this.authTokenBuf.length === 0) {
      return false;
    }
    const provided = Buffer.from(authHeader.slice('Bearer '.length), 'latin1');
    if (provided.length !== this.authTokenBuf.length) {
      return false;
    }
    try {
      return timingSafeEqual(provided, this.authTokenBuf);
    } catch {
      return false;
    }
  }

  private writeAccessLog(entry: AccessLog): void {
    // JSON.stringify escapes control characters in any user-controllable
    // field (origin, path), so an adversarial header cannot break out of
    // the log envelope.
    const payload = JSON.stringify({ event: 'http_access', ...entry });
    logger.info(payload);
  }

  protected recordTransportError(error: Error): void {
    this.lastTransportError = {
      at: new Date().toISOString(),
      message: error.message,
    };
  }

  protected registerSession(sessionId: string, entry: BaseSessionEntry<TTransport>): void {
    if (!this.sessions.has(sessionId)) {
      this.sessionsOpened += 1;
    }
    this.sessions.set(sessionId, entry);
  }

  protected unregisterSession(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      this.sessionsClosed += 1;
    }
    return deleted;
  }

  private recordResponseStatus(status: number): void {
    const bucket = `${Math.floor(status / 100)}xx`;
    this.responseStatusBuckets[bucket] = (this.responseStatusBuckets[bucket] ?? 0) + 1;
  }

  // ---------------------------------------------------------------------------
  // Session cleanup — shared shape, used by stop() and subclass code paths.
  // ---------------------------------------------------------------------------

  protected async closeEntry(sessionId: string, entry: BaseSessionEntry<TTransport>): Promise<void> {
    this.unregisterSession(sessionId);
    try {
      await entry.transport.close();
    } catch (err) {
      logger.warn(`[${this.logPrefix}] error closing transport: ${(err as Error).message}`);
    }
    try {
      await entry.mcp.close();
    } catch (err) {
      logger.warn(`[${this.logPrefix}] error closing mcp: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers shared by both transports.
// ---------------------------------------------------------------------------

export function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function respond(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // ignore
    }
    return;
  }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}
