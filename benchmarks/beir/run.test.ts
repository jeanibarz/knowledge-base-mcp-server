import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseArgs,
  runBeirBenchmark,
  type LexicalIndexLike,
} from './run.js';
import { DocumentBm25Ranker, tokenize } from './document-bm25.js';

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
  it('uses document-level BM25 by default without loading the chunk lexical index', async () => {
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
    ]);

    const result = await runBeirBenchmark(args, {
      gitSha: async () => 'test-sha',
      now: () => new Date('2026-05-27T12:00:00.000Z'),
      pythonVersion: async () => 'Python 3.test',
      silenceServerLogger: async () => {
        throw new Error('document-level benchmark should not load server logger');
      },
      loadLexicalIndex: async () => {
        throw new Error('document-level benchmark should not load LexicalIndex');
      },
    });

    const json = JSON.parse(await fsp.readFile(result.jsonPath, 'utf-8')) as {
      ranking: { lexical_unit: string; bm25: { k1: number; b: number } };
      metrics: { ndcgAt10: number; mapAt100: number; recallAt10: number; recallAt100: number };
      indexing: { files: number; chunks: number };
    };
    expect(json.ranking).toMatchObject({
      lexical_unit: 'document',
      bm25: { k1: 0.6, b: 0.9 },
    });
    expect(json.indexing).toMatchObject({ files: 2, chunks: 2 });
    expect(json.metrics).toMatchObject({
      ndcgAt10: 1,
      mapAt100: 1,
      recallAt10: 1,
      recallAt100: 1,
    });
    await expect(fsp.readFile(result.trecPath, 'utf-8')).resolves.toContain(
      'q1 Q0 doc-alpha 1 ',
    );
  });

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
      '--lexical-unit=chunk',
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
      'q1 Q0 doc-alpha 1 42.000000 kb-tiny-lexical-chunk-docrank\n',
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

  it('accepts additional built-in BEIR dataset names without a custom directory', () => {
    const args = parseArgs(['--dataset=nfcorpus']);

    expect(args.dataset).toBe('nfcorpus');
    expect(args.lexicalUnit).toBe('document');
  });

  it('reports the supported built-in datasets for unknown BEIR names', () => {
    expect(() => parseArgs(['--dataset=unknown-beir'])).toThrow(
      /built-in datasets: .*nfcorpus.*scifact/,
    );
  });
});

describe('document BM25 ranker', () => {
  it('tokenizes case-insensitively with punctuation splitting', () => {
    expect(tokenize('NF-kappaB/IL-6 response')).toEqual(['nf', 'kappab', 'il', '6', 'response']);
  });

  it('ranks matching BEIR documents by BM25 score', () => {
    const ranker = DocumentBm25Ranker.fromCorpus([
      { _id: 'doc-alpha', title: 'Alpha evidence', text: 'Alpha alpha benchmark.' },
      { _id: 'doc-beta', title: 'Beta evidence', text: 'Beta benchmark.' },
    ], { k1: 0.6, b: 0.9, titleWeight: 1 });

    expect(ranker.query('alpha evidence', 10)[0]?.docId).toBe('doc-alpha');
  });
});
