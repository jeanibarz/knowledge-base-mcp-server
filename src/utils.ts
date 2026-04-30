import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';
import { minimatch } from 'minimatch';
import { logger } from './logger.js';

/**
 * Coerce an unknown thrown value into an `Error`.
 *
 * Strict mode (`tsconfig.json` `useUnknownInCatchVariables`) types `catch`
 * variables as `unknown`; this helper narrows once at the catch boundary so
 * callers can rely on `err.message` / `err.stack` without re-checking.
 *
 * - `Error` in → returned by reference (preserves prototype, `cause`, and any
 *   ad-hoc properties like `__alreadyLogged` set by callers further up).
 * - `string` in → `new Error(x)`.
 * - anything else → `new Error(JSON.stringify(x))`. JSON-encoding is best-effort:
 *   if it throws (cycle, BigInt) we fall back to `String(x)` so the helper
 *   itself never throws inside a catch.
 */
export function toError(x: unknown): Error {
  if (x instanceof Error) return x;
  if (typeof x === 'string') return new Error(x);
  try {
    return new Error(JSON.stringify(x));
  } catch {
    return new Error(String(x));
  }
}

export async function calculateSHA256(filePath: string): Promise<string> {
  const fileBuffer = await fsp.readFile(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

/**
 * Recursively gets all files in a directory, excluding hidden files and directories.
 * @param dirPath The directory path to search
 * @returns Array of file paths
 */
export async function getFilesRecursively(dirPath: string): Promise<string[]> {
  const files: string[] = [];

  async function traverse(currentPath: string): Promise<void> {
    try {
      const entries = await fsp.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        // Skip hidden files and directories
        if (entry.name.startsWith('.')) {
          continue;
        }

        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await traverse(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      logger.error(`Error traversing directory ${currentPath}:`, error);
    }
  }

  await traverse(dirPath);
  return files;
}

// -----------------------------------------------------------------------------
// Ingest filter (RFC 011 §5.2).
//
// getFilesRecursively already skips dotfiles (`.index/`, `.reindex-trigger`,
// `.DS_Store`-when-dot-prefixed). The ingest filter runs on top of that walker
// output to refuse content that is not retrieval-worthy: workflow sidecars
// (`_seen.jsonl`), log directories (`logs/`, `tmp/`), and image / archive
// extensions (`.jsonl`, `.log`, images). Issue #46 added `.pdf`, `.html`, and
// `.htm` to the allowlist with dedicated loaders in `src/loaders.ts`. The
// arxiv ingestion workflow's ledger must still NOT reach the splitter — the
// walker today would chunk `_seen.jsonl` as JSON lines (RFC 011 §2.2). KBs
// that pair markdown notes with sibling PDFs (e.g. arxiv `notes/` + `pdfs/`)
// can suppress the PDFs with `INGEST_EXCLUDE_PATHS=pdfs/**`.
// -----------------------------------------------------------------------------

/**
 * Base extension allowlist for the ingest filter (Rule B). Extensions are
 * lowercased and include the leading dot. `INGEST_EXTRA_EXTENSIONS` merges
 * into this set; operators cannot remove base entries.
 *
 * Issue #46 — `.pdf`, `.html`, `.htm` ride the extension-routed loader layer
 * in `src/loaders.ts`. Adding here without a loader would re-introduce the
 * UTF-8-decoded-binary-noise bug; `loaders.ts` is the single source of truth
 * for what a loader exists for, this list is the source of truth for what
 * the ingest filter admits.
 */
export const INGEST_BASE_EXTENSIONS: readonly string[] = [
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.pdf',
  '.html',
  '.htm',
] as const;

/**
 * Segment names that exclude a file when they appear anywhere in the
 * KB-relative path. Covers workflow-owned sidecars that are never corpus.
 */
const EXCLUDED_SEGMENT_LITERALS: ReadonlySet<string> = new Set([
  '_seen.jsonl',
  '_seen.json',
  '_index.jsonl',
]);

/**
 * First-segment names that exclude an entire subtree. The arxiv workflow
 * writes into `logs/`; `tmp/` and `_tmp/` cover common staging-dir names
 * across adjacent workflows. A flat-file named `logs.md` at KB root is NOT
 * excluded (this is a first-segment check, not a basename check).
 */
const EXCLUDED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  'logs',
  'tmp',
  '_tmp',
]);

/**
 * Basenames that exclude the file regardless of location. Covers OS-owned
 * turds that are not dot-prefixed and therefore slip past the walker's
 * dotfile skip on case-preserving filesystems.
 */
const EXCLUDED_BASENAME_LITERALS: ReadonlySet<string> = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

/**
 * Issue #89 — basename regex patterns for filesystem-metadata sidecars that
 * slip past the dotfile walker but are never corpus content. Centralised here
 * so future loaders (PDF/HTML per #46, anything that widens the extension
 * allowlist) inherit the same skip list without re-deriving it.
 *
 *   `/:Zone\.Identifier$/i` — NTFS Alternate Data Stream leakage through
 *                     WSL/wslfs. A `foo.md` on a Windows-mounted volume
 *                     surfaces a zero-byte sibling `foo.md:Zone.Identifier`.
 *                     The previous draft of this list used the broader `/:/`
 *                     regex, but colons are valid in POSIX filenames (e.g.
 *                     `Design:Tradeoffs.md`, `2024-01-15: meeting.md`) and
 *                     `/:/` would silently drop those legitimate documents
 *                     with no recoverable override. We anchor on the
 *                     specific Zone.Identifier suffix because that is the
 *                     stream WSL/wslfs actually surfaces; other ADS streams
 *                     can be added here by name as they're observed.
 *
 *   `/^\._/`        — macOS AppleDouble resource-fork sidecars. The walker's
 *                     dotfile skip already catches these, but listing the
 *                     pattern here means future code paths that bypass the
 *                     walker (manual ingest, glob expansion in tests) still
 *                     drop them.
 *
 *   `/^Thumbs\.db$/i` and `/^\.DS_Store$/` — redundant with
 *                     EXCLUDED_BASENAME_LITERALS but listed here so the regex
 *                     surface alone documents the full skip set.
 */
export const SKIPPED_FILENAME_PATTERNS: readonly RegExp[] = [
  /:Zone\.Identifier$/i,
  /^\._/,
  /^Thumbs\.db$/i,
  /^\.DS_Store$/,
] as const;

/**
 * Module-level set of regex sources we've already logged a skip for. Each
 * pattern logs at most once per Node process so a surprised user can see
 * "oh, my Zone.Identifier files are being skipped" exactly once instead of
 * having a quiet bug or N-per-file log spam.
 */
const SKIPPED_PATTERNS_LOGGED: Set<string> = new Set();

/** Returns the matching regex (so the logger can name it), or null. */
function matchSkippedFilenamePattern(basename: string): RegExp | null {
  for (const re of SKIPPED_FILENAME_PATTERNS) {
    if (re.test(basename)) return re;
  }
  return null;
}

/**
 * Test-only: forget which patterns have been logged so a test can assert
 * the one-shot log fires.
 */
export function __resetSkippedFilenameLogForTests(): void {
  SKIPPED_PATTERNS_LOGGED.clear();
}

export interface IngestFilterOptions {
  /** Extra extensions to allow, merged with the base list. Leading dot and case insensitive. */
  extraExtensions?: readonly string[];
  /** Extra path-relative-to-KB-root glob patterns (minimatch) to exclude. */
  excludePaths?: readonly string[];
}

function normalizeExtensionEntry(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return '';
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

/**
 * Applies RFC 011 §5.2 filters on top of a `getFilesRecursively` result.
 *
 * Rule A — path exclusions (always applied, operator cannot override):
 *   - basename matches a `SKIPPED_FILENAME_PATTERNS` regex (issue #89) → excluded
 *   - any path segment in `EXCLUDED_SEGMENT_LITERALS` → excluded
 *   - first path segment in `EXCLUDED_FIRST_SEGMENTS` → excluded
 *   - basename in `EXCLUDED_BASENAME_LITERALS` → excluded
 *   - any `options.excludePaths` minimatch pattern matches → excluded
 *
 * Rule B — extension allowlist (base list + `options.extraExtensions`):
 *   - lowercased extension must be in the merged allowlist
 *
 * Paths are interpreted relative to `kbRoot`; comparisons use forward slashes
 * so patterns match identically on POSIX and Windows. The function is pure —
 * no I/O, no globals other than the constants above.
 */
export function filterIngestablePaths(
  paths: readonly string[],
  kbRoot: string,
  options: IngestFilterOptions = {},
): string[] {
  const allowedExtensions = new Set<string>(INGEST_BASE_EXTENSIONS);
  for (const raw of options.extraExtensions ?? []) {
    const normalized = normalizeExtensionEntry(raw);
    if (normalized.length > 0) {
      allowedExtensions.add(normalized);
    }
  }

  const excludePatterns = (options.excludePaths ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const result: string[] = [];
  for (const absPath of paths) {
    const relative = path
      .relative(kbRoot, absPath)
      .split(path.sep)
      .join('/');

    // Rule A.0 — issue #89: filesystem-metadata sidecar basenames (NTFS ADS
    // leakage like `foo.md:Zone.Identifier`, macOS AppleDouble `._foo`, etc.).
    // Logged at most once per pattern per process so a surprised user can see
    // "oh, that's why my Zone.Identifier files don't show up" without log spam.
    const basename = path.posix.basename(relative);
    const skippedBy = matchSkippedFilenamePattern(basename);
    if (skippedBy !== null) {
      const key = skippedBy.source;
      if (!SKIPPED_PATTERNS_LOGGED.has(key)) {
        SKIPPED_PATTERNS_LOGGED.add(key);
        logger.info(
          `Skipping filesystem-metadata sidecar ${absPath} (matches ${skippedBy}); ` +
            `further matches in this session will not be logged.`,
        );
      }
      continue;
    }

    // Rule A.1 — basename in exclusion list.
    if (EXCLUDED_BASENAME_LITERALS.has(basename)) continue;

    // Rule A.2 — any segment in the sidecar-literal set.
    const segments = relative.split('/').filter((s) => s.length > 0);
    if (segments.some((s) => EXCLUDED_SEGMENT_LITERALS.has(s))) continue;

    // Rule A.3 — first segment names an excluded subtree (only when the
    // path has depth > 1; a top-level file literally named `logs` is not
    // excluded by this branch).
    if (segments.length > 1 && EXCLUDED_FIRST_SEGMENTS.has(segments[0])) continue;

    // Rule A.4 — operator-supplied glob excludes. `nonegate: true` disables
    // minimatch's leading-`!` negation syntax so `INGEST_EXCLUDE_PATHS="!notes/*"`
    // reads as a literal pattern rather than inverting to "exclude everything
    // except notes/*" — the opposite of the operator's obvious intent.
    if (
      excludePatterns.some((pattern) =>
        minimatch(relative, pattern, { dot: true, nonegate: true }),
      )
    ) {
      continue;
    }

    // Rule B — extension allowlist (case-insensitive).
    const ext = path.posix.extname(basename).toLowerCase();
    if (!allowedExtensions.has(ext)) continue;

    result.push(absPath);
  }

  return result;
}

/**
 * KB-name grammar: `^[a-z0-9][a-z0-9._-]*$`, length 1-64.
 *
 * The leading-char rule rejects dotfiles (`.hidden`), relative traversal
 * (`..`), CLI-flag ambiguity (`-foo`), and the empty string. The tail rule
 * forbids `/`, `\\`, uppercase, and any other separator the filesystem
 * could split on. Null bytes are rejected as a side-effect of the regex
 * character class.
 */
export const KB_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidKbName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length < 1 || name.length > 64) return false;
  return KB_NAME_REGEX.test(name);
}

export function assertValidKbName(name: string): void {
  if (!isValidKbName(name)) {
    throw new Error(`invalid KB name: ${JSON.stringify(name)}`);
  }
}

/**
 * Resolves a user-supplied relative path against `<kbRootDir>/<kbName>/` and
 * asserts the real path stays inside the KB. Throws on null bytes, escapes,
 * or a missing KB directory. The returned path is realpath-resolved so
 * callers can use it directly for fs reads.
 *
 * Symlinks are followed — a link pointing outside the KB is rejected.
 */
export async function resolveKbPath(
  kbName: string,
  relativePath: string,
  kbRootDir: string,
): Promise<string> {
  // Reject `kbName === '..'` and friends before path.join can walk out of
  // kbRootDir. Without this, a `..` kbName would make kbRoot === kbRootDir's
  // parent and `prefix` would cover every path on disk.
  assertValidKbName(kbName);

  if (typeof relativePath !== 'string') {
    throw new Error('relativePath must be a string');
  }
  if (relativePath.includes('\0')) {
    throw new Error('path contains null byte');
  }

  // RFC 010 §5.1.1 steps 3+4: normalize backslashes, then lexical traversal
  // check (defence-in-depth before realpath). Catches Windows-style payloads
  // on POSIX hosts and absolute/`..` injections even when intermediate
  // realpath chains would resolve back inside the KB.
  const normalizedRelative = relativePath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalizedRelative)) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }
  const posixNormalized = path.posix.normalize(normalizedRelative);
  const segments = posixNormalized.split('/');
  if (segments.some((s) => s === '..')) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }

  const kbRoot = path.join(kbRootDir, kbName);
  let kbRootReal: string;
  try {
    kbRootReal = await fsp.realpath(kbRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`knowledge base not found: ${JSON.stringify(kbName)}`);
    }
    throw error;
  }
  const prefix = kbRootReal.endsWith(path.sep) ? kbRootReal : kbRootReal + path.sep;

  const candidate = path.join(kbRoot, normalizedRelative);
  let resolved: string;
  try {
    resolved = await fsp.realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // If the target does not exist, a lexical escape is still detectable:
      // compare the (non-real) candidate against the kbRoot prefix. The
      // realpath of the KB root itself was successful above, so only the
      // candidate is missing.
      const lexical = path.resolve(candidate);
      if (lexical !== kbRootReal && !lexical.startsWith(prefix)) {
        throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
      }
      // RFC 010 §5.1.1: error messages MUST NOT leak absolute paths.
      throw new Error(`path not found: ${JSON.stringify(relativePath)}`);
    }
    throw error;
  }

  if (resolved !== kbRootReal && !resolved.startsWith(prefix)) {
    throw new Error(`path escapes KB root: ${JSON.stringify(relativePath)}`);
  }
  return resolved;
}

