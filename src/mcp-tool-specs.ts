// mcp-tool-specs.ts
//
// Single source of truth for the MCP tool surface: each tool's name, its
// model-facing description, the Zod input shape, and whether it is gated behind
// KB_INGEST_ENABLED. KnowledgeBaseServer registers tools from this list, and
// scripts/gen-mcp-tools-doc.mjs renders docs/reference/mcp-tools.md from it so
// the doc cannot drift from the registered surface.
//
// This module is deliberately side-effect-free: it imports only zod and the
// description constants, never the server/index/FAISS stack. The doc generator
// can therefore import the built `build/mcp-tool-specs.js` without booting a
// server.

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';

import {
  ADD_DOCUMENT_DESCRIPTION,
  ASK_KNOWLEDGE_DESCRIPTION,
  DELETE_DOCUMENT_DESCRIPTION,
  DIFF_INDEX_DESCRIPTION,
  FIND_RELATED_DESCRIPTION,
  KB_STATS_DESCRIPTION,
  LIST_FACETS_DESCRIPTION,
  LIST_KNOWLEDGE_BASES_DESCRIPTION,
  LIST_MODELS_DESCRIPTION,
  RECOMMEND_KNOWLEDGE_BASE_DESCRIPTION,
  REINDEX_KNOWLEDGE_BASE_DESCRIPTION,
  RETRIEVE_KNOWLEDGE_DESCRIPTION,
} from './config/mcp-descriptions.js';

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export const KB_MAX_QUERY_CHARS = parsePositiveIntEnv(process.env.KB_MAX_QUERY_CHARS, 8192);
export const KB_MAX_FILTER_ITEMS = parsePositiveIntEnv(process.env.KB_MAX_FILTER_ITEMS, 64);
export const KB_MAX_GLOB_CHARS = parsePositiveIntEnv(process.env.KB_MAX_GLOB_CHARS, 1024);
export const KB_MAX_GLOB_WILDCARDS = parsePositiveIntEnv(process.env.KB_MAX_GLOB_WILDCARDS, 64);

const boundedQueryString = () =>
  z.string().max(
    KB_MAX_QUERY_CHARS,
    `query must be at most ${KB_MAX_QUERY_CHARS} characters`,
  );

const boundedFilterArray = () =>
  z.array(z.string()).max(
    KB_MAX_FILTER_ITEMS,
    `at most ${KB_MAX_FILTER_ITEMS} items are allowed`,
  );

// path_glob: cap raw length AND wildcard count. minimatch translates each
// wildcard into regex alternation; an unbounded wildcard count is the
// complexity lever a hostile glob would pull, so a length cap alone is
// insufficient.
const boundedGlobString = () =>
  z
    .string()
    .max(KB_MAX_GLOB_CHARS, `path_glob must be at most ${KB_MAX_GLOB_CHARS} characters`)
    .refine(
      (value) => (value.match(/[*?]/g)?.length ?? 0) <= KB_MAX_GLOB_WILDCARDS,
      `path_glob must contain at most ${KB_MAX_GLOB_WILDCARDS} wildcard characters`,
    );

