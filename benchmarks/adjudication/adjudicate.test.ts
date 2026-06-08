import { afterAll, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { PerQueryScore } from '../significance.js';
import {
  adjudicateRerank,
  loadAdjudicationInput,
  numericAtPath,
  parseAdjudicateArgs,
  renderAdjudicationMarkdown,
  runAdjudicateCli,
  type DomainEvidence,
} from './adjudicate.js';

// Deterministic per-query fixtures -------------------------------------------

function scores(prefix: string, values: number[]): PerQueryScore[] {
  return values.map((ndcgAt10, i) => ({ queryId: `${prefix}-q${i}`, ndcgAt10 }));
}

/** A domain where the candidate is uniformly better → significant improvement. */
function improvingDomain(domain: string): DomainEvidence {
  return {
    domain,
    mode: 'hybrid+rerank',
    baseline: scores(domain, [0.50, 0.50, 0.50, 0.50, 0.50]),
    candidate: scores(domain, [0.70, 0.70, 0.70, 0.70, 0.70]),
  };
}

/** A domain where the candidate is uniformly worse → significant regression. */
function regressingDomain(domain: string): DomainEvidence {
  return {
    domain,
    mode: 'hybrid+rerank',
    baseline: scores(domain, [0.70, 0.70, 0.70, 0.70, 0.70]),
    candidate: scores(domain, [0.50, 0.50, 0.50, 0.50, 0.50]),
  };
}

/** A domain whose per-query deltas cancel → no significant change. */
function flatDomain(domain: string): DomainEvidence {
  return {
    domain,
    mode: 'hybrid+rerank',
    baseline: scores(domain, [0.50, 0.50, 0.50, 0.50]),
    candidate: scores(domain, [0.60, 0.40, 0.55, 0.45]),
  };
}

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-adjudicate-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true });
});

describe('adjudicateRerank — per-domain gate + e2e veto (RFC 020 §3/§5/§9)', () => {
  it('SHIP-GATEs: enable on improving domains, skip-fallback on regressing/flat ones', () => {
    const result = adjudicateRerank({
      candidateModel: 'BAAI/bge-reranker-v2-m3',
      baselineModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
      domains: [improvingDomain('scifact'), regressingDomain('code'), flatDomain('skills')],
      e2e: [{ metric: 'faithfulness', baseline: 0.90, candidate: 0.905, tolerance: 0.01 }],
    });

    expect(result.decision).toBe('ship-gated');
    expect(result.enabledDomains).toEqual(['scifact']);
    expect(result.skipDomains).toEqual(['code', 'skills']);
    expect(result.e2eVetoed).toBe(false);
    expect(result.recommendedConfig).toEqual({
      KB_RERANK_MODEL: 'BAAI/bge-reranker-v2-m3',
      KB_RERANK_SKIP_DOMAINS: 'code,skills',
    });
    // The improving domain rejects the null after family correction; the flat
    // one does not.
    const byDomain = Object.fromEntries(result.domains.map((d) => [d.domain, d]));
    expect(byDomain.scifact.verdict).toBe('improvement');
    expect(byDomain.scifact.action).toBe('enable');
    expect(byDomain.code.verdict).toBe('regression');
    expect(byDomain.skills.verdict).toBe('no-significant-change');
    expect(byDomain.skills.action).toBe('skip');
  });

  it('SHIPs (no skip) when every measured domain improves and the e2e veto passes', () => {
    const result = adjudicateRerank({
      candidateModel: 'BAAI/bge-reranker-v2-m3',
      baselineModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
      domains: [improvingDomain('scifact'), improvingDomain('nfcorpus')],
      e2e: [{ metric: 'accuracy', baseline: 0.80, candidate: 0.81 }],
    });
    expect(result.decision).toBe('ship');
    expect(result.skipDomains).toEqual([]);
    expect(result.enabledDomains).toEqual(['scifact', 'nfcorpus']);
    expect(result.recommendedConfig.KB_RERANK_SKIP_DOMAINS).toBe('');
  });

  it('NO-SHIPs when the §5 e2e veto fires, even if BEIR improves', () => {
    const result = adjudicateRerank({
      candidateModel: 'BAAI/bge-reranker-v2-m3',
      baselineModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
      domains: [improvingDomain('scifact'), improvingDomain('nfcorpus')],
      e2e: [{ metric: 'faithfulness', baseline: 0.90, candidate: 0.80, tolerance: 0.01 }],
    });
    expect(result.decision).toBe('no-ship');
    expect(result.e2eVetoed).toBe(true);
    // No-ship stays on the baseline reranker and gates nothing.
    expect(result.recommendedConfig.KB_RERANK_MODEL).toBe('Xenova/ms-marco-MiniLM-L-6-v2');
    expect(result.recommendedConfig.KB_RERANK_SKIP_DOMAINS).toBe('');
  });

  it('NO-SHIPs when no domain shows a significant improvement', () => {
    const result = adjudicateRerank({
      candidateModel: 'BAAI/bge-reranker-v2-m3',
      baselineModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
      domains: [regressingDomain('code'), flatDomain('skills')],
    });
    expect(result.decision).toBe('no-ship');
    expect(result.enabledDomains).toEqual([]);
  });

  it('marks the decision provisional when evidence is pending (never fabricated)', () => {
    const result = adjudicateRerank({
      candidateModel: 'BAAI/bge-reranker-v2-m3',
      baselineModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
      domains: [improvingDomain('scifact')],
      pending: ['real BEIR runs outstanding (needs datasets + embedding model + candidate reranker)'],
    });
    expect(result.provisional).toBe(true);
    expect(result.summary).toMatch(/^PROVISIONAL/);
    expect(renderAdjudicationMarkdown(result)).toContain('Pending evidence');
  });

  it('honors the Bonferroni correction (a single weak win can be downgraded)', () => {
    // A marginal improvement that survives uncorrected but is killed by a large
    // family. We build one weakly-improving domain alongside many noisy ones.
    const weak: DomainEvidence = {
      domain: 'weak',
      baseline: scores('weak', [0.50, 0.51, 0.49, 0.50, 0.50, 0.50]),
      candidate: scores('weak', [0.55, 0.55, 0.55, 0.55, 0.55, 0.55]),
    };
    const family = [weak, flatDomain('a'), flatDomain('b'), flatDomain('c'), flatDomain('d')];
    const holm = adjudicateRerank({
      candidateModel: 'c',
      baselineModel: 'b',
      domains: family,
      correction: 'holm',
    });
    const none = adjudicateRerank({
      candidateModel: 'c',
      baselineModel: 'b',
      domains: family,
      correction: 'none',
    });
    // The correction can only make a verdict *less* significant, never more.
    const holmWeak = holm.domains.find((d) => d.domain === 'weak');
    const noneWeak = none.domains.find((d) => d.domain === 'weak');
    expect(holmWeak?.adjustedPValue).toBeGreaterThanOrEqual(noneWeak?.adjustedPValue ?? 0);
  });
});

