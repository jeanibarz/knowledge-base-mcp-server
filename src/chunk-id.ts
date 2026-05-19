import * as path from 'path';
import { pathToFileURL } from 'url';
import type { KBEditorUriMode } from './config/retrieval.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { buildResourceUri, parseKnowledgeBaseResourceUri } from './mcp-resources.js';

export interface ChunkCitation {
  chunk_id: string;
  resource_uri: string;
  path: string;
  line: number;
  column: number;
  editor_uri?: string;
}

interface LineRange {
  from: number;
  to: number;
}

export function buildChunkCitation(
  metadata: Record<string, unknown>,
  editorUriMode: KBEditorUriMode,
): ChunkCitation | null {
  const identity = resolveChunkIdentity(metadata);
  if (identity === null) return null;

  const fragment = buildChunkFragment(metadata);
  if (fragment === null) return null;

  const resourceUri = `${buildResourceUri(identity.knowledgeBase, identity.kbRelativePath)}#${fragment}`;
  const chunkId = `${identity.knowledgeBase}/${encodeRelativePath(identity.kbRelativePath)}#${fragment}`;
  const lineRange = getLineRange(metadata);
  const line = lineRange?.from ?? 1;
  const citation: ChunkCitation = {
    chunk_id: chunkId,
    resource_uri: resourceUri,
    path: identity.displayPath,
    line,
    column: 0,
  };
  const editorUri = buildEditorUri(metadata, editorUriMode, line);
  if (editorUri !== null) {
    citation.editor_uri = editorUri;
  }
  return citation;
}

export function buildChunkId(metadata: Record<string, unknown>): string | null {
  return buildChunkCitation(metadata, 'none')?.chunk_id ?? null;
}

export function buildEditorUri(
  metadata: Record<string, unknown>,
  mode: KBEditorUriMode,
  lineOverride?: number,
): string | null {
  if (mode === 'none') return null;
  const absolutePath = resolveAbsolutePath(metadata);
  if (absolutePath === null) return null;
  const line = lineOverride ?? getLineRange(metadata)?.from;
  if (mode === 'file') {
    const url = pathToFileURL(absolutePath).href;
    return line === undefined ? url : `${url}#L${line}`;
  }
  const suffix = line === undefined ? '' : `:${line}:0`;
  return `${mode}://file${absolutePath}${suffix}`;
}

function resolveChunkIdentity(metadata: Record<string, unknown>): {
  knowledgeBase: string;
  kbRelativePath: string;
  displayPath: string;
} | null {
  const knowledgeBase = resolveKnowledgeBase(metadata);
  const displayPath = resolveDisplayPath(metadata, knowledgeBase);
  if (knowledgeBase === null || displayPath === null) return null;
  const kbRelativePath = stripKnowledgeBasePrefix(displayPath, knowledgeBase);
  if (kbRelativePath === '') return null;
  return { knowledgeBase, kbRelativePath, displayPath };
}

function resolveKnowledgeBase(metadata: Record<string, unknown>): string | null {
  const knowledgeBase = metadata.knowledgeBase;
  if (typeof knowledgeBase === 'string' && knowledgeBase.trim() !== '') {
    return knowledgeBase;
  }
  const relativePath = normalizePosix(metadata.relativePath);
  if (relativePath !== null) {
    const [head] = relativePath.split('/');
    if (head && head !== '.' && head !== '..') return head;
  }
  const source = typeof metadata.source === 'string' ? metadata.source : null;
  if (source) {
    const relative = path.relative(KNOWLEDGE_BASES_ROOT_DIR, source).split(path.sep).join('/');
    const [head] = relative.split('/');
    if (head && head !== '.' && head !== '..' && !head.startsWith('..')) return head;
  }
  return null;
}

