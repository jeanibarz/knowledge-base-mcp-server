import { describe, expect, it } from '@jest/globals';
import {
  formatRetrievalAsJson,
  formatRetrievalAsVimgrep,
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

  it('adds a chunk citation link when stable chunk metadata is present', () => {
    const doc: ScoredDocument = {
      pageContent: 'sample content',
      metadata: {
        source: '/tmp/kbs/alpha/docs/deploy.md',
        knowledgeBase: 'alpha',
        relativePath: 'alpha/docs/deploy.md',
        loc: { lines: { from: 42, to: 58 } },
        chunkIndex: 0,
      },
      score: 0.42,
    } as unknown as ScoredDocument;

    const out = formatRetrievalAsMarkdown([doc], false, 'none');

    expect(out).toContain('**Source:** [alpha/docs/deploy.md#L42-L58](kb://alpha/docs/deploy.md#L42-L58)');
    expect(out).not.toContain('**Open:**');
  });

  it('adds an editor URI only when opted in', () => {
    const doc: ScoredDocument = {
      pageContent: 'sample content',
      metadata: {
        source: '/tmp/kbs/alpha/docs/deploy.md',
        knowledgeBase: 'alpha',
        relativePath: 'alpha/docs/deploy.md',
        loc: { lines: { from: 42, to: 58 } },
        chunkIndex: 0,
      },
    } as unknown as ScoredDocument;

    const out = formatRetrievalAsMarkdown([doc], false, 'vscode');

    expect(out).toContain('**Open:** vscode://file/tmp/kbs/alpha/docs/deploy.md:42:0');
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

  it('adds chunk_id and opt-in editor_uri as additive result fields', () => {
    const doc: ScoredDocument = {
      pageContent: 'c',
      metadata: {
        source: '/tmp/kbs/alpha/docs/deploy.md',
        knowledgeBase: 'alpha',
        relativePath: 'alpha/docs/deploy.md',
        loc: { lines: { from: 10, to: 12 } },
        chunkIndex: 0,
      },
      score: 1.5,
    } as unknown as ScoredDocument;

    expect(formatRetrievalAsJson([doc], false, 'cursor')[0]).toMatchObject({
      chunk_id: 'alpha/docs/deploy.md#L10-L12',
      editor_uri: 'cursor://file/tmp/kbs/alpha/docs/deploy.md:10:0',
    });
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

  it('keeps allowlisted lifecycle fields while stripping private frontmatter extras', () => {
    const doc: ScoredDocument = {
      pageContent: 'c',
      metadata: {
        frontmatter: {
          status: 'active',
          review_status: 'pending',
          contradicted_by: ['old.md'],
          manual_edits: false,
          promote_model: 'deterministic',
          tier: 'wisdom',
          confidence: 0.82,
          last_verified_at: '2026-05-09T01:02:03Z',
          extras: { private_token: 'SECRET_VALUE_XYZ' },
        },
      },
    } as unknown as ScoredDocument;

    const out = formatRetrievalAsJson([doc], false);

    expect(out[0].metadata).toEqual({
      frontmatter: {
        status: 'active',
        review_status: 'pending',
        contradicted_by: ['old.md'],
        manual_edits: false,
        promote_model: 'deterministic',
        tier: 'wisdom',
        confidence: 0.82,
        last_verified_at: '2026-05-09T01:02:03Z',
      },
    });
    expect(JSON.stringify(out)).not.toContain('SECRET_VALUE_XYZ');
    expect(JSON.stringify(out)).not.toContain('private_token');
  });

  it('does not invent absent lifecycle metadata in JSON output', () => {
    const doc: ScoredDocument = {
      pageContent: 'c',
      metadata: { source: 'doc.md' },
      score: 0.4,
    } as unknown as ScoredDocument;

    const out = formatRetrievalAsJson([doc], false);

    expect(out[0]).toEqual({ score: 0.4, content: 'c', metadata: { source: 'doc.md' } });
    expect(out[0].metadata).not.toHaveProperty('frontmatter');
  });
});

describe('formatRetrievalAsVimgrep', () => {
  it('prints path:line:col:preview lines for quickfix consumers', () => {
    const docs: ScoredDocument[] = [
      {
        pageContent: 'Deploy procedure starts here.\nAlways verify pods before continuing.',
        metadata: {
          source: '/tmp/kbs/work/runbooks/deploy.md',
          knowledgeBase: 'work',
          relativePath: 'work/runbooks/deploy.md',
          loc: { lines: { from: 42, to: 58 } },
          chunkIndex: 0,
        },
      } as unknown as ScoredDocument,
    ];

    expect(formatRetrievalAsVimgrep(docs)).toBe(
      'work/runbooks/deploy.md:42:0:Deploy procedure starts here. Always verify pods before continuing.',
    );
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
    expect(grouped[0].chunk_count).toBe(2);
    expect(grouped[0].best_score).toBe(0.3);
    expect(grouped[0].chunks).toHaveLength(2);
    expect(grouped[0].locations).toEqual([
      { score: 0.7, location: { lines: { from: 1, to: 5 } } },
      { score: 0.3, location: { lines: { from: 20, to: 25 } } },
    ]);
    expect(grouped[1].source).toBe('kb/other.md');
    expect(grouped[1].chunk_count).toBe(1);
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
    expect(out).toContain('**Chunk count:** 2');
    expect(out).toContain('"from":1');
    expect(out).toContain('"from":20');
    expect(out).toContain('first chunk');
    expect(out).toContain('second chunk');
  });
});
