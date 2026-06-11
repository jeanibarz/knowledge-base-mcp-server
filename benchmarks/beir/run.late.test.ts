import { describe, expect, it, jest } from '@jest/globals';
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
  now: () => new Date('2026-06-08T00:00:00.000Z'),
  pythonVersion: async () => null,
  silenceServerLogger: async () => undefined,
  loadLexicalIndex: async () => {
    throw new Error('loadLexicalIndex should not be called for late modes');
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
    JSON.stringify({ _id: 'q1', text: 'alpha gravity wave detection' }),
    '',
  ].join('\n'), 'utf-8');
  await fsp.writeFile(path.join(datasetDir, 'qrels', 'test.tsv'), [
    'query-id corpus-id score',
    'q1 doc-alpha 1',
    '',
  ].join('\n'), 'utf-8');
  return datasetDir;
}

describe('BEIR runner late-interaction modes', () => {
  it('runs standalone late mode without embedding provider or production search', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-late-'));
    const datasetDir = await writeTinyBeirDataset(root);
    const loadSearchBackend = jest.fn(async (): Promise<BeirSearchBackend> => {
      throw new Error('loadSearchBackend should not be called for late mode');
    });
    const args = parseArgs([
      '--dataset=tiny',
      `--dataset-dir=${datasetDir}`,
      '--mode=late',
      `--output-dir=${path.join(root, 'out')}`,
      `--workspace-root=${path.join(root, 'kb-beir-ws')}`,
      '--k=10',
    ]);

    const result = await runBeirBenchmark(args, { ...baseDeps, loadSearchBackend });

    expect(loadSearchBackend).not.toHaveBeenCalled();
    expect(result.report.mode).toBe('late');
    expect(result.report.embedding).toBeNull();
    expect(result.report.ranking.unit).toBe('source');
    expect(result.report.command).not.toContain('--lexical-unit');
    expect(result.report.late_interaction).toMatchObject({
      enabled: true,
      mode: 'standalone',
      model: 'hashed-token-maxsim-v1',
      documents_indexed: 2,
    });
    expect(result.report.metrics.ndcgAt10).toBe(1);
    expect(await fsp.readFile(result.reportPath, 'utf-8')).toContain('Late interaction: standalone');
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('reranks hybrid candidates with late interaction for hybrid+late', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-hybrid-late-'));
    const datasetDir = await writeTinyBeirDataset(root);
    const search = jest.fn(async (_query: string, _fetchK: number) => {
      const kbDir = path.join(process.env.KNOWLEDGE_BASES_ROOT_DIR ?? '', 'tiny');
      const files = await fsp.readdir(kbDir);
      const alpha = files.find((file) => file.includes('doc-alpha'));
      const beta = files.find((file) => file.includes('doc-beta'));
      return [
        {
          pageContent: 'Beta culinary recipe for a hearty tomato soup.',
          metadata: { relativePath: `tiny/${beta}`, chunkIndex: 0 },
          score: 2,
        },
        {
          pageContent: 'Alpha gravity wave detection evidence and analysis.',
          metadata: { relativePath: `tiny/${alpha}`, chunkIndex: 0 },
          score: 1,
        },
      ];
    });
    const loadSearchBackend = jest.fn(async (input: LoadSearchBackendInput): Promise<BeirSearchBackend> => {
      expect(input.mode).toBe('hybrid');
      expect(input.provider).toBe('fake');
      return {
        implementation: 'spy hybrid backend',
        prepare: async () => ({ files: 2, chunks: 2 }),
        search,
      };
    });
    const args = parseArgs([
      '--dataset=tiny',
      `--dataset-dir=${datasetDir}`,
      '--mode=hybrid+late',
      '--provider=fake',
      `--output-dir=${path.join(root, 'out')}`,
      `--workspace-root=${path.join(root, 'kb-beir-ws')}`,
      '--k=10',
      '--chunk-k=20',
    ]);

    const result = await runBeirBenchmark(args, { ...baseDeps, loadSearchBackend });

    expect(search).toHaveBeenCalledWith('alpha gravity wave detection', 20);
    expect(result.report.mode).toBe('hybrid+late');
    expect(result.report.embedding).toEqual({ provider: 'fake', model: 'fake-embeddings' });
    expect(result.report.ranking.implementation).toContain('late-interaction.ts');
    expect(result.report.late_interaction).toMatchObject({
      enabled: true,
      mode: 'rerank',
      candidate_source: 'hybrid top-20 candidates',
    });
    expect(result.report.metrics.ndcgAt10).toBe(1);
    const trec = await fsp.readFile(result.trecPath, 'utf-8');
    expect(trec.startsWith('q1 Q0 doc-alpha 1')).toBe(true);
    await fsp.rm(root, { recursive: true, force: true });
  });
});
