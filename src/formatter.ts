// RFC 012 §4.9 — extracted from KnowledgeBaseServer.ts so both the MCP
// surface and the CLI can produce byte-equal markdown output without the
// CLI having to import the MCP class (which would drag in McpServer,
// StdioServerTransport, SseHost, ReindexTriggerWatcher, and zod).

import type { Document } from '@langchain/core/documents';
import { buildChunkCitation, type ChunkCitation } from './chunk-id.js';
import { KB_EDITOR_URI, type KBEditorUriMode } from './config.js';
import { getInjectionSignals, type InjectionSignal } from './kb-shield.js';

/**
 * Score-bearing search result. Mirrors the shape `FaissIndexManager.similaritySearch`
 * returns (Document + score grafted on as a non-standard field).
 */
export interface ScoredDocument extends Document {
  score?: number;
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
  let formattedResults = '';
  if (results && results.length > 0) {
    formattedResults = results
      .map((doc, idx) => {
        const resultHeader = `**Result ${idx + 1}:**`;
        const content = doc.pageContent.trim();
        const sanitizedMetadata = sanitizeMetadataForWire(
          doc.metadata as Record<string, unknown>,
          extrasVisible,
        );
        const citation = buildChunkCitation(sanitizedMetadata, editorUriMode);
        const metadata = JSON.stringify(sanitizedMetadata, null, 2);
        const scoreText = doc.score !== undefined ? `**Score:** ${doc.score.toFixed(2)}\n\n` : '';
        const signals = getInjectionSignals(doc.pageContent);
        const shieldFooter = formatInjectionMarkdown(signals);
        return `${resultHeader}\n\n${scoreText}${content}\n\n${shieldFooter}${formatSourceBlock(metadata, citation)}`;
      })
      .join('\n\n---\n\n');
  } else {
    formattedResults = '_No similar results found._';
  }
  const disclaimer = '\n\n> **Disclaimer:** The provided results might not all be relevant. Please cross-check the relevance of the information.';
  return `## Semantic Search Results\n\n${formattedResults}${disclaimer}`;
}

export function formatRetrievalGroupedBySourceAsMarkdown(
  results: ScoredDocument[] | null | undefined,
  extrasVisible: boolean,
  editorUriMode: KBEditorUriMode = KB_EDITOR_URI,
): string {
  const grouped = groupRetrievalBySource(results, extrasVisible, editorUriMode);
  let formattedResults = '';
  if (grouped.length > 0) {
    formattedResults = grouped
      .map((group, idx) => {
        const chunks = group.chunks
          .map((chunk, chunkIdx) => {
            const scoreText = formatScore(chunk.score);
            const locationText = formatLocation(chunk.location);
            const openText = chunk.editor_uri ? `\n   **Open:** ${chunk.editor_uri}` : '';
            const shieldText = formatInjectionGrouped(chunk.injection_signals);
            return `${chunkIdx + 1}. **Score:** ${scoreText}\n   **Location:** ${locationText}${openText}\n\n   ${indentChunkContent(chunk.content.trim())}${shieldText}`;
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
  } else {
    formattedResults = '_No similar results found._';
  }
  const disclaimer = '\n\n> **Disclaimer:** The provided results might not all be relevant. Please cross-check the relevance of the information.';
  return `## Semantic Search Results\n\n${formattedResults}${disclaimer}`;
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
  return results.map((doc) => {
    const metadata = sanitizeMetadataForWire(
      doc.metadata as Record<string, unknown>,
      extrasVisible,
    );
    const citation = buildChunkCitation(metadata, editorUriMode);
    const signals = getInjectionSignals(doc.pageContent);
    return {
      score: doc.score ?? null,
      content: doc.pageContent,
      metadata,
      ...(citation ? { chunk_id: citation.chunk_id } : {}),
      ...(citation?.editor_uri ? { editor_uri: citation.editor_uri } : {}),
      ...(signals !== undefined ? { injection_signals: signals } : {}),
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
    const citation = buildChunkCitation(sanitizedMetadata, editorUriMode);
    const signals = getInjectionSignals(doc.pageContent);
    group.chunk_count += 1;
    group.best_score = bestScore(group.best_score, score);
    group.locations.push({ score, location });
    group.chunks.push({
      score,
      content: doc.pageContent,
      metadata: sanitizedMetadata,
      location,
      ...(citation ? { chunk_id: citation.chunk_id } : {}),
      ...(citation?.editor_uri ? { editor_uri: citation.editor_uri } : {}),
      ...(signals !== undefined ? { injection_signals: signals } : {}),
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

function formatSourceBlock(metadata: string, citation: ChunkCitation | null): string {
  if (citation === null) {
    return `**Source:**\n\`\`\`json\n${metadata}\n\`\`\``;
  }
  const openLine = citation.editor_uri ? `\n**Open:** ${citation.editor_uri}` : '';
  return `**Source:** [${citation.chunk_id}](${citation.resource_uri})${openLine}\n\n\`\`\`json\n${metadata}\n\`\`\``;
}
