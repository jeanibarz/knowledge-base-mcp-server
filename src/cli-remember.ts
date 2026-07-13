import * as fsp from 'fs/promises';
import * as path from 'path';
import { ActiveModelResolutionError, resolveActiveModel } from './active-model.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { getFilesRecursively } from './file-utils.js';
import { filterIngestablePaths } from './ingest-filter.js';
import { assertNoTraversal, resolveKbPath, resolveKnowledgeBaseDir } from './kb-fs.js';
import { withSidecarLock, withWriteLock } from './write-lock.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import { appendSectionInDocument, listHeadings, parseHeadingSpec } from './markdown-section.js';
import {
  appendFileAtomically,
  atomicWriteFile,
  createFileAtomically,
  rewriteFileAtomically,
} from './file-mutation.js';
import {
  DEFAULT_SIMILAR_K,
  DEFAULT_SIMILAR_THRESHOLD,
  EXIT_BLOCKED_BY_SIMILARITY_GUARD,
  buildBlockedJson,
  candidatesFromResults,
  formatBlockedMarkdown,
  type SimilarCandidate,
} from './cli-remember-similarity.js';
import { slugifyTitle } from './slug.js';
import {
  auditEnabled,
  recordMutation,
  sha256OfFileOrNull,
  type MutationOperation,
  type RefreshStatus,
} from './audit-log.js';

export const REMEMBER_HELP = `kb remember — write or extend knowledge-base notes (conservative write path)

Usage:
  kb remember --suggest --kb=<name> --title=<title>
  kb remember --kb=<name> --title=<title> --stdin --yes
  kb remember --kb=<name> --append=<path> --stdin --yes
  kb remember --kb=<name> --append=<path> --append-section="<#level> <text>"
              [--occurrence=<N>] --stdin --yes
  kb remember --lesson --title=<title> --stdin --yes

Modes:
  --suggest             List likely existing note targets for the given title.
                        Does NOT read stdin and does NOT write note files.
                        May update a small .index heading cache.
  (no --suggest)        Create or append. Both require \`--stdin --yes\`.
                        Create uses a slugified \`.md\` filename and refuses
                        to overwrite. Append accepts only existing
                        KB-relative paths and rejects path traversal.

Targeting:
  --kb=<name>           Target knowledge base. Required (except with
                        \`--lesson\`, which defaults to \`agent-task-lessons\`).
  --title=<title>       Note title; create uses a slugified \`.md\` filename.
  --append=<path>       Existing KB-relative note path; rejects traversal.
                        EOF appends rewrite under a per-file lock with an
                        atomic temp-file fsync + rename.
  --append-section=<spec>
                        Heading-aware append target. Spec is "<#level> <text>"
                        (e.g. "## OSS gate flow"). Requires \`--append=<path>\`.
                        Inserts at the END of the named section (after every
                        subsection), atomically rewrites the file, and refuses
                        to fall back to EOF if the heading is missing.
  --occurrence=<N>      1-indexed disambiguation when the heading appears
                        multiple times. Requires \`--append-section\`.

Templates:
  --lesson              Apply the agent-task-lesson template: defaults
                        \`--kb\` to \`agent-task-lessons\`, validates that the
                        body has the H2 sections "## Mistake",
                        "## Why it happened", and "## Better next time".
                        On empty or malformed input, prints a guided
                        skeleton and exits 2 instead of writing.

Similarity preflight (default ON, RFC issue #154):
  --check-similar       Force the preflight ON (default). Surface
                        index-load failures as exit 1/2 errors instead of
                        degrading to a warning.
  --no-check-similar    Disable the preflight for this write.
  --similar-threshold=<float>
                        Max FAISS distance treated as related (default 1.0;
                        lower distance = closer match).
  --similar-k=<int>     Top-K candidate chunks to surface (default 5).
  --force               Override the similarity guard and write anyway.
                        The success response reports that the guard was
                        overridden so the action stays auditable.

Input / output:
  --stdin               Read note content from stdin. Required for writes.
  --yes                 Required for non-interactive writes.
  --refresh             Re-index the affected KB after a successful write.
  --format=md|json      Output format for similarity-guard reports
                        (default: json — agent-friendly machine-readable).
  --model=<id>          Override the active model for the preflight
                        similarity search (RFC 013).
  --help, -h            Show this help.

Exit codes:
  0   write succeeded (or --suggest produced suggestions)
  1   runtime / index error
  2   argv / template-validation error (e.g. \`--lesson\` missing sections)
  3   similarity preflight refused to write; rerun with --force to override.

Examples:
  kb remember --suggest --kb=work --title="Quarterly plan"
  printf '# Quarterly plan\\n\\n...' | \\
    kb remember --kb=work --title="Quarterly plan" --stdin --yes
  printf '\\nFollow-up.\\n' | \\
    kb remember --kb=work --append=quarterly-plan.md --stdin --yes
  cat lesson.md | kb remember --lesson --title="don't mock the DB" --stdin --yes
`;