export const RETRIEVE_KNOWLEDGE_INPUT = {
  query: boundedQueryString().describe('The search query to use for retrieving similar chunks from the knowledge base.'),
  knowledge_base_name: z.string().optional().describe('The name of the knowledge base to search. If omitted, all available knowledge bases are considered.'),
  // Issue #975 — search a named subset of shelves, mirroring the research CLI's
  // repeatable `--include-kb`. Mutually exclusive with knowledge_base_name:
  // passing both is a VALIDATION error. Omitting it keeps the single-or-all
  // scope of knowledge_base_name; an unknown name fails closed with
  // KB_NOT_FOUND.
  knowledge_base_names: boundedFilterArray().optional().describe('Search only this named subset of knowledge bases (e.g. ["runbooks", "adr"]). Mutually exclusive with knowledge_base_name — passing both is a VALIDATION error. Omit to keep the knowledge_base_name rule (one named base, or all). An unknown name fails with KB_NOT_FOUND.'),
  threshold: z.number().optional().describe('The maximum similarity score threshold for returned dense documents. Defaults to 2 if not specified; in hybrid mode, the threshold is not applied because both legs are over-fetched for fusion, while metadata filters apply to both legs before fusion.'),
  // RFC 013 M3 §4.5 — optional override of the active embedding model.
  // When omitted, the server uses the model recorded in active.txt.
  // When passed, must be a registered model_id (see list_models).
  model_name: z.string().optional().describe('The model_id of an alternate embedding model to query (e.g. "openai__text-embedding-3-small"). If omitted, the active model is used. Run list_models for available ids.'),
  // Issue #53 / #853 — metadata POST-filters. Applied to dense candidates
  // before return and lexical candidates before hybrid fusion, ANDed with
  // each other and with knowledge_base_name. Hybrid overfetches both legs for
  // fusion, so the dense threshold is not applied to the fused results.
  extensions: boundedFilterArray().optional().describe('Limit results to chunks whose source file has one of these extensions (e.g. [".md", ".pdf"]). Case-insensitive; leading dot optional. In hybrid mode, applied to lexical candidates before fusion.'),
  path_glob: boundedGlobString().optional().describe('Limit results to chunks whose KB-internal relative path matches this glob (e.g. "runbooks/**"). The KB-name segment is stripped before matching. In hybrid mode, applied to lexical candidates before fusion.'),
  tags: boundedFilterArray().optional().describe('Limit results to chunks whose source file has ALL of these tags in its YAML frontmatter. In hybrid mode, applied to lexical candidates before fusion.'),
  since: z.string().optional().describe('Limit results to chunks whose current source-file mtime is at or after this bound. Accepts durations like "30d"/"24h" or ISO dates/timestamps; mtime can differ from indexed-content time on stale indexes. In hybrid mode, applied to lexical candidates before fusion.'),
  until: z.string().optional().describe('Limit results to chunks whose current source-file mtime is at or before this bound. Accepts durations like "30d"/"24h" or ISO dates/timestamps; mtime can differ from indexed-content time on stale indexes. In hybrid mode, applied to lexical candidates before fusion.'),
  context_before: z.int().min(0).max(5).optional().describe('Opt-in neighbor context: include up to this many preceding chunks from the same source around each dense semantic match. Defaults to 0.'),
  context_after: z.int().min(0).max(5).optional().describe('Opt-in neighbor context: include up to this many following chunks from the same source around each dense semantic match. Defaults to 0.'),
  context_window: z.int().min(0).max(5).optional().describe('Shorthand for setting context_before and context_after to the same value. Defaults to 0.'),
  // Issue #973 — bring ask_knowledge's configurable top-K to retrieve_knowledge.
  // Default 10 preserves the previously hardcoded value for 0.x clients.
  k: z.int().min(1).max(50).optional().describe('Retrieval top-K. Default 10.'),
  // #206 stage 2 — sparse+dense hybrid retrieval. Default 'dense' is
  // wire-compatible with 0.x clients: when the field is absent the
  // server runs the unmodified dense path. 'hybrid' fuses dense FAISS
  // top-N with per-KB BM25 top-N via Reciprocal Rank Fusion (c=60,
  // Cormack 2009); see RFC 006 §4 + #206 + ADR 0006. Issue #973 adds
  // 'lexical' (BM25-only) and 'auto' (prose stays dense, code/error-token
  // queries upgrade to hybrid) to match ask_knowledge; omitting the field
  // still defaults to 'dense' so existing clients see no behavior change.
  search_mode: z.enum(['dense', 'hybrid', 'lexical', 'auto']).optional().describe('Retrieval mode. "dense" (default) uses FAISS only. "hybrid" fuses FAISS top-N with per-KB BM25 top-N via Reciprocal Rank Fusion. "lexical" is BM25-only. "auto" keeps dense for prose and upgrades code/error-token queries to hybrid. See #206 + #973.'),
  task_context: z.string().optional().describe('Optional task context used by the relevance gate judge. Truncated to 2000 characters.'),
  gate: z.enum(['on', 'off']).optional().describe('Per-call relevance gate override. Omit to use KB_RELEVANCE_GATE.'),
  rerank: z.enum(['on', 'off']).optional().describe('Per-call RFC 019 reranker override for hybrid retrieval. Omit to use KB_RERANK.'),
};

