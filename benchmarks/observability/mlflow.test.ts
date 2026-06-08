import {
  beirMatrixMlflowPayload,
  beirRunMlflowPayload,
  flattenMetrics,
  flattenParams,
  logBeirRunToMlflow,
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
