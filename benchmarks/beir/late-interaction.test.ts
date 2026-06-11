import { describe, expect, it } from '@jest/globals';
import {
  LATE_INTERACTION_SCHEMA_VERSION,
  LateInteractionIndex,
  tokenize,
} from './late-interaction.js';

describe('late interaction benchmark adapter', () => {
  it('tokenizes normalized word pieces for token-level matching', () => {
    expect(tokenize('Alpha gravity-wave detection, v2.')).toEqual([
      'alpha',
      'gravity-wave',
      'detection',
      'v2.',
    ]);
  });

  it('ranks by ColBERT-style query-token MaxSim', () => {
    const index = LateInteractionIndex.build([
      {
        id: 'doc-alpha',
        text: 'Alpha gravity wave detection evidence and analysis.',
        metadata: { relativePath: 'tiny/doc-alpha.md' },
      },
      {
        id: 'doc-beta',
        text: 'Beta culinary recipe for a hearty tomato soup.',
        metadata: { relativePath: 'tiny/doc-beta.md' },
      },
    ]);

    const hits = index.search('alpha gravity wave detection', 2);

    expect(hits.map((hit) => hit.id)).toEqual(['doc-alpha', 'doc-beta']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(index.resourceReport('standalone', null)).toMatchObject({
      schema_version: LATE_INTERACTION_SCHEMA_VERSION,
      enabled: true,
      mode: 'standalone',
      model: 'hashed-token-maxsim-v1',
      documents_indexed: 2,
      gpu_requirement: expect.stringContaining('None'),
    });
  });

  it('reranks only a provided candidate set', () => {
    const index = LateInteractionIndex.build([
      {
        id: 'doc-alpha',
        text: 'Alpha gravity wave detection evidence.',
        metadata: { relativePath: 'tiny/doc-alpha.md' },
      },
      {
        id: 'doc-beta',
        text: 'Beta culinary recipe.',
        metadata: { relativePath: 'tiny/doc-beta.md' },
      },
    ]);

    const hits = index.rerank('tomato soup recipe', [
      {
        id: 'candidate-alpha',
        text: 'Alpha gravity wave detection evidence.',
        metadata: { relativePath: 'tiny/doc-alpha.md' },
      },
      {
        id: 'candidate-beta',
        text: 'Tomato soup recipe with basil.',
        metadata: { relativePath: 'tiny/doc-beta.md' },
      },
    ], 2);

    expect(hits.map((hit) => hit.id)).toEqual(['candidate-beta', 'candidate-alpha']);
  });
});
