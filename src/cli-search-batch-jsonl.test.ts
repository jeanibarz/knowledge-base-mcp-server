import { describe, expect, it } from '@jest/globals';
import {
  parseSearchArgs,
  runSearchBatchJsonlForText,
  type RunSearchDeps,
} from './cli-search.js';

function parseJsonl(stdout: string): Array<Record<string, unknown>> {
  return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('kb search --batch-jsonl', () => {
  it('runs one JSON search per row while caching shared model/index setup', async () => {
    const calls = {
      bootstrap: 0,
      resolve: 0,
      loadManager: 0,
      loadIndex: 0,
    };
    const manager = { id: 'manager-1' };
    const deps: RunSearchDeps = {
      bootstrapLayout: async () => { calls.bootstrap += 1; },
      resolveActiveModel: async (opts = {}) => {
        calls.resolve += 1;
        return opts.explicitOverride ?? 'ollama__default';
      },
      loadManagerForModel: async () => {
        calls.loadManager += 1;
        return manager as never;
      },
      loadWithJsonRetry: async () => { calls.loadIndex += 1; },
    };
    const runOne = async (args: string[], cachedDeps: RunSearchDeps): Promise<number> => {
      await cachedDeps.bootstrapLayout();
      const modelArg = args.find((arg) => arg.startsWith('--model='));
      const activeModel = await cachedDeps.resolveActiveModel({
        explicitOverride: modelArg?.slice('--model='.length),
      });
      const loadedManager = await cachedDeps.loadManagerForModel(activeModel);
      await cachedDeps.loadWithJsonRetry(loadedManager);
      process.stdout.write(JSON.stringify({ args, activeModel }));
      return 0;
    };

    const base = parseSearchArgs([
      '--batch-jsonl',
      '--model=ollama__demo',
      '--k=5',
      '--no-freshness',
    ]);
    const result = await runSearchBatchJsonlForText(
      '{"query":"deploy"}\n{"query":"rollback","k":2,"mode":"auto","no_cache":true}\n',
      base,
      deps,
      runOne,
    );

    expect(result.code).toBe(0);
    const rows = parseJsonl(result.stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      schema_version: 'kb.search.batch-jsonl.v1',
      line: 1,
      ok: true,
      exit_code: 0,
      query: 'deploy',
    });
    expect(rows[1]).toMatchObject({ line: 2, ok: true, query: 'rollback', requested_mode: 'auto' });
    expect((rows[0].result as { args: string[] }).args).toEqual([
      'deploy',
      '--model=ollama__demo',
      '--k=5',
      '--no-freshness',
      '--format=json',
    ]);
    expect((rows[1].result as { args: string[] }).args).toEqual([
      'rollback',
      '--model=ollama__demo',
      '--k=2',
      '--mode=auto',
      '--no-cache',
      '--no-freshness',
      '--format=json',
    ]);
    expect(calls).toEqual({
      bootstrap: 1,
      resolve: 1,
      loadManager: 1,
      loadIndex: 1,
    });
  });

  it('emits per-row error envelopes for invalid JSON and invalid row options', async () => {
    const base = parseSearchArgs(['--batch-jsonl']);
    const result = await runSearchBatchJsonlForText(
      '{"query":1}\nnot json\n',
      base,
      {
        bootstrapLayout: async () => undefined,
        resolveActiveModel: async () => 'ollama__default',
        loadManagerForModel: async () => ({}) as never,
        loadWithJsonRetry: async () => undefined,
      },
      async () => 0,
    );

    expect(result.code).toBe(2);
    expect(parseJsonl(result.stdout)).toEqual([
      {
        schema_version: 'kb.search.batch-jsonl.v1',
        line: 1,
        ok: false,
        exit_code: 2,
        error: { message: 'row query must be a string' },
      },
      expect.objectContaining({
        schema_version: 'kb.search.batch-jsonl.v1',
        line: 2,
        ok: false,
        exit_code: 2,
      }),
    ]);
  });

  it('wraps valid row search failures with stderr in the row envelope', async () => {
    const base = parseSearchArgs(['--batch-jsonl']);
    const result = await runSearchBatchJsonlForText(
      '{"query":"deploy"}\n',
      base,
      {
        bootstrapLayout: async () => undefined,
        resolveActiveModel: async () => 'ollama__default',
        loadManagerForModel: async () => ({}) as never,
        loadWithJsonRetry: async () => undefined,
      },
      async () => {
        process.stdout.write(JSON.stringify({ error: { code: 'BOOM' } }));
        process.stderr.write('search failed\n');
        return 1;
      },
    );

    expect(result.code).toBe(1);
    expect(parseJsonl(result.stdout)).toEqual([
      {
        schema_version: 'kb.search.batch-jsonl.v1',
        line: 1,
        ok: false,
        exit_code: 1,
        query: 'deploy',
        result: { error: { code: 'BOOM' } },
        stderr: 'search failed\n',
      },
    ]);
  });

  it('rejects single-query and mutating base arguments in batch mode', async () => {
    const withQuery = await runSearchBatchJsonlForText(
      '{"query":"deploy"}\n',
      parseSearchArgs(['--batch-jsonl', 'deploy']),
    );
    expect(withQuery).toMatchObject({
      code: 2,
      stdout: '',
      stderr: 'kb search: --batch-jsonl reads queries from JSONL stdin; omit <query>\n',
    });

    const withRefresh = await runSearchBatchJsonlForText(
      '{"query":"deploy"}\n',
      parseSearchArgs(['--batch-jsonl', '--refresh']),
    );
    expect(withRefresh).toMatchObject({
      code: 2,
      stdout: '',
      stderr: 'kb search: --batch-jsonl does not run --refresh; run single-query --refresh before batching\n',
    });
  });
});
