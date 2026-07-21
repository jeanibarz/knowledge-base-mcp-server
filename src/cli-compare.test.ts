import { describe, expect, it } from '@jest/globals';
import {
  buildCompareReport,
  buildCompareRows,
  COMPARE_SCHEMA_VERSION,
  formatCompareReport,
  parseCompareArgs,
  type CompareHit,
} from './cli-compare.js';

describe('parseCompareArgs', () => {
  it('parses required positionals with defaults', () => {
    expect(parseCompareArgs(['hello', 'model_a', 'model_b'])).toEqual({
      query: 'hello',
      modelA: 'model_a',
      modelB: 'model_b',
      k: 10,
      kb: undefined,
      noCache: false,
      format: 'md',
    });
  });

  it('parses --k, --kb, --no-cache, and --format=json', () => {
    expect(parseCompareArgs([
      'deploy',
      'ollama__a',
      'openai__b',
      '--k=5',
      '--kb=work',
      '--no-cache',
      '--format=json',
    ])).toEqual({
      query: 'deploy',
      modelA: 'ollama__a',
      modelB: 'openai__b',
      k: 5,
      kb: 'work',
      noCache: true,
      format: 'json',
    });
  });

  it('rejects invalid --format', () => {
    expect(() => parseCompareArgs(['q', 'a', 'b', '--format=csv'])).toThrow(
      "invalid --format value 'csv' (expected md or json)",
    );
  });

  it('rejects invalid --k', () => {
    expect(() => parseCompareArgs(['q', 'a', 'b', '--k=0'])).toThrow('invalid --k');
  });

  it('rejects missing positionals', () => {
    expect(() => parseCompareArgs(['only-one'])).toThrow('expected <query> <model_a> <model_b>');
  });

  it('rejects unknown flags', () => {
    expect(() => parseCompareArgs(['q', 'a', 'b', '--zzz'])).toThrow('unknown flag');
  });
});

describe('buildCompareRows / formatCompareReport', () => {
  const hitsA: CompareHit[] = [
    { source: 'work/a.md', chunkIndex: 0, score: 0.12 },
    { source: 'work/b.md', chunkIndex: 1, score: 0.34 },
  ];
  const hitsB: CompareHit[] = [
    { source: 'work/b.md', chunkIndex: 1, score: 0.21 },
    { source: 'work/c.md', chunkIndex: 0, score: 0.55 },
  ];

  it('joins hits by source#chunkIndex and sorts by best rank', () => {
    const rows = buildCompareRows(hitsA, hitsB);
    expect(rows).toEqual([
      {
        rank_a: 1,
        rank_b: null,
        score_a: 0.12,
        score_b: null,
        in_both: false,
        source: 'work/a.md',
      },
      {
        rank_a: 2,
        rank_b: 1,
        score_a: 0.34,
        score_b: 0.21,
        in_both: true,
        source: 'work/b.md',
      },
      {
        rank_a: null,
        rank_b: 2,
        score_a: null,
        score_b: 0.55,
        in_both: false,
        source: 'work/c.md',
      },
    ]);
  });

  it('markdown output keeps the historical table layout', () => {
    const report = buildCompareReport({
      query: 'deploy',
      modelA: 'ollama__a',
      modelB: 'openai__b',
      k: 5,
      kb: 'work',
      hitsA,
      hitsB,
    });
    const out = formatCompareReport(report, 'md');
    expect(out).toContain('# kb compare');
    expect(out).toContain('Query: deploy');
    expect(out).toContain('Model A: ollama__a');
    expect(out).toContain('Model B: openai__b');
    expect(out).toContain('rank_a  rank_b  score_a  score_b  in_both  source');
    expect(out).toContain('work/a.md');
    expect(out).toContain('  yes  ');
    expect(out).toContain('  no   ');
    expect(out).toMatch(/—/);
  });

  it('json output emits a stable schema envelope with the same rank/score data', () => {
    const report = buildCompareReport({
      query: 'deploy',
      modelA: 'ollama__a',
      modelB: 'openai__b',
      k: 5,
      kb: 'work',
      hitsA,
      hitsB,
    });
    const out = formatCompareReport(report, 'json');
    const parsed = JSON.parse(out) as typeof report;
    expect(parsed).toEqual({
      schema_version: COMPARE_SCHEMA_VERSION,
      query: 'deploy',
      model_a: 'ollama__a',
      model_b: 'openai__b',
      k: 5,
      knowledge_base: 'work',
      rows: [
        {
          rank_a: 1,
          rank_b: null,
          score_a: 0.12,
          score_b: null,
          in_both: false,
          source: 'work/a.md',
        },
        {
          rank_a: 2,
          rank_b: 1,
          score_a: 0.34,
          score_b: 0.21,
          in_both: true,
          source: 'work/b.md',
        },
        {
          rank_a: null,
          rank_b: 2,
          score_a: null,
          score_b: 0.55,
          in_both: false,
          source: 'work/c.md',
        },
      ],
    });
    expect(out.endsWith('\n')).toBe(true);
  });

  it('json knowledge_base is null when --kb is omitted', () => {
    const report = buildCompareReport({
      query: 'q',
      modelA: 'a',
      modelB: 'b',
      k: 10,
      hitsA: [],
      hitsB: [],
    });
    expect(report.knowledge_base).toBeNull();
    expect(report.rows).toEqual([]);
  });
});
