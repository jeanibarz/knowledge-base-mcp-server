import { describe, expect, it } from '@jest/globals';
import yaml from 'js-yaml';
import {
  assertHostAllowed,
  assertHttpUrl,
  buildSnapshotNote,
  classifyContentType,
  deriveTitleFromUrl,
  extensionForKind,
  extractHtmlTitle,
  followRedirectChain,
  isBlockedAddress,
  slugifyForFilename,
  UrlSnapshotError,
  type RawHttpResponse,
} from './url-snapshot.js';

// ---------------------------------------------------------------------------
// isBlockedAddress — the SSRF address classifier
// ---------------------------------------------------------------------------

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['127.9.9.9', 'IPv4 loopback range'],
    ['10.0.0.5', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12 low'],
    ['172.31.255.254', 'private 172.16/12 high'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.169.254', 'link-local cloud metadata'],
    ['0.0.0.0', 'unspecified IPv4'],
    ['100.64.0.1', 'CGNAT 100.64/10'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00::1', 'IPv6 unique-local'],
    ['fc00::abcd', 'IPv6 unique-local fc00'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['not-an-ip', 'unparseable input fails closed'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'public DNS'],
    ['1.1.1.1', 'public DNS'],
    ['93.184.216.34', 'example.com'],
    ['172.15.0.1', 'just outside 172.16/12'],
    ['172.32.0.1', 'just outside 172.16/12'],
    ['192.167.0.1', 'just outside 192.168/16'],
    ['100.63.0.1', 'just outside CGNAT'],
    ['2606:4700:4700::1111', 'public IPv6'],
    ['::ffff:8.8.8.8', 'IPv4-mapped public'],
  ])('allows %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertHttpUrl
// ---------------------------------------------------------------------------

describe('assertHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(assertHttpUrl('http://example.com/x').protocol).toBe('http:');
    expect(assertHttpUrl('https://example.com/x').protocol).toBe('https:');
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/x',
    'data:text/plain,hello',
  ])('rejects non-http scheme %s', (raw) => {
    expect(() => assertHttpUrl(raw)).toThrow(/unsupported URL scheme/);
  });

  it('rejects strings that are not URLs', () => {
    expect(() => assertHttpUrl('not a url')).toThrow(UrlSnapshotError);
  });
});

// ---------------------------------------------------------------------------
// assertHostAllowed
// ---------------------------------------------------------------------------

