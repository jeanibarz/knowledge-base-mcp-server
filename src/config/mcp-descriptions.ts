// ---------------------------------------------------------------------------
// Tool description overrides (RFC 010 M2 / #52).
// Operators can repurpose the same binary for different deployments (eng
// docs vs. personal notes vs. postmortems) by overriding the model-facing
// description the agent sees during tool selection. Read once at module
// load; set the env vars BEFORE the server process starts.
// ---------------------------------------------------------------------------

export const DEFAULT_RETRIEVE_KNOWLEDGE_DESCRIPTION =
  'Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 documents are returned with a score below a threshold of 2. A different threshold can optionally be provided.';
export const RETRIEVE_KNOWLEDGE_DESCRIPTION =
  process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION && process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION.length > 0
    ? process.env.RETRIEVE_KNOWLEDGE_DESCRIPTION
    : DEFAULT_RETRIEVE_KNOWLEDGE_DESCRIPTION;

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
  'Reports observability stats for the knowledge base index: per-KB file_count, chunk_count, total_bytes_indexed and last_updated_at; the active embedding provider/model/dim; the on-disk index_path; and server version/uptime. Pass `knowledge_base_name` to scope to a single KB; omit it to get an entry per registered KB.';
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
