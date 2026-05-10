// `kb superseded` — read-only review workflow for obsolete, contradicted, or
// superseded markdown notes (issue #232).

import * as fsp from 'fs/promises';
import * as path from 'path';
import { FaissIndexManager } from './FaissIndexManager.js';
import { resolveActiveModel } from './active-model.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { getFilesRecursively } from './file-utils.js';
import { parseFrontmatter } from './frontmatter.js';
import { liftFrontmatter, type LiftedFrontmatter } from './frontmatter-lift.js';
import { resolveKnowledgeBaseDir } from './kb-fs.js';
import type { ScoredDocument } from './formatter.js';

export type SupersededReason =
  | 'explicit_contradiction'
  | 'deprecated_status'
  | 'stale_last_verified_at'
  | 'low_confidence_active_note'
  | 'newer_near_neighbor';

export type SupersededEvidenceReason = 'newer_or_stronger_neighbor';

export interface SupersededArgs {
  kb: string;
  format: 'md' | 'json';
  k: number;
  includeClean: boolean;
  model?: string;
}

export interface SupersededNote {
  kb: string;
  relPath: string;
  absolutePath: string;
  body: string;
  frontmatter: RelevantFrontmatter;
  noteDate: Date;
}

export type SemanticNeighborSearcher = (
  note: SupersededNote,
  k: number,
) => Promise<ScoredDocument[]>;

export interface SupersededEvidence {
  path: string;
  score: number;
  newer_by_days?: number;
  reason: SupersededEvidenceReason;
}

export type RelevantFrontmatter = Pick<
  LiftedFrontmatter,
  | 'title'
  | 'status'
  | 'review_status'
  | 'contradicted_by'
  | 'confidence'
  | 'last_verified_at'
  | 'ingested_at'
  | 'published'
>;

export interface SupersededCandidate {
  candidate: string;
  reasons: SupersededReason[];
  evidence: SupersededEvidence[];
  frontmatter: RelevantFrontmatter;
  suggested_action: string;
}

export interface SupersededReport {
  kb: string;
  generatedAt: string;
  totals: {
    filesScanned: number;
    candidates: number;
    clean: number;
  };
  candidates: SupersededCandidate[];
}

export interface SupersededCheckOptions {
  rootDir: string;
  kb: string;
  k: number;
  includeClean: boolean;
  now?: Date;
  staleDays?: number;
  lowConfidenceThreshold?: number;
  semanticSearcher?: SemanticNeighborSearcher;
}

const DEFAULT_K = 5;
const DEFAULT_STALE_DAYS = 180;
const DEFAULT_LOW_CONFIDENCE = 0.5;
const SEMANTIC_DISTANCE_THRESHOLD = 1.0;
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const DEPRECATED_STATUS_RE = /^(archived|deprecated|dormant|obsolete|retired|stale|superseded)$/i;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function runSuperseded(rest: string[]): Promise<number> {
  let parsed: SupersededArgs;
  try {
    parsed = parseSupersededArgs(rest);
  } catch (err) {
    process.stderr.write(`kb superseded: ${(err as Error).message}\n`);
    return 2;
  }

  const semanticSearcher = await buildSemanticSearcher(parsed);

  try {
    const report = await supersededCheck({
      rootDir: KNOWLEDGE_BASES_ROOT_DIR,
      kb: parsed.kb,
      k: parsed.k,
      includeClean: parsed.includeClean,
      semanticSearcher,
    });
    process.stdout.write(
      parsed.format === 'json'
        ? formatSupersededJson(report)
        : formatSupersededMarkdown(report),
    );
    process.stdout.write('\n');
    return 0;
  } catch (err) {
    process.stderr.write(`kb superseded: ${(err as Error).message}\n`);
    return 1;
  }
}

export function parseSupersededArgs(rest: string[]): SupersededArgs {
  const out: SupersededArgs = {
    kb: '',
    format: 'md',
    k: DEFAULT_K,
    includeClean: false,
  };
  for (const raw of rest) {
    if (raw === '--help' || raw === '-h') {
      throw new Error(
        'usage: kb superseded --kb=<name> [--format=md|json] [--k=<int>] [--include-clean] [--model=<id>]',
      );
    }
    if (raw === '--include-clean') {
      out.includeClean = true;
      continue;
    }
    if (raw.startsWith('--kb=')) {
      out.kb = raw.slice('--kb='.length);
      if (out.kb.length === 0) throw new Error('--kb=<name> requires a non-empty value');
      continue;
    }
    if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v !== 'md' && v !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = v;
      continue;
    }
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = n;
      continue;
    }
    if (raw.startsWith('--model=')) {
      const v = raw.slice('--model='.length);
      if (v.length === 0) throw new Error('--model=<id> requires a non-empty value');
      out.model = v;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  if (out.kb.length === 0) throw new Error('missing --kb=<name>');
  return out;
}

