// Issue #403 — provenance-preserving URL snapshots for `kb import-url`.
//
// This module holds the network-facing and pure logic behind the
// `kb import-url` CLI command: the SSRF address classifier, the manual
// redirect chain, content-type routing, and the provenance-frontmatter
// note builder. `cli-import-url.ts` is the thin CLI wrapper on top.
//
// Splitting the testable logic out of the CLI handler follows the same
// shape as the recent `refactor(cli): move reusable CLI internals into
// core modules` change — the pure pieces here are unit-tested directly,
// without spawning the binary or touching the network.

import * as net from 'node:net';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { AgentOptions as HttpAgentOptions } from 'node:http';
import type { AgentOptions as HttpsAgentOptions } from 'node:https';
import yaml from 'js-yaml';

/** Raised for any URL-snapshot failure the operator should see verbatim. */
export class UrlSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlSnapshotError';
  }
}

// ----- SSRF address classifier ---------------------------------------------

function parseIPv4(value: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (m === null) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((n) => n > 255)) return null;
  return octets as [number, number, number, number];
}

function isBlockedIPv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 10) return true; // 10.0.0.0/8 — private
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT
  if (a >= 224) return true; // 224.0.0.0/3 — multicast + reserved
  return false;
}

/** First 16-bit group of an IPv6 address, or null when unparseable. */
function firstHextet(addr: string): number | null {
  if (addr.startsWith('::')) return 0;
  const idx = addr.indexOf(':');
  const head = idx === -1 ? addr : addr.slice(0, idx);
  if (!/^[0-9a-f]{1,4}$/.test(head)) return null;
  return parseInt(head, 16);
}

function isBlockedIPv6(raw: string): boolean {
  const addr = raw.toLowerCase();
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded IPv4.
  const mappedV4 = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(addr);
  if (addr.startsWith('::ffff:') && mappedV4 !== null) {
    const v4 = parseIPv4(mappedV4[1]);
    return v4 === null ? true : isBlockedIPv4(v4);
  }
  const head = firstHextet(addr);
  if (head === null) return true; // unparseable → block conservatively
  if (head >= 0xfe80 && head <= 0xfebf) return true; // fe80::/10 — link-local
  if (head >= 0xfc00 && head <= 0xfdff) return true; // fc00::/7 — unique-local
  if (head >= 0xff00) return true; // ff00::/8 — multicast
  return false;
}

/**
 * True when `ip` (an IPv4 or IPv6 literal) belongs to a range that a URL
 * fetch must not reach: loopback, private, link-local (incl. the cloud
 * metadata endpoint), CGNAT, unique-local, and multicast. Anything else —
 * a routable public address — returns false. Unparseable input is treated
 * as blocked so a classifier gap fails closed.
 */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return isBlockedIPv4(v4);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true; // not a recognizable IP literal
}

/** Resolves a hostname to one or more IP-literal strings. */
export type AddressResolver = (hostname: string) => Promise<string[]>;

/**
 * Throws `UrlSnapshotError` when `hostname` is — or resolves to — a blocked
 * address. IP-literal hostnames are classified directly; named hosts are
 * resolved via `resolve` and rejected if ANY returned address is blocked
 * (a conservative stance against split-horizon / rebinding tricks). The
 * whole check is skipped when `allowLocalNetwork` is set.
 */
export async function assertHostAllowed(
  hostname: string,
  resolve: AddressResolver,
  allowLocalNetwork: boolean,
): Promise<void> {
  if (allowLocalNetwork) return;
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (host === '') throw new UrlSnapshotError('URL has an empty host');
  if (net.isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new UrlSnapshotError(
        `refusing to fetch a private/loopback address: ${host} ` +
        `(pass --allow-local-network to override)`,
      );
    }
    return;
  }
  const addresses = await resolve(host);
  if (addresses.length === 0) {
    throw new UrlSnapshotError(`could not resolve host: ${host}`);
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new UrlSnapshotError(
        `host ${host} resolves to a private/loopback address: ${address} ` +
        `(pass --allow-local-network to override)`,
      );
    }
  }
}

// ----- URL validation ------------------------------------------------------

/**
 * Parses `raw` and rejects anything that is not a concrete http(s) URL with
 * a host. Used both on the user-supplied URL and on every redirect target.
 */
export function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlSnapshotError(`not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlSnapshotError(
      `unsupported URL scheme ${JSON.stringify(url.protocol.replace(/:$/, ''))} ` +
      `(only http and https are allowed)`,
    );
  }
  if (url.hostname === '') {
    throw new UrlSnapshotError(`URL has no host: ${JSON.stringify(raw)}`);
  }
  return url;
}

// ----- redirect chain ------------------------------------------------------

export interface RawHttpResponse {
  /** The URL that produced this response (after any prior redirect hops). */
  url: string;
  status: number;
  /** Header names are expected lowercased by callers. */
  headers: Record<string, string | undefined>;
  body: Buffer;
}

/** Performs a single non-redirecting HTTP GET. */
export type FetchOnce = (url: string) => Promise<RawHttpResponse>;

/**
 * Walks an HTTP redirect chain manually: each hop is re-validated as an
 * http(s) URL (so a redirect cannot smuggle in `file://` or a foreign
 * scheme) and `Location` is resolved relative to the current URL. Stops at
 * the first 2xx response; throws on a non-2xx terminal status, a redirect
 * without `Location`, or more than `maxRedirects` hops.
 */
