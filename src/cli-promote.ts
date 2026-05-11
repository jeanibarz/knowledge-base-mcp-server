// `kb promote` — positive memory-tier promotion workflow (issue #245).
//
// Complements `kb superseded` (which finds notes to retire): this command
// reviews a candidate note and, after explicit operator confirmation,
// updates lifecycle frontmatter (`tier`, `review_status`, `confidence`,
// `last_verified_at`). Default mode is a read-only dry-run; the file is
// rewritten only when the operator supplies `--yes`.
//
// Two surfaces, never combined:
//   - List mode:    --query=<topic> -> ranked candidates + lifecycle fields.
//   - Apply mode:   --path=<rel.md> [--tier=... --review-status=... etc].
//
// Heavy mutation is delegated to `rewriteFileAtomically` (same atomic
// temp-file fsync + rename used by `kb remember --append-section`).

import * as fsp from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';
import {
  ActiveModelResolutionError,
  resolveActiveModel,
  resolveFaissIndexBinaryPath,
} from './active-model.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import { rewriteFileAtomically } from './file-mutation.js';
import { parseFrontmatter } from './frontmatter.js';
import { liftFrontmatter, type LiftedFrontmatter } from './frontmatter-lift.js';
import { assertNoTraversal, resolveKbPath, resolveKnowledgeBaseDir } from './kb-fs.js';
import type { ScoredDocument } from './formatter.js';

export const PROMOTE_HELP = `kb promote — review and update lifecycle frontmatter for KB notes

Usage:
  # List mode (read-only): rank notes by topic and show lifecycle metadata.
  kb promote --kb=<name> --query=<topic> [--k=<int>] [--format=md|json]
             [--model=<id>]

  # Apply mode: preview proposed frontmatter changes for one note.
  # The file is rewritten ONLY when --yes is supplied; default is dry-run.
  kb promote --kb=<name> --path=<rel.md>
             [--tier=working|validated|wisdom]
             [--review-status=approved|needs-review]
             [--confidence=<0..1>]
             [--last-verified-at=<YYYY-MM-DD|now>]
             [--format=md|json] [--yes]

Required:
  --kb=<name>                Knowledge base under KNOWLEDGE_BASES_ROOT_DIR.

List mode:
  --query=<topic>            Topic to rank candidate notes by. Uses the same
                             semantic index as \`kb search\`/\`kb where\`.
  --k=<int>                  Top-K candidates to display (default 5).

Apply mode:
  --path=<rel.md>            KB-relative markdown file to review (no
                             traversal, no absolute paths).
  --tier=<value>             New lifecycle tier. Controlled vocabulary:
                             working, validated, wisdom.
  --review-status=<value>    New review status. Controlled vocabulary:
                             approved, needs-review.
  --confidence=<float>       Operator-supplied confidence in [0, 1].
  --last-verified-at=<date>  ISO date (YYYY-MM-DD) or the literal "now"
                             (replaced with today's UTC date).
  --yes                      Required to write. Without it the command runs
                             a dry-run that prints before/after frontmatter
                             and exits 0.

Common:
  --format=md|json           Output format (default md).
  --model=<id>               Override the active embedding model (RFC 013).
  --help, -h                 Show this help.

Examples:
  kb promote --kb=ops --query="canonical retry policy"
  kb promote --kb=ops --path=patterns/retry.md --tier=validated --confidence=0.8
  kb promote --kb=ops --path=patterns/retry.md --tier=wisdom \\
             --review-status=approved --last-verified-at=now --yes

Notes:
  - This is a single-file workflow. Bulk promotion is intentionally
    excluded from v1.
  - YAML frontmatter is re-emitted via js-yaml; comments and exact
    formatting are not preserved (the body below the closing \`---\` is
    byte-identical).
`;

export const PROMOTE_TIERS = ['working', 'validated', 'wisdom'] as const;
export type PromoteTier = (typeof PROMOTE_TIERS)[number];

