import { describe, expect, it, afterAll } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import {
  defaultDependencies,
  parseRagEvalArgs,
  runRagEval,
  type RagEvalOptions,
} from './run.js';
import type { GoldQaItem } from './types.js';

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rag-eval-test-'));
  tmpDirs.push(dir);
  return dir;
}

const goldItems: GoldQaItem[] = [
  { id: 'q1', dataset: 'nq', question: 'Capital of France?', goldAnswers: ['Paris'], goldSupportingFacts: ['Paris is the capital of France.'], answerType: 'short' },
  { id: 'q2', dataset: 'nq', question: 'Author of Hamlet?', goldAnswers: ['William Shakespeare'], goldSupportingFacts: ['Hamlet was written by William Shakespeare.'], answerType: 'short' },
];

describe('parseRagEvalArgs', () => {
  it('defaults to the full registry and parses flags', () => {
    const opts = parseRagEvalArgs(['--fake', '--samples=3', '--datasets=nq', '--max-items=10']);
    expect(opts.fake).toBe(true);
    expect(opts.samples).toBe(3);
    expect(opts.datasets).toEqual(['nq']);
    expect(opts.maxItems).toBe(10);
  });

  it('rejects an unknown dataset', () => {
    expect(() => parseRagEvalArgs(['--datasets=bogus'])).toThrow(/unknown rag-eval dataset/);
  });
});

describe('runRagEval --fake (hermetic, production wiring)', () => {
  it('produces a complete scorecard offline with 3 judge families and no pending items', async () => {
    const outputDir = await tmp();
    const options: RagEvalOptions = { ...parseRagEvalArgs(['--fake', '--samples=3', '--datasets=nq']), outputDir };
    // Real production dependencies (fake-mode judge/answer/tier2 wiring), only
    // loadDataset is overridden to avoid touching the gitignored cache.
    const result = await runRagEval(options, { ...defaultDependencies(), loadDataset: async () => goldItems });

    expect(result.scorecard.routing.items).toBe(2);
    expect(result.scorecard.routing.pending).toBe(0);
    expect(result.scorecard.tier1.exactMatch).toBe(1);
    expect(result.scorecard.panel.distinctFamilies).toBe(3);

    const json = JSON.parse(await fsp.readFile(result.jsonPath, 'utf-8'));
    expect(json.schema_version).toBe('kb.rag-eval-scorecard.v1');
    expect(await fsp.readFile(result.markdownPath, 'utf-8')).toContain('human-label-free');
  });

  it('records pending items (no fabrication) when there are no answers and not --fake', async () => {
    const outputDir = await tmp();
    const options: RagEvalOptions = { ...parseRagEvalArgs(['--datasets=nq', '--samples=2']), outputDir };
    const result = await runRagEval(options, { ...defaultDependencies(), loadDataset: async () => goldItems });
    expect(result.scorecard.routing.pending).toBeGreaterThan(0);
    expect(result.scorecard.correctness.accuracy).toBeNull();
  });
});
