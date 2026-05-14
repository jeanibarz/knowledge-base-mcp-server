// RFC 012 §4.9 — extracted from KnowledgeBaseServer.ts so both the MCP
// surface and the CLI can produce byte-equal markdown output without the
// CLI having to import the MCP class (which would drag in McpServer,
// StdioServerTransport, SseHost, ReindexTriggerWatcher, and zod).

import type { Document } from '@langchain/core/documents';
import { buildChunkCitation, type ChunkCitation } from './chunk-id.js';
import { KB_EDITOR_URI, type KBEditorUriMode } from './config/retrieval.js';
import {
  applyInjectionGuard,
  isInjectionGuardBypassed,
  resolveInjectionGuardOptions,
  type InjectionGuardOptions,
} from './injection-guard.js';
import { getInjectionSignals, type InjectionSignal } from './kb-shield.js';

/**
 * Score-bearing search result. Mirrors the shape `FaissIndexManager.similaritySearch`
 * returns (Document + score grafted on as a non-standard field).
 */
export interface ScoredDocument extends Document {
  score?: number;
  matchType?: 'semantic';
  semanticMatch?: true;
  contextChunks?: ContextDocument[];
  contextTruncated?: boolean;
}

export interface ContextDocument extends Document {
  matchType: 'context';
  semanticMatch: false;
  contextDirection: 'before' | 'after';
  contextDistance: number;
}

export interface RetrievalJsonResult {
  score: number | null;
  content: string;
  metadata: Record<string, unknown>;
  chunk_id?: string;
  editor_uri?: string;
  /**
   * Issue #217 — `kb-shield` retrieval-time prompt-injection signals. Populated
   * with an array (possibly empty) when `KB_SHIELD` is enabled; the field is
   * omitted when `KB_SHIELD=off`. Signals are evidence the downstream agent
   * uses to decide policy — the chunk's `content` is **never** modified.
   */
  injection_signals?: InjectionSignal[];
  match_type?: 'semantic';
  semantic_match?: true;
  context_chunks?: RetrievalJsonContextChunk[];
  context_truncated?: boolean;
}

export interface RetrievalJsonContextChunk {
  match_type: 'context';
  semantic_match: false;
  direction: 'before' | 'after';
  distance: number;
  content: string;
  metadata: Record<string, unknown>;
  chunk_id?: string;
  editor_uri?: string;
  injection_signals?: InjectionSignal[];
}

export interface GroupedRetrievalChunk extends RetrievalJsonResult {
  location: unknown | null;
}

export interface GroupedRetrievalSource {
  source: string;
  chunk_count: number;
  best_score: number | null;
  locations: Array<{ score: number | null; location: unknown | null }>;
  chunks: GroupedRetrievalChunk[];
}

/**
 * Strips `frontmatter.extras` from a chunk's metadata before wire
 * serialization unless the operator has opted back in via
 * `FRONTMATTER_EXTRAS_WIRE_VISIBLE=true`. RFC 011 §7.1 R1 — extras are a
 * leak surface the operator owns; the default posture is to suppress.
 *
 * Shallow-clones only the branches it mutates to avoid touching the
 * original `Document.metadata` (which is cached in the FAISS store).
 */
export function sanitizeMetadataForWire(
  metadata: Record<string, unknown>,
  extrasVisible: boolean,
): Record<string, unknown> {
  if (extrasVisible) return metadata;
  const fm = metadata.frontmatter;
  if (!fm || typeof fm !== 'object') return metadata;
  const fmObj = fm as Record<string, unknown>;
  if (!('extras' in fmObj)) return metadata;
  const { extras, ...fmWithoutExtras } = fmObj;
  void extras;
  return {
    ...metadata,
    frontmatter: fmWithoutExtras,
  };
}

const SEMANTIC_SEARCH_HEADER = '## Semantic Search Results';
const SEMANTIC_SEARCH_DISCLAIMER =
  '\n\n> **Disclaimer:** The provided results might not all be relevant. Please cross-check the relevance of the information.';
const NO_RESULTS_LINE = '_No similar results found._';

