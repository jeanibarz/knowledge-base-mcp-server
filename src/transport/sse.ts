// src/transport/sse.ts
//
// HTTP host that exposes the MCP server over SSE (Server-Sent Events).
// Stage 1 of RFC 008: stdio remains the default transport; this module is
// only loaded when MCP_TRANSPORT=sse.
//
// Surface:
//   GET  /health            unauthenticated JSON liveness probe
//   GET  /sse               long-lived SSE stream (mints a session)
//   POST /messages          per-session JSON-RPC POST (sessionId in query)
//   OPTIONS *               CORS preflight against MCP_ALLOWED_ORIGINS
//
// Logging stays on the existing stderr-only logger to preserve the invariant
// at src/logger.ts:16 (HTTP access lines never touch stdout).

import * as http from 'node:http';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { logger } from '../logger.js';
import { normalizeOrigin, type TransportConfig } from '../config.js';

const SSE_ENDPOINT = '/sse';
const MESSAGES_ENDPOINT = '/messages';
const HEALTH_ENDPOINT = '/health';

const SHUTDOWN_DRAIN_DEADLINE_MS = 10_000;
const SHUTDOWN_POLL_INTERVAL_MS = 50;

export interface SseHostOptions {
  config: TransportConfig;
  createMcpServer: () => McpServer;
}

interface SessionEntry {
  transport: SSEServerTransport;
  mcp: McpServer;
}

type AccessLog = {
  ts: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  origin: string | null;
  auth_present: boolean;
};

export class SseHost {
  private readonly options: SseHostOptions;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly originAllowList: ReadonlySet<string>;
  private readonly authTokenBuf: Buffer;
  private server?: http.Server;
  private inFlight = 0;
  private shuttingDown = false;

  constructor(options: SseHostOptions) {
    this.options = options;
    this.originAllowList = new Set(options.config.allowedOrigins);
    // The auth token presence is enforced at config load time when transport
    // is sse, so this branch should not fire — defensive fallback only.
    // RFC 008 §6.3: compare as latin1 (1 byte == 1 codeunit) so an
    // attacker-supplied `Authorization` header is not silently re-encoded via
    // UTF-8 substitution (U+FFFD is 3 bytes and mutates length) before the
    // constant-time compare.
    const token = options.config.authToken ?? '';
    this.authTokenBuf = Buffer.from(token, 'latin1');
  }

  async start(): Promise<http.Server> {
    if (this.server) {
      throw new Error('SseHost already started');
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
      logger.warn(`[sse] clientError: ${err.message}`);
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
      `Knowledge Base MCP server running on SSE at http://${this.options.config.bindAddr}:${this.options.config.port} ` +
        `(allowed_origins=${this.options.config.allowedOrigins.length})`,
    );
    return server;
  }