export async function followRedirectChain(
  startUrl: string,
  fetchOnce: FetchOnce,
  maxRedirects: number,
): Promise<RawHttpResponse> {
  let current = assertHttpUrl(startUrl).toString();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchOnce(current);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers['location'];
      if (location === undefined || location.trim() === '') {
        throw new UrlSnapshotError(
          `redirect (HTTP ${res.status}) from ${current} has no Location header`,
        );
      }
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new UrlSnapshotError(
          `redirect from ${current} points at an invalid Location: ${JSON.stringify(location)}`,
        );
      }
      current = assertHttpUrl(next).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new UrlSnapshotError(`fetch failed: HTTP ${res.status} from ${current}`);
    }
    return res;
  }
  throw new UrlSnapshotError(
    `too many redirects (limit ${maxRedirects}) starting from ${startUrl}`,
  );
}

// ----- content-type routing ------------------------------------------------

export type ContentKind = 'html' | 'pdf' | 'text' | 'unsupported';

/**
 * Routes a raw `Content-Type` header value to the loader family that can
 * extract readable text from it. `unsupported` covers binary payloads
 * (images, archives, octet-streams) the snapshot flow refuses to ingest.
 * A missing header is treated as `text` — the loader copes with plain text
 * and the user can still inspect the result.
 */
export function classifyContentType(raw: string | undefined): ContentKind {
  const base = (raw ?? '').split(';')[0].trim().toLowerCase();
  if (base === '') return 'text';
  if (base === 'application/pdf' || base === 'application/x-pdf') return 'pdf';
  if (base === 'text/html' || base === 'application/xhtml+xml') return 'html';
  if (base.startsWith('text/')) return 'text';
  if (
    base === 'application/json' ||
    base === 'application/xml' ||
    base.endsWith('+xml') ||
    base.endsWith('+json')
  ) {
    return 'text';
  }
  return 'unsupported';
}

/** Temp-file extension that routes `kind` to the matching loader. */
export function extensionForKind(kind: ContentKind): string {
  if (kind === 'pdf') return '.pdf';
  if (kind === 'html') return '.html';
  return '.txt';
}

// ----- title + slug helpers ------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    });
}

/** Extracts the `<title>` text from raw HTML, or null when absent/empty. */
export function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (m === null) return null;
  const decoded = decodeBasicEntities(m[1]).replace(/\s+/g, ' ').trim();
  return decoded === '' ? null : decoded;
}

/** Derives a human-ish title from a URL's last path segment or its host. */
export function deriveTitleFromUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last !== undefined) {
    let decoded = last;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      /* keep the raw segment */
    }
    const cleaned = decoded.replace(/\.[A-Za-z0-9]+$/, '').replace(/[-_]+/g, ' ').trim();
    if (cleaned.length > 0) return cleaned;
  }
  return url.hostname;
}

/** Lowercased, dash-joined, length-capped filename slug. */
export function slugifyForFilename(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug.length > 0 ? slug.slice(0, 80).replace(/-+$/, '') : 'snapshot';
}

// ----- snapshot note builder -----------------------------------------------

export interface SnapshotNoteFields {
  title: string;
  /** The URL the user asked for — the canonical provenance pointer. */
  sourceUrl: string;
  /** The URL that actually served the content; omitted when == sourceUrl. */
  resolvedUrl?: string;
  fetchedAt: string;
  contentSha256: string;
  contentType: string;
  httpStatus: number;
  byteCount: number;
  text: string;
}

/**
 * Renders a KB note with a provenance YAML frontmatter block followed by the
 * extracted plain text. Frontmatter is emitted via `js-yaml` so URLs and
 * titles are quoted/escaped correctly. `title` is a frontmatter-lift
 * whitelisted key; the provenance fields ride along as on-disk extras.
 */
export function buildSnapshotNote(fields: SnapshotNoteFields): string {
  const meta: Record<string, unknown> = {
    title: fields.title,
    source_url: fields.sourceUrl,
  };
  if (fields.resolvedUrl !== undefined && fields.resolvedUrl !== fields.sourceUrl) {
    meta.resolved_url = fields.resolvedUrl;
  }
  meta.fetched_at = fields.fetchedAt;
  meta.content_sha256 = fields.contentSha256;
  meta.content_type = fields.contentType;
  meta.http_status = fields.httpStatus;
  meta.byte_count = fields.byteCount;
  const frontmatter = yaml.dump(meta, { sortKeys: false, lineWidth: 0, noRefs: true });
  const body = fields.text.trim();
  return `---\n${frontmatter}---\n\n# ${fields.title}\n\n${body}\n`;
}