/**
 * Renders the empty-result body for `kb search` / `retrieve_knowledge`. With no
 * argument it matches the legacy `_No similar results found._` block; with an
 * `inlineGuidance` markdown fragment it injects that block between the
 * "no results" line and the disclaimer (issue #335).
 *
 * Issue #335 — CLI-only callers pass a staleness-derived inline tip so the
 * refresh command lands at the empty result, not just in the trailing footer.
 * MCP callers stay on the no-argument path and keep byte-equal output.
 */
export function formatRetrievalEmptyAsMarkdown(inlineGuidance?: string): string {
  const guidance = inlineGuidance ? `\n\n${inlineGuidance}` : '';
  return `${SEMANTIC_SEARCH_HEADER}\n\n${NO_RESULTS_LINE}${guidance}${SEMANTIC_SEARCH_DISCLAIMER}`;
}

/**
 * Produces the markdown body of a `retrieve_knowledge` / `kb search` response.
 * Byte-equal to the previous inline KnowledgeBaseServer formatting. Adding a
 * trailing freshness footer (CLI-only, RFC 012 §4.10) is the caller's
 * responsibility; this function owns body format only.
 */
export function formatRetrievalAsMarkdown(
  results: ScoredDocument[] | null | undefined,
  extrasVisible: boolean,
  editorUriMode: KBEditorUriMode = KB_EDITOR_URI,
): string {
  if (!results || results.length === 0) {
    return formatRetrievalEmptyAsMarkdown();
  }
  const guardOptions = resolveInjectionGuardOptions();
  const formattedResults = results
    .map((doc, idx) => {
      const hasContextAnnotation = hasNeighborContextAnnotation(doc);
      const resultHeader = hasContextAnnotation
        ? `**Result ${idx + 1} (semantic match):**`
        : `**Result ${idx + 1}:**`;
      const sanitizedMetadata = sanitizeMetadataForWire(
        doc.metadata as Record<string, unknown>,
        extrasVisible,
      );
      const guarded = guardRetrievalChunk(doc.pageContent, sanitizedMetadata, guardOptions);
      const content = guarded.content.trim();
      const citation = buildChunkCitation(guarded.metadata, editorUriMode);
      const metadata = JSON.stringify(guarded.metadata, null, 2);
      const scoreText = doc.score !== undefined ? `**Score:** ${doc.score.toFixed(2)}\n\n` : '';
      const signals = getShieldSignals(doc.pageContent, sanitizedMetadata, guardOptions);
      const shieldFooter = formatInjectionMarkdown(signals);
      const contextText = formatContextChunksAsMarkdown(doc, extrasVisible, editorUriMode);
      return `${resultHeader}\n\n${scoreText}${content}\n\n${shieldFooter}${formatSourceBlock(metadata, citation)}${contextText}`;
    })
    .join('\n\n---\n\n');
  return `${SEMANTIC_SEARCH_HEADER}\n\n${formattedResults}${SEMANTIC_SEARCH_DISCLAIMER}`;
}

export function formatRetrievalGroupedBySourceAsMarkdown(
  results: ScoredDocument[] | null | undefined,
  extrasVisible: boolean,
  editorUriMode: KBEditorUriMode = KB_EDITOR_URI,
): string {
  const grouped = groupRetrievalBySource(results, extrasVisible, editorUriMode);
  if (grouped.length === 0) {
    return formatRetrievalEmptyAsMarkdown();
  }
  const formattedResults = grouped
    .map((group, idx) => {
      const chunks = group.chunks
        .map((chunk, chunkIdx) => {
          const scoreText = formatScore(chunk.score);
          const locationText = formatLocation(chunk.location);
          const openText = chunk.editor_uri ? `\n   **Open:** ${chunk.editor_uri}` : '';
          const shieldText = formatInjectionGrouped(chunk.injection_signals);
          const typeText = chunk.match_type ? `\n   **Type:** ${chunk.match_type}` : '';
          const contextText = formatJsonContextChunksForGroupedMarkdown(chunk.context_chunks);
          return `${chunkIdx + 1}. **Score:** ${scoreText}${typeText}\n   **Location:** ${locationText}${openText}\n\n   ${indentChunkContent(chunk.content.trim())}${shieldText}${contextText}`;
        })
        .join('\n\n');
      return (
        `**Source ${idx + 1}:** \`${group.source}\`\n\n` +
        `**Best score:** ${formatScore(group.best_score)}\n\n` +
        `**Chunk count:** ${group.chunk_count}\n\n` +
        `**Matching chunks:**\n\n${chunks}`
      );
    })
    .join('\n\n---\n\n');
  return `${SEMANTIC_SEARCH_HEADER}\n\n${formattedResults}${SEMANTIC_SEARCH_DISCLAIMER}`;
}