function resolveDisplayPath(metadata: Record<string, unknown>, knowledgeBase: string | null): string | null {
  const relativePath = normalizePosix(metadata.relativePath);
  if (relativePath !== null) return relativePath;
  const source = typeof metadata.source === 'string' ? metadata.source : null;
  if (source && path.isAbsolute(source)) {
    const relative = path.relative(KNOWLEDGE_BASES_ROOT_DIR, source).split(path.sep).join('/');
    if (!relative.startsWith('..') && relative !== '') return relative;
  }
  if (source && knowledgeBase !== null && source.trim() !== '') {
    return `${knowledgeBase}/${source.split(path.sep).join('/')}`;
  }
  return null;
}

function stripKnowledgeBasePrefix(displayPath: string, knowledgeBase: string): string {
  return displayPath === knowledgeBase
    ? ''
    : displayPath.startsWith(`${knowledgeBase}/`)
      ? displayPath.slice(knowledgeBase.length + 1)
      : displayPath;
}

function buildChunkFragment(metadata: Record<string, unknown>): string | null {
  const lines = getLineRange(metadata);
  if (lines !== null) return `L${lines.from}-L${lines.to}`;
  const chunkIndex = metadata.chunkIndex ?? metadata.chunk_index;
  if (typeof chunkIndex === 'number' && Number.isInteger(chunkIndex) && chunkIndex >= 0) {
    return `chunk-${chunkIndex}`;
  }
  return null;
}

function getLineRange(metadata: Record<string, unknown>): LineRange | null {
  const loc = metadata.loc;
  if (!loc || typeof loc !== 'object') return null;
  const lines = (loc as Record<string, unknown>).lines;
  if (!lines || typeof lines !== 'object') return null;
  const from = (lines as Record<string, unknown>).from;
  const to = (lines as Record<string, unknown>).to;
  if (!isPositiveInteger(from)) return null;
  return { from, to: isPositiveInteger(to) ? to : from };
}

function resolveAbsolutePath(metadata: Record<string, unknown>): string | null {
  const source = typeof metadata.source === 'string' ? metadata.source : null;
  if (source && path.isAbsolute(source)) return source;
  const identity = resolveChunkIdentity(metadata);
  if (identity === null) return null;
  return path.join(KNOWLEDGE_BASES_ROOT_DIR, identity.knowledgeBase, identity.kbRelativePath);
}

function normalizePosix(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.split(path.sep).join('/');
}

