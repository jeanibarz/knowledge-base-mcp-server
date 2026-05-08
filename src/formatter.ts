// RFC 012 §4.9 — extracted from KnowledgeBaseServer.ts so both the MCP
// surface and the CLI can produce byte-equal markdown output without the
// CLI having to import the MCP class (which would drag in McpServer,
// StdioServerTransport, SseHost, ReindexTriggerWatcher, and zod).

import type { Document } from '@langchain/core/documents';

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
}

export interface GroupedRetrievalChunk extends RetrievalJsonResult {
  location: unknown | null;
}

export interface GroupedRetrievalSource {
  source: string;
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
        const metadata = JSON.stringify(sanitizedMetadata, null, 2);
        const scoreText = doc.score !== undefined ? `**Score:** ${doc.score.toFixed(2)}\n\n` : '';
        return `${resultHeader}\n\n${scoreText}${content}\n\n**Source:**\n\`\`\`json\n${metadata}\n\`\`\``;
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
): string {
  const grouped = groupRetrievalBySource(results, extrasVisible);
  let formattedResults = '';
  if (grouped.length > 0) {
    formattedResults = grouped
      .map((group, idx) => {
        const chunks = group.chunks
          .map((chunk, chunkIdx) => {
            const scoreText = formatScore(chunk.score);
            const locationText = formatLocation(chunk.location);
            return `${chunkIdx + 1}. **Score:** ${scoreText}\n   **Location:** ${locationText}\n\n   ${indentChunkContent(chunk.content.trim())}`;
          })
          .join('\n\n');
        return (
          `**Source ${idx + 1}:** \`${group.source}\`\n\n` +
          `**Best score:** ${formatScore(group.best_score)}\n\n` +
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
): RetrievalJsonResult[] {
  if (!results || results.length === 0) return [];
  return results.map((doc) => ({
    score: doc.score ?? null,
    content: doc.pageContent,
    metadata: sanitizeMetadataForWire(
      doc.metadata as Record<string, unknown>,
      extrasVisible,
    ),
  }));
}

export function groupRetrievalBySource(
  results: ScoredDocument[] | null | undefined,
  extrasVisible: boolean,
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
      group = { source, best_score: null, locations: [], chunks: [] };
      bySource.set(source, group);
      groups.push(group);
    }

    const score = doc.score ?? null;
    const location = getChunkLocation(sanitizedMetadata);
    group.best_score = bestScore(group.best_score, score);
    group.locations.push({ score, location });
    group.chunks.push({
      score,
      content: doc.pageContent,
      metadata: sanitizedMetadata,
      location,
    });
  });

  return groups;
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
