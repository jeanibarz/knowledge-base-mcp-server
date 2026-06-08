import {
  beirMatrixMlflowPayload,
  beirRunMlflowPayload,
  flattenMetrics,
  flattenParams,
  logBeirRunToMlflow,
  logMtebToMlflow,
  logRagEvalToMlflow,
  mtebMlflowPayload,
  ragEvalMlflowPayload,
  readMlflowConfig,
  type MlflowConfig,
} from './mlflow.js';

describe('benchmark MLflow observability', () => {
  it('stays disabled unless MLflow env is configured', () => {
    expect(readMlflowConfig({})).toBeUndefined();
  });

  it('parses optional MLflow config from env', () => {
    expect(readMlflowConfig({
      BENCH_MLFLOW_URI: 'file:/tmp/mlruns',
      BENCH_MLFLOW_EXPERIMENT: 'kb-local',
      BENCH_MLFLOW_RUN_NAME: 'trial-1',
      BENCH_MLFLOW_TAGS: 'suite=beir,dataset=scifact',
      BENCH_MLFLOW_PYTHON: '/opt/venv/bin/python',
    })).toEqual({
      trackingUri: 'file:/tmp/mlruns',
      experimentName: 'kb-local',
      runName: 'trial-1',
      tags: { suite: 'beir', dataset: 'scifact' },
      python: '/opt/venv/bin/python',
    });
  });

  it('flattens numeric benchmark values into MLflow metrics', () => {
    expect(flattenMetrics({
      warm_query: { p50_ms: 12, p95_ms: 21 },
      batch_query: { runs: [{ concurrency: 1, qps_p50: 3.5 }] },
      ignored: 'not-a-metric',
    })).toEqual({
      'warm_query.p50_ms': 12,
      'warm_query.p95_ms': 21,
      'batch_query.runs.0.concurrency': 1,
      'batch_query.runs.0.qps_p50': 3.5,
    });
  });

  it('flattens scalar params but skips object arrays', () => {
    expect(flattenParams({
      provider: 'stub',
      version: 1,
      models: ['a', 'b'],
      cases: [{ name: 'not scalar' }],
    })).toEqual({
      provider: 'stub',
      version: '1',
      models: 'a,b',
    });
  });
});