const FRONTMATTER_MAX_BYTES = 8192;

/**
 * Result of parsing YAML frontmatter.
 *
 * `tags` is pre-coerced to a `string[]` for back-compat with RFC 010 M1
 * callers that only consume tags. `frontmatter` carries the whole parsed
 * object — always an object (`{}` on no-frontmatter / malformed / oversized).
 * The raw shape of `frontmatter.tags` is preserved (string or string array)
 * so downstream consumers that want the unprocessed form can read it there.
 * Values are FAILSAFE-parsed, so scalars arrive as strings; `!!js/*` tags
 * are rejected at the YAML level.
 */
export interface ParsedFrontmatter {
  tags: string[];
  body: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Parses YAML frontmatter bounded at `---` delimiters. Returns extracted
 * `tags` (array or scalar-coerced), the `body` with frontmatter stripped,
 * and the full parsed `frontmatter` object (or `{}` on any failure mode).
 * Never throws: malformed YAML, oversized frontmatter, or no fence all
 * degrade to `{ tags: [], body: content, frontmatter: {} }`.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  if (typeof content !== 'string' || content.length === 0) {
    return { tags: [], body: content, frontmatter: {} };
  }

  // Opening fence must be `---\n` (or `---\r\n`) at byte 0.
  const openMatch = content.match(/^---\r?\n/);
  if (!openMatch) {
    return { tags: [], body: content, frontmatter: {} };
  }
  const openEnd = openMatch[0].length;

