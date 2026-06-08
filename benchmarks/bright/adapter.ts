// RFC 020 §8 (milestone M3) — the BRIGHT → BEIR dataset adapter.
//
// "Needs a BRIGHT dataset adapter alongside the BEIR one (same runner seam,
// different qrels/format)." BRIGHT does not ship the BEIR triple of
// corpus.jsonl / queries.jsonl / qrels/<split>.tsv. Instead each task is two
// row sets:
//
//   * documents — { id, content }
//   * examples  — { id, query, gold_ids[], excluded_ids[] }
//
// The relevance judgments are *inline on each example* (the `gold_ids` list),
// not a separate qrels file, and BRIGHT additionally carries `excluded_ids`
// (documents to drop from that one query's ranking before scoring — typically
// the query's own source page). This adapter is the seam: it converts a BRIGHT
// task into the exact BEIR-shaped dataset directory `benchmarks/beir/run.ts`
// already consumes via `--dataset-dir`, so BRIGHT runs through the *same*
// production retrieval path as BEIR with zero runner changes.
//
// Scope note (honest deviation): doc-level scoring in `metrics.ts` is global, so
// per-query `excluded_ids` are recorded as provenance but NOT subtracted from
// the ranking. Reported BRIGHT numbers are therefore a faithful local
// reproduction that may run slightly optimistic versus the official BRIGHT
// harness on tasks where a query's own page would otherwise be excluded. This is
// documented in benchmarks/bright/README.md and surfaced in the run report.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { ensureDirectory } from '../utils.js';

export interface BrightDocument {
  id: string;
  content: string;
  title?: string;
}

export interface BrightExample {
  id: string;
  query: string;
  gold_ids: string[];
  excluded_ids?: string[];
}

export interface BeirCorpusRow {
  _id: string;
  title?: string;
  text: string;
}

export interface BeirQueryRow {
  _id: string;
  text: string;
}

export interface BeirQrel {
  queryId: string;
  docId: string;
  relevance: number;
}

export interface BrightConversion {
  corpus: BeirCorpusRow[];
  queries: BeirQueryRow[];
  qrels: BeirQrel[];
  /** Per-query excluded doc ids, recorded for provenance (see scope note). */
  excluded: Array<{ queryId: string; docIds: string[] }>;
  /** gold_ids that reference a doc id absent from the corpus (data sanity). */
  danglingGoldIds: Array<{ queryId: string; docId: string }>;
}

/**
 * Convert a BRIGHT task's documents + examples into BEIR-shaped row sets.
 *
 * Pure and deterministic. The qrels are derived from each example's `gold_ids`
 * (relevance 1, BRIGHT is binary). Examples with an empty `query` or with no
 * `gold_ids` are dropped (an unjudged query contributes nothing to nDCG and
 * would otherwise materialise an empty qrels row). gold_ids that do not resolve
 * to a corpus document are reported on `danglingGoldIds` rather than silently
 * written, so a malformed export is visible.
 */
export function brightToBeirDataset(
  documents: readonly BrightDocument[],
  examples: readonly BrightExample[],
): BrightConversion {
  const corpus: BeirCorpusRow[] = documents.map((doc) => ({
    _id: doc.id,
    ...(doc.title !== undefined ? { title: doc.title } : {}),
    text: doc.content,
  }));
  const corpusIds = new Set(corpus.map((row) => row._id));

  const queries: BeirQueryRow[] = [];
  const qrels: BeirQrel[] = [];
  const excluded: Array<{ queryId: string; docIds: string[] }> = [];
  const danglingGoldIds: Array<{ queryId: string; docId: string }> = [];

  for (const example of examples) {
    const query = example.query?.trim() ?? '';
    const goldIds = example.gold_ids ?? [];
    if (query === '' || goldIds.length === 0) continue;

    queries.push({ _id: example.id, text: query });
    for (const docId of goldIds) {
      if (!corpusIds.has(docId)) {
        danglingGoldIds.push({ queryId: example.id, docId });
        continue;
      }
      qrels.push({ queryId: example.id, docId, relevance: 1 });
    }
    if (example.excluded_ids !== undefined && example.excluded_ids.length > 0) {
      excluded.push({ queryId: example.id, docIds: [...example.excluded_ids] });
    }
  }

  return { corpus, queries, qrels, excluded, danglingGoldIds };
}

