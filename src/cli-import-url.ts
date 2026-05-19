// `kb import-url` — snapshot a web page or PDF into a KB note while
// preserving provenance. See issue #403.
//
// Local HTML/PDF/text files can already be indexed once they exist on disk,
// and `kb capture` appends command stdout, but there was no first-class
// command to pull a URL into a note with its source URL, fetch time,
// content hash, and extraction metadata. This command fills that gap with
// a deliberately narrow scope: fetch (with SSRF/redirect/size guards),
// extract text via the existing loaders, and write one new note.
//
// The network-facing and pure logic lives in `url-snapshot.ts`; this file
// is the CLI wrapper — argv parsing, the temp-file extraction hop, the
// new-note write, and the JSON contract.

import { createHash } from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ActiveModelResolutionError, resolveActiveModel } from './active-model.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { loadManagerForModel } from './cli-shared.js';
import { assertNoTraversal, resolveKbPath, resolveKnowledgeBaseDir } from './kb-fs.js';
import { loadFile } from './loaders.js';
import { withWriteLock } from './write-lock.js';
import {
  buildSnapshotNote,
  classifyContentType,
  deriveTitleFromUrl,
  extensionForKind,
  extractHtmlTitle,
  fetchUrlSnapshot,
  slugifyForFilename,
  UrlSnapshotError,
  type ContentKind,
  type UrlFetcher,
} from './url-snapshot.js';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;

export const IMPORT_URL_HELP = `kb import-url — snapshot a web page or PDF into a KB note with provenance

Usage:
  kb import-url --kb=<name> <url> [options]

Fetches <url> over http(s), extracts readable text (HTML and PDF are routed
through the same loaders the indexer uses), and writes ONE new KB note. The
note carries a provenance frontmatter block — \`source_url\`, \`fetched_at\`,
\`content_sha256\`, \`content_type\`, \`http_status\`, \`byte_count\` — so the
snapshot stays auditable. Refuses to overwrite an existing note.

Targeting:
  --kb=<name>            Target knowledge base. Required.
  <url>                  The http(s) URL to snapshot. Required (also
                         accepted as --url=<url>).
  --note=<path>          KB-relative output path; must end in \`.md\`.
                         Defaults to a slug of the page title.
  --title=<text>         Override the note title (default: HTML <title>,
                         else the URL's last path segment).

Fetch guards:
  --max-bytes=<N>        Reject responses larger than N bytes
                         (default: ${DEFAULT_MAX_BYTES}).
  --timeout=<ms>         Per-request timeout in milliseconds
                         (default: ${DEFAULT_TIMEOUT_MS}).
  --max-redirects=<N>    Maximum redirect hops to follow
                         (default: ${DEFAULT_MAX_REDIRECTS}).
  --allow-local-network  Permit fetching private/loopback/link-local
                         addresses. Off by default — the fetch refuses
                         to reach internal hosts (SSRF guard).

Other:
  --refresh              Re-index the affected KB after a successful write.
  --help, -h             Show this help.

Examples:
  kb import-url --kb=research https://example.com/article
  kb import-url --kb=research https://example.com/paper.pdf --note=papers/x.md
  kb import-url --kb=work http://localhost:8080/doc --allow-local-network
`;

interface ImportUrlArgs {
  kb?: string;
  url?: string;
  note?: string;
  title?: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  allowLocalNetwork: boolean;
  refresh: boolean;
}

function parsePositiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid ${flag}: ${JSON.stringify(raw)} (expected a positive integer)`);
  }
  return n;
}

export function parseImportUrlArgs(rest: string[]): ImportUrlArgs {
  const out: ImportUrlArgs = {
    maxBytes: DEFAULT_MAX_BYTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRedirects: DEFAULT_MAX_REDIRECTS,
    allowLocalNetwork: false,
    refresh: false,
  };
  for (const raw of rest) {
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw === '--allow-local-network') { out.allowLocalNetwork = true; continue; }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--url=')) { out.url = raw.slice('--url='.length); continue; }
    if (raw.startsWith('--note=')) { out.note = raw.slice('--note='.length); continue; }
    if (raw.startsWith('--title=')) { out.title = raw.slice('--title='.length); continue; }
    if (raw.startsWith('--max-bytes=')) {
      out.maxBytes = parsePositiveInt('--max-bytes', raw.slice('--max-bytes='.length));
      continue;
    }
    if (raw.startsWith('--timeout=')) {
      out.timeoutMs = parsePositiveInt('--timeout', raw.slice('--timeout='.length));
      continue;
    }
    if (raw.startsWith('--max-redirects=')) {
      const n = Number(raw.slice('--max-redirects='.length));
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`invalid --max-redirects: ${JSON.stringify(raw)} (expected a non-negative integer)`);
      }
      out.maxRedirects = n;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    if (out.url !== undefined) {
      throw new Error(`unexpected extra argument: ${JSON.stringify(raw)} (URL already given)`);
    }
    out.url = raw;
  }
  return out;
}

function validateImportUrlArgs(args: ImportUrlArgs): asserts args is ImportUrlArgs & { kb: string; url: string } {
  if (args.kb === undefined || args.kb.trim() === '') {
    throw new Error('missing --kb=<name>');
  }
  if (args.url === undefined || args.url.trim() === '') {
    throw new Error('missing <url>');
  }
}

export interface RunImportUrlDeps {
  /** KB root the new note is written under. */
  rootDir: string;
  /** Network seam — fetches and returns the URL snapshot. */
  fetchUrl: UrlFetcher;
  /** Re-index the affected KB after a write (used by `--refresh`). */
  refresh: (kb: string) => Promise<void>;
  /** Clock seam so `fetched_at` is deterministic in tests. */
  now: () => Date;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function defaultImportUrlDeps(): RunImportUrlDeps {
  return {
    rootDir: KNOWLEDGE_BASES_ROOT_DIR,
    fetchUrl: fetchUrlSnapshot,
    refresh: refreshKnowledgeBase,
    now: () => new Date(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

export async function runImportUrl(
  rest: string[],
  deps: RunImportUrlDeps = defaultImportUrlDeps(),
): Promise<number> {
  let args: ImportUrlArgs & { kb: string; url: string };
  try {
    const parsed = parseImportUrlArgs(rest);
    validateImportUrlArgs(parsed);
    args = parsed;
  } catch (err) {
    deps.stderr(`kb import-url: ${(err as Error).message}\n`);
    return 2;
  }

  // Reject a traversal/absolute --note before any network I/O.
  if (args.note !== undefined && args.note.trim() !== '') {
    const note = args.note.trim();
    if (!note.toLowerCase().endsWith('.md')) {
      deps.stderr(`kb import-url: --note path must end in .md: ${JSON.stringify(note)}\n`);
      return 2;
    }
    try {
      assertNoTraversal(note);
    } catch (err) {
      deps.stderr(`kb import-url: ${(err as Error).message}\n`);
      return 1;
    }
  }

  let snapshot;
  try {
    snapshot = await deps.fetchUrl(args.url, {
      maxBytes: args.maxBytes,
      timeoutMs: args.timeoutMs,
      maxRedirects: args.maxRedirects,
      allowLocalNetwork: args.allowLocalNetwork,
    });
  } catch (err) {
    deps.stderr(`kb import-url: ${(err as Error).message}\n`);
    return 1;
  }

  const baseContentType = snapshot.contentType.split(';')[0].trim().toLowerCase();
  const kind = classifyContentType(snapshot.contentType);
  if (kind === 'unsupported') {
    deps.stderr(
      `kb import-url: unsupported content type ${JSON.stringify(baseContentType)}; ` +
      `only HTML, PDF, and text responses can be snapshotted.\n`,
    );
    return 1;
  }
  if (snapshot.body.length === 0) {
    deps.stderr('kb import-url: response body is empty; refusing to write an empty note.\n');
    return 1;
  }

  const contentSha256 = createHash('sha256').update(snapshot.body).digest('hex');

  let text: string;
  try {
    text = await extractText(snapshot.body, kind);
  } catch (err) {
    deps.stderr(`kb import-url: failed to extract text: ${(err as Error).message}\n`);
    return 1;
  }
  if (text.trim() === '') {
    deps.stderr('kb import-url: extracted no readable text; refusing to write an empty note.\n');
    return 1;
  }

  const title = resolveTitle(args.title, kind, snapshot.body, snapshot.finalUrl);
  const notePath = args.note !== undefined && args.note.trim() !== ''
    ? args.note.trim()
    : `${slugifyForFilename(title)}.md`;

  const note = buildSnapshotNote({
    title,
    sourceUrl: args.url,
    resolvedUrl: snapshot.finalUrl,
    fetchedAt: deps.now().toISOString(),
    contentSha256,
    contentType: baseContentType,
    httpStatus: snapshot.httpStatus,
    byteCount: snapshot.body.length,
    text,
  });

  let relativePath: string;
  try {
    relativePath = await createSnapshotNote(deps.rootDir, args.kb, notePath, note);
  } catch (err) {
    deps.stderr(`kb import-url: ${(err as Error).message}\n`);
    return 1;
  }

  let refreshed = false;
  if (args.refresh) {
    try {
      await deps.refresh(args.kb);
      refreshed = true;
    } catch (err) {
      if (err instanceof ActiveModelResolutionError) {
        deps.stderr(`kb import-url: ${err.message}\n`);
        return 2;
      }
      deps.stderr(`kb import-url: refresh failed after write: ${(err as Error).message}\n`);
      return 1;
    }
  }

  deps.stdout(`${JSON.stringify({
    knowledge_base_name: args.kb,
    path: relativePath,
    action: 'import-url',
    source_url: args.url,
    final_url: snapshot.finalUrl,
    http_status: snapshot.httpStatus,
    content_type: baseContentType,
    content_sha256: contentSha256,
    byte_count: snapshot.body.length,
    refreshed,
  }, null, 2)}\n`);
  return 0;
}

function resolveTitle(
  override: string | undefined,
  kind: ContentKind,
  body: Buffer,
  finalUrl: string,
): string {
  if (override !== undefined && override.trim() !== '') return override.trim();
  if (kind === 'html') {
    const fromHtml = extractHtmlTitle(body.toString('utf-8'));
    if (fromHtml !== null) return fromHtml;
  }
  return deriveTitleFromUrl(finalUrl);
}

/**
 * Extracts plain text from the downloaded bytes by routing them through the
 * indexer's own loaders. The loaders are filesystem-based, so the bytes are
 * staged in a private temp file whose extension selects the loader; the
 * temp directory is removed unconditionally afterwards.
 */
async function extractText(body: Buffer, kind: ContentKind): Promise<string> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-import-url-'));
  try {
    const tempFile = path.join(tempDir, `snapshot${extensionForKind(kind)}`);
    await fsp.writeFile(tempFile, body);
    return await loadFile(tempFile);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Writes `content` to a new KB note, refusing to overwrite an existing
 * file (the snapshot must not silently clobber). Mirrors the `wx`-open
 * create path of `kb remember`. Returns the KB-relative path written.
 */
async function createSnapshotNote(
  rootDir: string,
  kbName: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const documentPath = await resolveKbPath(rootDir, kbName, relativePath, { mustExist: false });
  await fsp.mkdir(path.dirname(documentPath), { recursive: true });
  try {
    const handle = await fsp.open(documentPath, 'wx');
    try {
      await handle.writeFile(content, 'utf-8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `refusing to overwrite existing note: ${relativePath} (pass --note=<path> to choose another)`,
      );
    }
    throw err;
  }
  const kbDir = await resolveKnowledgeBaseDir(rootDir, kbName);
  return path.relative(kbDir, documentPath).split(path.sep).join('/');
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

// `UrlSnapshotError` is re-exported so callers that only import this module
// can still narrow on the snapshot failure type if needed.
export { UrlSnapshotError };
