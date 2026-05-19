import { describe, expect, it } from '@jest/globals';
import {
  buildChunkCitation,
  buildChunkId,
  buildEditorUri,
  parseChunkReference,
} from './chunk-id.js';

describe('chunk citation handles', () => {
  it('builds a line-range chunk_id from KB, relative path, and loc.lines', () => {
    expect(buildChunkId({
      knowledgeBase: 'alpha',
      relativePath: 'alpha/docs/deploy.md',
      loc: { lines: { from: 42, to: 78 } },
      chunkIndex: 3,
    })).toBe('alpha/docs/deploy.md#L42-L78');
  });

  it('falls back to chunk index when line information is absent', () => {
    expect(buildChunkId({
      knowledgeBase: 'alpha',
      relativePath: 'alpha/pdfs/report.pdf',
      chunkIndex: 12,
    })).toBe('alpha/pdfs/report.pdf#chunk-12');
  });

  it('percent-encodes reserved path characters in handles and kb:// URIs', () => {
    const citation = buildChunkCitation({
      knowledgeBase: 'alpha',
      relativePath: 'alpha/docs/bug #123?.md',
      loc: { lines: { from: 4, to: 5 } },
      chunkIndex: 0,
    }, 'none');

    expect(citation?.chunk_id).toBe('alpha/docs/bug%20%23123%3F.md#L4-L5');
    expect(citation?.resource_uri).toBe('kb://alpha/docs/bug%20%23123%3F.md#L4-L5');
  });

  it('omits citation data when metadata lacks a stable KB/path/chunk anchor', () => {
    expect(buildChunkId({ source: 'doc.md' })).toBeNull();
  });
});

describe('editor URI output', () => {
  const metadata = {
    source: '/tmp/kbs/alpha/docs/deploy note.md',
    knowledgeBase: 'alpha',
    relativePath: 'alpha/docs/deploy note.md',
    loc: { lines: { from: 42, to: 78 } },
    chunkIndex: 0,
  };

  it('omits editor_uri by default', () => {
    expect(buildEditorUri(metadata, 'none')).toBeNull();
  });

  it('builds vscode and cursor line-jump URIs from absolute paths', () => {
    expect(buildEditorUri(metadata, 'vscode')).toBe(
      'vscode://file/tmp/kbs/alpha/docs/deploy note.md:42:0',
    );
    expect(buildEditorUri(metadata, 'cursor')).toBe(
      'cursor://file/tmp/kbs/alpha/docs/deploy note.md:42:0',
    );
  });

  it('builds file URIs with a line fragment', () => {
    expect(buildEditorUri(metadata, 'file')).toBe(
      'file:///tmp/kbs/alpha/docs/deploy%20note.md#L42',
    );
  });
});

describe('parseChunkReference (#411)', () => {
  it('parses a chunk id with an L<from>-L<to> fragment', () => {
    expect(parseChunkReference('alpha/docs/deploy.md#L42-L78')).toEqual({
      raw: 'alpha/docs/deploy.md#L42-L78',
      kind: 'chunk-id',
      knowledgeBase: 'alpha',
      kbRelativePath: 'docs/deploy.md',
      displayPath: 'alpha/docs/deploy.md',
      lineFrom: 42,
      lineTo: 78,
    });
  });

  it('treats a bare L<line> fragment as a single-line range', () => {
    const ref = parseChunkReference('alpha/docs/deploy.md#L42');
    expect(ref.lineFrom).toBe(42);
    expect(ref.lineTo).toBe(42);
  });

  it('parses a chunk-N fragment without inferring a line range', () => {
    const ref = parseChunkReference('alpha/pdfs/report.pdf#chunk-12');
    expect(ref).toMatchObject({ kind: 'chunk-id', chunkIndex: 12 });
    expect(ref.lineFrom).toBeUndefined();
  });

  it('parses a kb:// URI and its optional fragment', () => {
    expect(parseChunkReference('kb://alpha/docs/deploy.md#L1-L9')).toMatchObject({
      kind: 'kb-uri',
      knowledgeBase: 'alpha',
      kbRelativePath: 'docs/deploy.md',
      lineFrom: 1,
      lineTo: 9,
    });
    expect(parseChunkReference('kb://alpha/docs/deploy.md')).toMatchObject({
      kind: 'kb-uri',
      kbRelativePath: 'docs/deploy.md',
    });
  });

  it('parses a plain KB-relative path with no fragment', () => {
    expect(parseChunkReference('alpha/docs/deploy.md')).toEqual({
      raw: 'alpha/docs/deploy.md',
      kind: 'path',
      knowledgeBase: 'alpha',
      kbRelativePath: 'docs/deploy.md',
      displayPath: 'alpha/docs/deploy.md',
    });
  });

  it('treats a non-chunk # as a literal character in a plain path', () => {
    const ref = parseChunkReference('alpha/docs/bug#123.md');
    expect(ref.kind).toBe('path');
    expect(ref.kbRelativePath).toBe('docs/bug#123.md');
  });

  it('round-trips the chunk_id that buildChunkId emits', () => {
    const chunkId = buildChunkId({
      knowledgeBase: 'alpha',
      relativePath: 'alpha/docs/deploy.md',
      loc: { lines: { from: 42, to: 78 } },
    });
    const ref = parseChunkReference(chunkId as string);
    expect(ref.knowledgeBase).toBe('alpha');
    expect(ref.kbRelativePath).toBe('docs/deploy.md');
    expect([ref.lineFrom, ref.lineTo]).toEqual([42, 78]);
  });

  it('decodes percent-encoded segments in a chunk id', () => {
    const ref = parseChunkReference('alpha/docs/bug%20%23123%3F.md#L4-L5');
    expect(ref.kbRelativePath).toBe('docs/bug #123?.md');
    expect(ref.lineFrom).toBe(4);
  });

  it('rejects an empty reference', () => {
    expect(() => parseChunkReference('   ')).toThrow(/must not be empty/);
  });

  it('rejects a reference with no resolvable <kb>/<path> shape', () => {
    expect(() => parseChunkReference('justaword')).toThrow(/cannot parse reference/);
  });

  it('rejects a kb:// URI with an unrecognized fragment', () => {
    expect(() => parseChunkReference('kb://alpha/docs/deploy.md#section'))
      .toThrow(/unrecognized fragment/);
  });
});