/** Serialise rows as JSONL (one compact JSON object per line, trailing \n). */
export function formatJsonl<T extends object>(rows: readonly T[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/**
 * Serialise qrels as the BEIR `query-id\tcorpus-id\tscore` TSV with the header
 * row `metrics.ts` skips. Sorted by (queryId, docId) for a stable, diffable file.
 */
export function formatBeirQrelsTsv(qrels: readonly BeirQrel[]): string {
  const sorted = [...qrels].sort(
    (a, b) => a.queryId.localeCompare(b.queryId) || a.docId.localeCompare(b.docId),
  );
  const lines = ['query-id\tcorpus-id\tscore'];
  for (const qrel of sorted) {
    lines.push(`${qrel.queryId}\t${qrel.docId}\t${qrel.relevance}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Materialise a converted BRIGHT task as a BEIR `--dataset-dir`: writes
 * corpus.jsonl, queries.jsonl, and qrels/<split>.tsv under `targetDir`. Returns
 * the directory path so the caller can hand it straight to the BEIR runner.
 */
export async function materializeBrightDataset(
  targetDir: string,
  conversion: BrightConversion,
  split = 'test',
): Promise<string> {
  await ensureDirectory(targetDir);
  await ensureDirectory(path.join(targetDir, 'qrels'));
  await fsp.writeFile(path.join(targetDir, 'corpus.jsonl'), formatJsonl(conversion.corpus), 'utf-8');
  await fsp.writeFile(path.join(targetDir, 'queries.jsonl'), formatJsonl(conversion.queries), 'utf-8');
  await fsp.writeFile(path.join(targetDir, 'qrels', `${split}.tsv`), formatBeirQrelsTsv(conversion.qrels), 'utf-8');
  return targetDir;
}

// ---------------------------------------------------------------------------
// Loading a downloaded BRIGHT task from disk
// ---------------------------------------------------------------------------

export interface BrightTaskData {
  documents: BrightDocument[];
  examples: BrightExample[];
}

/**
 * Load one BRIGHT task from a directory laid out as
 * `<brightDir>/<task>/documents.jsonl` + `<brightDir>/<task>/examples.jsonl`.
 *
 * This is the format a `datasets`-based export (or the conversion script in the
 * README) produces. Rows are validated to the minimal BRIGHT shape so a
 * malformed export fails loudly at load, not mid-run.
 */
export async function loadBrightTaskDir(brightDir: string, task: string): Promise<BrightTaskData> {
  const taskDir = path.join(brightDir, task);
  const documents = await readJsonl<BrightDocument>(
    path.join(taskDir, 'documents.jsonl'),
    (row, line) => {
      if (typeof row.id !== 'string' || typeof row.content !== 'string') {
        throw new Error(`${taskDir}/documents.jsonl:${line}: expected { id: string, content: string }`);
      }
      return {
        id: row.id,
        content: row.content,
        ...(typeof row.title === 'string' ? { title: row.title } : {}),
      };
    },
  );
  const examples = await readJsonl<BrightExample>(
    path.join(taskDir, 'examples.jsonl'),
    (row, line) => {
      if (typeof row.id !== 'string' || typeof row.query !== 'string' || !Array.isArray(row.gold_ids)) {
        throw new Error(`${taskDir}/examples.jsonl:${line}: expected { id, query, gold_ids[] }`);
      }
      return {
        id: row.id,
        query: row.query,
        gold_ids: row.gold_ids.map(String),
        ...(Array.isArray(row.excluded_ids) ? { excluded_ids: row.excluded_ids.map(String) } : {}),
      };
    },
  );
  return { documents, examples };
}

async function readJsonl<T>(
  filePath: string,
  parse: (row: Record<string, unknown>, line: number) => T,
): Promise<T[]> {
  const raw = await fsp.readFile(filePath, 'utf-8');
  const out: T[] = [];
  raw.split(/\r?\n/).forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (trimmed === '') return;
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${filePath}:${index + 1}: expected a JSON object`);
    }
    out.push(parse(parsed as Record<string, unknown>, index + 1));
  });
  return out;
}
