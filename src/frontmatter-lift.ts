import * as fs from 'fs';
import * as path from 'path';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { logger } from './logger.js';

// -----------------------------------------------------------------------------
// RFC 011 §5.4 — whitelisted frontmatter lift + sibling PDF detection.
//
// `parseFrontmatter` returns the entire parsed YAML object; the server lifts
// a whitelist of known keys into a typed shape on every chunk's metadata.
// Unknown string-valued keys are collected into `frontmatter.extras` so a
// workflow author who adds a new field doesn't silently lose it — but the
// MCP-boundary sanitizer strips `extras` by default (RFC 011 §7.1 R1, wired
// in `src/KnowledgeBaseServer.ts`). Most allowed fields are scalar strings;
// fields with a stronger RFC005 contract (`contradicted_by`, `manual_edits`,
// and `confidence`) use explicit type coercion below.
// -----------------------------------------------------------------------------

/** Whitelisted frontmatter keys lifted into `ChunkMetadata.frontmatter`. */
const STRING_FRONTMATTER_WHITELIST: readonly string[] = [
  'arxiv_id',
  'title',
  'authors',
  'published',
  'ingested_at',
  'judge_method',
  'metrics_used',
  'bias_handling',
  'status',
  'review_status',
  'promote_model',
  'tier',
  'last_verified_at',
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
  status?: string;
  review_status?: string;
  contradicted_by?: string[];
  manual_edits?: boolean;
  promote_model?: string;
  tier?: string;
  confidence?: number;
  last_verified_at?: string;
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

    if (key === 'relevance_score') {
      // RFC 011 §5.4.3: parseInt + isFinite; non-numeric → omit and log.
      // Log the *length* of the rejected value, never the value itself —
      // frontmatter authored by the workflow is otherwise-untrusted input,
      // and the RFC §5.4.2 leak rule for non-string keys ("key name, not
      // value") applies equally here.
      if (typeof value !== 'string') {
        logger.debug(`Dropping non-string frontmatter key "${key}" from ${filePath}`);
        continue;
      }
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

    if (key === 'confidence') {
      const parsed = parseFiniteNumber(value);
      if (parsed !== undefined) {
        lifted.confidence = parsed;
        hasAny = true;
      } else {
        logger.debug(`Dropping non-numeric confidence (type=${typeof value}) from ${filePath}`);
      }
      continue;
    }

    if (key === 'manual_edits') {
      const parsed = parseBoolean(value);
      if (parsed !== undefined) {
        lifted.manual_edits = parsed;
        hasAny = true;
      } else {
        logger.debug(`Dropping invalid boolean frontmatter key "manual_edits" from ${filePath}`);
      }
      continue;
    }

    if (key === 'contradicted_by') {
      const parsed = parseStringList(value);
      if (parsed !== undefined) {
        lifted.contradicted_by = parsed;
        hasAny = true;
      } else {
        logger.debug(`Dropping non-string-list frontmatter key "contradicted_by" from ${filePath}`);
      }
      continue;
    }

    // FAILSAFE parses scalars as strings and lists/maps as arrays/objects.
    // Only strings survive the generic lift; arrays and objects are dropped
    // with a debug log so a workflow author who wrote `metrics: [a, b, c]`
    // sees why their field disappeared. RFC005 fields with typed targets are
    // handled explicitly above before this generic scalar gate.
    if (typeof value !== 'string') {
      logger.debug(`Dropping non-string frontmatter key "${key}" from ${filePath}`);
      continue;
    }

    if ((STRING_FRONTMATTER_WHITELIST as readonly string[]).includes(key)) {
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

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function parseStringList(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
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