interface RememberArgs {
  kb?: string;
  title?: string;
  append?: string;
  appendSection?: string;
  occurrence?: number;
  suggest: boolean;
  stdin: boolean;
  yes: boolean;
  refresh: boolean;
  /**
   * Issue #200 — `--lesson` opts the call into the agent-task-lesson
   * template. Defaults `--kb` to LESSON_DEFAULT_KB when not set, validates
   * that stdin has the three canonical sections (Mistake / Why it happened
   * / Better next time), and emits a guided skeleton when stdin is empty
   * or sections are missing — instead of writing a low-quality note.
   */
  lesson: boolean;
  /**
   * Whether the preflight semantic-similarity guard runs. Default ON
   * (issue #154 default-on decision). `--no-check-similar` opts out.
   */
  checkSimilar: boolean;
  /**
   * True iff the user explicitly passed `--check-similar` or
   * `--no-check-similar`. Distinguishes "I rely on this guard" from "the
   * default fired" so that an index-load failure can degrade to a stderr
   * warning in the implicit case (don't block fresh-install writes) but
   * exits non-zero when the user asked for the guard by name.
   */
  checkSimilarExplicit: boolean;
  similarThreshold: number;
  similarK: number;
  force: boolean;
  format: 'md' | 'json';
  model?: string;
}

/**
 * Default knowledge base for `--lesson` writes. The point of the flag is
 * to remove KB-name guesswork — agents should be able to write a lesson
 * without thinking about where it lands.
 */
const LESSON_DEFAULT_KB = 'agent-task-lessons';

/**
 * Required H2 sections in a lesson body. Match is case-insensitive,
 * trimmed, with trailing punctuation stripped, so `## Mistake:` and
 * `## Mistakes` count as the canonical "Mistake" section. The level
 * is enforced — `# Mistake` (H1) and `### Mistake` (H3) do NOT count,
 * because the skeleton, the docs, and downstream tooling all agree on
 * the H2 contract; a relaxed check would let lessons drift into
 * inconsistent shapes that break grep/anchor links over time.
 * Headings inside fenced code blocks never match — `listHeadings`
 * walks the markdown AST.
 */
const LESSON_HEADING_LEVEL = 2;
const REQUIRED_LESSON_SECTIONS: ReadonlyArray<{ canonical: string; aliases: ReadonlyArray<string> }> = [
  { canonical: 'Mistake', aliases: ['mistake', 'mistakes'] },
  { canonical: 'Why it happened', aliases: ['why it happened'] },
  { canonical: 'Better next time', aliases: ['better next time'] },
];

interface Suggestion {
  relativePath: string;
  score: number;
  label: string;
}

interface SuggestHeadingCacheEntry {
  relativePath: string;
  mtimeMs: number;
  size: number;
  firstHeading: string;
  pathTokens: string[];
}

interface SuggestHeadingCacheFile {
  schema_version: 'remember-suggest-heading-cache.v1';
  entries: Record<string, SuggestHeadingCacheEntry>;
}

interface SuggestHeadingCacheState {
  entries: Record<string, SuggestHeadingCacheEntry>;
  rebuild: boolean;
}

const SUGGEST_HEADING_CACHE_FILE = 'remember-suggest-heading-cache.json';
const SUGGEST_HEADING_CACHE_SCHEMA_VERSION = 'remember-suggest-heading-cache.v1';

