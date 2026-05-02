// src/transport/http.ts
//
// HTTP host that exposes the MCP server over streamable HTTP.
// Stage 2 of RFC 008: stdio remains the default transport; this module is
// only loaded when MCP_TRANSPORT=http.
//
// Surface:
//   GET  /health            unauthenticated JSON liveness probe
//   POST /mcp               initialize or per-session JSON-RPC POST
//   GET  /mcp               optional per-session SSE stream
//   DELETE /mcp             terminate a session
//   OPTIONS *               CORS preflight against MCP_ALLOWED_ORIGINS

import * as http from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { normalizeOrigin, type TransportConfig } from '../config.js';
import { logger } from '../logger.js';

const MCP_ENDPOINT = '/mcp';
const HEALTH_ENDPOINT = '/health';

const MAXIMUM_MESSAGE_SIZE_BYTES = 4 * 1024 * 1024;
const SHUTDOWN_DRAIN_DEADLINE_MS = 10_000;
const SHUTDOWN_POLL_INTERVAL_MS = 50;
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StreamableHttpHostOptions {
  config: TransportConfig;
  createMcpServer: () => McpServer;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
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

export class StreamableHttpHost {
  private readonly options: StreamableHttpHostOptions;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly originAllowList: ReadonlySet<string>;
  private readonly authTokenBuf: Buffer;
  private server?: http.Server;
  private inFlight = 0;
  private shuttingDown = false;

  constructor(options: StreamableHttpHostOptions) {
    this.options = options;
    this.originAllowList = new Set(options.config.allowedOrigins);
    const token = options.config.authToken ?? '';
    this.authTokenBuf = Buffer.from(token, 'latin1');
  }

  getConnectedMcpServers(): McpServer[] {
    return [...this.sessions.values()].map((entry) => entry.mcp);
  }

  async start(): Promise<http.Server> {
    if (this.server) {
      throw new Error('StreamableHttpHost already started');
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
      logger.warn(`[http] clientError: ${err.message}`);
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
      `Knowledge Base MCP server running on streamable HTTP at http://${this.options.config.bindAddr}:${this.options.config.port} ` +
        `(allowed_origins=${this.options.config.allowedOrigins.length})`,
    );
    return server;
  }

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
        `[http] shutdown drain exceeded ${SHUTDOWN_DRAIN_DEADLINE_MS}ms with ${this.inFlight} in-flight; forcing close`,
      );
    }

    const live = [...this.sessions.entries()];
    for (const [sessionId, entry] of live) {
      await this.closeEntry(sessionId, entry);
    }
    await closePromise;
    this.server = undefined;
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const path = url.pathname;
    const originHeader = headerValue(req.headers.origin);
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

    if (method === 'OPTIONS') {
      const status = this.handlePreflight(req, res, originHeader, normalizedOrigin);
      finalize(status);
      return;
    }

    if (path === HEALTH_ENDPOINT) {
      const status = this.handleHealth(method, res);
      finalize(status);
      return;
    }

    if (normalizedOrigin !== null && !this.originAllowList.has(normalizedOrigin)) {
      respond(res, 403, 'Origin not allowed');
      finalize(403);
      return;
    }

    if (!this.verifyBearer(req.headers.authorization)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="knowledge-base-mcp"');
      respond(res, 401, 'Unauthorized');
      finalize(401);
      return;
    }

    if (this.shuttingDown) {
      res.setHeader('Retry-After', '0');
      respond(res, 503, 'Shutting down');
      finalize(503);
      return;
    }

    if (originHeader !== null) {
      this.setCorsResponseHeaders(res, originHeader);
    }

    if (path !== MCP_ENDPOINT) {
      respond(res, 404, 'Not Found');
      finalize(404);
      return;
    }

    this.inFlight += 1;
    try {
      const status = await this.handleMcpRequest(req, res);
      finalize(status);
    } catch (err) {
      logger.error(`[http] error handling ${method} /mcp: ${(err as Error).message}`);
      if (!res.headersSent) {
        respondJsonRpcError(res, 500, -32603, 'Internal Server Error');
      }
      finalize(res.statusCode || 500);
    } finally {
      this.inFlight -= 1;
    }
  }

  private handlePreflight(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    originHeader: string | null,
    normalizedOrigin: string | null,
  ): number {
    if (originHeader === null || normalizedOrigin === null ||
        !this.originAllowList.has(normalizedOrigin)) {
      respond(res, 403, 'Origin not allowed');
      return 403;
    }
    this.setCorsResponseHeaders(res, originHeader);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
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

  private async handleMcpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<number> {
    const method = req.method ?? 'GET';
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      res.setHeader('Allow', 'GET, POST, DELETE');
      respondJsonRpcError(res, 405, -32000, 'Method not allowed.');
      return 405;
    }

    const sessionIdResult = readSessionId(req);
    if (sessionIdResult.kind === 'multiple') {
      respondJsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header must be a single value');
      return 400;
    }
    if (sessionIdResult.kind === 'malformed') {
      respondJsonRpcError(res, 400, -32000, 'Bad Request: malformed Mcp-Session-Id header');
      return 400;
    }
    const sessionId = sessionIdResult.sessionId;

    if (method === 'POST') {
      let parsedBody: unknown;
      try {
        parsedBody = await readJsonBody(req);
      } catch (err) {
        respondJsonRpcError(res, 400, -32700, `Parse error: ${(err as Error).message}`);
        return 400;
      }
      const isInitializationRequest = containsInitializeRequest(parsedBody);

      if (sessionId === null) {
        if (!isInitializationRequest) {
          respondJsonRpcError(
            res,
            400,
            -32000,
            'No valid session id; non-initialize method requires Mcp-Session-Id header',
          );
          return 400;
        }
        await this.handleInitializePost(req, res, parsedBody);
        return res.statusCode || 200;
      }

      const entry = this.sessions.get(sessionId);
      if (!entry || isInitializationRequest) {
        respondJsonRpcError(res, 404, -32001, 'Session not found');
        return 404;
      }
      await entry.transport.handleRequest(req, res, parsedBody);
      return res.statusCode || 200;
    }

    if (sessionId === null) {
      respondJsonRpcError(
        res,
        400,
        -32000,
        'No valid session id; non-initialize method requires Mcp-Session-Id header',
      );
      return 400;
    }

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      respondJsonRpcError(res, 404, -32001, 'Session not found');
      return 404;
    }

    if (method === 'GET') {
      res.once('close', () => {
        void this.closeSession(sessionId);
      });
    }

    await entry.transport.handleRequest(req, res);
    if (method === 'DELETE') {
      await entry.mcp.close();
    }
    return res.statusCode || 200;
  }

  private async handleInitializePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody: unknown,
  ): Promise<void> {
    let transport!: StreamableHTTPServerTransport;
    const mcp = this.options.createMcpServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, { transport, mcp });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
    };
    transport.onerror = (error) => {
      logger.warn(`[http] transport error: ${error.message}`);
    };
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
      try {
        await transport.close();
      } catch {
        // best-effort cleanup
      }
      try {
        await mcp.close();
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
  }

  private async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    await this.closeEntry(sessionId, entry);
  }

  private async closeEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    this.sessions.delete(sessionId);
    try {
      await entry.transport.close();
    } catch (err) {
      logger.warn(`[http] error closing transport: ${(err as Error).message}`);
    }
    try {
      await entry.mcp.close();
    } catch (err) {
      logger.warn(`[http] error closing mcp: ${(err as Error).message}`);
    }
  }

  private setCorsResponseHeaders(res: http.ServerResponse, origin: string): void {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    res.setHeader('Vary', 'Origin');
  }

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
    const payload = JSON.stringify({ event: 'http_access', ...entry });
    logger.info(payload);
  }
}

type SessionIdResult =
  | { kind: 'ok'; sessionId: string | null }
  | { kind: 'multiple' }
  | { kind: 'malformed' };

function readSessionId(req: http.IncomingMessage): SessionIdResult {
  const raw = req.headers['mcp-session-id'];
  if (raw === undefined) return { kind: 'ok', sessionId: null };
  if (Array.isArray(raw)) return { kind: 'multiple' };
  if (!UUID_SHAPE.test(raw)) return { kind: 'malformed' };
  return { kind: 'ok', sessionId: raw };
}

function containsInitializeRequest(parsedBody: unknown): boolean {
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  return messages.some((message) => isInitializeRequest(message));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAXIMUM_MESSAGE_SIZE_BYTES) {
      throw new Error('request body exceeds 4MB limit');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) {
    throw new Error('request body is empty');
  }
  return JSON.parse(raw);
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

function respondJsonRpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // ignore
    }
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  }));
}
