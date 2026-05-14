// `kb stale-check` — read-only drift detector for path / file / URL references
// embedded in markdown notes (issue #142).
//
// Walks every `.md` / `.markdown` file under one or all KBs, extracts:
//   - tilde-rooted absolute paths     (`~/foo/bar`)
//   - http(s) URLs                     (bare or inside markdown links)
//   - markdown-link relative paths     (`[label](relative/path.md)`)
//
// Resolves each reference and reports the ones that no longer exist (paths)
// or no longer answer 200/30x (URLs). Strictly read-only: never modifies
// notes; URL results are cached for 24h under
// `<KNOWLEDGE_BASES_ROOT_DIR>/.stale-check-cache.json` so consecutive runs
// don't replay every HEAD request.

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { listKnowledgeBases, resolveKnowledgeBaseDir } from './kb-fs.js';

export const STALE_CHECK_HELP = `kb stale-check — find broken references in markdown notes (read-only)

Usage:
  kb stale-check [--kb=<name>] [--no-cache] [--verbose|-v]

Walks every \`.md\` / \`.markdown\` file under one or all KBs and extracts:
  - tilde-rooted absolute paths       (\`~/foo/bar\`)
  - http(s) URLs                      (bare or inside markdown links)
  - markdown-link relative paths      (\`[label](relative/path.md)\`)

Resolves each reference and reports the ones that no longer exist (paths)
or no longer answer 200/30x (URLs). Strictly read-only.

URL HEAD results are cached for 24h under
\`<KNOWLEDGE_BASES_ROOT_DIR>/.stale-check-cache.json\` so consecutive runs
don't replay every request.

Options:
  --kb=<name>           Scope to one knowledge base. Omit for all KBs.
  --no-cache            Bypass the URL cache for this run; freshly probe
                        every URL and overwrite cached entries.
  --verbose, -v         Include OK references in the report (default:
                        only print broken/error references).
  --help, -h            Show this help.

Examples:
  kb stale-check
  kb stale-check --kb=work
  kb stale-check --no-cache --verbose
`;

export type ReferenceType = 'tilde-path' | 'rel-path' | 'url';

export interface Reference {
  type: ReferenceType;
  value: string;
  line: number;
}

export type ReferenceStatus = 'OK' | 'MISSING' | 'HTTP_ERROR' | 'TIMEOUT' | 'SKIPPED';

export interface ReferenceResult extends Reference {
  status: ReferenceStatus;
  detail?: string;
}

export interface UrlCheckOutcome {
  status: 'OK' | 'HTTP_ERROR' | 'TIMEOUT';
  detail?: string;
}

export type UrlChecker = (url: string) => Promise<UrlCheckOutcome>;

export interface UrlCacheEntry {
  checkedAt: number;
  status: UrlCheckOutcome['status'];
  detail?: string;
}

export interface UrlCache {
  [url: string]: UrlCacheEntry;
}

export interface StaleCheckOptions {
  rootDir: string;
  kbFilter?: string;
  cachePath?: string | null;
  cacheTtlMs?: number;
  urlChecker?: UrlChecker;
  urlConcurrency?: number;
  /** When true, return all checked references (incl. OK); default reports only stale. */
  verbose?: boolean;
}

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_URL_CONCURRENCY = 8;
const DEFAULT_URL_TIMEOUT_MS = 10_000;

const MARKDOWN_EXTS = new Set(['.md', '.markdown']);

export async function runStaleCheck(rest: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseStaleCheckArgs(rest);
  } catch (err) {
    process.stderr.write(`kb stale-check: ${(err as Error).message}\n`);
    return 2;
  }

  const rootDir = KNOWLEDGE_BASES_ROOT_DIR;
  const cachePath = path.join(rootDir, '.stale-check-cache.json');

  try {
    const report = await staleCheck({
      rootDir,
      kbFilter: parsed.kb,
      cachePath: parsed.noCache ? null : cachePath,
      verbose: parsed.verbose,
    });
    process.stdout.write(formatReport(report));
    return 0;
  } catch (err) {
    process.stderr.write(`kb stale-check: ${(err as Error).message}\n`);
    return 1;
  }
}