export async function supersededCheck(opts: SupersededCheckOptions): Promise<SupersededReport> {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const lowConfidenceThreshold = opts.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE;
  const kbDir = await resolveKnowledgeBaseDir(opts.rootDir, opts.kb);
  const markdownFiles = (await getFilesRecursively(kbDir))
    .filter((filePath) => MARKDOWN_EXTS.has(path.extname(filePath).toLowerCase()))
    .sort();

  const candidates: SupersededCandidate[] = [];
  let clean = 0;

  for (const filePath of markdownFiles) {
    const note = await readNote(kbDir, opts.kb, filePath);
    const reasons = detectLifecycleReasons(note.frontmatter, now, staleDays, lowConfidenceThreshold);
    const evidence = opts.semanticSearcher !== undefined
      ? await collectSemanticEvidence(note, opts.k, opts.semanticSearcher)
      : [];
    if (evidence.length > 0 && !reasons.includes('newer_near_neighbor')) {
      reasons.push('newer_near_neighbor');
    }

    const reportable = reasons.length > 0 || opts.includeClean;
    if (!reportable) {
      clean += 1;
      continue;
    }
    if (reasons.length === 0) clean += 1;
    candidates.push({
      candidate: note.relPath,
      reasons,
      evidence,
      frontmatter: note.frontmatter,
      suggested_action: reasons.length === 0
        ? 'no action suggested'
        : 'review candidate and consider status=deprecated or contradicted_by',
    });
  }

  return {
    kb: opts.kb,
    generatedAt: now.toISOString(),
    totals: {
      filesScanned: markdownFiles.length,
      candidates: candidates.filter((c) => c.reasons.length > 0).length,
      clean,
    },
    candidates,
  };
}