describe('BEIR ledger (RFC 020 §7)', () => {
  const config: MlflowConfig = {
    experimentName: 'kb-beir',
    tags: { suite: 'beir' },
    python: 'python3',
  };

  it('builds a per-run payload with commit + full env params, metrics, and the TREC artifact', () => {
    const payload = beirRunMlflowPayload({
      report: {
        git_sha: 'cafe',
        dataset: { name: 'scifact', split: 'test', queries_evaluated: 300 },
        mode: 'hybrid+rerank',
        embedding: { provider: 'ollama', model: 'nomic-embed-text' },
        rerank: { enabled: true, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topN: 40 },
        contextual: { enabled: false },
        chunking: { KB_CHUNK_SIZE: '1000', KB_CHUNK_OVERLAP: '200' },
        metrics: { ndcgAt10: 0.74, mapAt100: 0.6, precisionAt10: 0.09, recallAt10: 0.8, recallAt100: 0.9 },
        latency: { p50Ms: 12, p95Ms: 40, p99Ms: 55, meanMs: 18 },
      },
      jsonPath: '/tmp/scifact.json',
      trecPath: '/tmp/scifact.trec',
      repoRoot: '/repo',
    }, config);

    expect(payload.params).toMatchObject({
      kind: 'beir',
      git_sha: 'cafe',
      dataset: 'scifact',
      mode: 'hybrid+rerank',
      provider: 'ollama',
      model: 'nomic-embed-text',
      rerank_enabled: 'true',
      rerank_top_n: '40',
      chunk_size: '1000',
      chunk_overlap: '200',
    });
    expect(payload.metrics).toMatchObject({
      ndcg_at_10: 0.74,
      precision_at_10: 0.09,
      latency_p99_ms: 55,
      queries_evaluated: 300,
    });
    expect(payload.artifacts).toEqual(['/tmp/scifact.json', '/tmp/scifact.trec']);
  });

  it('logging is a no-op when MLflow is unconfigured', async () => {
    await expect(logBeirRunToMlflow({
      report: {
        git_sha: 'x',
        dataset: { name: 'd', split: 'test', queries_evaluated: 1 },
        mode: 'lexical',
        embedding: null,
        rerank: null,
        contextual: null,
        chunking: { KB_CHUNK_SIZE: null, KB_CHUNK_OVERLAP: null },
        metrics: { ndcgAt10: 0, mapAt100: 0, precisionAt10: 0, recallAt10: 0, recallAt100: 0 },
        latency: { p50Ms: 0, p95Ms: 0, p99Ms: 0, meanMs: 0 },
      },
      jsonPath: '/tmp/a.json',
      trecPath: '/tmp/a.trec',
      repoRoot: '/repo',
    }, undefined)).resolves.toBeUndefined();
  });

  it('builds a matrix payload with per-mode headline means and Δ_g metrics', () => {
    const payload = beirMatrixMlflowPayload({
      report: {
        git_sha: 'matrix1',
        modes: ['lexical', 'hybrid'],
        datasets: ['scifact', 'arguana'],
        env: { embedding_provider: 'ollama', rrf_c: '60', contextual: 'off' },
        perMode: [
          { mode: 'lexical', datasetsEvaluated: 2, datasetsRequested: 2, multiDomainMeanNdcgAt10: 0.55, multiDomainMeanPrecisionAt10: 0.1, multiDomainMeanRecallAt10: 0.6 },
          { mode: 'hybrid', datasetsEvaluated: 2, datasetsRequested: 2, multiDomainMeanNdcgAt10: 0.70, multiDomainMeanPrecisionAt10: 0.12, multiDomainMeanRecallAt10: 0.75 },
        ],
        generalization: {
          modes: [
            { mode: 'lexical', deltaG: { deltaG: 0.2, seenMeanNdcgAt10: 0.6, unseenMeanNdcgAt10: 0.48 } },
            { mode: 'hybrid', deltaG: { deltaG: 0.1, seenMeanNdcgAt10: 0.8, unseenMeanNdcgAt10: 0.72 } },
          ],
        },
      },
      jsonPath: '/tmp/matrix.json',
      markdownPath: '/tmp/matrix.md',
      repoRoot: '/repo',
    }, config);

    expect(payload.params).toMatchObject({ kind: 'beir-matrix', git_sha: 'matrix1', rrf_c: '60' });
    expect(payload.metrics['headline.hybrid.mean_ndcg_at_10']).toBe(0.70);
    expect(payload.metrics['delta_g.hybrid']).toBe(0.1);
    expect(payload.artifacts).toEqual(['/tmp/matrix.json', '/tmp/matrix.md']);
  });
});