// ----- default network fetcher ---------------------------------------------

export interface UrlSnapshot {
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  body: Buffer;
}

export interface FetchUrlOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  allowLocalNetwork: boolean;
}

/** Pluggable fetcher seam — the CLI injects a fake in tests. */
export type UrlFetcher = (startUrl: string, opts: FetchUrlOptions) => Promise<UrlSnapshot>;

const USER_AGENT = 'knowledge-base-mcp-server/kb-import-url';

function lowercaseHeaders(headers: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (headers !== null && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      out[key.toLowerCase()] = Array.isArray(value)
        ? value.map(String).join(', ')
        : value === undefined || value === null
          ? undefined
          : String(value);
    }
  }
  return out;
}

/**
 * Default production fetcher: an axios GET per hop with redirects disabled
 * (so {@link followRedirectChain} owns the chain and re-validates each hop),
 * a byte cap, a timeout, and — critically — an http(s) agent whose DNS
 * `lookup` re-runs the {@link isBlockedAddress} guard at connection time.
 * Pinning the connection to the validated address closes the redirect /
 * DNS-rebinding TOCTOU window that a one-shot pre-flight check leaves open.
 */
export async function fetchUrlSnapshot(
  startUrl: string,
  opts: FetchUrlOptions,
): Promise<UrlSnapshot> {
  const { default: axios } = await import('axios');
  const http = await import('node:http');
  const https = await import('node:https');
  const dns = await import('node:dns');

  const resolver: AddressResolver = async (hostname) => {
    const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return addresses.map((a) => a.address);
  };

  // Connection-time guard: every socket — including ones opened for a
  // redirect target — resolves through here, so a host that flips to a
  // private address between the pre-flight check and connect is still
  // rejected, and the connection is pinned to the validated address.
  const guardedLookup = (
    hostname: string,
    options: LookupOptions,
    callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err !== null) {
        callback(err, '', 0);
        return;
      }
      if (!opts.allowLocalNetwork) {
        for (const entry of addresses) {
          if (isBlockedAddress(entry.address)) {
            callback(
              new UrlSnapshotError(
                `host ${hostname} resolves to a private/loopback address: ${entry.address}`,
              ),
              '',
              0,
            );
            return;
          }
        }
      }
      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      const wantFamily = options.family;
      const picked =
        wantFamily === 4 || wantFamily === 6
          ? addresses.find((a) => a.family === wantFamily) ?? addresses[0]
          : addresses[0];
      callback(null, picked.address, picked.family);
    });
  };

  // `lookup` is honored by `net.createConnection` but is not declared on
  // the public `AgentOptions` type; the cast threads it through.
  const httpAgent = new http.Agent({ lookup: guardedLookup } as unknown as HttpAgentOptions);
  const httpsAgent = new https.Agent({ lookup: guardedLookup } as unknown as HttpsAgentOptions);

  const fetchOnce: FetchOnce = async (url) => {
    const parsed = assertHttpUrl(url);
    // Pre-flight DNS guard: surfaces a clean private-address error before
    // axios ever opens a socket. The agent `lookup` above is the actual
    // TOCTOU-safe enforcement point.
    await assertHostAllowed(parsed.hostname, resolver, opts.allowLocalNetwork);
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        maxRedirects: 0,
        timeout: opts.timeoutMs,
        maxContentLength: opts.maxBytes,
        maxBodyLength: opts.maxBytes,
        decompress: true,
        validateStatus: () => true,
        httpAgent,
        httpsAgent,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      });
      return {
        url,
        status: response.status,
        headers: lowercaseHeaders(response.headers),
        body: Buffer.from(response.data as ArrayBuffer),
      };
    } catch (err) {
      if (err instanceof UrlSnapshotError) throw err;
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof UrlSnapshotError) throw cause;
      const code = (err as NodeJS.ErrnoException).code;
      const message = (err as Error).message ?? String(err);
      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(message)) {
        throw new UrlSnapshotError(`request to ${url} timed out after ${opts.timeoutMs}ms`);
      }
      if (/maxContentLength|maxBodyLength/i.test(message)) {
        throw new UrlSnapshotError(
          `response from ${url} exceeds the --max-bytes limit (${opts.maxBytes} bytes)`,
        );
      }
      throw new UrlSnapshotError(`failed to fetch ${url}: ${message}`);
    }
  };

  const result = await followRedirectChain(startUrl, fetchOnce, opts.maxRedirects);
  if (result.body.length > opts.maxBytes) {
    throw new UrlSnapshotError(
      `response from ${result.url} exceeds the --max-bytes limit (${opts.maxBytes} bytes)`,
    );
  }
  return {
    finalUrl: result.url,
    httpStatus: result.status,
    contentType: result.headers['content-type'] ?? '',
    body: result.body,
  };
}
