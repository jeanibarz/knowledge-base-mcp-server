import * as fs from 'fs';
import * as path from 'path';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { logger } from './logger.js';

// -----------------------------------------------------------------------------
// RFC 011 §5.4 — whitelisted frontmatter lift + sibling PDF detection.
//
// `parseFrontmatter` returns the entire parsed YAML object; the server lifts
// a whitelist of known keys into a typed shape on every chunk's metadata.
// Unknown string-valued keys are collected into `frontmatter.extras` so a
// workflow author who adds a new field doesn't silently lose it — but the
// MCP-boundary sanitizer strips `extras` by default (RFC 011 §7.1 R1, wired
// in `src/KnowledgeBaseServer.ts`). Non-string-valued keys (YAML arrays or
// nested maps — FAILSAFE doesn't coerce numbers or booleans) are dropped:
// there's no safe scalar target for them here.
// -----------------------------------------------------------------------------

/** Whitelisted frontmatter keys lifted into `ChunkMetadata.frontmatter`. */
const FRONTMATTER_WHITELIST: readonly string[] = [
  'arxiv_id',
  'title',
  'authors',
  'published',
  'relevance_score',
  'ingested_at',
  'judge_method',
  'metrics_used',
  'bias_handling',
] as const;

export interface LiftedFrontmatter {
  arxiv_id?: string;
  title?: string;
  authors?: string;
  published?: string;
  relevance_score?: number;
  ingested_at?: string;
  judge_method?: string;
  metrics_used?: string;
  bias_handling?: string;
  /** Other string-valued frontmatter keys (e.g. workflow-specific additions). */
  extras?: Record<string, string>;
}

/**
 * Applies the RFC 011 §5.4.2 whitelist to `parseFrontmatter`'s raw object.
 * Returns `undefined` when the input yields no fields — absent metadata is
 * preferable to an empty object at the wire boundary.
 */
export function liftFrontmatter(
  frontmatter: Record<string, unknown>,
  filePath: string,
): LiftedFrontmatter | undefined {
  const lifted: LiftedFrontmatter = {};
  const extras: Record<string, string> = {};
  let hasAny = false;

  for (const [key, value] of Object.entries(frontmatter)) {
    // `tags` is already lifted into the sibling `tags` metadata field;
    // don't duplicate it into the frontmatter block.
    if (key === 'tags') continue;

    // FAILSAFE parses scalars as strings and lists/maps as arrays/objects.
    // Only strings survive the lift; arrays and objects are dropped with a
    // debug log so a workflow author who wrote `metrics: [a, b, c]` sees
    // why their field disappeared.
    if (typeof value !== 'string') {
      logger.debug(`Dropping non-string frontmatter key "${key}" from ${filePath}`);
      continue;
    }

    if (key === 'relevance_score') {
      // RFC 011 §5.4.3: parseInt + isFinite; non-numeric → omit and log.
      // Log the *length* of the rejected value, never the value itself —
      // frontmatter authored by the workflow is otherwise-untrusted input,
      // and the RFC §5.4.2 leak rule for non-string keys ("key name, not
      // value") applies equally here.
      const parsed = parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        lifted.relevance_score = parsed;
        hasAny = true;
      } else {
        logger.debug(
          `Dropping non-numeric relevance_score (length=${value.length}) from ${filePath}`,
        );
      }
      continue;
    }

    if ((FRONTMATTER_WHITELIST as readonly string[]).includes(key)) {
      (lifted as Record<string, unknown>)[key] = value;
      hasAny = true;
    } else {
      extras[key] = value;
    }
  }

  if (Object.keys(extras).length > 0) {
    lifted.extras = extras;
    hasAny = true;
  }

  return hasAny ? lifted : undefined;
}

/**
 * Looks for a PDF whose basename (without extension) matches the `.md` file
 * at `filePath`. Checks (in order) the arxiv `<kb>/pdfs/<stem>.pdf` layout,
 * then the same-directory `<stem>.pdf` fallback. Returns the KB-directory-
 * relative forward-slash path, or `undefined` when no sibling exists.
 *
 * Uses sync `existsSync` deliberately: called once per file inside an
 * already-`await`-heavy ingest loop; an extra async boundary is not worth
 * the 1-stat-per-file cost.
 */
export function detectSiblingPdfPath(
  filePath: string,
  knowledgeBaseName: string,
): string | undefined {
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  const kbRoot = path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName);

  // Returns a KB-directory-scoped forward-slash path, or undefined if
  // `candidate` escapes the KB root (e.g. the arxiv layout's `../pdfs/`
  // probe for a `.md` at the KB root resolves outside the KB — `pdf_path`
  // on a chunk must not reference a sibling KB's files).
  const toKbRelative = (candidate: string): string | undefined => {
    const rel = path.relative(kbRoot, candidate).split(path.sep).join('/');
    if (rel.length === 0 || rel.startsWith('../') || rel === '..' || path.posix.isAbsolute(rel)) {
      return undefined;
    }
    return rel;
  };

  // arxiv layout: notes/<stem>.md next to pdfs/<stem>.pdf
  const arxivCandidate = path.join(dir, '..', 'pdfs', `${stem}.pdf`);
  if (fs.existsSync(arxivCandidate)) {
    const rel = toKbRelative(arxivCandidate);
    if (rel !== undefined) return rel;
    // `arxivCandidate` escapes the KB (e.g. the .md lives at the KB root,
    // so `dir/../pdfs/` points at KNOWLEDGE_BASES_ROOT_DIR/pdfs — a sibling
    // directory, not a subdir of this KB). Fall through to same-dir check.
  }

  // Fallback: same-directory colocation (KBs that don't split notes/ and pdfs/)
  const sameDirCandidate = path.join(dir, `${stem}.pdf`);
  if (fs.existsSync(sameDirCandidate)) {
    const rel = toKbRelative(sameDirCandidate);
    if (rel !== undefined) return rel;
  }

  return undefined;
}
