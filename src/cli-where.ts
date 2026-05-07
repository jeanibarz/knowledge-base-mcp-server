// `kb where --topic=<query>` — one-shot "which KB and which file should I
// update?" recommendation (issue #141).
//
// Strategy (from the issue body, "cheap path"):
//   1. Run a similarity search across all KBs (no `--kb=` filter).
//   2. Group hits by `metadata.knowledgeBase`. The KB with the highest-scoring
//      top hit is the recommended KB.
//   3. The single file with the highest score within that KB is the
//      recommended existing target.
//   4. Apply a confidence threshold: lower FAISS distance = closer match;
//      a top score below `--threshold` (default 1.0) is "high confidence
//      existing target", otherwise suggest `kb remember --title=...` to
//      create a new note.
//   5. Print the recommendation + a copy-pasteable `kb remember` invocation.
//
// Strictly read-only — same posture as `kb search` without `--refresh`.
//
// Composes with #139 (`--append-section`) and #140 (`kb list --describe`)
// once those land; today the suggestion sticks to flags the CLI accepts.

import { FaissIndexManager } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  resolveActiveModel,
} from './active-model.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import type { ScoredDocument } from './formatter.js';

export interface WhereArgs {
  topic: string | null;
  model?: string;
  threshold: number;
  k: number;
  format: 'md' | 'json';
}

export interface WhereDecision {
  recommendedKb: string;
  existingTarget: string | null;
  confidence: number;
  suggestedInvocation: string;
}

const DEFAULT_CONFIDENCE_THRESHOLD = 1.0;
const DEFAULT_K = 20;

export async function runWhere(rest: string[]): Promise<number> {
  let parsed: WhereArgs;
  try {
    parsed = parseWhereArgs(rest);
  } catch (err) {
    process.stderr.write(`kb where: ${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.topic === null) {
    process.stderr.write('kb where: missing --topic=<query>\n');
    return 2;
  }

  try {
    await FaissIndexManager.bootstrapLayout();
  } catch (err) {
    process.stderr.write(`kb where: layout bootstrap failed: ${(err as Error).message}\n`);
    return 1;
  }

  let activeModelId: string;
  try {
    activeModelId = await resolveActiveModel({ explicitOverride: parsed.model });
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      process.stderr.write(`kb where: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`kb where: ${(err as Error).message}\n`);
    return 1;
  }

  let manager: FaissIndexManager;
  try {
    manager = await loadManagerForModel(activeModelId);
  } catch (err) {
    process.stderr.write(`kb where: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    await loadWithJsonRetry(manager);
  } catch (err) {
    process.stderr.write(`kb where: ${(err as Error).message}\n`);
    return 1;
  }

  let results: ScoredDocument[];
  try {
    // No `--kb=` filter — we want the cross-KB ranking.
    results = await manager.similaritySearch(
      parsed.topic,
      parsed.k,
      Number.POSITIVE_INFINITY,
    );
  } catch (err) {
    process.stderr.write(`kb where: ${(err as Error).message}\n`);
    return 1;
  }

  const decision = decideWhere(results, parsed.threshold);
  if (decision === null) {
    if (parsed.format === 'json') {
      process.stdout.write(`${JSON.stringify({ recommended_kb: null, results: [] }, null, 2)}\n`);
    } else {
      process.stdout.write(
        '_No similar notes found. Run `kb search --refresh` if the index is empty or stale._\n',
      );
    }
    return 0;
  }

  if (parsed.format === 'json') {
    process.stdout.write(`${JSON.stringify(toJsonShape(decision), null, 2)}\n`);
  } else {
    process.stdout.write(formatWhereMarkdown(decision));
    process.stdout.write('\n');
  }
  return 0;
}

export function parseWhereArgs(rest: string[]): WhereArgs {
  const out: WhereArgs = {
    topic: null,
    threshold: DEFAULT_CONFIDENCE_THRESHOLD,
    k: DEFAULT_K,
    format: 'md',
  };
  for (const raw of rest) {
    if (raw === '--help' || raw === '-h') {
      throw new Error(
        'usage: kb where --topic=<query> [--threshold=<float>] [--k=<int>] [--format=md|json] [--model=<id>]',
      );
    }
    if (raw.startsWith('--topic=')) {
      const v = raw.slice('--topic='.length);
      if (v.length === 0) throw new Error('--topic=<query> requires a non-empty value');
      out.topic = v;
      continue;
    }
    if (raw.startsWith('--model=')) {
      out.model = raw.slice('--model='.length);
      continue;
    }
    if (raw.startsWith('--threshold=')) {
      const n = Number(raw.slice('--threshold='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --threshold: ${raw}`);
      out.threshold = n;
      continue;
    }
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = n;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v !== 'md' && v !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = v;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  return out;
}

