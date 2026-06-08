import { describe, expect, it } from '@jest/globals';
import {
  rerankWithBenchmarkReranker,
  summarizeBenchmarkRerankerReports,
  type BenchmarkRerankCandidate,
} from './reranker-bakeoff-rerankers.js';

function candidate(id: string, text: string, score: number): BenchmarkRerankCandidate {
  return {
    pageContent: text,
    metadata: { relativePath: `${id}.md`, title: id },
    score,
  };
}

describe('issue #579 benchmark-only rerankers', () => {
  it('listwise attention reranks top candidates using query-token evidence across the candidate set', () => {
    const out = rerankWithBenchmarkReranker({
      mode: 'hybrid+listwise-rerank',
      query: 'gravity wave detection evidence',
      candidates: [
        candidate('near-miss', 'A tomato soup recipe with no scientific evidence.', 2),
        candidate('relevant', 'The study reports gravity wave detection evidence from the experiment.', 1),
      ],
    });

    expect(out.results[0].metadata.title).toBe('relevant');
    expect(out.report.strategy).toBe('listwise-attention');
    expect(out.report.candidates_reranked).toBe(2);
  });

  it('hard-negative head keeps a feature-based boundary separate from native rank', () => {
    const out = rerankWithBenchmarkReranker({
      mode: 'hybrid+hard-negative-rerank',
      query: 'citation graph semantic matching',
      candidates: [
        candidate('native-top', 'Unrelated operational checklist with matching but shallow terms.', 4),
        candidate('science', 'Citation graph analysis provides semantic matching evidence for related papers.', 1),
      ],
    });

    expect(out.results[0].metadata.title).toBe('science');
    expect(out.report.model).toBe('hard-negative-boundary-head-sim-v1');
  });

  it('adaptive mode skips a low-ambiguity query and reports the skipped route', () => {
    const out = rerankWithBenchmarkReranker({
      mode: 'hybrid+adaptive-rerank',
      query: 'alpha',
      candidates: [
        candidate('clear', 'alpha alpha alpha exact match', 2),
        candidate('other', 'beta gamma delta unrelated', 1),
      ],
    });

    expect(out.results[0].metadata.title).toBe('clear');
    expect(out.report.skipped).toBe(true);
    expect(out.report.skip_reason).toBe('low_ambiguity');
    expect(out.report.candidates_reranked).toBe(0);
  });

  it('summarizes per-query candidate counts and latency for reports', () => {
    const first = rerankWithBenchmarkReranker({
      mode: 'hybrid+listwise-rerank',
      query: 'alpha beta',
      candidates: [candidate('a', 'alpha', 1), candidate('b', 'beta', 0.5)],
    }).report;
    const second = rerankWithBenchmarkReranker({
      mode: 'hybrid+listwise-rerank',
      query: 'alpha beta',
      candidates: [candidate('a', 'alpha', 1)],
    }).report;

    expect(summarizeBenchmarkRerankerReports([first, second])).toMatchObject({
      strategy: 'listwise-attention',
      queries: 2,
      mean_candidates_in: 1.5,
      mean_candidates_reranked: 1.5,
    });
  });
});
