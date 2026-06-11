import { describe, expect, it } from '@jest/globals';
import { Document } from '@langchain/core/documents';

import { embeddingText } from './contextual-preface.js';
import {
  buildRetrievalViewDocuments,
  collapseRetrievalViewResults,
  parseRetrievalViews,
  shouldKeepForRetrievalViews,
} from './retrieval-views.js';

function canonicalDoc(): Document {
  return new Document({
    pageContent: '## Rollback\n\nRollback approval requires the release lead.',
    metadata: {
      source: '/kb/ops/runbook.md',
      relativePath: 'ops/runbook.md',
      knowledgeBase: 'ops',
      extension: '.md',
      chunkIndex: 3,
      tags: ['deploy'],
      frontmatter: { title: 'Operations Runbook' },
      contextual_preface: 'In section "Rollback", this chunk describes release rollback approval.',
    },
  });
}

describe('retrieval views', () => {
  it('parses csv, all, and off retrieval-view flags', () => {
    expect(parseRetrievalViews('passage,section,metadata,section')).toEqual([
      'passage',
      'section',
      'metadata',
    ]);
    expect(parseRetrievalViews('all')).toEqual(['passage', 'section', 'metadata', 'summary']);
    expect(parseRetrievalViews('off')).toEqual([]);
    expect(() => parseRetrievalViews('passage,unknown')).toThrow(/invalid retrieval view/);
  });

  it('emits extra view documents mapped to the canonical chunk', () => {
    const docs = buildRetrievalViewDocuments([canonicalDoc()], ['passage', 'section', 'metadata', 'summary']);
    expect(docs).toHaveLength(4);
    expect(docs[0].metadata.retrieval_view).toBeUndefined();

    const views = docs.slice(1).map((doc) => doc.metadata.retrieval_view as Record<string, unknown>);
    expect(views.map((view) => view.kind)).toEqual(['section', 'metadata', 'summary']);
    expect(embeddingText(docs[1])).toContain('Source: Operations Runbook');
    expect(embeddingText(docs[2])).toContain('Path: ops/runbook.md');
    expect(embeddingText(docs[3])).toContain('Summary: In section "Rollback"');
    for (const view of views) {
      expect(view).toMatchObject({
        schema_version: 'kb.retrieval-view.v1',
        canonical_id: '/kb/ops/runbook.md#3',
        canonical_source: '/kb/ops/runbook.md',
        canonical_chunk_index: 3,
      });
    }
  });

  it('keeps view records out of default searches and includes requested views only when opted in', () => {
    const [, section, metadata] = buildRetrievalViewDocuments([canonicalDoc()], ['section', 'metadata']);
    expect(shouldKeepForRetrievalViews(canonicalDoc(), undefined)).toBe(true);
    expect(shouldKeepForRetrievalViews(section, undefined)).toBe(false);
    expect(shouldKeepForRetrievalViews(section, ['section'])).toBe(true);
    expect(shouldKeepForRetrievalViews(metadata, ['section'])).toBe(false);
    expect(shouldKeepForRetrievalViews(canonicalDoc(), ['metadata'])).toBe(false);
  });

  it('collapses multiple view hits into one canonical result with diagnostics', () => {
    const [passage, section, metadata] = buildRetrievalViewDocuments([canonicalDoc()], ['section', 'metadata']);
    const collapsed = collapseRetrievalViewResults([
      { ...section, score: 0.8 },
      { ...metadata, score: 0.7 },
      { ...passage, score: 0.9 },
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].pageContent).toBe(passage.pageContent);
    expect(collapsed[0].metadata.retrieval_view).toBeUndefined();
    expect(collapsed[0].metadata.retrieval_view_collapse).toMatchObject({
      canonical_id: '/kb/ops/runbook.md#3',
      hit_count: 3,
      hits: [
        { view: 'section', rank: 1, score: 0.8 },
        { view: 'metadata', rank: 2, score: 0.7 },
        { view: 'passage', rank: 3, score: 0.9 },
      ],
      zoom_out: {
        source_title: 'Operations Runbook',
        section_title: 'Rollback',
      },
    });
    expect(collapsed[0].score).toBeLessThan(0.7);
  });

  it('strengthens and sorts higher-is-better lexical scores correctly', () => {
    const [passageA, sectionA] = buildRetrievalViewDocuments([canonicalDoc()], ['section']);
    const [passageB, sectionB] = buildRetrievalViewDocuments([
      new Document({
        pageContent: '## Deploy\n\nDeploy notes.',
        metadata: {
          source: '/kb/ops/deploy.md',
          relativePath: 'ops/deploy.md',
          knowledgeBase: 'ops',
          extension: '.md',
          chunkIndex: 0,
        },
      }),
    ], ['section']);

    const collapsed = collapseRetrievalViewResults([
      { ...sectionA, score: 4 },
      { ...passageA, score: 3 },
      { ...sectionB, score: 7 },
      { ...passageB, score: 6 },
    ], { scoreDirection: 'higher' });

    expect(collapsed.map((doc) => doc.metadata.source)).toEqual([
      '/kb/ops/deploy.md',
      '/kb/ops/runbook.md',
    ]);
    expect(collapsed[0].score).toBeGreaterThan(7);
  });
});