export const PROMOTE_REVIEW_STATUSES = ['approved', 'needs-review'] as const;
export type PromoteReviewStatus = (typeof PROMOTE_REVIEW_STATUSES)[number];

export interface PromoteArgs {
  kb: string;
  format: 'md' | 'json';
  yes: boolean;
  model?: string;
  // List mode
  query?: string;
  k: number;
  // Apply mode
  path?: string;
  tier?: PromoteTier;
  reviewStatus?: PromoteReviewStatus;
  confidence?: number;
  lastVerifiedAt?: string; // ISO date or literal "now"
}

export interface PromoteUpdates {
  tier?: PromoteTier;
  review_status?: PromoteReviewStatus;
  confidence?: number;
  last_verified_at?: string;
}

const DEFAULT_K = 5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Argument parsing & validation
// ---------------------------------------------------------------------------

export function parsePromoteArgs(rest: string[]): PromoteArgs {
  const out: PromoteArgs = {
    kb: '',
    format: 'md',
    yes: false,
    k: DEFAULT_K,
  };
  for (const raw of rest) {
    if (raw === '--yes') { out.yes = true; continue; }
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
    if (raw.startsWith('--query=')) {
      const v = raw.slice('--query='.length);
      if (v.length === 0) throw new Error('--query=<topic> requires a non-empty value');
      out.query = v;
      continue;
    }
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = n;
      continue;
    }
    if (raw.startsWith('--path=')) {
      const v = raw.slice('--path='.length);
      if (v.length === 0) throw new Error('--path=<rel.md> requires a non-empty value');
      out.path = v;
      continue;
    }
    if (raw.startsWith('--tier=')) {
      const v = raw.slice('--tier='.length);
      if (!isPromoteTier(v)) {
        throw new Error(
          `invalid --tier: ${JSON.stringify(v)} (allowed: ${PROMOTE_TIERS.join(', ')})`,
        );
      }
      out.tier = v;
      continue;
    }
    if (raw.startsWith('--review-status=')) {
      const v = raw.slice('--review-status='.length);
      if (!isReviewStatus(v)) {
        throw new Error(
          `invalid --review-status: ${JSON.stringify(v)} (allowed: ${PROMOTE_REVIEW_STATUSES.join(', ')})`,
        );
      }
      out.reviewStatus = v;
      continue;
    }
    if (raw.startsWith('--confidence=')) {
      const value = raw.slice('--confidence='.length);
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new Error(`invalid --confidence: ${JSON.stringify(value)} (must be a number in [0, 1])`);
      }
      out.confidence = n;
      continue;
    }
    if (raw.startsWith('--last-verified-at=')) {
      const value = raw.slice('--last-verified-at='.length);
      if (value.length === 0) {
        throw new Error('--last-verified-at requires a value (ISO date or "now")');
      }
      if (value !== 'now' && !DATE_RE.test(value)) {
        throw new Error(
          `invalid --last-verified-at: ${JSON.stringify(value)} (expected YYYY-MM-DD or "now")`,
        );
      }
      out.lastVerifiedAt = value;
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
  validatePromoteMode(out);
  return out;
}

function validatePromoteMode(args: PromoteArgs): void {
  const hasList = args.query !== undefined;
  const hasApply = args.path !== undefined;
  if (hasList && hasApply) {
    throw new Error('--query and --path are mutually exclusive (list vs apply mode)');
  }
  if (!hasList && !hasApply) {
    throw new Error('missing --query=<topic> (list mode) or --path=<rel.md> (apply mode)');
  }
  if (hasList) {
    if (args.tier !== undefined || args.reviewStatus !== undefined ||
        args.confidence !== undefined || args.lastVerifiedAt !== undefined) {
      throw new Error('--query (list mode) cannot be combined with --tier/--review-status/--confidence/--last-verified-at');
    }
    if (args.yes) {
      throw new Error('--query (list mode) is read-only; --yes has no effect');
    }
    return;
  }
  // apply mode
  if (args.tier === undefined && args.reviewStatus === undefined &&
      args.confidence === undefined && args.lastVerifiedAt === undefined) {
    throw new Error(
      '--path requires at least one of --tier, --review-status, --confidence, --last-verified-at',
    );
  }
}