/**
 * Produces the JSON shape the CLI emits with `--format=json`. Includes the
 * sanitized metadata and the score as a top-level field so callers don't
 * have to dig into a nested object.
 */
export function formatRetrievalAsJson(
  results: ScoredDocument[] | null | undefined,
  extrasVisible: boolean,
  editorUriMode: KBEditorUriMode = KB_EDITOR_URI,
): RetrievalJsonResult[] {
  if (!results || results.length === 0) return [];
  const guardOptions = resolveInjectionGuardOptions();
  return results.map((doc) => {
    const metadata = sanitizeMetadataForWire(
      doc.metadata as Record<string, unknown>,
      extrasVisible,
    );
    const guarded = guardRetrievalChunk(doc.pageContent, metadata, guardOptions);
    const citation = buildChunkCitation(guarded.metadata, editorUriMode);
    const signals = getShieldSignals(doc.pageContent, metadata, guardOptions);
    return {
      score: doc.score ?? null,
      content: guarded.content,
      metadata: guarded.metadata,
      ...(citation ? { chunk_id: citation.chunk_id } : {}),
      ...(citation?.editor_uri ? { editor_uri: citation.editor_uri } : {}),
      ...(signals !== undefined ? { injection_signals: signals } : {}),
      ...(hasNeighborContextAnnotation(doc)
        ? {
            match_type: 'semantic' as const,
            semantic_match: true as const,
          }
        : {}),
      ...(doc.contextChunks && doc.contextChunks.length > 0
        ? { context_chunks: formatContextChunksAsJson(doc.contextChunks, extrasVisible, editorUriMode) }
        : {}),
      ...(doc.contextTruncated ? { context_truncated: true } : {}),
    };
  });
}

export function groupRetrievalBySource(
  results: ScoredDocument[] | null | undefined,
  extrasVisible: boolean,
  editorUriMode: KBEditorUriMode = KB_EDITOR_URI,
): GroupedRetrievalSource[] {
  if (!results || results.length === 0) return [];

  const groups: GroupedRetrievalSource[] = [];
  const bySource = new Map<string, GroupedRetrievalSource>();
  const guardOptions = resolveInjectionGuardOptions();

  results.forEach((doc, idx) => {
    const sanitizedMetadata = sanitizeMetadataForWire(
      doc.metadata as Record<string, unknown>,
      extrasVisible,
    );
    const source = getSourcePath(sanitizedMetadata, idx);
    let group = bySource.get(source);
    if (group === undefined) {
      group = { source, chunk_count: 0, best_score: null, locations: [], chunks: [] };
      bySource.set(source, group);
      groups.push(group);
    }

    const score = doc.score ?? null;
    const location = getChunkLocation(sanitizedMetadata);
    const guarded = guardRetrievalChunk(doc.pageContent, sanitizedMetadata, guardOptions);
    const citation = buildChunkCitation(guarded.metadata, editorUriMode);
    const signals = getShieldSignals(doc.pageContent, sanitizedMetadata, guardOptions);
    group.chunk_count += 1;
    group.best_score = bestScore(group.best_score, score);
    group.locations.push({ score, location });
    group.chunks.push({
      score,
      content: guarded.content,
      metadata: guarded.metadata,
      location,
      ...(citation ? { chunk_id: citation.chunk_id } : {}),
      ...(citation?.editor_uri ? { editor_uri: citation.editor_uri } : {}),
      ...(signals !== undefined ? { injection_signals: signals } : {}),
      ...(hasNeighborContextAnnotation(doc)
        ? {
            match_type: 'semantic' as const,
            semantic_match: true as const,
          }
        : {}),
      ...(doc.contextChunks && doc.contextChunks.length > 0
        ? { context_chunks: formatContextChunksAsJson(doc.contextChunks, extrasVisible, editorUriMode) }
        : {}),
      ...(doc.contextTruncated ? { context_truncated: true } : {}),
    });
  });

  return groups;
}