describe('RAG eval ledger (RFC 020 §5/§7)', () => {
  const config: MlflowConfig = { experimentName: 'kb-rag-eval', tags: {}, python: 'python3' };

  it('builds a payload with panel config params and bias-coefficient metrics', () => {
    const payload = ragEvalMlflowPayload({
      report: {
        git_sha: 'beef',
        datasets: ['nq', 'hotpotqa'],
        config: { provider: 'ollama', embeddingModel: 'nomic', answererModel: 'deepseek', tier2Families: { entailment: 'nli', semantic: 'bertscore' } },
        panel: { distinctFamilies: 3, selfConsistencyK: 5, calibrationMethod: 'isotonic' },
        tier1: { exactMatch: 0.6, tokenF1: 0.7, contextRecall: 0.8, contextPrecision: 0.5 },
        routing: { items: 10, tier1Decided: 6, tier2Decided: 2, tier3Decided: 1, tier3Abstained: 1, pending: 0 },
        correctness: { scored: 9, correct: 7, accuracy: 0.778 },
        panelConfidence: { meanSelfConsistency: 0.9, meanCalibratedConfidence: 0.85, abstentionRate: 0.1 },
        biasProfiles: [
          { judge: 'deepseek-judge', family: 'deepseek', biasCoefficient: 0.05, positionBias: 0.02, dropped: false },
          { judge: 'biased-judge', family: 'x', biasCoefficient: 0.2, positionBias: 0.3, dropped: true },
        ],
      },
      jsonPath: '/tmp/rag.json',
      markdownPath: '/tmp/rag.md',
      repoRoot: '/repo',
    }, config);

    expect(payload.params).toMatchObject({
      kind: 'rag-eval',
      git_sha: 'beef',
      datasets: 'nq,hotpotqa',
      self_consistency_k: '5',
      calibration: 'isotonic',
      dropped_judges: 'biased-judge',
    });
    expect(payload.metrics['tier1.exactMatch']).toBe(0.6);
    expect(payload.metrics['correctness.accuracy']).toBeCloseTo(0.778, 5);
    expect(payload.metrics['bias.deepseek_judge.coefficient']).toBe(0.05);
    expect(payload.metrics['bias.biased_judge.position']).toBe(0.3);
    expect(payload.artifacts).toEqual(['/tmp/rag.json', '/tmp/rag.md']);
  });

  it('logging is a no-op when MLflow is unconfigured', async () => {
    await expect(logRagEvalToMlflow({
      report: {
        git_sha: 'x', datasets: [], config: { provider: null, embeddingModel: null, answererModel: null, tier2Families: { entailment: null, semantic: null } },
        panel: { distinctFamilies: 0, selfConsistencyK: 5, calibrationMethod: null },
        tier1: { exactMatch: 0, tokenF1: 0, contextRecall: null, contextPrecision: null },
        routing: { items: 0, tier1Decided: 0, tier2Decided: 0, tier3Decided: 0, tier3Abstained: 0, pending: 0 },
        correctness: { scored: 0, correct: 0, accuracy: null },
        panelConfidence: { meanSelfConsistency: null, meanCalibratedConfidence: null, abstentionRate: null },
        biasProfiles: [],
      },
      jsonPath: '/tmp/a.json', markdownPath: '/tmp/a.md', repoRoot: '/repo',
    }, undefined)).resolves.toBeUndefined();
  });
});

describe('MTEB ledger (RFC 020 §8/§7)', () => {
  const config: MlflowConfig = { experimentName: 'kb-mteb', tags: {}, python: 'python3' };

  it('builds a payload with the kb/MTEB model ids and per-task main scores', () => {
    const payload = mtebMlflowPayload({
      report: {
        git_sha: 'd00d',
        kb_model: 'dengcao/Qwen3-Embedding-0.6B:Q8_0',
        mteb_model_id: 'Qwen/Qwen3-Embedding-0.6B',
        mteb_version: '1.14.0',
        meanMainScore: 0.55,
        tasks: [{ task: 'SciFact', mainScore: 0.75 }, { task: 'NFCorpus', mainScore: 0.35 }],
      },
      jsonPath: '/tmp/mteb.json',
      markdownPath: '/tmp/mteb.md',
      repoRoot: '/repo',
    }, config);

    expect(payload.params).toMatchObject({ kind: 'mteb', mteb_model_id: 'Qwen/Qwen3-Embedding-0.6B', mteb_version: '1.14.0', tasks: '2' });
    expect(payload.metrics.mean_main_score).toBe(0.55);
    expect(payload.metrics['task.SciFact.main_score']).toBe(0.75);
    expect(payload.artifacts).toEqual(['/tmp/mteb.json', '/tmp/mteb.md']);
  });

  it('logging is a no-op when MLflow is unconfigured', async () => {
    await expect(logMtebToMlflow({
      report: { git_sha: 'x', kb_model: 'm', mteb_model_id: 'id', mteb_version: null, meanMainScore: null, tasks: [] },
      jsonPath: '/tmp/a.json', markdownPath: '/tmp/a.md', repoRoot: '/repo',
    }, undefined)).resolves.toBeUndefined();
  });
});