describe('numericAtPath', () => {
  it('reads dotted numeric paths and returns null for missing/non-numeric', () => {
    const root = { correctness: { accuracy: 0.83 }, tier1: { tokenF1: 0.7 }, note: 'x' };
    expect(numericAtPath(root, 'correctness.accuracy')).toBe(0.83);
    expect(numericAtPath(root, 'tier1.tokenF1')).toBe(0.7);
    expect(numericAtPath(root, 'correctness.missing')).toBeNull();
    expect(numericAtPath(root, 'note')).toBeNull();
    expect(numericAtPath(null, 'a.b')).toBeNull();
  });
});

describe('loadAdjudicationInput + runAdjudicateCli (manifest → report)', () => {
  async function writeRunFile(dir: string, name: string, dataset: string, values: number[]): Promise<string> {
    const file = path.join(dir, name);
    await fsp.writeFile(
      file,
      JSON.stringify({
        dataset: { name: dataset },
        per_query: values.map((ndcgAt10, i) => ({ queryId: `q${i}`, ndcgAt10 })),
      }),
      'utf-8',
    );
    return name;
  }

  it('loads BEIR run files + e2e scorecards and writes a JSON + markdown report', async () => {
    const dir = await makeTmpDir();
    await writeRunFile(dir, 'scifact-base.json', 'scifact', [0.50, 0.50, 0.50, 0.50]);
    await writeRunFile(dir, 'scifact-cand.json', 'scifact', [0.70, 0.70, 0.70, 0.70]);
    await writeRunFile(dir, 'code-base.json', 'code', [0.70, 0.70, 0.70, 0.70]);
    await writeRunFile(dir, 'code-cand.json', 'code', [0.50, 0.50, 0.50, 0.50]);

    // Two e2e scorecards (rag-eval shape) — candidate holds faithfulness.
    await fsp.writeFile(path.join(dir, 'rag-base.json'), JSON.stringify({ correctness: { accuracy: 0.80 } }), 'utf-8');
    await fsp.writeFile(path.join(dir, 'rag-cand.json'), JSON.stringify({ correctness: { accuracy: 0.805 } }), 'utf-8');

    const manifest = {
      candidateModel: 'BAAI/bge-reranker-v2-m3',
      baselineModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
      correction: 'holm' as const,
      domains: [
        { domain: 'scifact', mode: 'hybrid+rerank', baseline: 'scifact-base.json', candidate: 'scifact-cand.json' },
        { domain: 'code', mode: 'hybrid+rerank', baseline: 'code-base.json', candidate: 'code-cand.json' },
      ],
      e2eScorecards: { metrics: ['correctness.accuracy'], baseline: 'rag-base.json', candidate: 'rag-cand.json', tolerance: 0.02 },
    };
    const manifestPath = path.join(dir, 'manifest.json');
    await fsp.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');

    const input = await loadAdjudicationInput(manifest, dir);
    expect(input.domains).toHaveLength(2);
    expect(input.e2e).toEqual([{ metric: 'correctness.accuracy', baseline: 0.80, candidate: 0.805, tolerance: 0.02 }]);

    const outputDir = path.join(dir, 'out');
    const { adjudication, jsonPath, markdownPath } = await runAdjudicateCli(
      parseAdjudicateArgs(['--manifest', manifestPath, '--output-dir', outputDir, '--report-name', 'r'], {}),
    );
    expect(adjudication.decision).toBe('ship-gated');
    expect(adjudication.enabledDomains).toEqual(['scifact']);
    expect(adjudication.skipDomains).toEqual(['code']);
    const writtenJson = JSON.parse(await fsp.readFile(jsonPath, 'utf-8'));
    expect(writtenJson.decision).toBe('ship-gated');
    expect(await fsp.readFile(markdownPath, 'utf-8')).toContain('Reranker upgrade adjudication');
  });
});

describe('parseAdjudicateArgs', () => {
  it('requires --manifest', () => {
    expect(() => parseAdjudicateArgs([], {})).toThrow(/--manifest is required/);
  });
  it('parses output options and the fail flag', () => {
    const opts = parseAdjudicateArgs(
      ['--manifest', 'm.json', '--report-name', 'foo', '--fail-on-no-ship'],
      {},
    );
    expect(opts.reportName).toBe('foo');
    expect(opts.enforceFailures).toBe(true);
    expect(opts.manifestPath.endsWith('m.json')).toBe(true);
  });
});
