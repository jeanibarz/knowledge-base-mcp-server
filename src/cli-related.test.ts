import { describe, expect, it, jest } from '@jest/globals';
import {
  parseRelatedArgs,
  runRelated,
  type RunRelatedDeps,
} from './cli-related.js';
import {
  buildRelatedJsonPayload,
  findRelatedCore,
  parseRelatedTarget,
  type RelatedCoreManager,
} from './related-core.js';
import { parseChunkReference } from './chunk-id.js';
import type { SearchResultDocument } from './FaissIndexManager.js';

function doc(content: string, metadata: Record<string, unknown>, score?: number): SearchResultDocument {
  return {
    pageContent: content,
    metadata,
    ...(score !== undefined ? { score } : {}),
  } as SearchResultDocument;
}

function depsFor(manager: {
  findChunkByReference: jest.Mock<(...args: any[]) => any>;
  similaritySearch: jest.Mock<(...args: any[]) => any>;
}): RunRelatedDeps {
  return {
    bootstrapLayout: jest.fn(async () => undefined),
    resolveActiveModel: jest.fn(async () => 'huggingface__test-model'),
    loadManagerForModel: jest.fn(async () => manager) as never,
    loadWithJsonRetry: jest.fn(async () => undefined) as never,
  };
}

describe('parseRelatedArgs', () => {
  it('parses the narrow related-search flags', () => {
    expect(parseRelatedArgs([
      'alpha/docs/deploy.md#L1-L4',
      '--k=5',
      '--threshold=0.8',
      '--format=json',
      '--include-self',
      '--no-cache',
      '--all-kbs',
    ])).toEqual({
      target: 'alpha/docs/deploy.md#L1-L4',
      k: 5,
      threshold: 0.8,
      format: 'json',
      includeSelf: true,
      noCache: true,
      allKbs: true,
    });
  });

  it('rejects invalid combinations and missing targets', () => {
    expect(() => parseRelatedArgs([])).toThrow(/missing <chunk-id/);
    expect(() => parseRelatedArgs(['alpha/docs/a.md#L1-L2', '--all-kbs', '--kb=alpha']))
      .toThrow(/--all-kbs cannot be combined/);
  });
});

describe('parseRelatedTarget', () => {
  it('accepts a chunk id and a kb:// URI, rejects a bare <kb>/<path> location', () => {
    expect(parseRelatedTarget('alpha/docs/deploy.md#L1-L4')).toMatchObject({
      value: { kind: 'chunk-id', knowledgeBase: 'alpha', kbRelativePath: 'docs/deploy.md' },
    });
    expect(parseRelatedTarget('kb://alpha/docs/deploy.md')).toMatchObject({
      value: { kind: 'kb-uri', knowledgeBase: 'alpha' },
    });
    expect(parseRelatedTarget('alpha/docs/deploy.md')).toEqual({
      error: 'expected a chunk id or kb:// URI, got a KB-relative path',
    });
  });
});

describe('findRelatedCore', () => {
  const seed = doc('seed body', {
    knowledgeBase: 'alpha',
    relativePath: 'alpha/docs/deploy.md',
    loc: { lines: { from: 1, to: 4 } },
    chunkIndex: 0,
  });
  const related = doc('adjacent note', {
    knowledgeBase: 'alpha',
    relativePath: 'alpha/docs/other.md',
    loc: { lines: { from: 9, to: 12 } },
    chunkIndex: 0,
  }, 0.42);
  const reference = parseChunkReference('alpha/docs/deploy.md#L1-L4');

  it('over-fetches k+1, scopes to the seed KB, and drops the seed by default', async () => {
    const manager: RelatedCoreManager = {
      findChunkByReference: jest.fn(() => seed),
      similaritySearch: jest.fn(async () => [{ ...seed, score: 0.01 }, related]) as never,
    };

    const outcome = await findRelatedCore(manager, reference, {
      k: 1,
      threshold: 2,
      includeSelf: false,
      noCache: false,
      allKbs: false,
    });

    expect(manager.similaritySearch).toHaveBeenCalledWith(
      'seed body', 2, 2, 'alpha', undefined, expect.any(Object), { noCache: false },
    );
    expect('seedNotFound' in outcome).toBe(false);
    if ('seedNotFound' in outcome) throw new Error('unreachable');
    expect(outcome.scopedKb).toBe('alpha');
    expect(outcome.results).toEqual([related]);
  });

  it('keeps the seed and searches all KBs when includeSelf + allKbs are set', async () => {
    const manager: RelatedCoreManager = {
      findChunkByReference: jest.fn(() => seed),
      similaritySearch: jest.fn(async () => [{ ...seed, score: 0.0 }]) as never,
    };

    const outcome = await findRelatedCore(manager, reference, {
      k: 5,
      threshold: 2,
      includeSelf: true,
      noCache: false,
      allKbs: true,
    });

    // includeSelf → fetchK equals k (no +1); allKbs → undefined scope.
    expect(manager.similaritySearch).toHaveBeenCalledWith(
      'seed body', 5, 2, undefined, undefined, expect.any(Object), { noCache: false },
    );
    if ('seedNotFound' in outcome) throw new Error('unreachable');
    expect(outcome.scopedKb).toBeUndefined();
    expect(outcome.results).toHaveLength(1);
  });

  it('reports seedNotFound without searching when the reference resolves to no chunk', async () => {
    const similaritySearch = jest.fn();
    const manager: RelatedCoreManager = {
      findChunkByReference: jest.fn(() => null),
      similaritySearch: similaritySearch as never,
    };

    const outcome = await findRelatedCore(manager, reference, {
      k: 10,
      threshold: 2,
      includeSelf: false,
      noCache: false,
      allKbs: false,
    });

    expect(outcome).toEqual({ seedNotFound: true });
    expect(similaritySearch).not.toHaveBeenCalled();
  });
});