export const ASK_KNOWLEDGE_INPUT = {
  query: boundedQueryString().describe('Question to answer from retrieved knowledge-base snippets.'),
  knowledge_base_name: z.string().optional().describe('Name of a single knowledge base to search. If omitted, all available knowledge bases are considered.'),
  // Issue #975 — same named-subset scope as retrieve_knowledge.
  knowledge_base_names: boundedFilterArray().optional().describe('Answer from only this named subset of knowledge bases (e.g. ["runbooks", "adr"]). Mutually exclusive with knowledge_base_name — passing both is a VALIDATION error. Omit to keep the knowledge_base_name rule (one named base, or all). An unknown name fails with KB_NOT_FOUND.'),
  model_name: z.string().optional().describe('Registered embedding model_id to use for retrieval. If omitted, the active model is used.'),
  llm_profile: z.string().optional().describe('Saved kb llm profile name to use for answer generation.'),
  k: z.int().min(1).max(50).optional().describe('Retrieval top-K before context packing. Default 8.'),
  context_budget_tokens: z.int().min(64).optional().describe('Approximate token budget for snippets sent to the LLM. Default 6000.'),
  // Issue #974 — mirror retrieve_knowledge's metadata POST-filters on the ask
  // path so an agent can scope the evidence an answer is drawn from without
  // leaving the tool. ANDed with each other and with the KB scope; in hybrid
  // mode they apply to lexical candidates before fusion. Omitting them keeps the
  // unfiltered whole-base search (same hit count and formatting as before).
  extensions: boundedFilterArray().optional().describe('Limit answer evidence to chunks whose source file has one of these extensions (e.g. [".md", ".pdf"]). Case-insensitive; leading dot optional. In hybrid mode, applied to lexical candidates before fusion.'),
  path_glob: boundedGlobString().optional().describe('Limit answer evidence to chunks whose KB-internal relative path matches this glob (e.g. "runbooks/**"). The KB-name segment is stripped before matching. In hybrid mode, applied to lexical candidates before fusion.'),
  tags: boundedFilterArray().optional().describe('Limit answer evidence to chunks whose source file has ALL of these tags in its YAML frontmatter. In hybrid mode, applied to lexical candidates before fusion.'),
  since: z.string().optional().describe('Limit answer evidence to chunks whose current source-file mtime is at or after this bound. Accepts durations like "30d"/"24h" or ISO dates/timestamps; mtime can differ from indexed-content time on stale indexes. In hybrid mode, applied to lexical candidates before fusion.'),
  until: z.string().optional().describe('Limit answer evidence to chunks whose current source-file mtime is at or before this bound. Accepts durations like "30d"/"24h" or ISO dates/timestamps; mtime can differ from indexed-content time on stale indexes. In hybrid mode, applied to lexical candidates before fusion.'),
  // Issue #974 — opt-in neighbor windows, mirroring retrieve_knowledge. As on
  // retrieve, expansion is only supported with dense retrieval (hybrid/lexical
  // fusion has no stable neighbor ordering), so a window with a non-dense
  // effective mode is a VALIDATION error. Defaults stay 0 (no expansion).
  context_before: z.int().min(0).max(5).optional().describe('Opt-in neighbor context: include up to this many preceding chunks from the same source around each match before packing. Only supported with dense retrieval (search_mode="dense"); the default "auto" stays dense for prose. Defaults to 0.'),
  context_after: z.int().min(0).max(5).optional().describe('Opt-in neighbor context: include up to this many following chunks from the same source around each match before packing. Only supported with dense retrieval (search_mode="dense"); the default "auto" stays dense for prose. Defaults to 0.'),
  context_window: z.int().min(0).max(5).optional().describe('Shorthand for setting context_before and context_after to the same value. Only supported with dense retrieval (search_mode="dense"). Defaults to 0.'),
  // #732 — bring the search-mode + opt-in rerank surface of retrieve_knowledge
  // to the ask path. Defaults to 'auto' (prose stays dense, code/error-token
  // queries upgrade to hybrid); reranking stays opt-in.
  search_mode: z.enum(['dense', 'hybrid', 'lexical', 'auto']).optional().describe('Retrieval mode for the snippets fed to the answer LLM. "auto" (default) keeps dense for prose and upgrades code/error-token queries to hybrid; "dense" is FAISS-only; "hybrid" fuses FAISS + per-KB BM25 via Reciprocal Rank Fusion; "lexical" is BM25-only. See #206 + #732.'),
  rerank: z.enum(['on', 'off']).optional().describe('Per-call RFC 019 cross-encoder reranker override for hybrid retrieval. Off by default; omit to use KB_RERANK.'),
  task_context: z.string().optional().describe('Optional task context passed to the answer prompt and relevance gate when enabled.'),
  gate: z.enum(['on', 'off']).optional().describe('Per-call relevance gate override for retrieved snippets. Omit to keep the ask path ungated.'),
  timing: z.boolean().optional().describe('Include retrieval, packing, and LLM timing fields. Defaults to true for MCP.'),
};

