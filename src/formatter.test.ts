import { describe, expect, it } from '@jest/globals';
import {
  formatRetrievalAsJson,
  formatRetrievalGroupedBySourceAsMarkdown,
  formatRetrievalAsMarkdown,
  groupRetrievalBySource,
  sanitizeMetadataForWire,
  ScoredDocument,
} from './formatter.js';

describe('sanitizeMetadataForWire', () => {
  it('strips frontmatter.extras when extras visibility is disabled', () => {
    const input = {
      source: 'doc.md',
      frontmatter: { title: 'Hi', extras: { secret: 'value' } },
    };
    const out = sanitizeMetadataForWire(input, false) as typeof input;
    expect(out.frontmatter).toEqual({ title: 'Hi' });
    expect(out.frontmatter).not.toHaveProperty('extras');
  });

  it('preserves frontmatter.extras when visibility is enabled', () => {
    const input = {
      source: 'doc.md',
      frontmatter: { title: 'Hi', extras: { secret: 'value' } },
    };
    const out = sanitizeMetadataForWire(input, true);
    expect(out).toBe(input); // pass-through, no clone
  });

  it('does not clone metadata that has no frontmatter.extras', () => {
    const input = { source: 'doc.md' };
    const out = sanitizeMetadataForWire(input, false);
    expect(out).toBe(input);
  });

  it('does not mutate the original metadata object', () => {
    const original = {
      source: 'doc.md',
      frontmatter: { title: 'Hi', extras: { secret: 'value' } },
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    sanitizeMetadataForWire(original, false);
    expect(original).toEqual(snapshot);
  });
});

describe('formatRetrievalAsMarkdown', () => {
  const sampleDoc: ScoredDocument = {
    pageContent: 'sample content',
    metadata: { source: 'kb/doc.md' },
    score: 0.42,
    id: undefined,
  } as unknown as ScoredDocument;

  it('emits a "no results" body when results are empty', () => {
    const out = formatRetrievalAsMarkdown([], false);
    expect(out).toContain('## Semantic Search Results');
    expect(out).toContain('_No similar results found._');
    expect(out).toContain('Disclaimer');
  });

  it('handles null/undefined gracefully', () => {
    expect(formatRetrievalAsMarkdown(null, false)).toContain('No similar results');
    expect(formatRetrievalAsMarkdown(undefined, false)).toContain('No similar results');
  });

  it('renders one result with score, content, and source block', () => {
    const out = formatRetrievalAsMarkdown([sampleDoc], false);
    expect(out).toContain('**Result 1:**');
    expect(out).toContain('**Score:** 0.42');
    expect(out).toContain('sample content');
    expect(out).toContain('"source": "kb/doc.md"');
  });

  it('separates multiple results with --- and numbers them', () => {
    const docs = [sampleDoc, { ...sampleDoc, pageContent: 'second' } as ScoredDocument];
    const out = formatRetrievalAsMarkdown(docs, false);
    expect(out).toContain('**Result 1:**');
    expect(out).toContain('**Result 2:**');
    expect(out).toContain('---');
  });

  it('strips frontmatter.extras by default in the rendered metadata block', () => {
    const docWithExtras: ScoredDocument = {
      pageContent: 'x',
      metadata: { source: 'doc.md', frontmatter: { title: 'T', extras: { secret: 'shh' } } },
    } as unknown as ScoredDocument;
    const out = formatRetrievalAsMarkdown([docWithExtras], false);
    expect(out).not.toContain('secret');
    expect(out).not.toContain('shh');
    expect(out).toContain('"title": "T"');
  });
});

describe('formatRetrievalAsJson', () => {
  it('returns [] for empty results', () => {
    expect(formatRetrievalAsJson([], false)).toEqual([]);
    expect(formatRetrievalAsJson(null, false)).toEqual([]);
    expect(formatRetrievalAsJson(undefined, false)).toEqual([]);
  });

  it('returns shape { score, content, metadata } per result', () => {
    const doc: ScoredDocument = {
      pageContent: 'c',
      metadata: { source: 'doc.md' },
      score: 1.5,
    } as unknown as ScoredDocument;
    expect(formatRetrievalAsJson([doc], false)).toEqual([
      { score: 1.5, content: 'c', metadata: { source: 'doc.md' } },
    ]);
  });

  it('exposes score as null when missing', () => {
    const doc: ScoredDocument = {
      pageContent: 'c',
      metadata: {},
    } as unknown as ScoredDocument;
    expect(formatRetrievalAsJson([doc], false)[0].score).toBeNull();
  });

  it('strips extras by default', () => {
    const doc: ScoredDocument = {
      pageContent: 'c',
      metadata: { frontmatter: { title: 'T', extras: { s: 'x' } } },
    } as unknown as ScoredDocument;
    const out = formatRetrievalAsJson([doc], false);
    expect(out[0].metadata).toEqual({ frontmatter: { title: 'T' } });
  });
});

describe('groupRetrievalBySource', () => {
  it('collapses repeated chunks from the same source and keeps best score plus locations', () => {
    const docs: ScoredDocument[] = [
      {
        pageContent: 'first chunk',
        metadata: {
          source: 'kb/repeated.md',
          loc: { lines: { from: 1, to: 5 } },
        },
        score: 0.7,
      } as unknown as ScoredDocument,
      {
        pageContent: 'second chunk',
        metadata: {
          source: 'kb/repeated.md',
          loc: { lines: { from: 20, to: 25 } },
        },
        score: 0.3,
      } as unknown as ScoredDocument,
      {
        pageContent: 'other file',
        metadata: {
          source: 'kb/other.md',
          loc: { lines: { from: 3, to: 8 } },
        },
        score: 0.5,
      } as unknown as ScoredDocument,
    ];

    const grouped = groupRetrievalBySource(docs, false);

    expect(grouped).toHaveLength(2);
    expect(grouped[0].source).toBe('kb/repeated.md');
    expect(grouped[0].best_score).toBe(0.3);
    expect(grouped[0].chunks).toHaveLength(2);
    expect(grouped[0].locations).toEqual([
      { score: 0.7, location: { lines: { from: 1, to: 5 } } },
      { score: 0.3, location: { lines: { from: 20, to: 25 } } },
    ]);
    expect(grouped[1].source).toBe('kb/other.md');
  });

  it('keeps raw chunk metadata sanitized in grouped JSON-ready output', () => {
    const docs: ScoredDocument[] = [
      {
        pageContent: 'frontmatter',
        metadata: {
          source: 'kb/doc.md',
          frontmatter: { title: 'Visible', extras: { hidden: true } },
        },
        score: 0.2,
      } as unknown as ScoredDocument,
    ];

    const grouped = groupRetrievalBySource(docs, false);

    expect(grouped[0].chunks[0].metadata).toEqual({
      source: 'kb/doc.md',
      frontmatter: { title: 'Visible' },
    });
  });
});

describe('formatRetrievalGroupedBySourceAsMarkdown', () => {
  it('renders one source section for repeated chunks with chunk locations', () => {
    const docs: ScoredDocument[] = [
      {
        pageContent: 'first chunk',
        metadata: { source: 'kb/repeated.md', loc: { lines: { from: 1, to: 5 } } },
        score: 0.7,
      } as unknown as ScoredDocument,
      {
        pageContent: 'second chunk',
        metadata: { source: 'kb/repeated.md', loc: { lines: { from: 20, to: 25 } } },
        score: 0.3,
      } as unknown as ScoredDocument,
    ];

    const out = formatRetrievalGroupedBySourceAsMarkdown(docs, false);

    expect(out).toContain('**Source 1:** `kb/repeated.md`');
    expect(out).not.toContain('**Source 2:**');
    expect(out).toContain('**Best score:** 0.30');
    expect(out).toContain('"from":1');
    expect(out).toContain('"from":20');
    expect(out).toContain('first chunk');
    expect(out).toContain('second chunk');
  });
});
