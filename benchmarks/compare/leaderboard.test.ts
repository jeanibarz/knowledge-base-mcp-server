import { describe, expect, it } from '@jest/globals';
import { matrixReportToRun, renderLeaderboard, type LeaderboardRun } from './leaderboard.js';

const MATRIX_JSON = {
  schema_version: 'kb.beir-matrix.v1',
  generated_at: '2026-06-08T00:00:00.000Z',
  git_sha: 'deadbeef',
  modes: ['lexical', 'hybrid'],
  datasets: ['scifact', 'arguana'],
  env: {
    embedding_provider: 'ollama',
    embedding_model: 'nomic-embed-text',
    rrf_c: '60',
    rerank_model: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerank_top_n: '40',
    chunk_size: '1000',
    chunk_overlap: '200',
    contextual: 'off',
  },
  perMode: [
    { mode: 'lexical', datasetsEvaluated: 2, datasetsRequested: 2, multiDomainMeanNdcgAt10: 0.55, multiDomainMeanPrecisionAt10: 0.1, multiDomainMeanRecallAt10: 0.6 },
    { mode: 'hybrid', datasetsEvaluated: 2, datasetsRequested: 2, multiDomainMeanNdcgAt10: 0.70, multiDomainMeanPrecisionAt10: 0.12, multiDomainMeanRecallAt10: 0.75 },
  ],
  generalization: {
    modes: [
      { mode: 'lexical', deltaG: { deltaG: 0.20, seenMeanNdcgAt10: 0.6, unseenMeanNdcgAt10: 0.48 } },
      { mode: 'hybrid', deltaG: { deltaG: 0.10, seenMeanNdcgAt10: 0.8, unseenMeanNdcgAt10: 0.72 } },
    ],
  },
};

describe('matrixReportToRun', () => {
  it('maps a matrix report JSON onto the leaderboard run shape', () => {
    const run = matrixReportToRun(MATRIX_JSON, 'run-A');
    expect(run.label).toBe('run-A');
    expect(run.gitSha).toBe('deadbeef');
    expect(run.env.embedding_provider).toBe('ollama');
    const hybrid = run.modes.find((m) => m.mode === 'hybrid');
    expect(hybrid?.multiDomainMeanNdcgAt10).toBe(0.70);
    expect(hybrid?.deltaG).toBe(0.10);
  });

  it('tolerates missing fields without throwing', () => {
    const run = matrixReportToRun({ perMode: [{ mode: 'lexical' }] }, 'sparse');
    expect(run.gitSha).toBe('unknown');
    expect(run.modes[0].multiDomainMeanNdcgAt10).toBeNull();
    expect(run.modes[0].deltaG).toBeNull();
  });

  it('rejects a non-object report', () => {
    expect(() => matrixReportToRun(null, 'x')).toThrow(/not an object/);
  });
});

describe('renderLeaderboard', () => {
  function run(label: string, gitSha: string, hybridNdcg: number, hybridDeltaG: number): LeaderboardRun {
    return {
      label,
      gitSha,
      generatedAt: '2026-06-08T00:00:00.000Z',
      env: {
        embedding_provider: 'ollama', embedding_model: 'nomic-embed-text', rrf_c: '60',
        rerank_model: 'm', rerank_top_n: '40', chunk_size: '1000', chunk_overlap: '200', contextual: 'off',
      },
      modes: [
        { mode: 'lexical', multiDomainMeanNdcgAt10: 0.55, datasetsEvaluated: 2, datasetsRequested: 2, deltaG: 0.2 },
        { mode: 'hybrid', multiDomainMeanNdcgAt10: hybridNdcg, datasetsEvaluated: 2, datasetsRequested: 2, deltaG: hybridDeltaG },
      ],
    };
  }

  it('renders an HTML leaderboard, highlighting the best run per mode', async () => {
    const html = await renderLeaderboard({
      runs: [run('old', 'aaa111', 0.66, 0.18), run('new', 'bbb222', 0.72, 0.09)],
      generatedAt: '2026-06-08T12:00:00.000Z',
    });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('BEIR retrieval leaderboard');
    // Headline cells present for both runs.
    expect(html).toContain('0.7200');
    expect(html).toContain('0.6600');
    // The higher hybrid nDCG (0.72) is marked best; the lower is not.
    expect(html).toMatch(/class="best"[^>]*>0\.7200/);
    // Provenance carries the commit.
    expect(html).toContain('bbb222');
    // Δ_g rendered as a signed percentage.
    expect(html).toContain('+9.00%');
  });

  it('renders a placeholder when there are no runs', async () => {
    const html = await renderLeaderboard({ runs: [], generatedAt: '2026-06-08T12:00:00.000Z' });
    expect(html).toContain('no runs');
  });
});