function isPromoteTier(value: string): value is PromoteTier {
  return (PROMOTE_TIERS as readonly string[]).includes(value);
}

function isReviewStatus(value: string): value is PromoteReviewStatus {
  return (PROMOTE_REVIEW_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Frontmatter rewrite (pure)
// ---------------------------------------------------------------------------

export interface FrontmatterRewriteResult {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed: string[];
  newContent: string;
}

/**
 * Pure rewrite: takes the original file content, applies `updates` to the
 * YAML frontmatter (creating it if absent), and returns both the new
 * content and a before/after diff summary. The body below the closing
 * `---` is preserved byte-for-byte; YAML formatting is normalized by
 * js-yaml on the way out.
 */
export function applyFrontmatterUpdates(
  originalContent: string,
  updates: PromoteUpdates,
): FrontmatterRewriteResult {
  const parsed = parseFrontmatter(originalContent);
  const before: Record<string, unknown> = { ...parsed.frontmatter };

  // parseFrontmatter returns `body === originalContent` when no fence was
  // consumed (no opening fence, missing close, or malformed YAML). In that
  // case we emit a brand-new fence rather than rewrite one in place.
  const hasFence = parsed.body !== originalContent;

  const after: Record<string, unknown> = { ...before };
  const changed: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (!isEqual(after[key], value)) {
      changed.push(key);
    }
    after[key] = value;
  }

  const body = hasFence ? parsed.body : originalContent;
  const newContent = serializeWithFrontmatter(after, body);
  return { before, after, changed, newContent };
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return false;
}

function serializeWithFrontmatter(fm: Record<string, unknown>, body: string): string {
  // js-yaml.dump always ends with a trailing newline; the leading `---\n`
  // and trailing `---\n` form the fence. `body` comes from parseFrontmatter
  // (or is the whole original file when there was no fence), so its
  // leading whitespace already reflects the author's intended spacing
  // between fence and content — concat directly.
  const dumped = yaml.dump(fm, {
    sortKeys: false,
    lineWidth: 0, // never wrap so single-line values stay readable
    noRefs: true,
  });
  return `---\n${dumped}---\n${body}`;
}

// ---------------------------------------------------------------------------
// Apply mode (dry-run + file mutation)
// ---------------------------------------------------------------------------

export interface PromoteApplyOptions {
  rootDir: string;
  kb: string;
  relativePath: string;
  updates: PromoteUpdates;
  apply: boolean; // false = dry-run, true = write
  now?: Date;
}

export interface PromoteApplyResult {
  kb: string;
  relativePath: string;
  applied: boolean;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed: string[];
}

export async function promoteApply(opts: PromoteApplyOptions): Promise<PromoteApplyResult> {
  assertNoTraversal(opts.relativePath);
  const documentPath = await resolveKbPath(
    opts.rootDir,
    opts.kb,
    opts.relativePath,
    { mustExist: true },
  );
  const stat = await fsp.stat(documentPath);
  if (!stat.isFile()) {
    throw new Error(`promote target is not a file: ${JSON.stringify(opts.relativePath)}`);
  }

  const updates = materializeUpdates(opts.updates, opts.now ?? new Date());

  // Read once for dry-run preview; rewriteFileAtomically re-reads under the
  // mutation lock for the actual write so concurrent edits are caught there.
  const original = await fsp.readFile(documentPath, 'utf-8');
  const preview = applyFrontmatterUpdates(original, updates);

  if (opts.apply && preview.changed.length > 0) {
    await rewriteFileAtomically(documentPath, (current) =>
      applyFrontmatterUpdates(current, updates).newContent,
    );
  }

  const kbDir = await resolveKnowledgeBaseDir(opts.rootDir, opts.kb);
  const relPath = path.relative(kbDir, documentPath).split(path.sep).join('/');
  return {
    kb: opts.kb,
    relativePath: relPath,
    applied: opts.apply && preview.changed.length > 0,
    before: preview.before,
    after: preview.after,
    changed: preview.changed,
  };
}

function materializeUpdates(updates: PromoteUpdates, now: Date): PromoteUpdates {
  if (updates.last_verified_at !== 'now') return updates;
  const iso = now.toISOString().slice(0, 10);
  return { ...updates, last_verified_at: iso };
}

// ---------------------------------------------------------------------------
// List mode (read-only candidate discovery)
// ---------------------------------------------------------------------------

export type SemanticCandidateSearcher = (
  query: string,
  k: number,
  kb: string,
) => Promise<ScoredDocument[]>;

export interface PromoteCandidate {
  relativePath: string;
  score: number;
  excerpt: string;
  frontmatter: RelevantFrontmatter;
}

export interface PromoteListReport {
  kb: string;
  query: string;
  generatedAt: string;
  candidates: PromoteCandidate[];
}

export type RelevantFrontmatter = Pick<
  LiftedFrontmatter,
  'title' | 'tier' | 'status' | 'review_status' | 'confidence' | 'last_verified_at'
>;

export interface PromoteListOptions {
  kb: string;
  query: string;
  k: number;
  now?: Date;
  semanticSearcher: SemanticCandidateSearcher;
}

export async function promoteListCandidates(
  opts: PromoteListOptions,
): Promise<PromoteListReport> {
  const raw = await opts.semanticSearcher(opts.query, opts.k, opts.kb);
  // De-dup by relative path (chunks from the same file may appear multiple
  // times in semantic results); first occurrence wins (best score).
  const seen = new Set<string>();
  const candidates: PromoteCandidate[] = [];
  for (const result of raw) {
    const metadata = (result.metadata ?? {}) as Record<string, unknown>;
    const relPath = readRelativePath(metadata, opts.kb);
    if (relPath === null || seen.has(relPath)) continue;
    seen.add(relPath);
    candidates.push({
      relativePath: relPath,
      score: typeof result.score === 'number' ? result.score : Number.NaN,
      excerpt: truncateExcerpt(result.pageContent),
      frontmatter: pickRelevantFrontmatter(metadata.frontmatter),
    });
    if (candidates.length >= opts.k) break;
  }
  return {
    kb: opts.kb,
    query: opts.query,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    candidates,
  };
}

function readRelativePath(metadata: Record<string, unknown>, kb: string): string | null {
  const raw = metadata.relativePath;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const prefix = `${kb}/`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function pickRelevantFrontmatter(input: unknown): RelevantFrontmatter {
  if (!input || typeof input !== 'object') return {};
  const lifted = input as LiftedFrontmatter;
  const out: RelevantFrontmatter = {};
  for (const key of ['title', 'tier', 'status', 'review_status', 'confidence', 'last_verified_at'] as const) {
    const value = lifted[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function truncateExcerpt(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function formatPromoteListMarkdown(report: PromoteListReport): string {
  const lines: string[] = [
    '## Promote — Candidate Review',
    '',
    `Knowledge base: \`${report.kb}\``,
    `Query: \`${report.query}\``,
    `Generated: ${report.generatedAt}`,
    `Candidates: ${report.candidates.length}`,
    '',
  ];
  if (report.candidates.length === 0) {
    lines.push('_No candidates found. Run `kb search --refresh` if the index is empty or stale._');
    return lines.join('\n');
  }
  for (const c of report.candidates) {
    lines.push(`### \`${c.relativePath}\``);
    lines.push(`Score: ${Number.isFinite(c.score) ? c.score.toFixed(4) : 'n/a'} (lower = closer match)`);
    if (Object.keys(c.frontmatter).length > 0) {
      lines.push('');
      lines.push('Lifecycle:');
      lines.push('```json');
      lines.push(JSON.stringify(c.frontmatter, null, 2));
      lines.push('```');
    }
    if (c.excerpt.length > 0) {
      lines.push('');
      lines.push(`Excerpt: ${c.excerpt}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatPromoteListJson(report: PromoteListReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatPromoteApplyMarkdown(result: PromoteApplyResult): string {
  const heading = result.applied ? 'applied' : (result.changed.length === 0 ? 'no-op' : 'dry-run');
  const lines: string[] = [
    `## Promote — \`${result.relativePath}\` (${heading})`,
    '',
    `Knowledge base: \`${result.kb}\``,
    `Changed keys: ${result.changed.length > 0 ? result.changed.join(', ') : 'none'}`,
    '',
    'Before:',
    '```json',
    JSON.stringify(result.before, null, 2),
    '```',
    '',
    'After:',
    '```json',
    JSON.stringify(result.after, null, 2),
    '```',
  ];
  if (!result.applied && result.changed.length > 0) {
    lines.push('');
    lines.push('_Dry-run: re-run with `--yes` to write._');
  }
  return lines.join('\n');
}

export function formatPromoteApplyJson(result: PromoteApplyResult): string {
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Argv handler
// ---------------------------------------------------------------------------

export async function runPromote(rest: string[]): Promise<number> {
  let parsed: PromoteArgs;
  try {
    parsed = parsePromoteArgs(rest);
  } catch (err) {
    process.stderr.write(`kb promote: ${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.query !== undefined) {
    return runPromoteList(parsed);
  }
  return runPromoteApply(parsed);
}

async function runPromoteList(args: PromoteArgs): Promise<number> {
  const semanticSearcher = await buildSemanticSearcher(args);
  if (semanticSearcher === null) return 1;
  try {
    const report = await promoteListCandidates({
      kb: args.kb,
      query: args.query as string,
      k: args.k,
      semanticSearcher,
    });
    process.stdout.write(
      args.format === 'json'
        ? formatPromoteListJson(report)
        : formatPromoteListMarkdown(report),
    );
    process.stdout.write('\n');
    return 0;
  } catch (err) {
    process.stderr.write(`kb promote: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runPromoteApply(args: PromoteArgs): Promise<number> {
  try {
    const result = await promoteApply({
      rootDir: KNOWLEDGE_BASES_ROOT_DIR,
      kb: args.kb,
      relativePath: args.path as string,
      updates: {
        tier: args.tier,
        review_status: args.reviewStatus,
        confidence: args.confidence,
        last_verified_at: args.lastVerifiedAt,
      },
      apply: args.yes,
    });
    process.stdout.write(
      args.format === 'json'
        ? formatPromoteApplyJson(result)
        : formatPromoteApplyMarkdown(result),
    );
    process.stdout.write('\n');
    return 0;
  } catch (err) {
    process.stderr.write(`kb promote: ${(err as Error).message}\n`);
    return 1;
  }
}

async function buildSemanticSearcher(
  args: PromoteArgs,
): Promise<SemanticCandidateSearcher | null> {
  try {
    await FaissIndexManager.bootstrapLayout();
  } catch (err) {
    process.stderr.write(`kb promote: layout bootstrap failed: ${(err as Error).message}\n`);
    return null;
  }
  let activeModelId: string;
  try {
    activeModelId = await resolveActiveModel({ explicitOverride: args.model });
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      process.stderr.write(`kb promote: ${err.message}\n`);
      return null;
    }
    process.stderr.write(`kb promote: ${(err as Error).message}\n`);
    return null;
  }

  const indexPath = await resolveFaissIndexBinaryPath(activeModelId);
  if (indexPath === null) {
    process.stderr.write(
      `kb promote: no existing FAISS index for model "${activeModelId}"; run kb search --refresh first\n`,
    );
    return null;
  }

  const manager = await loadManagerForModel(activeModelId);
  try {
    await loadWithJsonRetry(manager);
  } catch (err) {
    process.stderr.write(`kb promote: ${(err as Error).message}\n`);
    return null;
  }
  return (query, k, kb) => manager.similaritySearch(
    query,
    Math.max(k * 4, 20),
    Number.POSITIVE_INFINITY,
    kb,
    { extensions: ['.md', '.markdown'] },
  );
}