interface ParsedArgs {
  kb?: string;
  noCache: boolean;
  verbose: boolean;
}

export function parseStaleCheckArgs(rest: string[]): ParsedArgs {
  const out: ParsedArgs = { noCache: false, verbose: false };
  for (const raw of rest) {
    if (raw === '--no-cache') { out.noCache = true; continue; }
    if (raw === '--verbose' || raw === '-v') { out.verbose = true; continue; }
    if (raw.startsWith('--kb=')) {
      out.kb = raw.slice('--kb='.length);
      if (out.kb.length === 0) throw new Error('--kb=<name> requires a non-empty value');
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  return out;
}

export interface FileReport {
  kb: string;
  /** KB-relative posix path, e.g. "subdir/note.md". */
  relPath: string;
  results: ReferenceResult[];
}

export interface StaleCheckReport {
  kbs: string[];
  files: FileReport[];
  totals: {
    filesScanned: number;
    referencesChecked: number;
    staleReferences: number;
    filesWithStale: number;
  };
}

export async function staleCheck(opts: StaleCheckOptions): Promise<StaleCheckReport> {
  const rootDir = opts.rootDir;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const concurrency = opts.urlConcurrency ?? DEFAULT_URL_CONCURRENCY;
  const checker = opts.urlChecker ?? defaultUrlChecker;

  const kbs = await selectKbs(rootDir, opts.kbFilter);

  const cache: UrlCache = opts.cachePath !== null && opts.cachePath !== undefined
    ? await loadUrlCache(opts.cachePath)
    : {};

  const fileReports: FileReport[] = [];
  let referencesChecked = 0;
  let staleReferences = 0;
  let filesWithStale = 0;

  // Collect URL checks across all files first so we can dedupe and parallelize.
  const urlsToCheck = new Set<string>();
  type FilePending = {
    kb: string;
    relPath: string;
    notePath: string;
    refs: Reference[];
  };
  const pendings: FilePending[] = [];

  for (const kb of kbs) {
    const kbDir = await resolveKnowledgeBaseDir(rootDir, kb);
    const files = await listMarkdownFiles(kbDir);
    for (const notePath of files) {
      const content = await fsp.readFile(notePath, 'utf-8');
      const refs = extractReferences(content);
      const relPath = path.relative(kbDir, notePath).split(path.sep).join('/');
      for (const ref of refs) {
        if (ref.type === 'url' && !cacheValid(cache[ref.value], cacheTtlMs)) {
          urlsToCheck.add(ref.value);
        }
      }
      pendings.push({ kb, relPath, notePath, refs });
    }
  }

  if (urlsToCheck.size > 0) {
    await checkUrlsConcurrently(Array.from(urlsToCheck), checker, concurrency, cache);
  }

  for (const pending of pendings) {
    const results: ReferenceResult[] = [];
    for (const ref of pending.refs) {
      const outcome = await resolveReference(ref, pending.notePath, cache);
      results.push({ ...ref, ...outcome });
    }
    referencesChecked += results.length;
    const staleHere = results.filter(isStale).length;
    if (staleHere > 0) {
      staleReferences += staleHere;
      filesWithStale += 1;
    }
    fileReports.push({ kb: pending.kb, relPath: pending.relPath, results });
  }

  if (opts.cachePath !== null && opts.cachePath !== undefined) {
    await saveUrlCache(opts.cachePath, cache);
  }

  return {
    kbs,
    files: fileReports,
    totals: {
      filesScanned: pendings.length,
      referencesChecked,
      staleReferences,
      filesWithStale,
    },
  };
}

async function selectKbs(rootDir: string, kbFilter: string | undefined): Promise<string[]> {
  if (kbFilter !== undefined) {
    // Throws KB_NOT_FOUND if missing; surface as a 1-exit error message.
    await resolveKnowledgeBaseDir(rootDir, kbFilter);
    return [kbFilter];
  }
  const all = await listKnowledgeBases(rootDir);
  return all.sort();
}

async function listMarkdownFiles(kbDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof fsp.readdir>> = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (MARKDOWN_EXTS.has(ext)) out.push(full);
      }
    }
  }
  await walk(kbDir);
  return out.sort();
}