export async function runRemember(rest: string[]): Promise<number> {
  let parsed: RememberArgs;
  try {
    parsed = parseRememberArgs(rest);
    validateRememberArgs(parsed);
  } catch (err) {
    process.stderr.write(`kb remember: ${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.suggest) {
    try {
      return await runSuggest(parsed.kb!, parsed.title!);
    } catch (err) {
      process.stderr.write(`kb remember: ${(err as Error).message}\n`);
      return 1;
    }
  }

  let content: string;
  try {
    content = await readAllStdin();
  } catch (err) {
    process.stderr.write(`kb remember: failed to read stdin: ${(err as Error).message}\n`);
    return 1;
  }

  if (parsed.lesson) {
    const validation = validateLessonContent(content);
    if (!validation.ok) {
      writeLessonValidationFailure(parsed, validation);
      return 2;
    }
    if (parsed.kb === LESSON_DEFAULT_KB) {
      try {
        await ensureLessonKbExists(parsed.kb);
      } catch (err) {
        process.stderr.write(`kb remember: ${(err as Error).message}\n`);
        return 1;
      }
    }
  }

  let preflight: PreflightOutcome | null = null;
  if (parsed.checkSimilar) {
    try {
      preflight = await runPreflight(content, parsed);
    } catch (err) {
      if (parsed.checkSimilarExplicit) {
        // User asked for the guard by name; surface the failure clearly.
        if (err instanceof ActiveModelResolutionError) {
          process.stderr.write(`kb remember: ${err.message}\n`);
          return 2;
        }
        process.stderr.write(
          `kb remember: similarity preflight failed: ${(err as Error).message}\n` +
          `Hint: run \`kb search --refresh\` to rebuild the index, or \`kb models add ...\` if no model is registered.\n`,
        );
        return 1;
      }
      // Default-on path: an unconfigured / stale / missing index must not
      // block a write the user did not gate on the guard. Warn and proceed.
      process.stderr.write(
        `kb remember: similarity guard skipped (${(err as Error).message}). ` +
        `Run \`kb search --refresh\` or \`kb models add ...\` to enable preflight, ` +
        `or pass --no-check-similar to silence this notice.\n`,
      );
      preflight = null;
    }

    if (preflight !== null && preflight.candidates.length > 0 && !parsed.force) {
      writeBlockedOutput(parsed, preflight);
      return EXIT_BLOCKED_BY_SIMILARITY_GUARD;
    }
  }

  const auditing = auditEnabled();
  const planned: MutationOperation =
    parsed.appendSection !== undefined ? 'append-section'
    : parsed.append !== undefined ? 'append'
    : 'create';
  const expectedRelPath: string | null =
    planned === 'create' ? null : (parsed.append ?? null);
  const beforeDocPath = auditing && expectedRelPath !== null
    ? await safeResolveKbPath(parsed.kb!, expectedRelPath)
    : null;
  const beforeHash = beforeDocPath !== null
    ? await sha256OfFileOrNull(beforeDocPath)
    : null;

  let relativePath = '';
  let action: 'create' | 'append' | 'append-section' = planned;
  let writePerformed = false;
  let writeError: Error | undefined;
  try {
    if (parsed.appendSection !== undefined) {
      relativePath = await appendSectionInExistingNote(
        parsed.kb!,
        parsed.append!,
        parsed.appendSection,
        content,
        parsed.occurrence,
      );
      action = 'append-section';
    } else if (parsed.append !== undefined) {
      relativePath = await appendExistingNote(parsed.kb!, parsed.append, content);
      action = 'append';
    } else {
      relativePath = await createNewNote(parsed.kb!, parsed.title!, content);
      action = 'create';
    }
    writePerformed = true;
  } catch (err) {
    writeError = err as Error;
  }

  let refreshStatus: RefreshStatus = parsed.refresh ? 'skipped' : null;
  let refreshError: Error | undefined;
  if (writePerformed && parsed.refresh) {
    try {
      await refreshKnowledgeBase(parsed.kb!);
      refreshStatus = 'ok';
    } catch (err) {
      refreshStatus = 'failed';
      refreshError = err as Error;
    }
  }

  if (auditing) {
    const afterRelPath = writePerformed ? relativePath : expectedRelPath;
    const afterDocPath = afterRelPath !== null
      ? await safeResolveKbPath(parsed.kb!, afterRelPath)
      : null;
    const afterHash = afterDocPath !== null
      ? await sha256OfFileOrNull(afterDocPath)
      : null;
    await recordMutation({
      surface: 'cli.kb-remember',
      operation: action,
      kb: parsed.kb!,
      relative_path: afterRelPath,
      before_sha256: beforeHash,
      after_sha256: afterHash,
      write_performed: writePerformed,
      refresh_requested: parsed.refresh,
      refresh_status: refreshStatus,
      decision_flags: {
        force: parsed.force,
        similarity_check: parsed.checkSimilar,
        lesson: parsed.lesson,
        append_section: parsed.appendSection !== undefined,
      },
      error: (writeError ?? refreshError)?.message,
    });
  }

  if (writeError !== undefined) {
    process.stderr.write(`kb remember: ${writeError.message}\n`);
    return 1;
  }
  if (refreshError !== undefined) {
    if (refreshError instanceof ActiveModelResolutionError) {
      process.stderr.write(`kb remember: ${refreshError.message}\n`);
      return 2;
    }
    process.stderr.write(`kb remember: refresh failed after write: ${refreshError.message}\n`);
    return 1;
  }

  const summary: Record<string, unknown> = {
    knowledge_base_name: parsed.kb,
    path: relativePath,
    action,
    refreshed: parsed.refresh,
  };
  if (parsed.lesson) {
    summary.lesson = true;
    summary.write_performed = true;
  }
  if (preflight !== null) {
    summary.similarity_check = {
      performed: true,
      candidates_found: preflight.candidates.length,
      ...(preflight.candidates.length > 0
        ? { overridden_with_force: true, candidates: preflight.candidates }
        : {}),
    };
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

interface LessonValidation {
  ok: boolean;
  missing: string[];
  found: string[];
  /** True when stdin was empty/whitespace — distinguishes "no body at all" from "wrong sections". */
  empty: boolean;
}

function normalizeHeadingText(text: string): string {
  return text
    .trim()
    .replace(/[\s:.?!,;]+$/u, '')
    .toLowerCase();
}

function validateLessonContent(content: string): LessonValidation {
  const empty = content.trim() === '';
  if (empty) {
    return {
      ok: false,
      missing: REQUIRED_LESSON_SECTIONS.map((s) => s.canonical),
      found: [],
      empty: true,
    };
  }
  const headings = listHeadings(content);
  const seen = new Set<string>();
  for (const h of headings) {
    if (h.level !== LESSON_HEADING_LEVEL) continue;
    const norm = normalizeHeadingText(h.text);
    for (const req of REQUIRED_LESSON_SECTIONS) {
      if (req.aliases.includes(norm)) {
        seen.add(req.canonical);
      }
    }
  }
  const missing = REQUIRED_LESSON_SECTIONS
    .filter((s) => !seen.has(s.canonical))
    .map((s) => s.canonical);
  return {
    ok: missing.length === 0,
    missing,
    found: Array.from(seen),
    empty: false,
  };
}

function buildLessonSkeleton(): string {
  return [
    '## Mistake',
    '',
    '<one or two sentences: what action led to the unwanted outcome>',
    '',
    '## Why it happened',
    '',
    '<root cause: missing context, wrong assumption, ambiguous instruction, etc.>',
    '',
    '## Better next time',
    '',
    '<a generic, transferable rule — avoid task-specific names, paths, branches, or PR numbers>',
    '',
  ].join('\n');
}

function writeLessonValidationFailure(args: RememberArgs, validation: LessonValidation): void {
  const skeleton = buildLessonSkeleton();
  if (args.format === 'json') {
    const payload = {
      action: 'lesson-validation',
      write_performed: false,
      lesson: true,
      knowledge_base_name: args.kb,
      empty_input: validation.empty,
      missing_sections: validation.missing,
      found_sections: validation.found,
      skeleton,
      decision_hint: {
        summary: validation.empty
          ? 'Lesson body is empty. Fill in the skeleton below and pipe it back through stdin.'
          : `Lesson body is missing required sections: ${validation.missing.join(', ')}.`,
        recommended_agent_actions: [
          'Pipe the returned skeleton (or your edited version) into `kb remember --lesson --title=<...> --stdin --yes`.',
          'Keep the body generic — avoid PR numbers, branch names, repo-local paths.',
          'Use --no-check-similar only if you have already inspected the candidates surfaced by the similarity guard.',
        ],
      },
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const header = validation.empty
    ? 'kb remember --lesson: stdin is empty.'
    : `kb remember --lesson: missing required sections: ${validation.missing.join(', ')}.`;
  process.stdout.write(`${header}\n\nFill in this skeleton and pipe it back through stdin:\n\n`);
  process.stdout.write(skeleton);
  process.stdout.write('\n');
}

async function ensureLessonKbExists(kbName: string): Promise<void> {
  if (kbName !== LESSON_DEFAULT_KB) return;
  const kbDir = path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName);
  try {
    await fsp.mkdir(kbDir, { recursive: true });
  } catch (err) {
    throw new Error(`failed to create lesson knowledge base at ${kbDir}: ${(err as Error).message}`);
  }
}

interface PreflightOutcome {
  candidates: SimilarCandidate[];
  threshold: number;
  k: number;
}

async function runPreflight(content: string, args: RememberArgs): Promise<PreflightOutcome> {
  if (content.trim() === '') {
    // Empty proposed content cannot be meaningfully embedded; do not block,
    // but downstream write paths may still refuse it (e.g. --append-section).
    return { candidates: [], threshold: args.similarThreshold, k: args.similarK };
  }

  await FaissIndexManager.bootstrapLayout();
  const activeModelId = await resolveActiveModel({ explicitOverride: args.model });
  const manager = await loadManagerForModel(activeModelId);
  await loadWithJsonRetry(manager);

  const results = await manager.similaritySearch(
    content,
    args.similarK,
    args.similarThreshold,
    args.kb,
  );

  return {
    candidates: candidatesFromResults(results, args.kb!),
    threshold: args.similarThreshold,
    k: args.similarK,
  };
}

function writeBlockedOutput(args: RememberArgs, preflight: PreflightOutcome): void {
  if (args.format === 'md') {
    process.stdout.write(formatBlockedMarkdown(preflight.candidates));
    process.stdout.write('\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(buildBlockedJson(preflight.candidates), null, 2)}\n`);
}

function parseRememberArgs(rest: string[]): RememberArgs {
  const out: RememberArgs = {
    suggest: false,
    stdin: false,
    yes: false,
    refresh: false,
    lesson: false,
    // Default ON (issue #154): writes run the guard unless the caller
    // explicitly opts out with --no-check-similar.
    checkSimilar: true,
    checkSimilarExplicit: false,
    similarThreshold: DEFAULT_SIMILAR_THRESHOLD,
    similarK: DEFAULT_SIMILAR_K,
    force: false,
    format: 'json',
  };
  for (const raw of rest) {
    if (raw === '--suggest') { out.suggest = true; continue; }
    if (raw === '--stdin') { out.stdin = true; continue; }
    if (raw === '--yes') { out.yes = true; continue; }
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw === '--lesson') { out.lesson = true; continue; }
    if (raw === '--check-similar') {
      out.checkSimilar = true;
      out.checkSimilarExplicit = true;
      continue;
    }
    if (raw === '--no-check-similar') {
      out.checkSimilar = false;
      out.checkSimilarExplicit = true;
      continue;
    }
    if (raw === '--force') { out.force = true; continue; }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--title=')) { out.title = raw.slice('--title='.length); continue; }
    if (raw.startsWith('--append=')) { out.append = raw.slice('--append='.length); continue; }
    if (raw.startsWith('--append-section=')) {
      out.appendSection = raw.slice('--append-section='.length);
      continue;
    }
    if (raw.startsWith('--occurrence=')) {
      const value = raw.slice('--occurrence='.length);
      const parsedNum = Number(value);
      if (!Number.isInteger(parsedNum) || parsedNum < 1) {
        throw new Error(`--occurrence must be a positive integer; got ${JSON.stringify(value)}`);
      }
      out.occurrence = parsedNum;
      continue;
    }
    if (raw.startsWith('--similar-threshold=')) {
      const value = raw.slice('--similar-threshold='.length);
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--similar-threshold must be a positive number; got ${JSON.stringify(value)}`);
      }
      out.similarThreshold = n;
      continue;
    }
    if (raw.startsWith('--similar-k=')) {
      const value = raw.slice('--similar-k='.length);
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--similar-k must be a positive integer; got ${JSON.stringify(value)}`);
      }
      out.similarK = n;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`--format must be md or json; got ${JSON.stringify(value)}`);
      }
      out.format = value;
      continue;
    }
    if (raw.startsWith('--model=')) {
      out.model = raw.slice('--model='.length);
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${raw}`);
  }
  // --lesson removes KB-name guesswork: default `--kb` to the canonical
  // lesson KB when the caller didn't pass one. An explicit `--kb=` still
  // wins so the operator can store lessons elsewhere if they want.
  if (out.lesson && (out.kb === undefined || out.kb.trim() === '')) {
    out.kb = LESSON_DEFAULT_KB;
  }
  return out;
}

function validateRememberArgs(args: RememberArgs): void {
  if (args.kb === undefined || args.kb.trim() === '') {
    throw new Error('missing --kb=<name>');
  }
  if (args.lesson) {
    if (args.suggest) {
      throw new Error('--lesson cannot be combined with --suggest');
    }
    if (args.append !== undefined || args.appendSection !== undefined) {
      throw new Error('--lesson is for new lesson notes; use --title=<title>, not --append');
    }
  }
  if (args.suggest) {
    if (args.title === undefined || args.title.trim() === '') {
      throw new Error('missing --title=<title>');
    }
    if (args.append !== undefined) {
      throw new Error('--suggest cannot be combined with --append');
    }
    if (args.stdin) {
      throw new Error('--suggest does not read stdin');
    }
    if (args.yes) {
      throw new Error('--suggest cannot be combined with --yes');
    }
    if (args.refresh) {
      throw new Error('--suggest cannot be combined with --refresh');
    }
    if (args.checkSimilarExplicit && args.checkSimilar) {
      throw new Error('--suggest cannot be combined with --check-similar');
    }
    if (args.force) {
      throw new Error('--suggest cannot be combined with --force');
    }
    return;
  }

  if (!args.stdin) {
    throw new Error('writes require --stdin');
  }
  if (!args.yes) {
    throw new Error('writes require --yes');
  }
  if (args.force && !args.checkSimilar) {
    throw new Error('--force has no effect without --check-similar');
  }
  if (args.appendSection !== undefined) {
    if (args.appendSection.trim() === '') {
      throw new Error('--append-section must not be empty');
    }
    if (args.append === undefined) {
      throw new Error('--append-section requires --append=<path>');
    }
    if (args.title !== undefined) {
      throw new Error('--append-section cannot be combined with --title');
    }
    if (args.append.trim() === '') {
      throw new Error('--append must not be empty');
    }
    return;
  }
  if (args.occurrence !== undefined) {
    throw new Error('--occurrence requires --append-section');
  }
  if (args.append !== undefined) {
    if (args.append.trim() === '') {
      throw new Error('--append must not be empty');
    }
    if (args.title !== undefined) {
      throw new Error('--append cannot be combined with --title');
    }
    return;
  }
  if (args.title === undefined || args.title.trim() === '') {
    throw new Error('missing --title=<title>');
  }
}

async function runSuggest(kbName: string, title: string): Promise<number> {
  const kbDir = await resolveKnowledgeBaseDir(KNOWLEDGE_BASES_ROOT_DIR, kbName);
  const allFiles = await getFilesRecursively(kbDir);
  const ingestable = filterIngestablePaths(allFiles, kbDir);
  const cache = await loadSuggestHeadingCache(kbDir);
  const nextEntries: Record<string, SuggestHeadingCacheEntry> = {};
  let cacheChanged = cache.rebuild;
  const suggestions = (await Promise.all(
    ingestable.map(async (filePath) => {
      const result = await scoreCandidate(kbDir, filePath, title, cache.entries);
      if (result?.cacheEntry !== undefined) {
        nextEntries[result.cacheEntry.relativePath] = result.cacheEntry;
        if (!suggestCacheEntriesEqual(cache.entries[result.cacheEntry.relativePath], result.cacheEntry)) {
          cacheChanged = true;
        }
      }
      return result?.suggestion ?? null;
    }),
  ))
    .filter((s): s is Suggestion => s !== null)
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, 10);
  if (!sameCacheKeys(cache.entries, nextEntries)) {
    cacheChanged = true;
  }
  if (cacheChanged) {
    await saveSuggestHeadingCacheBestEffort(kbDir, nextEntries);
  }

  if (suggestions.length === 0) {
    process.stdout.write(`No likely existing targets for "${title}" in ${kbName}.\n`);
    return 0;
  }

  process.stdout.write(`Likely existing targets for "${title}" in ${kbName}:\n`);
  for (const s of suggestions) {
    process.stdout.write(`- ${s.relativePath} (${s.label})\n`);
  }
  return 0;
}

async function scoreCandidate(
  kbDir: string,
  filePath: string,
  title: string,
  cacheEntries: Record<string, SuggestHeadingCacheEntry>,
): Promise<{ suggestion: Suggestion | null; cacheEntry?: SuggestHeadingCacheEntry } | null> {
  const relativePath = path.relative(kbDir, filePath).split(path.sep).join('/');
  const titleTokens = tokenize(title);
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let cacheEntry = cacheEntries[relativePath];
  if (
    cacheEntry === undefined ||
    cacheEntry.relativePath !== relativePath ||
    cacheEntry.mtimeMs !== stat.mtimeMs ||
    cacheEntry.size !== stat.size ||
    !Array.isArray(cacheEntry.pathTokens)
  ) {
    try {
      cacheEntry = {
        relativePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        firstHeading: await readFirstHeading(filePath),
        pathTokens: Array.from(tokenize(pathTextForSuggestion(relativePath))),
      };
    } catch {
      // A candidate that vanished or is unreadable between walk and score is
      // simply not useful as a suggestion.
      return null;
    }
  }

  const pathScore = overlapScore(titleTokens, new Set(cacheEntry.pathTokens));
  let headingScore = 0;
  if (cacheEntry.firstHeading !== '') {
    headingScore = overlapScore(titleTokens, tokenize(cacheEntry.firstHeading));
  }

  const score = Math.max(pathScore, headingScore);
  if (score <= 0) return { suggestion: null, cacheEntry };
  return {
    suggestion: {
      relativePath,
      score,
      label: headingScore >= pathScore && cacheEntry.firstHeading !== ''
        ? `heading: ${cacheEntry.firstHeading}`
        : 'filename match',
    },
    cacheEntry,
  };
}

async function loadSuggestHeadingCache(kbDir: string): Promise<SuggestHeadingCacheState> {
  const cachePath = suggestHeadingCachePath(kbDir);
  try {
    const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf-8')) as unknown;
    if (!isSuggestHeadingCacheFile(parsed)) {
      throw new Error('invalid schema');
    }
    return { entries: parsed.entries, rebuild: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { entries: {}, rebuild: false };
    }
    process.stderr.write(`kb remember: ignoring invalid suggest heading cache at ${cachePath}: ${(err as Error).message}\n`);
    return { entries: {}, rebuild: true };
  }
}

async function saveSuggestHeadingCacheBestEffort(
  kbDir: string,
  entries: Record<string, SuggestHeadingCacheEntry>,
): Promise<void> {
  const cachePath = suggestHeadingCachePath(kbDir);
  const payload: SuggestHeadingCacheFile = {
    schema_version: SUGGEST_HEADING_CACHE_SCHEMA_VERSION,
    entries,
  };
  try {
    await withSidecarLock(async () => {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await atomicWriteFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`);
    });
  } catch (err) {
    process.stderr.write(`kb remember: suggest heading cache update skipped: ${(err as Error).message}\n`);
  }
}

