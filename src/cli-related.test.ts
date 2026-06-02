import { describe, expect, it, jest } from '@jest/globals';
import {
  parseRelatedArgs,
  runRelated,
  type RunRelatedDeps,
} from './cli-related.js';
import type { SearchResultDocument } from './FaissIndexManager.js';

function doc(content: string, metadata: Record<string, unknown>, score?: number): SearchResultDocument {
  return {
    pageContent: content,
    metadata,
    ...(score !== undefined ? { score } : {}),
  } as SearchResultDocument;
}

function depsFor(manager: {
  findChunkByReference: jest.Mock;
  similaritySearch: jest.Mock;
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
      findChunkByReference: jest.fn(() => seed),
      similaritySearch: jest.fn(async () => [{ ...seed, score: 0.01 }, related]),
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
      findChunkByReference: jest.fn(() => null),
      similaritySearch: jest.fn(),
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
