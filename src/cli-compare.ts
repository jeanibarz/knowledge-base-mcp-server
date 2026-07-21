import { FaissIndexManager } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  resolveActiveModel,
} from './active-model.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';

export const COMPARE_SCHEMA_VERSION = 'kb.compare.v1' as const;

export const COMPARE_HELP = `kb compare — side-by-side rank/score table for two embedding models

Usage:
  kb compare <query> <model_a> <model_b> [--k=<int>] [--kb=<name>] [--no-cache] [--format=md|json]

Runs the same query against two registered models' indexes and prints a
joined table of \`rank_a / rank_b / score_a / score_b / in_both / source\`,
sorted by best rank in either column. Useful when evaluating a candidate
embedding model against the current active one.

Scores are per-model L2 distances and are NOT directly comparable across
models — read the relative ordering, not the magnitudes.

Arguments:
  <query>               Query string (positional).
  <model_a>             First model id (\`<provider>__<slug>\`); see \`kb models list\`.
  <model_b>             Second model id; must differ from <model_a>.

Options:
  --k=<int>             Top-K results per model (default: 10).
  --kb=<name>           Scope to one knowledge base. Omit to search ALL KBs.
  --no-cache            Bypass the query-embedding cache for both model legs.
  --format=md|json      Output format (default: md). \`json\` emits a stable
                        rank/score object documented in docs/cli-json-contracts.md.
  --help, -h            Show this help.

Examples:
  kb compare "rollback procedure" ollama__nomic-embed-text openai__text-embedding-3-small
  kb compare "deploy" ollama__nomic-embed-text huggingface__bge-small-en --k=5 --kb=work
  kb compare "deploy" ollama__nomic-embed-text huggingface__bge-small-en --format=json
`;

export interface CompareArgs {
  query: string;
  modelA: string;
  modelB: string;
  k: number;
  kb?: string;
  noCache: boolean;
  format: 'md' | 'json';
}

export interface CompareHit {
  source: string;
  chunkIndex: number;
  /** Present when the search hit carried a numeric score; omitted → markdown "—". */
  score?: number;
}

export interface CompareRow {
  rank_a: number | null;
  rank_b: number | null;
  score_a: number | null;
  score_b: number | null;
  in_both: boolean;
  source: string;
}

export interface CompareReport {
  schema_version: typeof COMPARE_SCHEMA_VERSION;
  query: string;
  model_a: string;
  model_b: string;
  k: number;
  knowledge_base: string | null;
  rows: CompareRow[];
}

export function parseCompareArgs(rest: string[]): CompareArgs {
  const positionals: string[] = [];
  let k = 10;
  let kb: string | undefined;
  let noCache = false;
  let format: 'md' | 'json' = 'md';

  for (const raw of rest) {
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`invalid --k: ${raw}`);
      }
      k = n;
      continue;
    }
    if (raw.startsWith('--kb=')) {
      kb = raw.slice('--kb='.length);
      continue;
    }
    if (raw === '--no-cache') {
      noCache = true;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format value '${value}' (expected md or json)`);
      }
      format = value;
      continue;
    }
    if (raw.startsWith('--')) {
      throw new Error(`unknown flag: ${raw}`);
    }
    positionals.push(raw);
  }

  if (positionals.length !== 3) {
    throw new Error('expected <query> <model_a> <model_b>');
  }

  const [query, modelA, modelB] = positionals;
  return { query, modelA, modelB, k, kb, noCache, format };
}

/** Join two top-K hit lists into a rank/score table sorted by best rank. */
export function buildCompareRows(hitsA: CompareHit[], hitsB: CompareHit[]): CompareRow[] {
  interface MutableRow {
    rank_a?: number;
    rank_b?: number;
    score_a?: number;
    score_b?: number;
    source: string;
  }
  const rows = new Map<string, MutableRow>();

  hitsA.forEach((hit, i) => {
    const key = `${hit.source}#${hit.chunkIndex}`;
    rows.set(key, {
      rank_a: i + 1,
      ...(hit.score !== undefined ? { score_a: hit.score } : {}),
      source: hit.source,
    });
  });
  hitsB.forEach((hit, i) => {
    const key = `${hit.source}#${hit.chunkIndex}`;
    const existing = rows.get(key);
    if (existing) {
      existing.rank_b = i + 1;
      if (hit.score !== undefined) existing.score_b = hit.score;
    } else {
      rows.set(key, {
        rank_b: i + 1,
        ...(hit.score !== undefined ? { score_b: hit.score } : {}),
        source: hit.source,
      });
    }
  });

  const sorted = Array.from(rows.values());
  sorted.sort((a, b) => {
    const minA = Math.min(a.rank_a ?? Number.POSITIVE_INFINITY, a.rank_b ?? Number.POSITIVE_INFINITY);
    const minB = Math.min(b.rank_a ?? Number.POSITIVE_INFINITY, b.rank_b ?? Number.POSITIVE_INFINITY);
    return minA - minB;
  });

  return sorted.map((r) => ({
    rank_a: r.rank_a ?? null,
    rank_b: r.rank_b ?? null,
    score_a: r.score_a ?? null,
    score_b: r.score_b ?? null,
    in_both: r.rank_a !== undefined && r.rank_b !== undefined,
    source: r.source,
  }));
}

