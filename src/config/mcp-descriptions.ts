// ---------------------------------------------------------------------------
// Tool description overrides (RFC 010 M2 / #52).
// Operators can repurpose the same binary for different deployments (eng
// docs vs. personal notes vs. postmortems) by overriding the model-facing
// description the agent sees during tool selection. Read once at module
// load; set the env vars BEFORE the server process starts.
// ---------------------------------------------------------------------------

import { initializeProjectConfig } from './project-config.js';

initializeProjectConfig();

export const DEFAULT_RETRIEVE_KNOWLEDGE_DESCRIPTION =
  'Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 documents are returned. Dense retrieval limits results to a similarity score of 2 by default; a different threshold can optionally be provided. Hybrid retrieval does not apply this threshold because both legs are over-fetched for fusion.';
export const RETRIEVE_KNOWLEDGE_DESCRIPTION =
  process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION && process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION.length > 0
    ? process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION
    : DEFAULT_RETRIEVE_KNOWLEDGE_DESCRIPTION;

export const DEFAULT_ASK_KNOWLEDGE_DESCRIPTION =
  'Answers a question from retrieved knowledge-base context using the configured local OpenAI-compatible LLM endpoint. Returns a structured payload with answer, citations, context-packing diagnostics, abstention_reason, LLM provenance, retrieval model, and optional timing. Use retrieve_knowledge when you only need raw chunks.';
export const ASK_KNOWLEDGE_DESCRIPTION =
  process.env.ASK_KNOWLEDGE_DESCRIPTION && process.env.ASK_KNOWLEDGE_DESCRIPTION.length > 0
    ? process.env.ASK_KNOWLEDGE_DESCRIPTION
    : DEFAULT_ASK_KNOWLEDGE_DESCRIPTION;

export const DEFAULT_LIST_KNOWLEDGE_BASES_DESCRIPTION =
  'Lists the available knowledge bases.';
export const LIST_KNOWLEDGE_BASES_DESCRIPTION =
  process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION && process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION.length > 0
    ? process.env.LIST_KNOWLEDGE_BASES_DESCRIPTION
    : DEFAULT_LIST_KNOWLEDGE_BASES_DESCRIPTION;

// RFC 013 M3 section4.5 - list_models tool description.
export const DEFAULT_LIST_MODELS_DESCRIPTION =
  'Lists the embedding models registered for retrieval. Returns an array of {model_id, provider, model_name, active}. Use the model_id as the optional `model_name` argument to retrieve_knowledge to query a specific model instead of the active default.';
export const LIST_MODELS_DESCRIPTION =
  process.env.LIST_MODELS_DESCRIPTION && process.env.LIST_MODELS_DESCRIPTION.length > 0
    ? process.env.LIST_MODELS_DESCRIPTION
    : DEFAULT_LIST_MODELS_DESCRIPTION;

// Issue #54 - kb_stats tool description.
export const DEFAULT_KB_STATS_DESCRIPTION =
  'Reports observability stats for the knowledge base index: per-KB file_count, chunk_count, total_bytes_indexed and last_updated_at; the active embedding provider/model/dim; the on-disk index_path; server version/commit/uptime; process-lifetime chat-completion calls with bounded provider/model attribution, attempts/retries, cache outcomes, and answer impact; answer-cache counters; and HTTP/SSE transport counters when a remote transport is active. Pass `knowledge_base_name` to scope to a single KB; omit it to get an entry per registered KB.';
export const KB_STATS_DESCRIPTION =
  process.env.KB_STATS_DESCRIPTION && process.env.KB_STATS_DESCRIPTION.length > 0
    ? process.env.KB_STATS_DESCRIPTION
    : DEFAULT_KB_STATS_DESCRIPTION;

// Issue #51 - MCP ingest tools.
export const ADD_DOCUMENT_DESCRIPTION =
  'Adds or overwrites a UTF-8 document in a knowledge base, creating parent directories as needed, then updates the active model index so the new content is queryable immediately.';

export const DELETE_DOCUMENT_DESCRIPTION =
  'DESTRUCTIVE: Deletes a document from a knowledge base and removes its hash sidecar. FAISS does not support vector deletion in this server, so orphan vectors for the removed file persist until a full rebuild; run reindex_knowledge_base after deletes if vector hygiene matters.';

export const REINDEX_KNOWLEDGE_BASE_DESCRIPTION =
  'Forces the active model to fully rebuild its FAISS index from on-disk files, replacing the in-memory store and clearing orphan vectors left behind by prior delete_document calls. The rebuild always covers every KB because FAISS lacks per-vector deletion; passing knowledge_base_name is accepted (and recorded in the response) but does not narrow the rebuild scope.';

export const DIFF_INDEX_DESCRIPTION =
  'Compares retrieval-result churn across two persisted FAISS index versions for a list of plaintext queries. Returns rank deltas, top-K membership changes, and stability/churn scores; useful before promoting a new index version.';

