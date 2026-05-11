import * as path from 'path';
import { pathToFileURL } from 'url';
import type { KBEditorUriMode } from './config.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { buildResourceUri } from './mcp-resources.js';

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
