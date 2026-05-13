import { Document } from '@langchain/core/documents';
import {
  buildChunkManifest,
  countStableChunkPrefix,
  normalizeChunkTextForEmbedding,
} from './file-ingest.js';

describe('normalizeChunkTextForEmbedding', () => {
  it('collapses insignificant text differences before indexing dedupe', () => {
    expect(normalizeChunkTextForEmbedding('  Cafe\u0301\t\nrunbook   section  ')).toBe('Caf\u00e9 runbook section');
  });
});

describe('buildChunkManifest', () => {
  it('hashes normalized chunk text and stable metadata for prefix comparison', () => {
    const first = buildChunkManifest(
      [
        new Document({
          pageContent: '  Cafe\u0301\t\nrunbook   section  ',
          metadata: { source: '/kb/doc.md', chunkIndex: 0, tags: ['ops'] },
        }),
        new Document({
          pageContent: 'next section',
          metadata: { tags: ['ops'], chunkIndex: 1, source: '/kb/doc.md' },
        }),
      ],
      'a'.repeat(64),
    );
    const second = buildChunkManifest(
      [
        new Document({
          pageContent: 'Caf\u00e9 runbook section',
          metadata: { tags: ['ops'], chunkIndex: 0, source: '/kb/doc.md' },
        }),
        new Document({
          pageContent: 'changed section',
          metadata: { source: '/kb/doc.md', chunkIndex: 1, tags: ['ops'] },
        }),
      ],
      'b'.repeat(64),
    );

    expect(first.schema_version).toBe('kb.chunk-manifest.v1');
    expect(first.chunks).toHaveLength(2);
    expect(first.chunks[0]).toEqual(expect.objectContaining({
      chunkIndex: 0,
      textHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      metadataHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      vectorDocstoreId: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(first.chunks[0].textHash).toBe(second.chunks[0].textHash);
    expect(first.chunks[0].metadataHash).toBe(second.chunks[0].metadataHash);
    expect(countStableChunkPrefix(first, second)).toBe(1);
  });
});