export const KB_STATS_INPUT = {
  knowledge_base_name: z
    .string()
    .optional()
    .describe('Name of a single KB to scope to. If omitted, every registered KB is reported.'),
};

export const DIFF_INDEX_INPUT = {
  before: z.string().describe('BEFORE index version number, relative directory, or absolute version directory.'),
  after: z.string().describe('AFTER index version number, relative directory, or absolute version directory.'),
  queries: z.array(boundedQueryString()).min(1).max(KB_MAX_FILTER_ITEMS).describe('Plaintext queries to run against both index versions.'),
  model_name: z.string().optional().describe('Optional registered embedding model id. If omitted, the active model is used.'),
  knowledge_base_name: z.string().optional().describe('Optional KB scope applied to every query.'),
  top_k: z.int().min(1).max(100).optional().describe('Top-K results per query. Default 10.'),
  threshold: z.number().optional().describe('Dense similarity threshold. Default 2.'),
  format: z.enum(['json', 'markdown']).optional().describe('Response format. Default markdown.'),
};

// Issue #1133 — find_related mirrors the read-only `kb related` CLI: seed-chunk
// "more-like-this" expansion from an existing result's id/URI. The seed is a
// chunk id or kb:// URI (not a text query); k/threshold/knowledge_base_name
// mirror retrieve_knowledge's bounds. all_kbs broadens past the seed KB and is
// mutually exclusive with knowledge_base_name (VALIDATION); include_self keeps
// the seed in the results.
export const FIND_RELATED_INPUT = {
  chunk_id: z
    .string()
    .min(1, 'chunk_id must not be empty')
    .describe('The seed chunk to expand from: a public chunk id (e.g. "alpha/docs/deploy.md#L42-L78") or a kb:// resource URI from a prior retrieve_knowledge result. A bare <kb>/<path> location is rejected because it cannot name a single chunk.'),
  knowledge_base_name: z
    .string()
    .optional()
    .describe('Scope the related search to this knowledge base. Defaults to the seed chunk\'s own knowledge base. Mutually exclusive with all_kbs — passing both is a VALIDATION error.'),
  all_kbs: z
    .boolean()
    .optional()
    .describe('Search across all knowledge bases instead of the default seed-KB scope. Mutually exclusive with knowledge_base_name.'),
  k: z.int().min(1).max(50).optional().describe('Related results to return. Default 10.'),
  threshold: z
    .number()
    .optional()
    .describe('Maximum dense similarity score; lower = closer match. Default 2.'),
  include_self: z
    .boolean()
    .optional()
    .describe('Keep the seed chunk in the result set. Omitted/false excludes it (the default).'),
};

