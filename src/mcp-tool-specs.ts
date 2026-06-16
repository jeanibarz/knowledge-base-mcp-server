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

import { z, type ZodRawShape } from 'zod';

import {
  ADD_DOCUMENT_DESCRIPTION,
  ASK_KNOWLEDGE_DESCRIPTION,
  DELETE_DOCUMENT_DESCRIPTION,
  DIFF_INDEX_DESCRIPTION,
  KB_STATS_DESCRIPTION,
  LIST_KNOWLEDGE_BASES_DESCRIPTION,
  LIST_MODELS_DESCRIPTION,
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
  threshold: z.number().optional().describe('The maximum similarity score threshold for returned documents. Defaults to 2 if not specified.'),
  // RFC 013 M3 §4.5 — optional override of the active embedding model.
  // When omitted, the server uses the model recorded in active.txt.
  // When passed, must be a registered model_id (see list_models).
  model_name: z.string().optional().describe('The model_id of an alternate embedding model to query (e.g. "openai__text-embedding-3-small"). If omitted, the active model is used. Run list_models for available ids.'),
  // Issue #53 — metadata POST-filters. Applied after FAISS returns,
  // ANDed with each other and with knowledge_base_name + threshold.
  extensions: boundedFilterArray().optional().describe('Limit results to chunks whose source file has one of these extensions (e.g. [".md", ".pdf"]). Case-insensitive; leading dot optional.'),
  path_glob: boundedGlobString().optional().describe('Limit results to chunks whose KB-internal relative path matches this glob (e.g. "runbooks/**"). The KB-name segment is stripped before matching.'),
  tags: boundedFilterArray().optional().describe('Limit results to chunks whose source file has ALL of these tags in its YAML frontmatter.'),
  since: z.string().optional().describe('Limit dense results to chunks whose current source-file mtime is at or after this bound. Accepts durations like "30d"/"24h" or ISO dates/timestamps; mtime can differ from indexed-content time on stale indexes.'),
  until: z.string().optional().describe('Limit dense results to chunks whose current source-file mtime is at or before this bound. Accepts durations like "30d"/"24h" or ISO dates/timestamps; mtime can differ from indexed-content time on stale indexes.'),
  context_before: z.number().int().min(0).max(5).optional().describe('Opt-in neighbor context: include up to this many preceding chunks from the same source around each dense semantic match. Defaults to 0.'),
  context_after: z.number().int().min(0).max(5).optional().describe('Opt-in neighbor context: include up to this many following chunks from the same source around each dense semantic match. Defaults to 0.'),
  context_window: z.number().int().min(0).max(5).optional().describe('Shorthand for setting context_before and context_after to the same value. Defaults to 0.'),
  // #206 stage 2 — sparse+dense hybrid retrieval. Default 'dense' is
  // wire-compatible with 0.x clients: when the field is absent the
  // server runs the unmodified dense path. 'hybrid' fuses dense FAISS
  // top-N with per-KB BM25 top-N via Reciprocal Rank Fusion (c=60,
  // Cormack 2009); see RFC 006 §4 + #206 + ADR 0006.
  search_mode: z.enum(['dense', 'hybrid']).optional().describe('Retrieval mode. "dense" (default) uses FAISS only. "hybrid" fuses FAISS top-N with per-KB BM25 top-N via Reciprocal Rank Fusion. See #206.'),
  task_context: z.string().optional().describe('Optional task context used by the relevance gate judge. Truncated to 2000 characters.'),
  gate: z.enum(['on', 'off']).optional().describe('Per-call relevance gate override. Omit to use KB_RELEVANCE_GATE.'),
  rerank: z.enum(['on', 'off']).optional().describe('Per-call RFC 019 reranker override for hybrid retrieval. Omit to use KB_RERANK.'),
};

export const ASK_KNOWLEDGE_INPUT = {
  query: boundedQueryString().describe('Question to answer from retrieved knowledge-base snippets.'),
  knowledge_base_name: z.string().optional().describe('Name of a single knowledge base to search. If omitted, all available knowledge bases are considered.'),
  model_name: z.string().optional().describe('Registered embedding model_id to use for retrieval. If omitted, the active model is used.'),
  llm_profile: z.string().optional().describe('Saved kb llm profile name to use for answer generation.'),
  k: z.number().int().min(1).max(50).optional().describe('Retrieval top-K before context packing. Default 8.'),
  context_budget_tokens: z.number().int().min(64).optional().describe('Approximate token budget for snippets sent to the LLM. Default 6000.'),
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
  top_k: z.number().int().min(1).max(100).optional().describe('Top-K results per query. Default 10.'),
  threshold: z.number().optional().describe('Dense similarity threshold. Default 2.'),
  format: z.enum(['json', 'markdown']).optional().describe('Response format. Default markdown.'),
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
}

// Order mirrors registration in KnowledgeBaseServer.registerTools so the
// generated doc reads top-to-bottom like the server surface.
export const MCP_TOOL_SPECS: McpToolSpec[] = [
  { name: 'list_knowledge_bases', description: LIST_KNOWLEDGE_BASES_DESCRIPTION },
  { name: 'retrieve_knowledge', description: RETRIEVE_KNOWLEDGE_DESCRIPTION, inputShape: RETRIEVE_KNOWLEDGE_INPUT },
  { name: 'ask_knowledge', description: ASK_KNOWLEDGE_DESCRIPTION, inputShape: ASK_KNOWLEDGE_INPUT },
  { name: 'list_models', description: LIST_MODELS_DESCRIPTION },
  { name: 'kb_stats', description: KB_STATS_DESCRIPTION, inputShape: KB_STATS_INPUT },
  { name: 'diff_index', description: DIFF_INDEX_DESCRIPTION, inputShape: DIFF_INDEX_INPUT },
  { name: 'add_document', description: ADD_DOCUMENT_DESCRIPTION, inputShape: ADD_DOCUMENT_INPUT, ingestGated: true },
  { name: 'delete_document', description: DELETE_DOCUMENT_DESCRIPTION, inputShape: DELETE_DOCUMENT_INPUT, ingestGated: true },
  { name: 'reindex_knowledge_base', description: REINDEX_KNOWLEDGE_BASE_DESCRIPTION, inputShape: REINDEX_KNOWLEDGE_BASE_INPUT, ingestGated: true },
];