export function formatRetrievalAsVimgrep(
  results: ScoredDocument[] | null | undefined,
): string {
  if (!results || results.length === 0) return '';
  return results
    .map((doc, idx) => {
      const metadata = doc.metadata as Record<string, unknown>;
      const citation = buildChunkCitation(metadata, 'none');
      const fallbackPath = getSourcePath(metadata, idx);
      const preview = doc.pageContent.trim().replace(/\s+/g, ' ').slice(0, 80);
      return `${citation?.path ?? fallbackPath}:${citation?.line ?? 1}:${citation?.column ?? 0}:${preview}`;
    })
    .join('\n');
}

function getSourcePath(metadata: Record<string, unknown>, idx: number): string {
  const source = metadata.source;
  if (typeof source === 'string' && source.trim() !== '') {
    return source;
  }
  const relativePath = metadata.relativePath;
  if (typeof relativePath === 'string' && relativePath.trim() !== '') {
    return relativePath;
  }
  return `(unknown source ${idx + 1})`;
}

function getChunkLocation(metadata: Record<string, unknown>): unknown | null {
  if ('loc' in metadata) return metadata.loc;
  if ('chunkIndex' in metadata) return { chunkIndex: metadata.chunkIndex };
  if ('chunk_index' in metadata) return { chunk_index: metadata.chunk_index };
  return null;
}

function bestScore(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return Math.min(current, candidate);
}

function formatScore(score: number | null): string {
  return score === null ? 'n/a' : score.toFixed(2);
}

function formatLocation(location: unknown | null): string {
  if (location === null || location === undefined) return 'not recorded';
  return `\`${JSON.stringify(location)}\``;
}

function indentChunkContent(content: string): string {
  if (content === '') return '';
  return content.replace(/\n/g, '\n   ');
}

/**
 * Issue #217 — render `kb-shield` hits as inline blockquote lines beneath an
 * offending chunk in the flat markdown view. Visible to the human operator,
 * not blocking — the chunk content stays untouched above.
 */
function formatInjectionMarkdown(signals: InjectionSignal[] | undefined): string {
  if (!signals || signals.length === 0) return '';
  const lines = signals
    .map((s) => `> ⚠ injection-signal: ${s.rule} [${s.span_start}, ${s.span_end})`)
    .join('\n');
  return `${lines}\n\n`;
}

/**
 * Same idea as `formatInjectionMarkdown`, but indented so it lines up with the
 * grouped-by-source numbered chunk list.
 */
function formatInjectionGrouped(signals: InjectionSignal[] | undefined): string {
  if (!signals || signals.length === 0) return '';
  const lines = signals
    .map((s) => `\n   > ⚠ injection-signal: ${s.rule} [${s.span_start}, ${s.span_end})`)
    .join('');
  return lines;
}

function formatInjectionContext(signals: InjectionSignal[] | undefined): string {
  if (!signals || signals.length === 0) return '';
  const lines = signals
    .map((s) => `\n  > ⚠ injection-signal: ${s.rule} [${s.span_start}, ${s.span_end})`)
    .join('');
  return lines;
}

function guardRetrievalChunk(
  content: string,
  metadata: Record<string, unknown>,
  options: InjectionGuardOptions,
): { content: string; metadata: Record<string, unknown> } {
  return applyInjectionGuard(content, metadata, options);
}

function getShieldSignals(
  content: string,
  metadata: Record<string, unknown>,
  options: InjectionGuardOptions,
): InjectionSignal[] | undefined {
  if (isInjectionGuardBypassed(metadata, options)) return undefined;
  return getInjectionSignals(content);
}