function suggestHeadingCachePath(kbDir: string): string {
  return path.join(kbDir, '.index', SUGGEST_HEADING_CACHE_FILE);
}

function isSuggestHeadingCacheFile(value: unknown): value is SuggestHeadingCacheFile {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as { schema_version?: unknown; entries?: unknown };
  if (obj.schema_version !== SUGGEST_HEADING_CACHE_SCHEMA_VERSION) return false;
  if (typeof obj.entries !== 'object' || obj.entries === null || Array.isArray(obj.entries)) return false;
  for (const [key, entry] of Object.entries(obj.entries)) {
    if (!isSuggestHeadingCacheEntry(entry) || entry.relativePath !== key) {
      return false;
    }
  }
  return true;
}

function isSuggestHeadingCacheEntry(value: unknown): value is SuggestHeadingCacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<SuggestHeadingCacheEntry>;
  return (
    typeof entry.relativePath === 'string' &&
    typeof entry.mtimeMs === 'number' &&
    Number.isFinite(entry.mtimeMs) &&
    typeof entry.size === 'number' &&
    Number.isFinite(entry.size) &&
    typeof entry.firstHeading === 'string' &&
    Array.isArray(entry.pathTokens) &&
    entry.pathTokens.every((token) => typeof token === 'string')
  );
}