  // Search for the closing fence within the size cap. The closing fence
  // `---` must sit at the start of a line — either at position 0 of the
  // slice (empty frontmatter: `---\n---\n`) or right after a `\n`.
  const searchLimit = Math.min(content.length, FRONTMATTER_MAX_BYTES);
  const searchSlice = content.slice(openEnd, searchLimit);
  const closeMatch = searchSlice.match(/(^|\n)---(\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { tags: [], body: content, frontmatter: {} };
  }
  const leadNL = closeMatch[1]; // '' or '\n'
  // YAML ends at matchStart when there is a leading `\n` (the `\n` is part
  // of the fence, not the YAML). With no leading `\n` the match sits at
  // position 0, so YAML is empty.
  const yamlEnd = leadNL === '\n' ? closeMatch.index : 0;
  const fenceEnd = closeMatch.index + closeMatch[0].length;
  const yamlRaw = searchSlice.slice(0, yamlEnd);
  const body = content.slice(openEnd + fenceEnd);

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlRaw, { schema: yaml.FAILSAFE_SCHEMA });
  } catch {
    return { tags: [], body: content, frontmatter: {} };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { tags: [], body, frontmatter: {} };
  }

  const parsedObject = parsed as Record<string, unknown>;
  const raw = parsedObject.tags;
  let tags: string[] = [];
  if (Array.isArray(raw)) {
    tags = raw
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) tags = [trimmed];
  }
  return { tags, body, frontmatter: parsedObject };
}