// ---- Reference extraction --------------------------------------------------

const URL_RE = /https?:\/\/[^\s)\]<>"'`]+/g;
const TILDE_RE = /~\/[A-Za-z0-9_./~@:+\-]+/g;
const MD_LINK_RE = /\[[^\]\n]*\]\(([^)\s]+)\)/g;
// Trailing punctuation often glued to extracted refs; trim it before checking.
const TRAILING_PUNCT_RE = /[.,;:!?)\]]+$/;

export function extractReferences(content: string): Reference[] {
  const refs: Reference[] = [];
  const seenPerLine = new Map<number, Set<string>>();
  const lines = content.split('\n');

  const push = (type: ReferenceType, raw: string, lineNum: number): void => {
    const value = raw.replace(TRAILING_PUNCT_RE, '').trim();
    if (value.length === 0) return;
    const key = `${type}:${value}`;
    let lineSet = seenPerLine.get(lineNum);
    if (lineSet === undefined) {
      lineSet = new Set<string>();
      seenPerLine.set(lineNum, lineSet);
    }
    if (lineSet.has(key)) return;
    lineSet.add(key);
    refs.push({ type, value, line: lineNum });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Markdown links first — capture group is the URL/path.
    let mdMatch: RegExpExecArray | null;
    MD_LINK_RE.lastIndex = 0;
    while ((mdMatch = MD_LINK_RE.exec(line)) !== null) {
      const target = mdMatch[1];
      if (/^https?:\/\//i.test(target)) {
        push('url', target, lineNum);
      } else if (target.startsWith('~/')) {
        push('tilde-path', target, lineNum);
      } else if (
        !target.startsWith('#') &&
        !target.startsWith('mailto:') &&
        !target.startsWith('tel:') &&
        !path.isAbsolute(target) &&
        /\.[A-Za-z0-9]{1,8}(?:#.*)?$/.test(target)
      ) {
        // Heuristic: relative path with a file extension. Skips bare anchors,
        // mailto:, and absolute paths (too noisy for an MVP).
        push('rel-path', target, lineNum);
      }
    }

    // Bare URLs.
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(line)) !== null) {
      push('url', m[0], lineNum);
    }

    // Tilde paths — high-signal absolute references.
    TILDE_RE.lastIndex = 0;
    while ((m = TILDE_RE.exec(line)) !== null) {
      push('tilde-path', m[0], lineNum);
    }
  }

  return refs;
}

// ---- Resolution -----------------------------------------------------------

async function resolveReference(
  ref: Reference,
  notePath: string,
  cache: UrlCache,
): Promise<{ status: ReferenceStatus; detail?: string }> {
  if (ref.type === 'url') {
    const cached = cache[ref.value];
    if (cached !== undefined) {
      return { status: cached.status, detail: cached.detail };
    }
    return { status: 'SKIPPED', detail: 'no result' };
  }

  let target: string;
  if (ref.type === 'tilde-path') {
    target = path.join(os.homedir(), ref.value.slice(2));
  } else {
    target = path.resolve(path.dirname(notePath), stripFragment(ref.value));
  }

  return checkPath(target);
}

function stripFragment(value: string): string {
  const hashIdx = value.indexOf('#');
  return hashIdx === -1 ? value : value.slice(0, hashIdx);
}

async function checkPath(absPath: string): Promise<{ status: ReferenceStatus; detail?: string }> {
  try {
    const stat = await fsp.lstat(absPath);
    if (stat.isSymbolicLink()) {
      try {
        await fsp.stat(absPath);
        return { status: 'OK' };
      } catch {
        return { status: 'MISSING', detail: 'broken symlink' };
      }
    }
    return { status: 'OK' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      const parent = path.dirname(absPath);
      try {
        const parentEntries = await fsp.readdir(parent);
        if (parentEntries.length === 0) {
          return { status: 'MISSING', detail: 'parent dir is empty' };
        }
        return { status: 'MISSING' };
      } catch {
        return { status: 'MISSING', detail: 'parent dir missing' };
      }
    }
    return { status: 'MISSING', detail: code ?? 'stat failed' };
  }
}

