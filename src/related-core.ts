// related-core.ts
//
// Command-independent "more-like-this" core behind both the `kb related` CLI
// adapter (`cli-related.ts`) and the `find_related` MCP tool
// (`KnowledgeBaseServer.ts`). Per the repo's non-CLI import boundary (issue
// #405 / `non-cli-import-boundary.test.ts`), the MCP server must NOT import a
// `cli-*` command adapter, so the reusable retrieval + formatting logic lives
// here and both surfaces import it.
//
// This module owns no I/O or process concerns (no argv parsing, no stdout, no
// exit codes): it takes an already-loaded index manager and returns structured
// results, leaving each caller to apply its own transport contract.

import type { Document } from '@langchain/core/documents';
import type {
  FaissIndexManager,
  SearchResultDocument,
  SimilaritySearchTiming,
} from './FaissIndexManager.js';
import { buildChunkId, parseChunkReference, type ChunkReference } from './chunk-id.js';
import { FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI } from './config/retrieval.js';
import { formatRetrievalAsJson, type ScoredDocument } from './formatter.js';

/**
 * Validate and parse a related-search target. Accepts the two addressable
 * pointer forms a prior search result carries — a public chunk id or a `kb://`
 * resource URI — and rejects a bare `<kb>/<path>` location (which cannot name a
 * single chunk). Shared so the CLI `kb related` argument and the MCP
 * `find_related` `chunk_id` argument go through the exact same gate.
 */
export function parseRelatedTarget(
  target: string,
): { value: ChunkReference } | { error: string } {
  try {
    const reference = parseChunkReference(target);
    if (reference.kind === 'path') {
      return { error: 'expected a chunk id or kb:// URI, got a KB-relative path' };
    }
    return { value: reference };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * The read-only slice of a loaded index the related core needs: resolve a seed
 * chunk by reference, then run dense similarity over its text. Both the CLI
 * (`runRelated`) and the MCP `find_related` handler supply a `FaissIndexManager`
 * that satisfies this.
 */
export interface RelatedCoreManager {
  findChunkByReference(reference: ChunkReference): Document | null;
  similaritySearch: FaissIndexManager['similaritySearch'];
}

/**
 * The semantic knobs of a related search, shared by the CLI and the MCP tool.
 * The CLI's `RelatedArgs` is a structural superset (it adds CLI-only
 * `target`/`format`), so the CLI can pass its parsed args straight through.
 */
export interface RelatedCoreOptions {
  k: number;
  threshold: number;
  includeSelf: boolean;
  noCache: boolean;
  kb?: string;
  allKbs: boolean;
}

export type RelatedCoreResult =
  | { seed: Document; scopedKb: string | undefined; results: SearchResultDocument[] }
  | { seedNotFound: true };

/**
 * The read-only "more-like-this" core behind `kb related` and the MCP
 * `find_related` tool. Resolves the seed chunk from the loaded index, runs
 * dense similarity search using the seed chunk's own text, and excludes the
 * seed from the results unless `includeSelf` is set. Returns `seedNotFound`
 * when no indexed chunk matches the reference so each caller can map it to its
 * own error contract (CLI exit code 1 / MCP KB_NOT_FOUND). Performs no I/O
 * beyond the two manager calls — all retrieval logic stays in the manager.
 */
export async function findRelatedCore(
  manager: RelatedCoreManager,
  reference: ChunkReference,
  options: RelatedCoreOptions,
): Promise<RelatedCoreResult> {
  const seed = manager.findChunkByReference(reference);
  if (seed === null) {
    return { seedNotFound: true };
  }

  const scopedKb = options.allKbs ? undefined : (options.kb ?? reference.knowledgeBase);
  const fetchK = options.includeSelf ? options.k : options.k + 1;
  const timing: SimilaritySearchTiming = {};
  const rawResults = await manager.similaritySearch(
    seed.pageContent,
    fetchK,
    options.threshold,
    scopedKb,
    undefined,
    timing,
    { noCache: options.noCache },
  );
  const results = options.includeSelf
    ? rawResults.slice(0, options.k)
    : excludeSeed(rawResults, seed).slice(0, options.k);
  return { seed, scopedKb, results };
}

/** Structured `kb.related.v1` payload shared by the CLI `--format=json` output and the MCP `find_related` tool. */
export interface RelatedJsonPayload {
  schema_version: 'kb.related.v1';
  seed: Record<string, unknown>;
  scoped_kb: string | null;
  include_self: boolean;
  results: ReturnType<typeof formatRetrievalAsJson>;
}

/**
 * Build the `kb.related.v1` JSON payload (seed + scoped KB + related results)
 * from a resolved `findRelatedCore` result. Shared so the CLI JSON output and
 * the MCP `find_related` response are byte-identical.
 */
export function buildRelatedJsonPayload(input: {
  target: string;
  seed: Document;
  scopedKb: string | undefined;
  includeSelf: boolean;
  results: SearchResultDocument[];
}): RelatedJsonPayload {
  const seedMetadata = input.seed.metadata as Record<string, unknown>;
  const [formattedSeed] = formatRetrievalAsJson(
    [input.seed as ScoredDocument],
    FRONTMATTER_EXTRAS_WIRE_VISIBLE,
    KB_EDITOR_URI,
  );
  const { score: _seedScore, ...seedPayload } = formattedSeed ?? {
    content: input.seed.pageContent,
    metadata: seedMetadata,
    chunk_id: buildChunkId(seedMetadata) ?? undefined,
  };
  void _seedScore;
  return {
    schema_version: 'kb.related.v1',
    seed: {
      target: input.target,
      ...seedPayload,
    },
    scoped_kb: input.scopedKb ?? null,
    include_self: input.includeSelf,
    results: formatRetrievalAsJson(input.results, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI),
  };
}

/**
 * Drop the seed chunk from a related-search result set by matching its public
 * chunk id. When the seed has no derivable chunk id the results are returned
 * unchanged (the caller's `k` slice still bounds the output).
 */
function excludeSeed(
  results: SearchResultDocument[],
  seed: Document,
): SearchResultDocument[] {
  const seedId = buildChunkId(seed.metadata as Record<string, unknown>);
  if (seedId === null) return results;
  return results.filter((result) => (
    buildChunkId(result.metadata as Record<string, unknown>) !== seedId
  ));
}
