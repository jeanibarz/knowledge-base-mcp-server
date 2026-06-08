import { describe, expect, it } from '@jest/globals';
import {
  buildBrightReport,
  formatBrightMarkdown,
  meanNdcgForMode,
  modeDeltas,
  type BrightRunPoint,
} from './report.js';

function point(task: string, mode: BrightRunPoint['mode'], ndcg: number, error?: string): BrightRunPoint {
  return { task, mode, ndcgAt10: ndcg, precisionAt10: ndcg / 10, recallAt10: ndcg, queriesEvaluated: 5, error };
}

const points: BrightRunPoint[] = [
  point('biology', 'dense', 0.30),
  point('biology', 'hybrid+rerank', 0.45),
  point('economics', 'dense', 0.20),
  point('economics', 'hybrid+rerank', 0.38),
  point('robotics', 'dense', 0.10),
  point('robotics', 'hybrid+rerank', 0, 'run failed'),
];

function makeReport() {
  return buildBrightReport({
    generatedAt: '2026-06-08T00:00:00.000Z',
    gitSha: 'test-sha',
    provider: 'ollama',
    model: 'nomic-embed-text',
    split: 'test',
    tasks: ['biology', 'economics', 'robotics'],
    modes: ['dense', 'hybrid+rerank'],
    points,
  });
}

describe('meanNdcgForMode', () => {
  it('averages only the tasks that actually scored for a mode', () => {
    const report = makeReport();
    expect(meanNdcgForMode(report, 'dense')).toEqual({ mean: 0.2, tasks: 3 });
    // robotics hybrid+rerank errored → excluded from the mean and the count.
    expect(meanNdcgForMode(report, 'hybrid+rerank')).toEqual({ mean: Number(((0.45 + 0.38) / 2).toFixed(6)), tasks: 2 });
  });
});

describe('modeDeltas', () => {
  it('reports hybrid+rerank − dense per task where both modes scored', () => {
    const deltas = modeDeltas(makeReport(), 'hybrid+rerank', 'dense');
    expect(deltas).toEqual([
      { task: 'biology', high: 0.45, low: 0.30, delta: 0.15 },
      { task: 'economics', high: 0.38, low: 0.20, delta: 0.18 },
    ]);
    // robotics is excluded because its hybrid+rerank cell errored.
    expect(deltas.find((d) => d.task === 'robotics')).toBeUndefined();
  });
});

describe('formatBrightMarkdown', () => {
  it('renders the per-task table, the per-mode mean, and the rerank-vs-dense Δ', () => {
    const md = formatBrightMarkdown(makeReport());
    expect(md).toContain('# BRIGHT reasoning-intensive retrieval — local report');
    expect(md).toContain('## nDCG@10 by task and mode');
    expect(md).toContain('| biology | 0.3000 | 0.4500 |');
    expect(md).toContain('| robotics | 0.1000 | ERR |');
    expect(md).toContain('## hybrid+rerank vs dense (Δ nDCG@10)');
    expect(md).toContain('+0.1500');
    expect(md).toContain('## Caveats');
  });

  it('marks an empty run as pending rather than fabricating numbers', () => {
    const empty = buildBrightReport({
      generatedAt: '2026-06-08T00:00:00.000Z',
      gitSha: 'test-sha',
      provider: null,
      model: null,
      split: 'test',
      tasks: ['biology'],
      modes: ['dense', 'hybrid+rerank'],
      points: [],
    });
    const md = formatBrightMarkdown(empty);
    expect(md).toContain('No BRIGHT runs recorded yet');
  });

  it('adds the fake-provider self-test caveat when the provider is fake', () => {
    const report = buildBrightReport({
      generatedAt: '2026-06-08T00:00:00.000Z',
      gitSha: 'test-sha',
      provider: 'fake',
      model: 'fake-embeddings',
      split: 'test',
      tasks: ['biology'],
      modes: ['dense'],
      points: [point('biology', 'dense', 0.5)],
    });
    expect(report.caveats.some((c) => c.includes('fake'))).toBe(true);
  });
});
