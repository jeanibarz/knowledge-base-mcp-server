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

/**
 * Produces the JSON shape the CLI emits with `--format=json`. Includes the
 * sanitized metadata and the score as a top-level field so callers don't
 * have to dig into a nested object.
 */
export function formatRetrievalAsJson(
  results: ScoredDocument[] | null | undefined,
  extrasVisible: boolean,
): Array<{ score: number | null; content: string; metadata: Record<string, unknown> }> {
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