function hasNeighborContextAnnotation(doc: ScoredDocument): boolean {
  return doc.matchType === 'semantic' || doc.semanticMatch === true || doc.contextChunks !== undefined;
}

function formatContextChunksAsMarkdown(
  doc: ScoredDocument,
  extrasVisible: boolean,
  editorUriMode: KBEditorUriMode,
): string {
  if (!doc.contextChunks || doc.contextChunks.length === 0) {
    return doc.contextTruncated ? '\n\n**Context chunks:** truncated by response cap.' : '';
  }
  const guardOptions = resolveInjectionGuardOptions();
  const chunks = doc.contextChunks
    .map((chunk) => {
      const metadata = sanitizeMetadataForWire(
        chunk.metadata as Record<string, unknown>,
        extrasVisible,
      );
      const guarded = guardRetrievalChunk(chunk.pageContent, metadata, guardOptions);
      const citation = buildChunkCitation(guarded.metadata, editorUriMode);
      const signals = getShieldSignals(chunk.pageContent, metadata, guardOptions);
      const openText = citation?.editor_uri ? `\n   **Open:** ${citation.editor_uri}` : '';
      const sourceText = citation ? `\n   **Source:** ${citation.chunk_id}` : '';
      const shieldText = formatInjectionContext(signals);
      return (
        `- **Context (${chunk.contextDirection}, distance ${chunk.contextDistance}):**${sourceText}${openText}\n\n` +
        `  ${indentListContent(guarded.content.trim())}${shieldText}`
      );
    })
    .join('\n\n');
  const truncated = doc.contextTruncated ? '\n\n_Context truncated by response cap._' : '';
  return `\n\n**Context chunks:**\n\n${chunks}${truncated}`;
}

function formatContextChunksAsJson(
  chunks: ContextDocument[],
  extrasVisible: boolean,
  editorUriMode: KBEditorUriMode,
): RetrievalJsonContextChunk[] {
  const guardOptions = resolveInjectionGuardOptions();
  return chunks.map((chunk) => {
    const metadata = sanitizeMetadataForWire(
      chunk.metadata as Record<string, unknown>,
      extrasVisible,
    );
    const guarded = guardRetrievalChunk(chunk.pageContent, metadata, guardOptions);
    const citation = buildChunkCitation(guarded.metadata, editorUriMode);
    const signals = getShieldSignals(chunk.pageContent, metadata, guardOptions);
    return {
      match_type: 'context',
      semantic_match: false,
      direction: chunk.contextDirection,
      distance: chunk.contextDistance,
      content: guarded.content,
      metadata: guarded.metadata,
      ...(citation ? { chunk_id: citation.chunk_id } : {}),
      ...(citation?.editor_uri ? { editor_uri: citation.editor_uri } : {}),
      ...(signals !== undefined ? { injection_signals: signals } : {}),
    };
  });
}

function formatJsonContextChunksForGroupedMarkdown(
  chunks: RetrievalJsonContextChunk[] | undefined,
): string {
  if (!chunks || chunks.length === 0) return '';
  const lines = chunks
    .map((chunk) => (
      `   - **Context (${chunk.direction}, distance ${chunk.distance}):**\n\n` +
      `     ${indentListContent(chunk.content.trim())}${formatInjectionGrouped(chunk.injection_signals)}`
    ))
    .join('\n\n');
  return `\n\n   **Context chunks:**\n\n${lines}`;
}

function indentListContent(content: string): string {
  if (content === '') return '';
  return content.replace(/\n/g, '\n  ');
}

function formatSourceBlock(metadata: string, citation: ChunkCitation | null): string {
  if (citation === null) {
    return `**Source:**\n\`\`\`json\n${metadata}\n\`\`\``;
  }
  const openLine = citation.editor_uri ? `\n**Open:** ${citation.editor_uri}` : '';
  return `**Source:** [${citation.chunk_id}](${citation.resource_uri})${openLine}\n\n\`\`\`json\n${metadata}\n\`\`\``;
}