async function readFirstHeading(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath, 'utf-8');
  const firstHeading = content.split(/\r?\n/, 30).find((line) => /^#{1,6}\s+\S/.test(line));
  return firstHeading === undefined ? '' : firstHeading.replace(/^#{1,6}\s+/, '').trim();
}

function pathTextForSuggestion(relativePath: string): string {
  return relativePath.replace(/\.[^.]+$/, '').replace(/[/_-]+/g, ' ');
}

function sameCacheKeys(
  before: Record<string, SuggestHeadingCacheEntry>,
  after: Record<string, SuggestHeadingCacheEntry>,
): boolean {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (beforeKeys.length !== afterKeys.length) return false;
  return beforeKeys.every((key, index) => key === afterKeys[index]);
}

function suggestCacheEntriesEqual(
  a: SuggestHeadingCacheEntry | undefined,
  b: SuggestHeadingCacheEntry,
): boolean {
  return (
    a !== undefined &&
    a.relativePath === b.relativePath &&
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.firstHeading === b.firstHeading &&
    a.pathTokens.length === b.pathTokens.length &&
    a.pathTokens.every((token, index) => token === b.pathTokens[index])
  );
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let matches = 0;
  for (const token of a) {
    if (b.has(token)) matches += 1;
  }
  return matches / a.size;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

async function createNewNote(kbName: string, title: string, content: string): Promise<string> {
  const relativePath = `${slugifyTitle(title)}.md`;
  const documentPath = await resolveKbPath(KNOWLEDGE_BASES_ROOT_DIR, kbName, relativePath, { mustExist: false });
  const kbDir = await resolveKnowledgeBaseDir(KNOWLEDGE_BASES_ROOT_DIR, kbName);
  try {
    await createFileAtomically(documentPath, content, { kbDir });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`refusing to overwrite existing note: ${relativePath}`);
    }
    throw err;
  }
  return relativePath;
}

