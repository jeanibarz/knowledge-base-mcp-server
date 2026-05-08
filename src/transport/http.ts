// src/transport/http.ts
//
// HTTP host that exposes the MCP server over streamable HTTP.
// Stage 2 of RFC 008: stdio remains the default transport; this module is
// only loaded when MCP_TRANSPORT=http.
//
// Surface:
//   GET    /health     unauthenticated JSON liveness probe
//   POST   /mcp        initialize or per-session JSON-RPC POST
//   GET    /mcp        optional per-session SSE stream
//   DELETE /mcp        terminate a session
//   OPTIONS *          CORS preflight against MCP_ALLOWED_ORIGINS
//
// Issue #158 — most of the host (lifecycle, dispatch gates, auth, CORS,
// notify fanout, access log) lives in `BaseHttpHost`; this file owns the
// per-method routing on `/mcp`, the streamable-HTTP session bookkeeping
// (Mcp-Session-Id header), and the JSON-RPC error envelope.

import * as http from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { logger } from '../logger.js';
import {
  BaseHttpHost,
  type BaseHttpHostOptions,
  respond,
} from './base-http-host.js';

const MCP_ENDPOINT = '/mcp';
const MAXIMUM_MESSAGE_SIZE_BYTES = 4 * 1024 * 1024;
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type StreamableHttpHostOptions = BaseHttpHostOptions;

export class StreamableHttpHost extends BaseHttpHost<StreamableHTTPServerTransport> {
  protected get logPrefix(): string {
    return 'http';
  }

  protected get bannerLabel(): string {
    return 'streamable HTTP';
  }

  protected corsAllowedMethods(): string {
    return 'GET, POST, DELETE, OPTIONS';
  }

  protected corsAllowedHeaders(): string {
    return 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID';
  }

  protected setExtraCorsResponseHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  }

  protected async handleAuthenticatedRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<number> {
    const method = req.method ?? 'GET';

    if (url.pathname !== MCP_ENDPOINT) {
      // Only /mcp is routed past the auth gate; everything else 404s as
      // plain text (matches pre-#158 behaviour). The /health gate ran
      // earlier in BaseHttpHost.dispatch.
      respond(res, 404, 'Not Found');
      return 404;
    }

    this.inFlight += 1;
    try {
      return await this.handleMcpRequest(req, res, method);
    } catch (err) {
      logger.error(`[http] error handling ${method} /mcp: ${(err as Error).message}`);
      if (!res.headersSent) {
        respondJsonRpcError(res, 500, -32603, 'Internal Server Error');
      }
      return res.statusCode || 500;
    } finally {
      this.inFlight -= 1;
    }
  }

  private async handleMcpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
  ): Promise<number> {
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
}

// ---------------------------------------------------------------------------
// HTTP-only helpers — JSON-RPC error envelope, session-id header parsing,
// JSON body reader.
// ---------------------------------------------------------------------------

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