export function formatSupersededJson(report: SupersededReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatSupersededMarkdown(report: SupersededReport): string {
  const lines: string[] = [
    '## Superseded Review',
    '',
    `Knowledge base: \`${report.kb}\``,
    `Generated: ${report.generatedAt}`,
    `Summary: ${report.totals.candidates} candidate(s), ${report.totals.clean} clean note(s), ${report.totals.filesScanned} file(s) scanned.`,
    '',
  ];

  if (report.candidates.length === 0) {
    lines.push('_No superseded candidates found._');
    return lines.join('\n');
  }

  for (const candidate of report.candidates) {
    lines.push(`### \`${candidate.candidate}\``);
    lines.push(`Reasons: ${candidate.reasons.length > 0 ? candidate.reasons.join(', ') : 'none'}`);
    lines.push(`Suggested action: ${candidate.suggested_action}`);
    if (Object.keys(candidate.frontmatter).length > 0) {
      lines.push('');
      lines.push('Frontmatter:');
      lines.push('```json');
      lines.push(JSON.stringify(candidate.frontmatter, null, 2));
      lines.push('```');
    }
    if (candidate.evidence.length > 0) {
      lines.push('');
      lines.push('Evidence:');
      for (const evidence of candidate.evidence) {
        const newer = evidence.newer_by_days !== undefined
          ? `, newer_by_days=${evidence.newer_by_days}`
          : '';
        lines.push(`- \`${evidence.path}\` score=${evidence.score}${newer} (${evidence.reason})`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

async function buildSemanticSearcher(args: SupersededArgs): Promise<SemanticNeighborSearcher | undefined> {
  try {
    await FaissIndexManager.bootstrapLayout();
    const activeModelId = await resolveActiveModel({ explicitOverride: args.model });
    const manager = await loadManagerForModel(activeModelId);
    await loadWithJsonRetry(manager);
    return (note, k) => manager.similaritySearch(
      buildSemanticQuery(note),
      k + 1,
      SEMANTIC_DISTANCE_THRESHOLD,
      args.kb,
      { extensions: ['.md', '.markdown'] },
    );
  } catch (err) {
    process.stderr.write(
      `kb superseded: semantic neighbor scan skipped: ${(err as Error).message}\n`,
    );
    return undefined;
  }
}

async function readNote(kbDir: string, kb: string, filePath: string): Promise<SupersededNote> {
  const content = await fsp.readFile(filePath, 'utf-8');
  const stat = await fsp.stat(filePath);
  const parsed = parseFrontmatter(content);
  const lifted = liftFrontmatter(parsed.frontmatter, filePath);
  const frontmatter = pickRelevantFrontmatter(lifted);
  return {
    kb,
    relPath: path.relative(kbDir, filePath).split(path.sep).join('/'),
    absolutePath: filePath,
    body: parsed.body,
    frontmatter,
    noteDate: bestDate(frontmatter) ?? stat.mtime,
  };
}

function detectLifecycleReasons(
  frontmatter: RelevantFrontmatter,
  now: Date,
  staleDays: number,
  lowConfidenceThreshold: number,
): SupersededReason[] {
  const reasons: SupersededReason[] = [];
  if ((frontmatter.contradicted_by?.length ?? 0) > 0) {
    reasons.push('explicit_contradiction');
  }
  if (hasDeprecatedStatus(frontmatter)) {
    reasons.push('deprecated_status');
  }
  const verified = parseDate(frontmatter.last_verified_at);
  if (verified !== null && now.getTime() - verified.getTime() >= staleDays * MS_PER_DAY) {
    reasons.push('stale_last_verified_at');
  }
  if (
    typeof frontmatter.confidence === 'number' &&
    frontmatter.confidence < lowConfidenceThreshold &&
    !hasDeprecatedStatus(frontmatter)
  ) {
    reasons.push('low_confidence_active_note');
  }
  return reasons;
}

async function collectSemanticEvidence(
  note: SupersededNote,
  k: number,
  searcher: SemanticNeighborSearcher,
): Promise<SupersededEvidence[]> {
  const raw = await searcher(note, k);
  const evidence: SupersededEvidence[] = [];
  for (const result of raw) {
    const relPath = readResultRelativePath(result, note.kb);
    if (relPath === null || relPath === note.relPath) continue;
    const metadata = result.metadata as Record<string, unknown> | undefined;
    if (metadata?.knowledgeBase !== note.kb) continue;
    const frontmatter = readResultFrontmatter(metadata);
    const neighborDate = bestDate(frontmatter);
    const newerByDays = neighborDate !== null
      ? Math.floor((neighborDate.getTime() - note.noteDate.getTime()) / MS_PER_DAY)
      : undefined;
    const higherConfidence =
      typeof frontmatter.confidence === 'number' &&
      typeof note.frontmatter.confidence === 'number' &&
      frontmatter.confidence > note.frontmatter.confidence;
    const strongerLifecycle = !hasDeprecatedStatus(frontmatter) && hasDeprecatedStatus(note.frontmatter);
    const newer = newerByDays !== undefined && newerByDays > 0;
    if (!newer && !higherConfidence && !strongerLifecycle) continue;
    evidence.push({
      path: relPath,
      score: result.score ?? Number.NaN,
      ...(newerByDays !== undefined && newerByDays > 0 ? { newer_by_days: newerByDays } : {}),
      reason: 'newer_or_stronger_neighbor',
    });
    if (evidence.length >= k) break;
  }
  return evidence;
}

function buildSemanticQuery(note: SupersededNote): string {
  const title = note.frontmatter.title ?? '';
  const body = note.body.replace(/\s+/g, ' ').trim();
  const excerpt = body.length > 2000 ? body.slice(0, 2000) : body;
  return `${title}\n${excerpt}`.trim();
}

function pickRelevantFrontmatter(lifted: LiftedFrontmatter | undefined): RelevantFrontmatter {
  if (lifted === undefined) return {};
  const out: RelevantFrontmatter = {};
  for (const key of [
    'title',
    'status',
    'review_status',
    'contradicted_by',
    'confidence',
    'last_verified_at',
    'ingested_at',
    'published',
  ] as const) {
    const value = lifted[key];
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function readResultFrontmatter(metadata: Record<string, unknown> | undefined): RelevantFrontmatter {
  const fm = metadata?.frontmatter;
  if (!fm || typeof fm !== 'object') return {};
  return pickRelevantFrontmatter(fm as LiftedFrontmatter);
}

function readResultRelativePath(result: ScoredDocument, kb: string): string | null {
  const metadata = result.metadata as Record<string, unknown> | undefined;
  const raw = metadata?.relativePath;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const prefix = `${kb}/`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function hasDeprecatedStatus(frontmatter: RelevantFrontmatter): boolean {
  return [frontmatter.status, frontmatter.review_status]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => DEPRECATED_STATUS_RE.test(value.trim()));
}

function bestDate(frontmatter: RelevantFrontmatter): Date | null {
  return (
    parseDate(frontmatter.last_verified_at) ??
    parseDate(frontmatter.ingested_at) ??
    parseDate(frontmatter.published)
  );
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
