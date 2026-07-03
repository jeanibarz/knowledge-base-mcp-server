// src/transport-config.ts
//
// RFC 008 — MCP transport selection + per-transport config (stdio, SSE,
// streamable HTTP). Extracted out of `src/config.ts` (issue #159) so the
// transport types/loader form a coherent module instead of one face of a
// 40-export grab-bag. `KnowledgeBaseServer.run`, `transport/sse.ts`, and
// `transport/http.ts` import directly from here; nothing in `config.ts`
// depends on this file.

import { readFileSync } from 'node:fs';

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
  /**
   * Host-header allow-list for DNS-rebinding protection (issue #750). When
   * non-empty, `BaseHttpHost` rejects any non-`/health` request whose `Host`
   * header is missing or not listed. Empty means the check is disabled.
   * Populated by `parseAllowedHosts` (loopback defaults + `MCP_ALLOWED_HOSTS`).
   */
  allowedHosts?: string[];
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

function resolveAuthToken(env: NodeJS.ProcessEnv): string | undefined {
  const tokenFile = env.MCP_AUTH_TOKEN_FILE;
  if (tokenFile === undefined || tokenFile.length === 0) {
    return env.MCP_AUTH_TOKEN;
  }

  let token: string;
  try {
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new TransportConfigError(
      `MCP_AUTH_TOKEN_FILE='${tokenFile}' could not be read: ${detail}`,
    );
  }

  if (token.length === 0) {
    throw new TransportConfigError(
      `MCP_AUTH_TOKEN_FILE='${tokenFile}' is empty after trimming whitespace`,
    );
  }

  return token;
}

// Bind addresses that resolve to the local machine. When the server binds to
// any of these, the derived Host allow-list also accepts the common loopback
// aliases a browser/client would send (`localhost`, `127.0.0.1`, `[::1]`).
const LOOPBACK_BIND_ADDRS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '0.0.0.0',
  '::',
]);

/**
 * Render a bind address the way it appears in an HTTP `Host` header: IPv6
 * literals are bracketed (`::1` -> `[::1]`), everything else is left as-is.
 */
function hostHeaderForm(addr: string): string {
  if (addr.includes(':') && !addr.startsWith('[')) {
    return `[${addr}]`;
  }
  return addr;
}

/**
 * Derive the default Host allow-list from the bind address and port. Includes
 * both the `host:port` and bare `host` forms (clients may omit the port when
 * it is the scheme default), plus loopback aliases when the bind address is
 * local. All entries are lowercased for case-insensitive comparison.
 */
export function defaultAllowedHosts(bindAddr: string, port: number): string[] {
  const hosts = new Set<string>();
  const add = (host: string): void => {
    const lower = host.toLowerCase();
    hosts.add(`${lower}:${port}`);
    hosts.add(lower);
  };
  add(hostHeaderForm(bindAddr));
  if (LOOPBACK_BIND_ADDRS.has(bindAddr.toLowerCase())) {
    add('localhost');
    add('127.0.0.1');
    add('[::1]');
  }
  return [...hosts];
}

/**
 * Parse `MCP_ALLOWED_HOSTS` into the effective Host allow-list.
 *
 * - unset/empty  -> loopback defaults only (protection on for local binds).
 * - `*`          -> empty list, which disables Host validation entirely. This
 *                   is the escape hatch for reverse-proxy deployments whose
 *                   forwarded `Host` cannot be enumerated. Unlike
 *                   `MCP_ALLOWED_ORIGINS='*'` (which would defeat CSRF/CORS),
 *                   disabling Host validation only forgoes the rebinding
 *                   defense-in-depth, so it is permitted rather than rejected.
 * - a CSV list   -> defaults plus the configured hosts (so localhost keeps
 *                   working even when an operator adds a proxy hostname).
 */
export function parseAllowedHosts(
  raw: string | undefined,
  bindAddr: string,
  port: number,
): string[] {
  if (raw !== undefined && raw.trim() === '*') {
    return [];
  }
  const configured = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return [...new Set([...defaultAllowedHosts(bindAddr, port), ...configured])];
}

export function loadTransportConfig(env: NodeJS.ProcessEnv = process.env): TransportConfig {
  const transport = parseTransport(env.MCP_TRANSPORT);
  const port = parsePort(env.MCP_PORT);
  const bindAddr = env.MCP_BIND_ADDR && env.MCP_BIND_ADDR.length > 0
    ? env.MCP_BIND_ADDR
    : DEFAULT_MCP_BIND_ADDR;
  const authToken = resolveAuthToken(env);
  const allowedOrigins = parseAllowedOrigins(env.MCP_ALLOWED_ORIGINS);
  const allowedHosts = parseAllowedHosts(env.MCP_ALLOWED_HOSTS, bindAddr, port);
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
        `MCP_TRANSPORT=${transport} requires MCP_AUTH_TOKEN_FILE or MCP_AUTH_TOKEN to be set (generate with: openssl rand -base64 32)`,
      );
    }
    // RFC 008 §6.1 / §8.1 R3: tokens shorter than 32 chars are rejected at
    // startup so operators cannot unintentionally deploy a brute-forceable
    // secret even if generation tooling truncates.
    if (authToken.length < 32) {
      throw new TransportConfigError(
        'Resolved MCP auth token must be at least 32 characters (generate with: openssl rand -base64 32)',
      );
    }
  }

  return { transport, port, bindAddr, authToken, allowedOrigins, allowedHosts, authBackoff };
}