describe('buildRelatedJsonPayload', () => {
  it('builds a kb.related.v1 payload with the seed (score stripped) and formatted results', () => {
    const seed = doc('seed body', {
      knowledgeBase: 'alpha',
      relativePath: 'alpha/docs/deploy.md',
      loc: { lines: { from: 1, to: 4 } },
      chunkIndex: 0,
      frontmatter: { status: 'active', extras: { private_note: 'do not emit' } },
    });
    const related = doc('adjacent note', {
      knowledgeBase: 'alpha',
      relativePath: 'alpha/docs/other.md',
      loc: { lines: { from: 9, to: 12 } },
      chunkIndex: 0,
    }, 0.42);

    const payload = buildRelatedJsonPayload({
      target: 'alpha/docs/deploy.md#L1-L4',
      seed,
      scopedKb: 'alpha',
      includeSelf: false,
      results: [related],
    });

    expect(payload.schema_version).toBe('kb.related.v1');
    expect(payload.seed).toMatchObject({
      target: 'alpha/docs/deploy.md#L1-L4',
      chunk_id: 'alpha/docs/deploy.md#L1-L4',
    });
    // The seed is emitted without a score field, and frontmatter extras stay hidden.
    expect(payload.seed).not.toHaveProperty('score');
    expect((payload.seed.metadata as { frontmatter?: unknown }).frontmatter).toEqual({ status: 'active' });
    expect(payload.scoped_kb).toBe('alpha');
    expect(payload.include_self).toBe(false);
    expect(payload.results).toEqual([
      expect.objectContaining({ chunk_id: 'alpha/docs/other.md#L9-L12', content: 'adjacent note' }),
    ]);
  });

  it('reports scoped_kb as null when the related search spanned all KBs', () => {
    const seed = doc('seed body', {
      knowledgeBase: 'alpha',
      relativePath: 'alpha/docs/deploy.md',
      loc: { lines: { from: 1, to: 4 } },
      chunkIndex: 0,
    });
    const payload = buildRelatedJsonPayload({
      target: 'alpha/docs/deploy.md#L1-L4',
      seed,
      scopedKb: undefined,
      includeSelf: false,
      results: [],
    });
    expect(payload.scoped_kb).toBeNull();
    expect(payload.results).toEqual([]);
  });
});

describe('runRelated', () => {
  it('resolves the seed chunk, searches with its text, and excludes the seed by default', async () => {
    const seed = doc('deploy rollback seed text', {
      knowledgeBase: 'alpha',
      relativePath: 'alpha/docs/deploy.md',
      loc: { lines: { from: 1, to: 4 } },
      chunkIndex: 0,
      frontmatter: {
        status: 'active',
        extras: { private_note: 'do not emit' },
      },
    });
    const related = doc('adjacent deploy note', {
      knowledgeBase: 'alpha',
      relativePath: 'alpha/docs/other.md',
      loc: { lines: { from: 9, to: 12 } },
      chunkIndex: 0,
    }, 0.42);
    const manager = {
      findChunkByReference: jest.fn((..._args: any[]) => seed),
      similaritySearch: jest.fn(async (..._args: any[]) => [{ ...seed, score: 0.01 }, related]),
    };
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const code = await runRelated(
        ['alpha/docs/deploy.md#L1-L4', '--format=json', '--k=1'],
        depsFor(manager),
      );

      expect(code).toBe(0);
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(manager.findChunkByReference).toHaveBeenCalledWith(expect.objectContaining({
        knowledgeBase: 'alpha',
        kbRelativePath: 'docs/deploy.md',
        lineFrom: 1,
        lineTo: 4,
      }));
      expect(manager.similaritySearch).toHaveBeenCalledWith(
        'deploy rollback seed text',
        2,
        2,
        'alpha',
        undefined,
        expect.any(Object),
        { noCache: false },
      );
      const payload = JSON.parse(String(stdoutSpy.mock.calls[0][0])) as {
        seed: { chunk_id: string; metadata: { frontmatter?: Record<string, unknown> } };
        scoped_kb: string;
        results: Array<{ chunk_id: string; content: string }>;
      };
      expect(payload.seed.chunk_id).toBe('alpha/docs/deploy.md#L1-L4');
      expect(payload.seed.metadata.frontmatter).toEqual({ status: 'active' });
      expect(payload.scoped_kb).toBe('alpha');
      expect(payload.results).toEqual([
        expect.objectContaining({
          chunk_id: 'alpha/docs/other.md#L9-L12',
          content: 'adjacent deploy note',
        }),
      ]);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('reports a missing indexed seed as a runtime error', async () => {
    const manager = {
      findChunkByReference: jest.fn((..._args: any[]) => null),
      similaritySearch: jest.fn((..._args: any[]) => undefined),
    };
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const code = await runRelated(['kb://alpha/docs/deploy.md#L1-L4'], depsFor(manager));

      expect(code).toBe(1);
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy.mock.calls.map((call) => String(call[0])).join(''))
        .toContain("no indexed chunk matched 'kb://alpha/docs/deploy.md#L1-L4'");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
