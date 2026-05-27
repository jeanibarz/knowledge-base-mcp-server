import { flattenMetrics, flattenParams, readMlflowConfig } from './mlflow.js';

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