// Issue #1151 — list_facets mirrors the read-only `kb tags` CLI: enumerate the
// frontmatter facet values that exist so a client can learn the valid filter
// vocabulary. Both inputs are optional, matching the CLI's all-KBs /
// tags-status-type defaults. An empty/whitespace value is normalized to "unset"
// by the handler rather than scoping to a literal empty KB / facet name.
export const LIST_FACETS_INPUT = {
  knowledge_base_name: z
    .string()
    .optional()
    .describe('Scope the facet scan to this knowledge base. Omit to aggregate across every KB (the default).'),
  facet: z
    .string()
    .optional()
    .describe('Report a single frontmatter key (any key) instead of the default tags/status/type set.'),
};

// Issue #1152 — recommend_knowledge_base mirrors the read-only `kb where` CLI:
// route a topic to the best KB + existing file. topic is the only required
// input; k/threshold/model_name mirror the CLI's --k/--threshold/--model and
// keep the same semantics (lower threshold distance = closer / stricter).
export const RECOMMEND_KNOWLEDGE_BASE_INPUT = {
  topic: z
    .string()
    .min(1, 'topic must not be empty')
    .describe('The topic / one-line description to place. The server runs one cross-KB similarity search for this text and recommends the closest KB + file.'),
  k: z.int().min(1).max(50).optional().describe('Top-K cross-KB hits to consider when grouping. Default 20.'),
  threshold: z
    .number()
    .positive()
    .optional()
    .describe('Confidence cutoff (a distance; lower = closer). A best-file score BELOW this is a high-confidence existing target; above it, no existing_target is returned. Default 1.0.'),
  model_name: z
    .string()
    .optional()
    .describe('Override the active embedding model for this call (RFC 013). Defaults to the active model.'),
};

export const ADD_DOCUMENT_INPUT = {
  knowledge_base_name: z.string().describe('The name of the knowledge base to write into.'),
  path: z.string().describe('KB-relative document path to create or overwrite. Parent directories are created as needed.'),
  content: z.string().describe('UTF-8 text content to write.'),
};

export const DELETE_DOCUMENT_INPUT = {
  knowledge_base_name: z.string().describe('The name of the knowledge base to delete from.'),
  path: z.string().describe('KB-relative document path to delete.'),
};

export const REINDEX_KNOWLEDGE_BASE_INPUT = {
  knowledge_base_name: z
    .string()
    .optional()
    .describe('Name of a single KB to force re-index. If omitted, every registered KB is re-indexed.'),
};

export interface McpToolSpec {
  /** Wire name passed to mcp.tool(). */
  name: string;
  /** Model-facing description (may be overridden via env at load time). */
  description: string;
  /** Zod input shape, or undefined for tools that take no arguments. */
  inputShape?: ZodRawShape;
  /** True when the tool is only registered if KB_INGEST_ENABLED is set. */
  ingestGated?: boolean;
  /**
   * Issue #798 — advisory MCP `ToolAnnotations` (readOnlyHint / destructiveHint
   * / idempotentHint) the server passes to `mcp.tool()`. These are hints an MCP
   * client's policy layer keys on to gate auto-approval and confirm destructive
   * actions; they are NOT server-side enforcement (the ingest gate remains the
   * enforcement layer). Read-only tools mirror `!ingestGated`; the three
   * ingest-gated writes are annotated by hand since a single boolean cannot
   * distinguish a destructive delete from an idempotent add/reindex.
   */
  annotations: ToolAnnotations;
}

// Shared annotation objects. The nine readers do not modify their environment;
// per the MCP spec `destructiveHint`/`idempotentHint` are meaningful only when
// `readOnlyHint === false`, so a lone `readOnlyHint: true` is the complete hint
// for a reader.
const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true };

