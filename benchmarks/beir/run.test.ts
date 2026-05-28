import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseArgs,
  runBeirBenchmark,
  type LexicalIndexLike,
} from './run.js';

async function writeTinyBeirDataset(root: string): Promise<string> {
  const datasetDir = path.join(root, 'tiny');
  await fsp.mkdir(path.join(datasetDir, 'qrels'), { recursive: true });
  await fsp.writeFile(path.join(datasetDir, 'corpus.jsonl'), [
    JSON.stringify({ _id: 'doc-alpha', title: 'Alpha', text: 'Alpha benchmark evidence.' }),
    JSON.stringify({ _id: 'doc-beta', title: 'Beta', text: 'Beta benchmark evidence.' }),
    '',
  ].join('\n'), 'utf-8');
  await fsp.writeFile(path.join(datasetDir, 'queries.jsonl'), [
    JSON.stringify({ _id: 'q1', text: 'alpha evidence' }),
    '',
  ].join('\n'), 'utf-8');
  await fsp.writeFile(path.join(datasetDir, 'qrels', 'test.tsv'), [
    'query-id corpus-id score',
    'q1 doc-alpha 1',
    '',
  ].join('\n'), 'utf-8');
  return datasetDir;
}

describe('BEIR benchmark runner', () => {
  it('writes metrics JSON, TREC, and Markdown artifacts for a tiny local dataset', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-run-test-'));
    const datasetDir = await writeTinyBeirDataset(root);
    const outputDir = path.join(root, 'out');
    const workspaceRoot = path.join(root, 'kb-beir-workspace');

    const args = parseArgs([
      '--dataset=tiny',
      `--dataset-dir=${datasetDir}`,
      '--split=test',
      '--mode=lexical',
      `--output-dir=${outputDir}`,
      `--workspace-root=${workspaceRoot}`,
      '--k=10',
      '--chunk-k=10',
    ]);

    const result = await runBeirBenchmark(args, {
      gitSha: async () => 'test-sha',
      now: () => new Date('2026-05-27T12:00:00.000Z'),
      pythonVersion: async () => 'Python 3.test',
      silenceServerLogger: async () => undefined,
      loadLexicalIndex: async (_buildRoot, _kbName, kbPath): Promise<LexicalIndexLike> => {
        const files = await fsp.readdir(kbPath);
        const alphaFile = files.find((file) => file.includes('doc-alpha'));
        if (alphaFile === undefined) {
          throw new Error('tiny dataset did not produce a doc-alpha markdown file');
        }
        return {
          refresh: async () => ({
            added: 2,
            updated: 0,
            removed: 0,
            failed: 0,
            totalFiles: 2,
            totalChunks: 2,
          }),
          save: async () => undefined,
          query: async () => [{
            metadata: { source: path.join(kbPath, alphaFile) },
            score: 42,
          }],
          numChunks: () => 2,
          numFiles: () => 2,
        };
      },
    });

    const json = JSON.parse(await fsp.readFile(result.jsonPath, 'utf-8')) as {
      git_sha: string;
      metrics: { ndcgAt10: number; mapAt100: number; recallAt10: number; recallAt100: number };
      dataset: { corpus_documents: number; queries_evaluated: number };
    };
    expect(json.git_sha).toBe('test-sha');
    expect(json.dataset).toMatchObject({ corpus_documents: 2, queries_evaluated: 1 });
    expect(json.metrics).toMatchObject({
      ndcgAt10: 1,
      mapAt100: 1,
      recallAt10: 1,
      recallAt100: 1,
    });
    await expect(fsp.readFile(result.trecPath, 'utf-8')).resolves.toBe(
      'q1 Q0 doc-alpha 1 42.000000 kb-tiny-lexical-docrank\n',
    );
    await expect(fsp.readFile(result.reportPath, 'utf-8')).resolves.toContain(
      'This is a local BEIR benchmark run, not an official leaderboard submission.',
    );
    await expect(fsp.stat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to use the repository checkout as a destructive workspace root', async () => {
    const args = parseArgs([
      '--dataset=scifact',
      `--workspace-root=${process.cwd()}`,
      `--output-dir=${path.join(os.tmpdir(), 'kb-beir-safe-workspace-out')}`,
    ]);

    await expect(runBeirBenchmark(args, {
      gitSha: async () => 'unused',
      loadLexicalIndex: async () => {
        throw new Error('should not load lexical index');
      },
      now: () => new Date('2026-05-27T12:00:00.000Z'),
      pythonVersion: async () => null,
      silenceServerLogger: async () => undefined,
    })).rejects.toThrow('--workspace-root must not be the repository root or one of its parents');
  });

  it('applies BEIR runner arguments and retrieval environment from a JSON config file', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-beir-config-test-'));
    const configPath = path.join(root, 'beir-config.json');
    const previousChunkSize = process.env.KB_CHUNK_SIZE;
    const previousChunkOverlap = process.env.KB_CHUNK_OVERLAP;
    await fsp.writeFile(configPath, JSON.stringify({
      schema_version: 'kb.beir-config.v1',
      env: {
        KB_CHUNK_SIZE: 384,
        KB_CHUNK_OVERLAP: '48',
      },
      beir: {
        dataset: 'tiny',
        dataset_dir: path.join(root, 'tiny-dataset'),
        split: 'dev',
        mode: 'lexical',
        output_dir: path.join(root, 'out-from-config'),
        workspace_root: path.join(root, 'kb-beir-workspace-from-config'),
        k: 7,
        chunk_k: 11,
        max_queries: 2,
        keep_workspace: true,
      },
    }), 'utf-8');

    try {
      const args = parseArgs([
        `--config=${configPath}`,
        '--k=5',
      ]);

      expect(args).toMatchObject({
        dataset: 'tiny',
        datasetDir: path.join(root, 'tiny-dataset'),
        split: 'dev',
        mode: 'lexical',
        outputDir: path.join(root, 'out-from-config'),
        workspaceRoot: path.join(root, 'kb-beir-workspace-from-config'),
        k: 5,
        chunkK: 11,
        maxQueries: 2,
        keepWorkspace: true,
      });
      expect(process.env.KB_CHUNK_SIZE).toBe('384');
      expect(process.env.KB_CHUNK_OVERLAP).toBe('48');
    } finally {
      if (previousChunkSize === undefined) delete process.env.KB_CHUNK_SIZE;
      else process.env.KB_CHUNK_SIZE = previousChunkSize;
      if (previousChunkOverlap === undefined) delete process.env.KB_CHUNK_OVERLAP;
      else process.env.KB_CHUNK_OVERLAP = previousChunkOverlap;
    }
  });
});