  /**
   * Graceful shutdown:
   *   1. stop accepting new connections (server.close)
   *   2. poll-wait in-flight POSTs for up to SHUTDOWN_DRAIN_DEADLINE_MS
   *   3. close all active SSE sessions (transport.close + mcp.close)
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
        `[sse] shutdown drain exceeded ${SHUTDOWN_DRAIN_DEADLINE_MS}ms with ${this.inFlight} in-flight; forcing close`,
      );
    }

    // Snapshot to defend against concurrent mutation via onclose deletes.
    // transport.close() chains into Protocol._onclose, which nulls the
    // protocol's _transport reference — so the subsequent mcp.close() call
    // routes through Protocol.close → undefined?.close() = no-op. That keeps
    // us safe from the recursion pitfall while still giving the SDK a chance
    // to run any future cleanup that lives on McpServer rather than Protocol.
    const live = [...this.sessions.values()];
    for (const entry of live) {
      try {
        await entry.transport.close();
      } catch (err) {
        logger.warn(`[sse] error closing transport: ${(err as Error).message}`);
      }
      try {
        await entry.mcp.close();
      } catch (err) {
        logger.warn(`[sse] error closing mcp: ${(err as Error).message}`);
      }
    }
    this.sessions.clear();
    await closePromise;
    this.server = undefined;
  }

  // -------------------------------------------------------------------------
  // Request dispatch
  // -------------------------------------------------------------------------

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const path = url.pathname;
    const originHeader = headerValue(req.headers.origin);
    // The stored allow-list is already normalized at config-parse time (see
    // parseAllowedOrigins). Apply the same normalization to the incoming
    // Origin before lookup so operator-friendly input like a trailing slash
    // or mixed-case scheme still matches the browser-sent form. The raw
    // header is kept for the access log and the CORS echo, because browsers
    // compare Access-Control-Allow-Origin against their sent Origin byte-
    // exactly.
    const normalizedOrigin =
      originHeader !== null ? normalizeOrigin(originHeader) : null;
    const authPresent = Boolean(req.headers.authorization);

    const finalize = (status: number) => {
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
      const status = this.handlePreflight(req, res, originHeader, normalizedOrigin);
      finalize(status);
      return;
    }

    // 2. /health is unauthenticated and origin-unchecked.
    if (path === HEALTH_ENDPOINT) {
      const status = this.handleHealth(method, res);
      finalize(status);
      return;
    }

    // 3. Origin allow-list. Missing Origin is treated as a non-browser caller
    //    and accepted; if Origin is present it must be in the allow-list
    //    (after normalization).
    if (normalizedOrigin !== null && !this.originAllowList.has(normalizedOrigin)) {
      respond(res, 403, 'Origin not allowed');
      finalize(403);
      return;
    }

    // 4. Bearer-token auth.
    if (!this.verifyBearer(req.headers.authorization)) {
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

    // 7. Route by path.
    if (method === 'GET' && path === SSE_ENDPOINT) {
      // SSE GET is long-lived; we do not increment inFlight (would block drain).
      // Status logged immediately as 200; the SDK has already written headers
      // by the time start() resolves.
      try {
        await this.handleSseOpen(req, res);
        finalize(200);
      } catch (err) {
        logger.error(`[sse] error opening stream: ${(err as Error).message}`);
        if (!res.headersSent) {
          respond(res, 500, 'Error establishing SSE stream');
        }
        finalize(500);
      }
      return;
    }

    if (method === 'POST' && path === MESSAGES_ENDPOINT) {
      this.inFlight += 1;
      try {
        const status = await this.handleMessagePost(req, res, url);
        finalize(status);
      } catch (err) {
        logger.error(`[sse] error handling POST /messages: ${(err as Error).message}`);
        if (!res.headersSent) {
          respond(res, 500, 'Internal Server Error');
        }
        finalize(res.statusCode || 500);
      } finally {
        this.inFlight -= 1;
      }
      return;
    }

    respond(res, 404, 'Not Found');
    finalize(404);
  }

  // -------------------------------------------------------------------------
  // Endpoint handlers
  // -------------------------------------------------------------------------

  private handlePreflight(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    originHeader: string | null,
    normalizedOrigin: string | null,
  ): number {
    // originHeader and normalizedOrigin are null together (see dispatch); this
    // guard short-circuits both cases — including a preflight with no Origin
    // header, which gets a 403.
    if (originHeader === null || normalizedOrigin === null ||
        !this.originAllowList.has(normalizedOrigin)) {
      respond(res, 403, 'Origin not allowed');
      return 403;
    }
    this.setCorsResponseHeaders(res, originHeader);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Last-Event-ID',
    );
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

  private async handleSseOpen(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const transport = new SSEServerTransport(MESSAGES_ENDPOINT, res);
    const mcp = this.options.createMcpServer();
    const sessionId = transport.sessionId;
    // The SDK's Protocol.connect() chains additional handlers behind whatever
    // we set here, so registering this *before* connect() preserves it. The
    // handler must NOT call mcp.close(): Protocol.close() routes through
    // transport.close() which re-fires onclose → infinite recursion. Map
    // delete is idempotent, so multiple onclose firings are harmless.
    transport.onclose = () => {
      this.sessions.delete(sessionId);
    };
    this.sessions.set(sessionId, { transport, mcp });
    try {
      await mcp.connect(transport);
    } catch (err) {
      this.sessions.delete(sessionId);
      throw err;
    }
  }

  private async handleMessagePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<number> {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      respond(res, 400, 'Missing sessionId parameter');
      return 400;
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      respond(res, 404, 'Session not found');
      return 404;
    }
    await entry.transport.handlePostMessage(req, res);
    return res.statusCode || 202;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private setCorsResponseHeaders(res: http.ServerResponse, origin: string): void {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  /**
   * Constant-time bearer comparison. Length-mismatched tokens short-circuit
   * (the Node crypto API throws on unequal-length inputs); the wrapper
   * try/catch is belt-and-braces against a future refactor losing the
   * length check.
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
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function respond(res: http.ServerResponse, status: number, message: string): void {
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

