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
// Logging stays on the existing stderr-only logger to preserve the
// invariant at src/logger.ts:16 (HTTP access lines never touch stdout).
//
// Issue #158 — most of the host (lifecycle, dispatch gates, auth, CORS,
// notify fanout, access log) lives in `BaseHttpHost`; this file owns the
// SSE-specific routing and the long-lived `GET /sse` handling that must
// not increment `inFlight`.

import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { logger } from '../logger.js';
import {
  BaseHttpHost,
  type BaseHttpHostOptions,
  respond,
} from './base-http-host.js';

const SSE_ENDPOINT = '/sse';
const MESSAGES_ENDPOINT = '/messages';

export type SseHostOptions = BaseHttpHostOptions;

export class SseHost extends BaseHttpHost<SSEServerTransport> {
  protected get logPrefix(): string {
    return 'sse';
  }

  protected get bannerLabel(): string {
    return 'SSE';
  }

  protected corsAllowedMethods(): string {
    return 'GET, POST, OPTIONS';
  }

  protected corsAllowedHeaders(): string {
    return 'Authorization, Content-Type, Last-Event-ID';
  }

  protected async handleAuthenticatedRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<number> {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'GET' && path === SSE_ENDPOINT) {
      // SSE GET is long-lived; we do NOT increment inFlight (would block
      // drain). Status logged immediately as 200; the SDK has already
      // written headers by the time start() resolves.
      try {
        await this.handleSseOpen(req, res);
        return 200;
      } catch (err) {
        logger.error(`[sse] error opening stream: ${(err as Error).message}`);
        if (!res.headersSent) {
          respond(res, 500, 'Error establishing SSE stream');
        }
        return 500;
      }
    }

    if (method === 'POST' && path === MESSAGES_ENDPOINT) {
      this.inFlight += 1;
      try {
        return await this.handleMessagePost(req, res, url);
      } catch (err) {
        logger.error(`[sse] error handling POST /messages: ${(err as Error).message}`);
        if (!res.headersSent) {
          respond(res, 500, 'Internal Server Error');
        }
        return res.statusCode || 500;
      } finally {
        this.inFlight -= 1;
      }
    }

    respond(res, 404, 'Not Found');
    return 404;
  }

  private async handleSseOpen(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const transport = new SSEServerTransport(MESSAGES_ENDPOINT, res);
    const mcp = this.options.createMcpServer();
    const sessionId = transport.sessionId;
    // The SDK's Protocol.connect() chains additional handlers behind
    // whatever we set here, so registering this *before* connect()
    // preserves it. The handler must NOT call mcp.close(): Protocol.close()
    // routes through transport.close() which re-fires onclose → infinite
    // recursion. Map delete is idempotent, so multiple onclose firings are
    // harmless.
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
}
