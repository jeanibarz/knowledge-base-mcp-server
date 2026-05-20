// src/transport-config.ts
//
// RFC 008 — MCP transport selection + per-transport config (stdio, SSE,
// streamable HTTP). Extracted out of `src/config.ts` (issue #159) so the
// transport types/loader form a coherent module instead of one face of a
// 40-export grab-bag. `KnowledgeBaseServer.run`, `transport/sse.ts`, and
// `transport/http.ts` import directly from here; nothing in `config.ts`
// depends on this file.

export type McpTransport = 'stdio' | 'sse' | 'http';

const VALID_TRANSPORTS: readonly McpTransport[] = ['stdio', 'sse', 'http'];

export const DEFAULT_MCP_PORT = 8765;
export const DEFAULT_MCP_BIND_ADDR = '127.0.0.1';
export const DEFAULT_MCP_AUTH_BACKOFF_THRESHOLD = 5;
export const DEFAULT_MCP_AUTH_BACKOFF_MS = 30_000;
export const DEFAULT_MCP_AUTH_BACKOFF_MAX_ENTRIES = 1024;

export interface AuthBackoffConfig {
  failureThreshold: number;
  backoffMs: number;
  maxEntries: number;
}

export interface TransportConfig {
  transport: McpTransport;
  port: number;
  bindAddr: string;
  authToken?: string;
  allowedOrigins: string[];
  authBackoff?: AuthBackoffConfig;
}

export class TransportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportConfigError';
  }
}

function parseTransport(raw: string | undefined): McpTransport {
  if (raw === undefined || raw === '') {
    return 'stdio';
  }
  if ((VALID_TRANSPORTS as readonly string[]).includes(raw)) {
    return raw as McpTransport;
  }
  throw new TransportConfigError(
    `Invalid MCP_TRANSPORT='${raw}'; expected one of ${VALID_TRANSPORTS.join('|')}`,
  );
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_MCP_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TransportConfigError(
      `Invalid MCP_PORT='${raw}'; expected integer in [1, 65535]`,
    );
  }
  return port;
}

function parseNonNegativeInteger(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new TransportConfigError(
      `Invalid ${name}='${raw}'; expected non-negative integer`,
    );
  }
  return value;
}

function parsePositiveInteger(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new TransportConfigError(
      `Invalid ${name}='${raw}'; expected integer >= 1`,
    );
  }
  return value;
}

/**
 * Normalize an origin string to the RFC 6454 form browsers actually send:
 * lowercased scheme + host, no path, no trailing slash. Non-default ports
 * are preserved (`:8080`); the WHATWG URL parser strips scheme-default ports
 * (`:443` on https, `:80` on http), matching browser behavior.
 * Accepts operator-friendly input like "HTTPS://App.EXAMPLE.com:8080/".
 *
 * Falls back to a plain `toLowerCase()` on strings the WHATWG URL parser
 * rejects (e.g. missing scheme). A malformed stored entry will then never
 * match a browser-sent Origin and silently behave as "deny" — which is the
 * safe direction for an allow-list. Tightening this into a hard reject is
 * tracked separately in #77's issue body.
 */
export function normalizeOrigin(origin: string): string {
  const trimmed = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  if (raw.trim() === '*') {
    throw new TransportConfigError(
      "MCP_ALLOWED_ORIGINS='*' is rejected; list explicit origins (see RFC 008 §6.4 / §7.6)",
    );
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => normalizeOrigin(entry));
}

export function loadTransportConfig(env: NodeJS.ProcessEnv = process.env): TransportConfig {
  const transport = parseTransport(env.MCP_TRANSPORT);
  const port = parsePort(env.MCP_PORT);
  const bindAddr = env.MCP_BIND_ADDR && env.MCP_BIND_ADDR.length > 0
    ? env.MCP_BIND_ADDR
    : DEFAULT_MCP_BIND_ADDR;
  const authToken = env.MCP_AUTH_TOKEN;
  const allowedOrigins = parseAllowedOrigins(env.MCP_ALLOWED_ORIGINS);
  const authBackoff = {
    failureThreshold: parseNonNegativeInteger(
      'MCP_AUTH_BACKOFF_THRESHOLD',
      env.MCP_AUTH_BACKOFF_THRESHOLD,
      DEFAULT_MCP_AUTH_BACKOFF_THRESHOLD,
    ),
    backoffMs: parseNonNegativeInteger(
      'MCP_AUTH_BACKOFF_MS',
      env.MCP_AUTH_BACKOFF_MS,
      DEFAULT_MCP_AUTH_BACKOFF_MS,
    ),
    maxEntries: parsePositiveInteger(
      'MCP_AUTH_BACKOFF_MAX_ENTRIES',
      env.MCP_AUTH_BACKOFF_MAX_ENTRIES,
      DEFAULT_MCP_AUTH_BACKOFF_MAX_ENTRIES,
    ),
  };

  if (transport === 'sse' || transport === 'http') {
    if (!authToken || authToken.length === 0) {
      throw new TransportConfigError(
        `MCP_TRANSPORT=${transport} requires MCP_AUTH_TOKEN to be set (generate with: openssl rand -base64 32)`,
      );
    }
    // RFC 008 §6.1 / §8.1 R3: tokens shorter than 32 chars are rejected at
    // startup so operators cannot unintentionally deploy a brute-forceable
    // secret even if generation tooling truncates.
    if (authToken.length < 32) {
      throw new TransportConfigError(
        'MCP_AUTH_TOKEN must be at least 32 characters (generate with: openssl rand -base64 32)',
      );
    }
  }

  return { transport, port, bindAddr, authToken, allowedOrigins, authBackoff };
}