// ---------------------------------------------------------------------------
// MCP prompts surface (#642).
// The server's third MCP primitive (alongside tools + resources): a small,
// opinionated set of read-only, parameterized prompt templates that an MCP
// client (Claude Desktop, IDE plugins) can surface as slash-commands and that
// pre-wire a grounded `retrieve_knowledge` workflow. v1 is intentionally a
// fixed registry — there is no user-defined-prompt store. Template TEXT lives
// here so the wording stays next to the tool descriptions; the wire handlers
// and arg substitution live in `src/mcp-prompts.ts`.
//
// Each template is read-only: rendering substitutes the caller's arguments
// into instruction text. The server never runs retrieval or calls an LLM while
// answering `prompts/get`; the returned messages tell the client/agent to call
// the `retrieve_knowledge` tool itself.
// ---------------------------------------------------------------------------

export interface KbPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface KbPromptTemplate {
  name: string;
  description: string;
  arguments: readonly KbPromptArgument[];
  /**
   * Render the prompt body from already-validated arguments. Required
   * arguments are guaranteed present by the caller (`renderKbPrompt`);
   * optional arguments may be absent and the template supplies a default.
   */
  render: (args: Record<string, string>) => string;
}

/**
 * Describe the KB scope for an instruction line. When the caller passed a
 * `knowledge_base_name` the retrieval is pinned to that shelf; otherwise the
 * agent searches every registered KB (the `retrieve_knowledge` default).
 */
function kbScopeClause(args: Record<string, string>): string {
  const kb = args.knowledge_base_name?.trim();
  return kb
    ? `the "${kb}" knowledge base (pass knowledge_base_name="${kb}")`
    : 'all available knowledge bases (omit knowledge_base_name)';
}

export const KB_PROMPT_TEMPLATES: readonly KbPromptTemplate[] = [
  {
    name: 'summarize_kb',
    description:
      'Summarize what a knowledge base contains, grounded in retrieved chunks and cited by source path.',
    arguments: [
      { name: 'knowledge_base_name', description: 'KB to summarize. Omit to summarize across all KBs.' },
      { name: 'focus', description: 'Optional topic to focus the summary on.' },
    ],
    render: (args) => {
      const focus = args.focus?.trim();
      const query = focus && focus.length > 0 ? focus : 'key topics and themes';
      return [
        `Summarize ${kbScopeClause(args)}.`,
        '',
        `1. Call the retrieve_knowledge tool with query="${query}" scoped to ${kbScopeClause(args)}.`,
        '2. Write a concise, structured summary (3-6 bullet points) of the retrieved material.',
        '3. Ground every point in the retrieved chunks — cite the source path for each claim and do not add facts that are not in the results.',
        '4. If retrieval returns nothing relevant, say so plainly instead of guessing.',
      ].join('\n');
    },
  },
  {
    name: 'cite_sources',
    description:
      'Answer a question strictly from retrieved knowledge-base chunks, citing the source path for every claim.',
    arguments: [
      { name: 'question', description: 'The question to answer from the knowledge base.', required: true },
      { name: 'knowledge_base_name', description: 'KB to search. Omit to search all KBs.' },
    ],
    render: (args) =>
      [
        `Answer this question using only the knowledge base: "${args.question}"`,
        '',
        `1. Call the retrieve_knowledge tool with query="${args.question}" scoped to ${kbScopeClause(args)}.`,
        '2. Answer strictly from the retrieved chunks. Cite the source path inline after each claim, e.g. (source: notes/topic.md).',
        '3. Do not use outside knowledge. If the retrieved chunks do not support an answer, state that the knowledge base does not cover it and abstain.',
      ].join('\n'),
  },
  {
    name: 'compare_notes',
    description:
      'Compare and contrast two topics using retrieved knowledge-base chunks, with citations for each side.',
    arguments: [
      { name: 'topic_a', description: 'First topic to compare.', required: true },
      { name: 'topic_b', description: 'Second topic to compare.', required: true },
      { name: 'knowledge_base_name', description: 'KB to search. Omit to search all KBs.' },
    ],
    render: (args) =>
      [
        `Compare and contrast "${args.topic_a}" and "${args.topic_b}" using the knowledge base.`,
        '',
        `1. Call retrieve_knowledge once with query="${args.topic_a}" and once with query="${args.topic_b}", both scoped to ${kbScopeClause(args)}.`,
        '2. Produce a comparison covering points in common and key differences.',
        '3. Cite the source path for each point. Use only retrieved material; if one topic has no coverage, say so.',
      ].join('\n'),
  },
  {
    name: 'research_brief',
    description:
      'Produce a short, cited research brief on a topic from retrieved knowledge-base chunks.',
    arguments: [
      { name: 'topic', description: 'The topic to brief.', required: true },
      { name: 'knowledge_base_name', description: 'KB to search. Omit to search all KBs.' },
      { name: 'k', description: 'How many chunks to retrieve before synthesizing (default 8).' },
    ],
    render: (args) => {
      const k = args.k?.trim();
      const kClause = k && k.length > 0 ? ` with up to ${k} results` : '';
      return [
        `Write a research brief on "${args.topic}" grounded in the knowledge base.`,
        '',
        `1. Call retrieve_knowledge with query="${args.topic}"${kClause}, scoped to ${kbScopeClause(args)}.`,
        '2. Structure the brief as: Background, Key findings, Open questions.',
        '3. Ground every statement in the retrieved chunks and cite the source path. Flag gaps where the knowledge base is thin rather than filling them with outside knowledge.',
      ].join('\n');
    },
  },
];