function encodeRelativePath(relativePath: string): string {
  return relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// ---------------------------------------------------------------------------
// Reference parsing (#411) — the inverse of `buildChunkCitation`. `kb open`
// decomposes a chunk id / kb:// URI / KB-relative path so it can resolve the
// source location a retrieval result points back to.
// ---------------------------------------------------------------------------

/**
 * Decomposition of a retrieval reference. The `kbRelativePath` is still
 * untrusted — callers must resolve it through `resolveKbPath`, which owns
 * the traversal and KB-root containment checks.
 */
export interface ChunkReference {
  /** The reference text exactly as supplied. */
  raw: string;
  /** Which of the three accepted forms the reference used. */
  kind: 'chunk-id' | 'kb-uri' | 'path';
  /** KB authority (the first path segment). */
  knowledgeBase: string;
  /** Path below the KB directory — pass straight to `resolveKbPath`. */
  kbRelativePath: string;
  /** KB-prefixed path, matching a search result's `metadata.relativePath`. */
  displayPath: string;
  /** First line of the cited range, when the reference encodes one. */
  lineFrom?: number;
  /** Last line of the cited range; equals `lineFrom` for a single line. */
  lineTo?: number;
  /** Chunk ordinal, when the reference used a `#chunk-<n>` fragment. */
  chunkIndex?: number;
}

interface ParsedFragment {
  lineFrom?: number;
  lineTo?: number;
  chunkIndex?: number;
}

const CHUNK_FRAGMENT_RE = /^(?:L(\d+)(?:-L(\d+))?|chunk-(\d+))$/;

/**
 * Parse a chunk fragment (`L<from>-L<to>`, `L<line>`, or `chunk-<n>`).
 * Returns `null` for any other text so callers can tell a real chunk
 * reference apart from a `#` that merely appears inside a filename.
 */
function parseChunkFragment(fragment: string): ParsedFragment | null {
  const match = CHUNK_FRAGMENT_RE.exec(fragment);
  if (match === null) return null;
  if (match[3] !== undefined) {
    return { chunkIndex: Number(match[3]) };
  }
  const from = Number(match[1]);
  return { lineFrom: from, lineTo: match[2] === undefined ? from : Number(match[2]) };
}

/**
 * Parse a retrieval reference into its KB / path / line components.
 * Accepts the three pointer forms `kb search` prints:
 *
 *   - chunk id   `<kb>/<encoded-path>#L<from>-L<to>` (or `#chunk-<n>`)
 *   - kb:// URI  `kb://<kb>/<encoded-path>` with an optional fragment
 *   - KB path    `<kb>/<relative-path>` (a result's `metadata.relativePath`)
 *
 * Throws on syntactically invalid input.
 */
export function parseChunkReference(input: string): ChunkReference {
  const raw = input.trim();
  if (raw === '') {
    throw new Error('reference must not be empty');
  }

  // Form 1 — kb:// resource URI. `parseKnowledgeBaseResourceUri` strips the
  // fragment itself; it is re-parsed here for the optional line range.
  if (/^kb:\/\//i.test(raw)) {
    const { kbName, relativePath } = parseKnowledgeBaseResourceUri(raw);
    const fragment = parseReferenceFragment(raw, 'kb:// URI');
    return {
      raw,
      kind: 'kb-uri',
      knowledgeBase: kbName,
      kbRelativePath: relativePath,
      displayPath: `${kbName}/${relativePath}`,
      ...(fragment ?? {}),
    };
  }

  // Forms 2 and 3 share a `<kb>/<path>` body. A chunk id is set apart by a
  // trailing `#L..` / `#chunk-<n>` fragment; a `#` followed by anything else
  // is treated as a literal character inside a plain KB-relative path.
  const hashIndex = raw.lastIndexOf('#');
  if (hashIndex !== -1) {
    const fragment = parseChunkFragment(raw.slice(hashIndex + 1));
    if (fragment !== null) {
      const body = raw.slice(0, hashIndex);
      let parsed: { kbName: string; relativePath: string };
      try {
        // A chunk id is a `kb://`-less encoded resource path; re-attach the
        // scheme to reuse the same KB-name / traversal validation.
        parsed = parseKnowledgeBaseResourceUri(`kb://${body}`);
      } catch (err) {
        throw new Error(`invalid chunk id '${raw}': ${(err as Error).message}`);
      }
      return {
        raw,
        kind: 'chunk-id',
        knowledgeBase: parsed.kbName,
        kbRelativePath: parsed.relativePath,
        displayPath: `${parsed.kbName}/${parsed.relativePath}`,
        ...fragment,
      };
    }
  }

  // Form 3 — a plain `<kb>/<relative-path>`, e.g. a search result's path.
  const slashIndex = raw.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= raw.length - 1) {
    throw new Error(
      `cannot parse reference '${raw}' ` +
      `(expected a chunk id, a kb:// URI, or a <kb>/<path> location)`,
    );
  }
  return {
    raw,
    kind: 'path',
    knowledgeBase: raw.slice(0, slashIndex),
    kbRelativePath: raw.slice(slashIndex + 1),
    displayPath: raw,
  };
}

function parseReferenceFragment(raw: string, context: string): ParsedFragment | null {
  const hashIndex = raw.indexOf('#');
  if (hashIndex === -1) return null;
  const fragmentText = raw.slice(hashIndex + 1);
  const fragment = parseChunkFragment(fragmentText);
  if (fragment === null) {
    throw new Error(
      `unrecognized fragment '#${fragmentText}' in ${context} ` +
      `(expected #L<from>-L<to> or #chunk-<n>)`,
    );
  }
  return fragment;
}
