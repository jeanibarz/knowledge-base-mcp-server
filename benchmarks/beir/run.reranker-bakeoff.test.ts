import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseArgs,
  runBeirBenchmark,
  type BeirSearchBackend,
  type LoadSearchBackendInput,
  type RunDependencies,
} from './run.js';

const baseDeps = {
  gitSha: async () => 'test-sha',
  now: () => new Date('2026-06-09T00:00:00.000Z'),
  pythonVersion: async () => null,
  silenceServerLogger: async () => undefined,
  loadLexicalIndex: async () => {
    throw new Error('loadLexicalIndex should not be called for benchmark rerank modes');
  },
} satisfies Omit<RunDependencies, 'loadSearchBackend'>;

async function writeTinyBeirDataset(root: string): Promise<string> {
  const datasetDir = path.join(root, 'tiny');
  await fsp.mkdir(path.join(datasetDir, 'qrels'), { recursive: true });
  await fsp.writeFile(path.join(datasetDir, 'corpus.jsonl'), [
    JSON.stringify({ _id: 'doc-alpha', title: 'Alpha', text: 'Alpha gravity wave detection evidence and analysis.' }),
    JSON.stringify({ _id: 'doc-beta', title: 'Beta', text: 'Beta culinary recipe for a hearty tomato soup.' }),
    '',
  ].join('\n'), 'utf-8');
  await fsp.writeFile(path.join(datasetDir, 'queries.jsonl'), [
    JSON.stringify({ _id: 'q1', text: 'alpha gravity wave detection evidence analysis' }),
    '',
  ].join('\n'), 'utf-8');
  await fsp.writeFile(path.join(datasetDir, 'qrels', 'test.tsv'), [
    'query-id corpus-id score',
    'q1 doc-alpha 1',
    '',
  ].join('\n'), 'utf-8');
  return datasetDir;
}

async function loadBakeoffBackend(input: LoadSearchBackendInput): Promise<BeirSearchBackend> {
  const relativeByDoc = new Map<string, string>();
  return {
    implementation: 'test production hybrid candidate generator',
    prepare: async () => {
      const kbRoot = process.env.KNOWLEDGE_BASES_ROOT_DIR;
      if (kbRoot === undefined) throw new Error('KNOWLEDGE_BASES_ROOT_DIR missing');
      const kbPath = path.join(kbRoot, input.kbName);
      const files = await fsp.readdir(kbPath);
      for (const file of files) {
        const text = await fsp.readFile(path.join(kbPath, file), 'utf-8');
        if (text.includes('Alpha gravity')) relativeByDoc.set('doc-alpha', `${input.kbName}/${file}`);
        if (text.includes('Beta culinary')) relativeByDoc.set('doc-beta', `${input.kbName}/${file}`);
      }
      return { files: files.length, chunks: files.length };
    },
    search: async () => [
      {
        pageContent: 'Beta culinary recipe for a hearty tomato soup.',
        metadata: { relativePath: relativeByDoc.get('doc-beta') },
        score: 2,
      },
      {
        pageContent: 'Alpha gravity wave detection evidence and analysis.',
        metadata: { relativePath: relativeByDoc.get('doc-alpha') },
        score: 1,
      },
    ],
  };
}

describe('BEIR runner issue #579 reranker bakeoff modes', () => {
  let root: string;
  let datasetDir: string;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-reranker-bakeoff-'));
    datasetDir = await writeTinyBeirDataset(root);
  });

  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it.each([
    ['hybrid+listwise-rerank', 'listwise-attention', 'qr-style-token-attention-v1'],
    ['hybrid+hard-negative-rerank', 'hard-negative-head', 'hard-negative-boundary-head-sim-v1'],
    ['hybrid+adaptive-rerank', 'adaptive-listwise-attention', 'adaptive-qr-style-token-attention-v1'],
  ])('runs benchmark-only %s over hybrid candidates and records candidate diagnostics', async (mode, strategy, model) => {
    const args = parseArgs([
      '--dataset=tiny',
      `--dataset-dir=${datasetDir}`,
      `--mode=${mode}`,
      '--provider=fake',
      `--output-dir=${path.join(root, `out-${mode}`)}`,
      `--workspace-root=${path.join(root, `kb-beir-ws-${mode}`)}`,
      '--k=2',
      '--chunk-k=2',
      '--candidate-pool-k=2',
    ]);

    const result = await runBeirBenchmark(args, { ...baseDeps, loadSearchBackend: loadBakeoffBackend });

    expect(result.report.schema_version).toBe('kb.beir-benchmark.v7');
    expect(result.report.mode).toBe(mode);
    expect(result.report.reranker_bakeoff).toMatchObject({
      strategy,
      model,
      queries: 1,
      mean_candidates_in: 2,
      mean_candidates_reranked: 2,
      skipped_queries: 0,
    });
    expect(result.report.metrics.ndcgAt10).toBe(1);
    const trec = await fsp.readFile(result.trecPath, 'utf-8');
    expect(trec.split(/\r?\n/)[0]).toContain('doc-alpha');
  });
});
