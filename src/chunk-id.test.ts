import { describe, expect, it } from '@jest/globals';
import { buildChunkCitation, buildChunkId, buildEditorUri } from './chunk-id.js';

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