describe('assertHostAllowed', () => {
  const neverCalled = async (): Promise<string[]> => {
    throw new Error('resolver should not be called');
  };

  it('passes an IP-literal host that is public without resolving', async () => {
    await expect(assertHostAllowed('8.8.8.8', neverCalled, false)).resolves.toBeUndefined();
  });

  it('rejects an IP-literal host that is private', async () => {
    await expect(assertHostAllowed('127.0.0.1', neverCalled, false)).rejects.toThrow(
      /private\/loopback/,
    );
  });

  it('strips IPv6 brackets before classifying', async () => {
    await expect(assertHostAllowed('[::1]', neverCalled, false)).rejects.toThrow(UrlSnapshotError);
  });

  it('allows a named host that resolves only to public addresses', async () => {
    const resolve = async (): Promise<string[]> => ['93.184.216.34'];
    await expect(assertHostAllowed('example.com', resolve, false)).resolves.toBeUndefined();
  });

  it('rejects a named host that resolves to any private address', async () => {
    const resolve = async (): Promise<string[]> => ['93.184.216.34', '10.0.0.1'];
    await expect(assertHostAllowed('rebind.example', resolve, false)).rejects.toThrow(
      /resolves to a private/,
    );
  });

  it('rejects a named host with no addresses', async () => {
    const resolve = async (): Promise<string[]> => [];
    await expect(assertHostAllowed('nx.example', resolve, false)).rejects.toThrow(
      /could not resolve/,
    );
  });

  it('skips every check when allowLocalNetwork is set', async () => {
    await expect(assertHostAllowed('127.0.0.1', neverCalled, true)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// followRedirectChain
// ---------------------------------------------------------------------------

function res(partial: Partial<RawHttpResponse> & { url: string; status: number }): RawHttpResponse {
  return {
    headers: {},
    body: Buffer.alloc(0),
    ...partial,
  };
}

describe('followRedirectChain', () => {
  it('returns the first 2xx response directly', async () => {
    const fetchOnce = async (url: string): Promise<RawHttpResponse> =>
      res({ url, status: 200, body: Buffer.from('ok') });
    const out = await followRedirectChain('https://example.com/', fetchOnce, 5);
    expect(out.status).toBe(200);
    expect(out.body.toString()).toBe('ok');
  });

  it('follows a redirect chain and resolves a relative Location', async () => {
    const responses: Record<string, RawHttpResponse> = {
      'https://example.com/a': res({
        url: 'https://example.com/a',
        status: 301,
        headers: { location: '/b' },
      }),
      'https://example.com/b': res({
        url: 'https://example.com/b',
        status: 200,
        body: Buffer.from('final'),
      }),
    };
    const out = await followRedirectChain(
      'https://example.com/a',
      async (url) => responses[url],
      5,
    );
    expect(out.url).toBe('https://example.com/b');
    expect(out.body.toString()).toBe('final');
  });

  it('throws when a redirect has no Location header', async () => {
    const fetchOnce = async (url: string): Promise<RawHttpResponse> =>
      res({ url, status: 302 });
    await expect(followRedirectChain('https://example.com/', fetchOnce, 5)).rejects.toThrow(
      /no Location header/,
    );
  });

  it('throws after exceeding the redirect limit', async () => {
    let n = 0;
    const fetchOnce = async (url: string): Promise<RawHttpResponse> =>
      res({ url, status: 302, headers: { location: `https://example.com/${n++}` } });
    await expect(followRedirectChain('https://example.com/start', fetchOnce, 3)).rejects.toThrow(
      /too many redirects/,
    );
  });

  it('throws on a non-2xx terminal status', async () => {
    const fetchOnce = async (url: string): Promise<RawHttpResponse> =>
      res({ url, status: 404 });
    await expect(followRedirectChain('https://example.com/', fetchOnce, 5)).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('rejects a redirect that points at a non-http scheme', async () => {
    const fetchOnce = async (url: string): Promise<RawHttpResponse> =>
      res({ url, status: 302, headers: { location: 'file:///etc/passwd' } });
    await expect(followRedirectChain('https://example.com/', fetchOnce, 5)).rejects.toThrow(
      /unsupported URL scheme/,
    );
  });
});

// ---------------------------------------------------------------------------
// content-type routing
// ---------------------------------------------------------------------------

describe('classifyContentType', () => {
  it.each([
    ['text/html', 'html'],
    ['text/html; charset=utf-8', 'html'],
    ['application/xhtml+xml', 'html'],
    ['application/pdf', 'pdf'],
    ['text/plain', 'text'],
    ['text/markdown; charset=utf-8', 'text'],
    ['application/json', 'text'],
    ['', 'text'],
    [undefined, 'text'],
    ['image/png', 'unsupported'],
    ['application/octet-stream', 'unsupported'],
  ])('classifies %s as %s', (raw, expected) => {
    expect(classifyContentType(raw)).toBe(expected);
  });
});

describe('extensionForKind', () => {
  it('routes each kind to the loader-selecting extension', () => {
    expect(extensionForKind('pdf')).toBe('.pdf');
    expect(extensionForKind('html')).toBe('.html');
    expect(extensionForKind('text')).toBe('.txt');
  });
});

// ---------------------------------------------------------------------------
// title + slug helpers
// ---------------------------------------------------------------------------

describe('extractHtmlTitle', () => {
  it('extracts and decodes the <title> text', () => {
    expect(extractHtmlTitle('<html><head><title>Hello &amp; Goodbye</title></head></html>'))
      .toBe('Hello & Goodbye');
  });

  it('collapses whitespace inside the title', () => {
    expect(extractHtmlTitle('<title>  multi\n  line  </title>')).toBe('multi line');
  });

  it('returns null when there is no usable title', () => {
    expect(extractHtmlTitle('<html><body>no title</body></html>')).toBeNull();
    expect(extractHtmlTitle('<title>   </title>')).toBeNull();
  });
});

describe('deriveTitleFromUrl', () => {
  it('uses the last path segment without its extension', () => {
    expect(deriveTitleFromUrl('https://example.com/docs/getting-started.html'))
      .toBe('getting started');
  });

  it('falls back to the hostname when there is no path', () => {
    expect(deriveTitleFromUrl('https://example.com/')).toBe('example.com');
  });
});

describe('slugifyForFilename', () => {
  it('lowercases, dash-joins, and caps length', () => {
    expect(slugifyForFilename('Hello, World!')).toBe('hello-world');
  });

  it('falls back to "snapshot" for empty slugs', () => {
    expect(slugifyForFilename('!!!')).toBe('snapshot');
  });
});

// ---------------------------------------------------------------------------
// buildSnapshotNote
// ---------------------------------------------------------------------------

describe('buildSnapshotNote', () => {
  function parsed(note: string): { fm: Record<string, unknown>; body: string } {
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(note);
    if (m === null) throw new Error('note has no frontmatter fence');
    return { fm: yaml.load(m[1]) as Record<string, unknown>, body: m[2] };
  }

  it('emits a provenance frontmatter block and the extracted body', () => {
    const note = buildSnapshotNote({
      title: 'Example Article',
      sourceUrl: 'https://example.com/article',
      fetchedAt: '2026-05-19T12:00:00.000Z',
      contentSha256: 'a'.repeat(64),
      contentType: 'text/html',
      httpStatus: 200,
      byteCount: 4321,
      text: 'The extracted plain text.',
    });
    const { fm, body } = parsed(note);
    expect(fm).toMatchObject({
      title: 'Example Article',
      source_url: 'https://example.com/article',
      fetched_at: '2026-05-19T12:00:00.000Z',
      content_sha256: 'a'.repeat(64),
      content_type: 'text/html',
      http_status: 200,
      byte_count: 4321,
    });
    expect(fm).not.toHaveProperty('resolved_url');
    expect(body).toContain('# Example Article');
    expect(body).toContain('The extracted plain text.');
  });

  it('records resolved_url only when it differs from source_url', () => {
    const note = buildSnapshotNote({
      title: 'T',
      sourceUrl: 'https://example.com/a',
      resolvedUrl: 'https://example.com/b',
      fetchedAt: '2026-05-19T12:00:00.000Z',
      contentSha256: 'b'.repeat(64),
      contentType: 'text/html',
      httpStatus: 200,
      byteCount: 10,
      text: 'body',
    });
    expect(parsed(note).fm.resolved_url).toBe('https://example.com/b');
  });

  it('keeps a query-string URL parseable through the YAML round-trip', () => {
    const url = 'https://example.com/search?q=a:b#frag';
    const note = buildSnapshotNote({
      title: 'T',
      sourceUrl: url,
      fetchedAt: '2026-05-19T12:00:00.000Z',
      contentSha256: 'c'.repeat(64),
      contentType: 'text/html',
      httpStatus: 200,
      byteCount: 10,
      text: 'body',
    });
    expect(parsed(note).fm.source_url).toBe(url);
  });
});
