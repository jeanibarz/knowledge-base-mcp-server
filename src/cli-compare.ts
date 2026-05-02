import { FaissIndexManager } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  resolveActiveModel,
} from './active-model.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';

export async function runCompare(rest: string[]): Promise<number> {
  // Parse: <query> <model_a> <model_b> [--k=<int>] [--kb=<name>]
  const positionals: string[] = [];
  let k = 10;
  let kb: string | undefined;
  for (const raw of rest) {
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) {
        process.stderr.write(`kb compare: invalid --k: ${raw}\n`);
        return 2;
      }
      k = n;
      continue;
    }
    if (raw.startsWith('--kb=')) { kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--')) {
      process.stderr.write(`kb compare: unknown flag: ${raw}\n`);
      return 2;
    }
    positionals.push(raw);
  }
  if (positionals.length !== 3) {
    process.stderr.write('kb compare: expected <query> <model_a> <model_b>\n');
    return 2;
  }
  const [query, modelA, modelB] = positionals;

  try {
    await FaissIndexManager.bootstrapLayout();
  } catch (err) {
    process.stderr.write(`kb compare: layout bootstrap failed: ${(err as Error).message}\n`);
    return 1;
  }

  let resolvedA: string;
  let resolvedB: string;
  try {
    resolvedA = await resolveActiveModel({ explicitOverride: modelA });
    resolvedB = await resolveActiveModel({ explicitOverride: modelB });
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      process.stderr.write(`kb compare: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`kb compare: ${(err as Error).message}\n`);
    return 1;
  }
  if (resolvedA === resolvedB) {
    process.stderr.write(`kb compare: model_a and model_b resolve to the same id "${resolvedA}". Pick two different models.\n`);
    return 2;
  }

  let resultsA;
  let resultsB;
  try {
    const managerA = await loadManagerForModel(resolvedA);
    await loadWithJsonRetry(managerA);
    resultsA = await managerA.similaritySearch(query, k, undefined, kb);

    const managerB = await loadManagerForModel(resolvedB);
    await loadWithJsonRetry(managerB);
    resultsB = await managerB.similaritySearch(query, k, undefined, kb);
  } catch (err) {
    process.stderr.write(`kb compare: ${(err as Error).message}\n`);
    return 1;
  }

  interface Row {
    rank_a?: number;
    rank_b?: number;
    score_a?: number;
    score_b?: number;
    source: string;
  }
  const rows = new Map<string, Row>();
  resultsA.forEach((doc: any, i: number) => {
    const key = `${(doc.metadata?.source ?? 'unknown')}#${doc.metadata?.chunkIndex ?? 0}`;
    rows.set(key, { rank_a: i + 1, score_a: doc.score, source: doc.metadata?.source ?? 'unknown' });
  });
  resultsB.forEach((doc: any, i: number) => {
    const key = `${(doc.metadata?.source ?? 'unknown')}#${doc.metadata?.chunkIndex ?? 0}`;
    const existing = rows.get(key);
    if (existing) {
      existing.rank_b = i + 1;
      existing.score_b = doc.score;
    } else {
      rows.set(key, { rank_b: i + 1, score_b: doc.score, source: doc.metadata?.source ?? 'unknown' });
    }
  });

  const sorted = Array.from(rows.entries()).map(([key, r]) => ({ key, ...r }));
  sorted.sort((a, b) => {
    const ra = a.rank_a ?? Number.POSITIVE_INFINITY;
    const rb = a.rank_b ?? Number.POSITIVE_INFINITY;
    const minA = Math.min(ra, rb);
    const ra2 = b.rank_a ?? Number.POSITIVE_INFINITY;
    const rb2 = b.rank_b ?? Number.POSITIVE_INFINITY;
    const minB = Math.min(ra2, rb2);
    return minA - minB;
  });

  process.stdout.write('# kb compare\n\n');
  process.stdout.write(`Query: ${query}\n`);
  process.stdout.write(`Model A: ${resolvedA}\n`);
  process.stdout.write(`Model B: ${resolvedB}\n`);
  process.stdout.write('(Scores are per-model L2 distances; not directly comparable across models.)\n\n');
  process.stdout.write('rank_a  rank_b  score_a  score_b  in_both  source\n');
  for (const r of sorted) {
    const ra = r.rank_a !== undefined ? String(r.rank_a).padStart(6) : '     —';
    const rb = r.rank_b !== undefined ? String(r.rank_b).padStart(6) : '     —';
    const sa = r.score_a !== undefined ? r.score_a.toFixed(2).padStart(7) : '      —';
    const sb = r.score_b !== undefined ? r.score_b.toFixed(2).padStart(7) : '      —';
    const both = r.rank_a !== undefined && r.rank_b !== undefined ? '  yes  ' : '  no   ';
    process.stdout.write(`${ra}  ${rb}  ${sa}  ${sb}  ${both}  ${r.source}\n`);
  }
  return 0;
}
