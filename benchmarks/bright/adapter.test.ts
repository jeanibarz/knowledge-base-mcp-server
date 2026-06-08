import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  brightToBeirDataset,
  formatBeirQrelsTsv,
  loadBrightTaskDir,
  materializeBrightDataset,
  type BrightDocument,
  type BrightExample,
} from './adapter.js';
import { parseQrelsTsv } from '../beir/metrics.js';

const DOCS: BrightDocument[] = [
  { id: 'doc-1', content: 'Alpha passage about gradient descent.' },
  { id: 'doc-2', content: 'Beta passage about eigenvalues.' },
  { id: 'doc-3', content: 'Gamma passage about backpropagation.' },
];

const EXAMPLES: BrightExample[] = [
  { id: 'ex-1', query: 'how does gradient descent converge', gold_ids: ['doc-1', 'doc-3'], excluded_ids: ['doc-2'] },
  { id: 'ex-2', query: 'what is an eigenvalue', gold_ids: ['doc-2'] },
];

describe('brightToBeirDataset', () => {
  it('maps documents to corpus rows and examples to queries', () => {
    const out = brightToBeirDataset(DOCS, EXAMPLES);
    expect(out.corpus).toEqual([
      { _id: 'doc-1', text: 'Alpha passage about gradient descent.' },
      { _id: 'doc-2', text: 'Beta passage about eigenvalues.' },
      { _id: 'doc-3', text: 'Gamma passage about backpropagation.' },
    ]);
    expect(out.queries).toEqual([
      { _id: 'ex-1', text: 'how does gradient descent converge' },
      { _id: 'ex-2', text: 'what is an eigenvalue' },
    ]);
  });

  it('derives binary qrels from each example gold_ids (one row per gold id)', () => {
    const out = brightToBeirDataset(DOCS, EXAMPLES);
    expect(out.qrels).toEqual([
      { queryId: 'ex-1', docId: 'doc-1', relevance: 1 },
      { queryId: 'ex-1', docId: 'doc-3', relevance: 1 },
      { queryId: 'ex-2', docId: 'doc-2', relevance: 1 },
    ]);
  });

  it('records per-query excluded_ids as provenance (not subtracted from qrels)', () => {
    const out = brightToBeirDataset(DOCS, EXAMPLES);
    expect(out.excluded).toEqual([{ queryId: 'ex-1', docIds: ['doc-2'] }]);
  });

  it('drops examples with an empty query or no gold_ids', () => {
    const out = brightToBeirDataset(DOCS, [
      { id: 'blank', query: '   ', gold_ids: ['doc-1'] },
      { id: 'nogold', query: 'a real query', gold_ids: [] },
      ...EXAMPLES,
    ]);
    expect(out.queries.map((q) => q._id)).toEqual(['ex-1', 'ex-2']);
  });

  it('reports gold_ids that do not resolve to a corpus document', () => {
    const out = brightToBeirDataset(DOCS, [
      { id: 'ex-x', query: 'q', gold_ids: ['doc-1', 'ghost-doc'] },
    ]);
    expect(out.danglingGoldIds).toEqual([{ queryId: 'ex-x', docId: 'ghost-doc' }]);
    expect(out.qrels).toEqual([{ queryId: 'ex-x', docId: 'doc-1', relevance: 1 }]);
  });
});

describe('formatBeirQrelsTsv', () => {
  it('emits a sorted BEIR header+rows TSV that round-trips through parseQrelsTsv', () => {
    const out = brightToBeirDataset(DOCS, EXAMPLES);
    const tsv = formatBeirQrelsTsv(out.qrels);
    expect(tsv.split('\n')[0]).toBe('query-id\tcorpus-id\tscore');
    const parsed = parseQrelsTsv(tsv);
    expect(parsed.byQuery.get('ex-1')?.get('doc-1')).toBe(1);
    expect(parsed.byQuery.get('ex-1')?.get('doc-3')).toBe(1);
    expect(parsed.byQuery.get('ex-2')?.get('doc-2')).toBe(1);
  });
});

describe('materializeBrightDataset + loadBrightTaskDir', () => {
  it('writes a BEIR-shaped dataset dir that the BEIR runner can consume', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-bright-mat-'));
    const out = brightToBeirDataset(DOCS, EXAMPLES);
    const dir = await materializeBrightDataset(path.join(root, 'biology'), out, 'test');

    const corpus = await fsp.readFile(path.join(dir, 'corpus.jsonl'), 'utf-8');
    const queries = await fsp.readFile(path.join(dir, 'queries.jsonl'), 'utf-8');
    const qrels = await fsp.readFile(path.join(dir, 'qrels', 'test.tsv'), 'utf-8');
    expect(corpus.trim().split('\n')).toHaveLength(3);
    expect(queries.trim().split('\n')).toHaveLength(2);
    expect(parseQrelsTsv(qrels).byQuery.size).toBe(2);

    await fsp.rm(root, { recursive: true, force: true });
  });

  it('loads a downloaded BRIGHT task from documents.jsonl + examples.jsonl', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-bright-load-'));
    const taskDir = path.join(root, 'biology');
    await fsp.mkdir(taskDir, { recursive: true });
    await fsp.writeFile(path.join(taskDir, 'documents.jsonl'), DOCS.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf-8');
    await fsp.writeFile(path.join(taskDir, 'examples.jsonl'), EXAMPLES.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

    const data = await loadBrightTaskDir(root, 'biology');
    expect(data.documents).toHaveLength(3);
    expect(data.examples[0]).toMatchObject({ id: 'ex-1', gold_ids: ['doc-1', 'doc-3'], excluded_ids: ['doc-2'] });

    await fsp.rm(root, { recursive: true, force: true });
  });

  it('fails loudly on a malformed examples row', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-bright-bad-'));
    const taskDir = path.join(root, 'biology');
    await fsp.mkdir(taskDir, { recursive: true });
    await fsp.writeFile(path.join(taskDir, 'documents.jsonl'), JSON.stringify(DOCS[0]) + '\n', 'utf-8');
    await fsp.writeFile(path.join(taskDir, 'examples.jsonl'), JSON.stringify({ id: 'x', query: 'q' }) + '\n', 'utf-8');
    await expect(loadBrightTaskDir(root, 'biology')).rejects.toThrow(/gold_ids/);
    await fsp.rm(root, { recursive: true, force: true });
  });
});