async function appendExistingNote(kbName: string, relativePath: string, content: string): Promise<string> {
  assertNoTraversal(relativePath);
  const documentPath = await resolveKbPath(KNOWLEDGE_BASES_ROOT_DIR, kbName, relativePath, { mustExist: false });
  const kbDir = await resolveKnowledgeBaseDir(KNOWLEDGE_BASES_ROOT_DIR, kbName);
  const stat = await fsp.stat(documentPath);
  if (!stat.isFile()) {
    throw new Error(`append target is not a file: ${JSON.stringify(relativePath)}`);
  }
  await appendFileAtomically(documentPath, content, { kbDir });
  return path.relative(kbDir, documentPath)
    .split(path.sep)
    .join('/');
}

async function appendSectionInExistingNote(
  kbName: string,
  relativePath: string,
  headingSpec: string,
  content: string,
  occurrence: number | undefined,
): Promise<string> {
  if (content.trim() === '') {
    // The point of --append-section is to prevent foot-guns; silently writing
    // empty content is the original error mode this feature exists to remove.
    throw new Error('--append-section refuses to write empty content (stdin was empty or whitespace-only)');
  }
  assertNoTraversal(relativePath);
  const documentPath = await resolveKbPath(KNOWLEDGE_BASES_ROOT_DIR, kbName, relativePath, { mustExist: false });
  let stat;
  try {
    stat = await fsp.stat(documentPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `--append-section target does not exist: ${JSON.stringify(relativePath)} (use --title to create a new note)`,
      );
    }
    throw err;
  }
  if (!stat.isFile()) {
    throw new Error(`append target is not a file: ${JSON.stringify(relativePath)}`);
  }

  const spec = parseHeadingSpec(headingSpec);
  const kbDir = await resolveKnowledgeBaseDir(KNOWLEDGE_BASES_ROOT_DIR, kbName);
  await rewriteFileAtomically(documentPath, (original) =>
    appendSectionInDocument(original, spec, content, { occurrence }).content,
    { kbDir },
  );

  return path.relative(kbDir, documentPath)
    .split(path.sep)
    .join('/');
}

async function refreshKnowledgeBase(kbName: string): Promise<void> {
  await FaissIndexManager.bootstrapLayout();
  const activeModelId = await resolveActiveModel();
  const manager = await loadManagerForModel(activeModelId);
  await withWriteLock(manager.modelDir, async () => {
    await manager.initialize();
    await manager.updateIndex(kbName);
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

async function safeResolveKbPath(kbName: string, relativePath: string): Promise<string | null> {
  try {
    return await resolveKbPath(
      KNOWLEDGE_BASES_ROOT_DIR,
      kbName,
      relativePath,
      { mustExist: false },
    );
  } catch {
    return null;
  }
}