export function buildCompareReport(input: {
  query: string;
  modelA: string;
  modelB: string;
  k: number;
  kb?: string;
  hitsA: CompareHit[];
  hitsB: CompareHit[];
}): CompareReport {
  return {
    schema_version: COMPARE_SCHEMA_VERSION,
    query: input.query,
    model_a: input.modelA,
    model_b: input.modelB,
    k: input.k,
    knowledge_base: input.kb ?? null,
    rows: buildCompareRows(input.hitsA, input.hitsB),
  };
}

export function formatCompareReport(report: CompareReport, format: 'md' | 'json'): string {
  if (format === 'json') {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  const lines: string[] = [
    '# kb compare',
    '',
    `Query: ${report.query}`,
    `Model A: ${report.model_a}`,
    `Model B: ${report.model_b}`,
    '(Scores are per-model L2 distances; not directly comparable across models.)',
    '',
    'rank_a  rank_b  score_a  score_b  in_both  source',
  ];
  for (const r of report.rows) {
    const ra = r.rank_a !== null ? String(r.rank_a).padStart(6) : '     —';
    const rb = r.rank_b !== null ? String(r.rank_b).padStart(6) : '     —';
    const sa = r.score_a !== null ? r.score_a.toFixed(2).padStart(7) : '      —';
    const sb = r.score_b !== null ? r.score_b.toFixed(2).padStart(7) : '      —';
    const both = r.in_both ? '  yes  ' : '  no   ';
    lines.push(`${ra}  ${rb}  ${sa}  ${sb}  ${both}  ${r.source}`);
  }
  return `${lines.join('\n')}\n`;
}

function toCompareHit(doc: { score?: number; metadata?: { source?: string; chunkIndex?: number } }): CompareHit {
  return {
    source: doc.metadata?.source ?? 'unknown',
    chunkIndex: doc.metadata?.chunkIndex ?? 0,
    ...(typeof doc.score === 'number' && Number.isFinite(doc.score) ? { score: doc.score } : {}),
  };
}

export async function runCompare(rest: string[]): Promise<number> {
  let parsed: CompareArgs;
  try {
    parsed = parseCompareArgs(rest);
  } catch (err) {
    process.stderr.write(`kb compare: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    await FaissIndexManager.bootstrapLayout();
  } catch (err) {
    process.stderr.write(`kb compare: layout bootstrap failed: ${(err as Error).message}\n`);
    return 1;
  }

  let resolvedA: string;
  let resolvedB: string;
  try {
    resolvedA = await resolveActiveModel({ explicitOverride: parsed.modelA });
    resolvedB = await resolveActiveModel({ explicitOverride: parsed.modelB });
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      process.stderr.write(`kb compare: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`kb compare: ${(err as Error).message}\n`);
    return 1;
  }
  if (resolvedA === resolvedB) {
    process.stderr.write(
      `kb compare: model_a and model_b resolve to the same id "${resolvedA}". Pick two different models.\n`,
    );
    return 2;
  }

  let hitsA: CompareHit[];
  let hitsB: CompareHit[];
  try {
    const managerA = await loadManagerForModel(resolvedA);
    await loadWithJsonRetry(managerA);
    const resultsA = await managerA.similaritySearch(
      parsed.query,
      parsed.k,
      undefined,
      parsed.kb,
      undefined,
      undefined,
      { noCache: parsed.noCache },
    );

    const managerB = await loadManagerForModel(resolvedB);
    await loadWithJsonRetry(managerB);
    const resultsB = await managerB.similaritySearch(
      parsed.query,
      parsed.k,
      undefined,
      parsed.kb,
      undefined,
      undefined,
      { noCache: parsed.noCache },
    );

    hitsA = resultsA.map(toCompareHit);
    hitsB = resultsB.map(toCompareHit);
  } catch (err) {
    process.stderr.write(`kb compare: ${(err as Error).message}\n`);
    return 1;
  }

  const report = buildCompareReport({
    query: parsed.query,
    modelA: resolvedA,
    modelB: resolvedB,
    k: parsed.k,
    kb: parsed.kb,
    hitsA,
    hitsB,
  });
  process.stdout.write(formatCompareReport(report, parsed.format));
  return 0;
}
