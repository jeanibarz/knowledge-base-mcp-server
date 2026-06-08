import { describe, expect, it, afterAll } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { parseMtebRunArgs, runMtebRecord } from './run.js';

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mteb-run-test-'));
  tmpDirs.push(dir);
  return dir;
}

describe('parseMtebRunArgs', () => {
  it('parses result + provider and defaults output dir', () => {
    const opts = parseMtebRunArgs(['--result=out.json', '--provider=ollama']);
    expect(opts.resultPath).toContain('out.json');
    expect(opts.provider).toBe('ollama');
    expect(opts.outputDir).toContain(path.join('benchmarks', 'results', 'mteb'));
  });
});

describe('runMtebRecord', () => {
  it('folds a python result JSON into a record + markdown and resolves the model id', async () => {
    const work = await tmp();
    const resultPath = path.join(work, 'folded.json');
    await fsp.writeFile(resultPath, JSON.stringify({
      kb_model: 'dengcao/Qwen3-Embedding-0.6B:Q8_0',
      mteb_model_id: 'Qwen/Qwen3-Embedding-0.6B',
      mteb_version: '1.14.0',
      tasks: [
        { task: 'SciFact', task_type: 'Retrieval', split: 'test', main_score: 0.75, metric: 'main_score' },
        { task: 'NFCorpus', task_type: 'Retrieval', split: 'test', main_score: 0.35, metric: 'main_score' },
      ],
    }), 'utf-8');

    const outputDir = path.join(work, 'out');
    const result = await runMtebRecord(
      { resultPath, provider: 'ollama', outputDir },
      () => new Date('2026-06-08T00:00:00.000Z'),
    );

    expect(result.record.mteb_model_id).toBe('Qwen/Qwen3-Embedding-0.6B');
    expect(result.record.meanMainScore).toBeCloseTo(0.55, 5);
    expect(result.record.tasks).toHaveLength(2);
    const md = await fsp.readFile(result.markdownPath, 'utf-8');
    expect(md).toContain('# MTEB submission — embedding-model rank');
  });

  it('produces a pending record when there is no input (no fabrication)', async () => {
    const outputDir = path.join(await tmp(), 'out');
    const result = await runMtebRecord({ provider: 'ollama', outputDir }, () => new Date('2026-06-08T00:00:00.000Z'));
    expect(result.record.meanMainScore).toBeNull();
    expect(result.record.tasks).toHaveLength(0);
  });
});