/**
 * Reduces a flat list of cross-KB search results to a single recommendation.
 *
 * Returns `null` when `results` is empty or no result has a usable
 * `metadata.knowledgeBase` field (defensive — should not happen in practice
 * since FaissIndexManager always stamps it).
 *
 * Lower score = closer match (FAISS L2 distance). The "best" hit is the one
 * with the lowest score; the "best file" within that KB is the lowest-scoring
 * result whose `relativePath` is set.
 */
export function decideWhere(
  results: readonly ScoredDocument[],
  confidenceThreshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): WhereDecision | null {
  if (results.length === 0) return null;

  let bestKb: string | null = null;
  let bestKbScore = Number.POSITIVE_INFINITY;
  for (const r of results) {
    const kb = readKb(r);
    if (kb === null) continue;
    const score = r.score ?? Number.POSITIVE_INFINITY;
    if (score < bestKbScore) {
      bestKbScore = score;
      bestKb = kb;
    }
  }
  if (bestKb === null) return null;

  let bestFile: string | null = null;
  let bestFileScore = Number.POSITIVE_INFINITY;
  for (const r of results) {
    if (readKb(r) !== bestKb) continue;
    const rel = readRelativePath(r);
    if (rel === null) continue;
    const score = r.score ?? Number.POSITIVE_INFINITY;
    if (score < bestFileScore) {
      bestFileScore = score;
      bestFile = rel;
    }
  }

  const confident = bestFile !== null && bestFileScore < confidenceThreshold;
  return {
    recommendedKb: bestKb,
    existingTarget: confident ? bestFile : null,
    confidence: confident ? bestFileScore : bestKbScore,
    suggestedInvocation: confident
      ? buildAppendInvocation(bestKb, bestFile as string)
      : buildCreateInvocation(bestKb),
  };
}

function readKb(r: ScoredDocument): string | null {
  const v = (r.metadata as Record<string, unknown> | undefined)?.knowledgeBase;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readRelativePath(r: ScoredDocument): string | null {
  const v = (r.metadata as Record<string, unknown> | undefined)?.relativePath;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function buildAppendInvocation(kb: string, relPath: string): string {
  return (
    `kb remember --kb=${kb} \\\n` +
    `             --append=${relPath} \\\n` +
    `             --stdin --yes`
  );
}

function buildCreateInvocation(kb: string): string {
  return `kb remember --kb=${kb} --title=<title> --stdin --yes`;
}

export function formatWhereMarkdown(d: WhereDecision): string {
  const target = d.existingTarget ?? '_(none — suggest creating a new note)_';
  const conf = d.confidence.toFixed(2);
  const confLabel = d.existingTarget !== null ? 'high' : 'low';
  return (
    `Recommended KB:        ${d.recommendedKb}\n` +
    `Existing target:       ${target}\n` +
    `Confidence:            ${conf} (${confLabel}; lower distance = closer match)\n` +
    `Suggested invocation:  ${d.suggestedInvocation}`
  );
}

function toJsonShape(d: WhereDecision): Record<string, unknown> {
  return {
    recommended_kb: d.recommendedKb,
    existing_target: d.existingTarget,
    confidence: d.confidence,
    suggested_invocation: d.suggestedInvocation,
  };
}