// ---- URL checking + cache --------------------------------------------------

async function checkUrlsConcurrently(
  urls: string[],
  checker: UrlChecker,
  concurrency: number,
  cache: UrlCache,
): Promise<void> {
  const queue = urls.slice();
  const workers: Promise<void>[] = [];
  const limit = Math.max(1, Math.min(concurrency, urls.length));
  for (let i = 0; i < limit; i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const url = queue.shift();
        if (url === undefined) break;
        const outcome = await checker(url).catch((err): UrlCheckOutcome => ({
          status: 'HTTP_ERROR',
          detail: (err as Error).message ?? 'unknown error',
        }));
        cache[url] = {
          checkedAt: Date.now(),
          status: outcome.status,
          detail: outcome.detail,
        };
      }
    })());
  }
  await Promise.all(workers);
}

async function defaultUrlChecker(url: string): Promise<UrlCheckOutcome> {
  // Lazy import: pulls axios only when we actually have URLs to check.
  const { default: axios } = await import('axios');
  const opts = {
    timeout: DEFAULT_URL_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: (): boolean => true,
  } as const;
  try {
    let res = await axios.head(url, opts);
    if (res.status === 405 || res.status === 501) {
      // Fall back to a ranged GET so we don't pull the whole body.
      res = await axios.get(url, {
        ...opts,
        headers: { Range: 'bytes=0-0' },
        responseType: 'stream',
      });
    }
    if (res.status >= 200 && res.status < 400) return { status: 'OK' };
    return { status: 'HTTP_ERROR', detail: `HTTP ${res.status}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return { status: 'TIMEOUT', detail: 'request timed out' };
    }
    if (code === 'ENOTFOUND') return { status: 'HTTP_ERROR', detail: 'DNS failure' };
    if (code === 'ECONNREFUSED') return { status: 'HTTP_ERROR', detail: 'connection refused' };
    return { status: 'HTTP_ERROR', detail: (err as Error).message ?? 'request failed' };
  }
}

function cacheValid(entry: UrlCacheEntry | undefined, ttlMs: number): boolean {
  if (entry === undefined) return false;
  return Date.now() - entry.checkedAt < ttlMs;
}

async function loadUrlCache(cachePath: string): Promise<UrlCache> {
  try {
    const raw = await fsp.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as UrlCache;
  } catch {
    return {};
  }
}

async function saveUrlCache(cachePath: string, cache: UrlCache): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // Cache is best-effort. Don't fail the report on write errors.
  }
}

// ---- Output ---------------------------------------------------------------

function isStale(r: ReferenceResult): boolean {
  return r.status === 'MISSING' || r.status === 'HTTP_ERROR' || r.status === 'TIMEOUT';
}

export function formatReport(report: StaleCheckReport): string {
  const lines: string[] = [];
  for (const file of report.files) {
    const stale = file.results.filter(isStale);
    if (stale.length === 0) continue; // omit clean files from default output
    lines.push(`${file.kb}/${file.relPath}`);
    for (const r of stale) {
      lines.push(`  L${r.line}  ${padCol(r.value, 50)}${formatStatus(r)}`);
    }
  }

  if (report.totals.staleReferences === 0) {
    lines.push(
      `No drift across ${report.totals.filesScanned} file(s) in ${report.kbs.length} KB(s).`,
    );
  } else {
    lines.push(
      `Summary: ${report.totals.staleReferences} stale reference(s) in ` +
      `${report.totals.filesWithStale} file(s) across ${report.kbs.length} KB(s).`,
    );
  }
  return lines.join('\n') + '\n';
}

function padCol(value: string, width: number): string {
  if (value.length >= width) return `${value} `;
  return value + ' '.repeat(width - value.length);
}

function formatStatus(r: ReferenceResult): string {
  if (r.status === 'OK') return 'OK';
  if (r.status === 'MISSING') return r.detail !== undefined ? `MISSING (${r.detail})` : 'MISSING';
  if (r.status === 'HTTP_ERROR') return r.detail !== undefined ? r.detail : 'HTTP_ERROR';
  if (r.status === 'TIMEOUT') return 'TIMEOUT';
  return r.status;
}
