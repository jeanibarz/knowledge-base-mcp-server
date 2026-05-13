import { normalizeChunkTextForEmbedding } from './file-ingest.js';

describe('normalizeChunkTextForEmbedding', () => {
  it('collapses insignificant text differences before indexing dedupe', () => {
    expect(normalizeChunkTextForEmbedding('  Cafe\u0301\t\nrunbook   section  ')).toBe('Caf\u00e9 runbook section');
  });
});
