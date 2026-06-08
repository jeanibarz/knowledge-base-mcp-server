import { describe, expect, it } from '@jest/globals';
import {
  buildMtebRecord,
  formatMtebMarkdown,
  parseMtebTaskJson,
  type ParsedMtebTask,
} from './result.js';

const sciFactJson = JSON.stringify({
  task_name: 'SciFact',
  task_type: 'Retrieval',
  mteb_version: '1.14.0',
  scores: {
    test: [{ main_score: 0.751, ndcg_at_10: 0.751 }],
  },
});

describe('parseMtebTaskJson', () => {
  it('extracts the test-split main score and the mteb version', () => {
    const task = parseMtebTaskJson(sciFactJson, 'fallback');
    expect(task.task).toBe('SciFact');
    expect(task.taskType).toBe('Retrieval');
    expect(task.split).toBe('test');
    expect(task.mainScore).toBeCloseTo(0.751, 5);
    expect(task.mtebVersion).toBe('1.14.0');
  });

  it('falls back gracefully when scores are missing', () => {
    const task = parseMtebTaskJson('{"task_name":"X"}', 'X');
    expect(task.mainScore).toBe(0);
    expect(task.split).toBe('unknown');
  });
});

describe('buildMtebRecord', () => {
  const tasks: ParsedMtebTask[] = [
    { task: 'SciFact', taskType: 'Retrieval', split: 'test', mainScore: 0.75, metric: 'main_score', mtebVersion: '1.14.0' },
    { task: 'NFCorpus', taskType: 'Retrieval', split: 'test', mainScore: 0.35, metric: 'main_score', mtebVersion: '1.14.0' },
  ];

  it('records the per-task scores, the mean and the provenance', () => {
    const record = buildMtebRecord({
      generatedAt: '2026-06-08T00:00:00.000Z',
      gitSha: 'sha',
      kbModel: 'dengcao/Qwen3-Embedding-0.6B:Q8_0',
      mtebModelId: 'Qwen/Qwen3-Embedding-0.6B',
      taskFiles: tasks,
    });
    expect(record.schema_version).toBe('kb.mteb-result.v1');
    expect(record.meanMainScore).toBeCloseTo(0.55, 5);
    expect(record.mteb_version).toBe('1.14.0');
    expect(record.tasks).toHaveLength(2);
  });

  it('marks an empty run as pending without fabricating a score', () => {
    const record = buildMtebRecord({
      generatedAt: '2026-06-08T00:00:00.000Z',
      gitSha: 'sha',
      kbModel: 'm',
      mtebModelId: 'id',
      taskFiles: [],
    });
    expect(record.meanMainScore).toBeNull();
    expect(record.caveats.some((c) => /No MTEB tasks recorded yet/.test(c))).toBe(true);
  });
});

describe('formatMtebMarkdown', () => {
  it('renders the task table and pipeline-vs-model caveat', () => {
    const record = buildMtebRecord({
      generatedAt: '2026-06-08T00:00:00.000Z',
      gitSha: 'sha',
      kbModel: 'dengcao/Qwen3-Embedding-0.6B:Q8_0',
      mtebModelId: 'Qwen/Qwen3-Embedding-0.6B',
      taskFiles: [{ task: 'SciFact', taskType: 'Retrieval', split: 'test', mainScore: 0.75, metric: 'main_score', mtebVersion: '1.14.0' }],
    });
    const md = formatMtebMarkdown(record);
    expect(md).toContain('# MTEB submission — embedding-model rank');
    expect(md).toContain('| SciFact | Retrieval | test | 0.7500 |');
    expect(md).toContain('ranks the embedding model, not the kb retrieval pipeline');
  });
});
