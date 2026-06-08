// RFC 020 §5 — gold-bearing QA dataset loader.
//
// Loads a dataset of GoldQaItem rows from JSONL (the same gitignored-cache
// convention as the BEIR/BRIGHT adapters — datasets are fetched, never
// vendored). One JSON object per line; the loader is tolerant of the upstream
// field-name variants (HotpotQA's `supporting_facts`, NQ's `short_answers`,
// 2WikiMultiHop's `answer`/`evidences`) and normalizes them into the canonical
// GoldQaItem shape. Parsing is pure and synchronous over a string so it is unit
// testable without touching the filesystem.

import * as fsp from 'fs/promises';
import { getRagDataset } from './registry.js';
import type { GoldQaItem } from './types.js';

interface RawQaRow {
  id?: unknown;
  _id?: unknown;
  question?: unknown;
  query?: unknown;
  answer?: unknown;
  answers?: unknown;
  gold_answers?: unknown;
  short_answers?: unknown;
  supporting_facts?: unknown;
  supporting_sentences?: unknown;
  evidences?: unknown;
  gold_supporting_facts?: unknown;
  answer_type?: unknown;
}

/** Parse a JSONL string into GoldQaItem rows for a named dataset. */
export function parseGoldQaJsonl(raw: string, dataset: string): GoldQaItem[] {
  const items: GoldQaItem[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    let parsed: RawQaRow;
    try {
      parsed = JSON.parse(line) as RawQaRow;
    } catch (err) {
      throw new Error(`rag-eval dataset ${dataset}: line ${i + 1} is not valid JSON: ${(err as Error).message}`);
    }
    items.push(normalizeRow(parsed, dataset, i));
  }
  return items;
}

function normalizeRow(row: RawQaRow, dataset: string, index: number): GoldQaItem {
  const id = firstString(row.id, row._id) ?? `${dataset}-${index}`;
  const question = firstString(row.question, row.query);
  if (question === undefined) {
    throw new Error(`rag-eval dataset ${dataset}: row ${id} has no question/query`);
  }
  const goldAnswers = collectStrings(row.gold_answers, row.answers, row.short_answers, row.answer);
  const goldSupportingFacts = collectStrings(
    row.gold_supporting_facts,
    row.supporting_facts,
    row.supporting_sentences,
    row.evidences,
  );
  const answerType = parseAnswerType(row.answer_type, dataset, goldAnswers);
  return { id, dataset, question, goldAnswers, goldSupportingFacts, answerType };
}

/** Load and parse a gold-QA dataset file from disk. */
export async function loadGoldQaDataset(filePath: string, dataset: string): Promise<GoldQaItem[]> {
  if (getRagDataset(dataset) === undefined) {
    throw new Error(`rag-eval: unknown dataset "${dataset}"; known: see benchmarks/rag-eval/registry.ts`);
  }
  const raw = await fsp.readFile(filePath, 'utf-8');
  return parseGoldQaJsonl(raw, dataset);
}

function parseAnswerType(value: unknown, dataset: string, goldAnswers: readonly string[]): 'short' | 'long' {
  if (value === 'short' || value === 'long') return value;
  // Heuristic default: a short single-token-ish gold answer is `short`; a long
  // multi-sentence gold answer (or none) routes to Tier 2/3 as `long`.
  const longest = goldAnswers.reduce((max, answer) => Math.max(max, answer.split(/\s+/).length), 0);
  return longest > 0 && longest <= 12 ? 'short' : 'long';
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** Collect strings from the first defined source; flattens nested arrays. */
function collectStrings(...sources: unknown[]): string[] {
  for (const source of sources) {
    if (source === undefined || source === null) continue;
    const out = flattenStrings(source);
    if (out.length > 0) return out;
  }
  return [];
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() === '' ? [] : [value.trim()];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        if (entry.trim() !== '') out.push(entry.trim());
      } else if (Array.isArray(entry)) {
        // HotpotQA supporting_facts are [title, sentence] pairs (the sentence
        // text is the meaningful gold span); keep the LAST non-empty string so
        // a [title, sentence] pair yields the sentence, not the article title.
        const strings = entry.filter((part): part is string => typeof part === 'string' && part.trim() !== '');
        if (strings.length > 0) out.push(strings[strings.length - 1].trim());
      }
    }
    return out;
  }
  return [];
}