// Order mirrors registration in KnowledgeBaseServer.registerTools so the
// generated doc reads top-to-bottom like the server surface.
export const MCP_TOOL_SPECS: McpToolSpec[] = [
  { name: 'list_knowledge_bases', description: LIST_KNOWLEDGE_BASES_DESCRIPTION, annotations: READ_ONLY_ANNOTATIONS },
  { name: 'retrieve_knowledge', description: RETRIEVE_KNOWLEDGE_DESCRIPTION, inputShape: RETRIEVE_KNOWLEDGE_INPUT, annotations: READ_ONLY_ANNOTATIONS },
  { name: 'ask_knowledge', description: ASK_KNOWLEDGE_DESCRIPTION, inputShape: ASK_KNOWLEDGE_INPUT, annotations: READ_ONLY_ANNOTATIONS },
  { name: 'list_models', description: LIST_MODELS_DESCRIPTION, annotations: READ_ONLY_ANNOTATIONS },
  { name: 'kb_stats', description: KB_STATS_DESCRIPTION, inputShape: KB_STATS_INPUT, annotations: READ_ONLY_ANNOTATIONS },
  { name: 'diff_index', description: DIFF_INDEX_DESCRIPTION, inputShape: DIFF_INDEX_INPUT, annotations: READ_ONLY_ANNOTATIONS },
  // Issue #1133 — read-only seed-chunk "more-like-this" expansion mirroring `kb related`.
  { name: 'find_related', description: FIND_RELATED_DESCRIPTION, inputShape: FIND_RELATED_INPUT, annotations: READ_ONLY_ANNOTATIONS },
  // Issue #1151 — read-only frontmatter-facet enumeration mirroring `kb tags`.
  { name: 'list_facets', description: LIST_FACETS_DESCRIPTION, inputShape: LIST_FACETS_INPUT, annotations: READ_ONLY_ANNOTATIONS },
  // Issue #1152 — read-only topic→shelf routing mirroring `kb where`.
  { name: 'recommend_knowledge_base', description: RECOMMEND_KNOWLEDGE_BASE_DESCRIPTION, inputShape: RECOMMEND_KNOWLEDGE_BASE_INPUT, annotations: READ_ONLY_ANNOTATIONS },
  // add_document writes a document: not read-only, and additive rather than
  // destructive (it creates/overwrites a single path). Re-writing the same
  // path+content leaves the KB in the same state, so it is idempotent.
  {
    name: 'add_document',
    description: ADD_DOCUMENT_DESCRIPTION,
    inputShape: ADD_DOCUMENT_INPUT,
    ingestGated: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  // delete_document removes a document: the one destructive write. Deleting the
  // same path twice is not a stable no-op (the second call has nothing to
  // remove), so it is not marked idempotent.
  {
    name: 'delete_document',
    description: DELETE_DOCUMENT_DESCRIPTION,
    inputShape: DELETE_DOCUMENT_INPUT,
    ingestGated: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  // reindex_knowledge_base rebuilds the index from unchanged sources: not
  // read-only, but additive (it does not delete source content) and idempotent
  // (re-running over the same sources reproduces the same index).
  {
    name: 'reindex_knowledge_base',
    description: REINDEX_KNOWLEDGE_BASE_DESCRIPTION,
    inputShape: REINDEX_KNOWLEDGE_BASE_INPUT,
    ingestGated: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

const ANNOTATIONS_BY_NAME = new Map(MCP_TOOL_SPECS.map((spec) => [spec.name, spec.annotations]));

/**
 * Look up the advisory `ToolAnnotations` for a registered tool. Throws if the
 * name is unknown so a registration/spec drift fails loudly rather than
 * silently registering a tool with no safety hints.
 */
export function toolAnnotations(name: string): ToolAnnotations {
  const annotations = ANNOTATIONS_BY_NAME.get(name);
  if (annotations === undefined) {
    throw new Error(`No MCP tool annotations registered for tool "${name}"`);
  }
  return annotations;
}
