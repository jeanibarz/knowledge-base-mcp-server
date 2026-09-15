import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_ASK_KNOWLEDGE_DESCRIPTION,
  DEFAULT_KB_STATS_DESCRIPTION,
  DEFAULT_LIST_KNOWLEDGE_BASES_DESCRIPTION,
  DEFAULT_LIST_MODELS_DESCRIPTION,
  DEFAULT_RETRIEVE_KNOWLEDGE_DESCRIPTION,
} from './mcp-descriptions.js';
import {
  defaultFaissIndexPath,
  resolveKnowledgeBasesRootDir,
} from './paths.js';
import {
  DEFAULT_FLAT_SEARCH_P95_ADVISORY_MS,
  DEFAULT_HNSW_EF_CONSTRUCTION,
  DEFAULT_HNSW_EF_SEARCH,
  DEFAULT_HNSW_M,
  DEFAULT_HNSW_RANDOM_SEED,
  defaultIndexingBatchSize,
} from './indexing.js';
import {
  DEFAULT_HUGGINGFACE_MODEL_NAME,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL_NAME,
  KNOWN_EMBEDDING_PROVIDERS,
} from './provider.js';
import {
  DEFAULT_RERANK_BATCH_SIZE,
  DEFAULT_RERANK_MODEL,
  DEFAULT_RERANK_TOP_N,
  MAX_RERANK_BATCH_SIZE,
  MAX_RERANK_TOP_N,
} from './reranker.js';
import {
  DEFAULT_DAEMON_CLIENT_TIMEOUT_MS,
  DEFAULT_DAEMON_HEALTH_TIMEOUT_MS,
  MAX_DAEMON_CLIENT_TIMEOUT_MS,
} from '../daemon-client.js';
import {
  DAEMON_MAX_CONCURRENCY_ENV,
  DAEMON_QUEUE_MAX_ENV,
  DEFAULT_DAEMON_MAX_CONCURRENCY,
  DEFAULT_DAEMON_QUEUE_MAX,
  MAX_DAEMON_CONCURRENCY,
  MAX_DAEMON_QUEUE_MAX,
} from '../daemon-admission.js';
import { closestSuggestion, levenshteinDistance } from '../suggestion-core.js';

export type ConfigFindingStatus = 'ok' | 'warn' | 'error';
export type ConfigValueKind =
  | 'boolean'
  | 'csv'
  | 'dependency'
  | 'duration'
  | 'enum'
  | 'integer'
  | 'number'
  | 'path'
  | 'secret'
  | 'string'
  | 'url'
  | 'unknown';

export interface ConfigFinding {
  name: string;
  status: ConfigFindingStatus;
  kind: ConfigValueKind;
  source: string;
  value: string | null;
  message: string;
}

export interface ConfigValidateReport {
  schema_version: 'kb.config-validate.v1';
  status: ConfigFindingStatus;
  source: string;
  checked_at: string;
  counts: Record<ConfigFindingStatus, number>;
  findings: ConfigFinding[];
}

export type ConfigValueSource = 'env' | 'file' | 'default';

export interface ConfigShowEntry {
  name: string;
  kind: ConfigValueKind;
  value: string | null;
  source: ConfigValueSource;
  redacted: boolean;
}

export interface ConfigShowReport {
  schema_version: 'kb.config-show.v1';
  config_file?: string | null;
  entries: ConfigShowEntry[];
}

export interface DotEnvParseResult {
  env: Record<string, string>;
  errors: ConfigFinding[];
}

type ConfigSpec =
  | BaseSpec<'boolean'>
  | BaseSpec<'csv'>
  | BaseSpec<'duration'>
  | BaseSpec<'integer'>
  | BaseSpec<'number'>
  | BaseSpec<'path'>
  | BaseSpec<'secret'>
  | BaseSpec<'string'>
  | BaseSpec<'url'>
  | EnumSpec;

interface BaseSpec<K extends ConfigValueKind> {
  name: string;
  kind: K;
  default?: string;
  docDefault?: string;
  description?: string;
  defaultValue?: (env: NodeJS.ProcessEnv | Record<string, string | undefined>) => string | null;
  emptyUsesDefault?: boolean;
  normalize?: (value: string) => string;
  min?: number;
  max?: number;
  secret?: boolean;
  protocols?: string[];
  booleanValues?: readonly string[];
  truthyValues?: readonly string[];
  integerSyntax?: 'number' | 'digits';
}

interface EnumSpec extends BaseSpec<'enum'> {
  values: string[];
}

interface ValidateOptions {
  source?: string;
  now?: () => Date;
}

const STRICT_BOOL_VALUES = ['on', 'off', 'true', 'false', '1', '0'] as const;
const STRICT_TRUTHY_VALUES = ['on', 'true', '1'] as const;
const YES_NO_BOOL_VALUES = [...STRICT_BOOL_VALUES, 'yes', 'no'] as const;
const YES_NO_TRUTHY_VALUES = [...STRICT_TRUTHY_VALUES, 'yes'] as const;
const QUERY_CACHE_BOOL_VALUES = [...YES_NO_BOOL_VALUES, 'enabled', 'disabled'] as const;
const RERANK_CACHE_BOOL_VALUES = [...STRICT_BOOL_VALUES, 'enabled', 'disabled'] as const;
export const CONTROLLED_PREFIXES = [
  'KB_',
  'MCP_',
  'OLLAMA_',
  'OPENAI_',
  'HUGGINGFACE_',
  'FAISS_',
  'KNOWLEDGE_BASES_',
  'EMBEDDING_',
  'INGEST_',
  'INDEXING_',
  'REINDEX_',
  'FRONTMATTER_',
  'LOG_FILE',
] as const;

export const CONFIG_SCHEMA: readonly ConfigSpec[] = [
  { name: 'KNOWLEDGE_BASES_ROOT_DIR', kind: 'path', docDefault: '$HOME/knowledge_bases', description: 'Root directory containing knowledge base shelves.', defaultValue: (env) => resolveKnowledgeBasesRootDir(env.KNOWLEDGE_BASES_ROOT_DIR) },
  { name: 'FAISS_INDEX_PATH', kind: 'path', docDefault: '$KNOWLEDGE_BASES_ROOT_DIR/.faiss', description: 'Directory where FAISS index data is stored.', defaultValue: (env) => defaultFaissIndexPath(effectiveStringValue(env, 'KNOWLEDGE_BASES_ROOT_DIR', resolveKnowledgeBasesRootDir(undefined))) },
  { name: 'KB_INDEX_TYPE', kind: 'enum', values: ['flat', 'sq8', 'hnsw'], default: 'flat', normalize: lowercase, description: 'FAISS index structure built for dense retrieval: exact flat, scalar-quantized sq8, or approximate hnsw.' },
  { name: 'KB_HNSW_M', kind: 'integer', default: String(DEFAULT_HNSW_M), min: 2, max: 128, integerSyntax: 'digits', description: 'HNSW graph connectivity when KB_INDEX_TYPE=hnsw.' },
  { name: 'KB_HNSW_EF_CONSTRUCTION', kind: 'integer', default: String(DEFAULT_HNSW_EF_CONSTRUCTION), min: 1, max: 10000, integerSyntax: 'digits', description: 'HNSW build-time candidate list size when KB_INDEX_TYPE=hnsw.' },
  { name: 'KB_HNSW_EF_SEARCH', kind: 'integer', default: String(DEFAULT_HNSW_EF_SEARCH), min: 1, max: 10000, integerSyntax: 'digits', description: 'HNSW query-time candidate list size when KB_INDEX_TYPE=hnsw.' },
  { name: 'KB_HNSW_RANDOM_SEED', kind: 'integer', default: String(DEFAULT_HNSW_RANDOM_SEED), min: 1, max: 2147483647, integerSyntax: 'digits', description: 'HNSW random seed recorded in the index manifest.' },
  { name: 'EMBEDDING_PROVIDER', kind: 'enum', values: [...KNOWN_EMBEDDING_PROVIDERS], default: 'huggingface', description: 'Default embedding provider for retrieval and ingest.' },
  { name: 'KB_ACTIVE_MODEL', kind: 'string', description: 'Active model override; otherwise the active model sidecar or legacy provider env is used.' },
  { name: 'KB_FAKE_DIM', kind: 'integer', default: '256', min: 8, max: 4096, description: 'Embedding dimensionality used by the deterministic fake provider; testing only.' },

  { name: 'HUGGINGFACE_API_KEY', kind: 'secret', secret: true, description: 'API token authenticating requests to the Hugging Face embedding provider.' },
  { name: 'HUGGINGFACE_MODEL_NAME', kind: 'string', default: DEFAULT_HUGGINGFACE_MODEL_NAME, emptyUsesDefault: true, description: 'Hugging Face feature-extraction model used for embeddings.' },
  { name: 'HUGGINGFACE_PROVIDER', kind: 'string', default: 'hf-inference', emptyUsesDefault: true, description: 'Hugging Face inference provider routed through the router endpoint.' },
  { name: 'HUGGINGFACE_ENDPOINT_URL', kind: 'url', docDefault: 'https://router.huggingface.co/hf-inference/models/$HUGGINGFACE_MODEL_NAME/pipeline/feature-extraction', defaultValue: (env) => `https://router.huggingface.co/hf-inference/models/${effectiveValue(env, 'HUGGINGFACE_MODEL_NAME')}/pipeline/feature-extraction`, protocols: ['http:', 'https:'], description: 'Full feature-extraction endpoint URL overriding the derived Hugging Face router URL.' },
  { name: 'OLLAMA_BASE_URL', kind: 'url', default: 'http://localhost:11434', protocols: ['http:', 'https:'], description: 'Base URL of the local Ollama server used for embeddings.' },
  { name: 'OLLAMA_MODEL', kind: 'string', default: 'dengcao/Qwen3-Embedding-0.6B:Q8_0', emptyUsesDefault: true, description: 'Ollama embedding model tag pulled and served locally.' },
  { name: 'OPENAI_API_KEY', kind: 'secret', secret: true, description: 'API key authenticating requests to the OpenAI embedding provider.' },
  { name: 'OPENAI_MODEL_NAME', kind: 'string', default: DEFAULT_OPENAI_MODEL_NAME, emptyUsesDefault: true, description: 'OpenAI embedding model used for retrieval and ingest.' },
  { name: 'OPENAI_BASE_URL', kind: 'url', docDefault: 'https://api.openai.com/v1', defaultValue: () => DEFAULT_OPENAI_BASE_URL, protocols: ['http:', 'https:'], description: 'Base URL for OpenAI-compatible embedding endpoints; must include the API version path (e.g. /v1).' },
  { name: 'KB_EMBEDDING_TASK_PREFIXES', kind: 'boolean', default: 'on', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Enables role-specific embedding task prefixes for model families that require separate document/query prefixes.' },
  { name: 'KB_PROVIDER_BREAKER', kind: 'boolean', default: 'on', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Enables the process-shared open/half-open circuit breaker for embedding and LLM provider calls.' },
  { name: 'KB_PROVIDER_BREAKER_FAILURE_THRESHOLD', kind: 'integer', default: '3', min: 1, max: 100, integerSyntax: 'digits', description: 'Consecutive provider failures before the circuit opens.' },
  { name: 'KB_PROVIDER_BREAKER_COOLDOWN_MS', kind: 'duration', default: '30000', min: 1, max: 3600000, description: 'Open-circuit cooldown before a single half-open recovery probe is allowed.' },
  { name: 'KB_EMBED_TIMEOUT_MS', kind: 'duration', default: '120000', min: 1, description: 'Per-call deadline for network embedding-provider calls; on expiry the call fails with PROVIDER_TIMEOUT and the circuit breaker records it.' },

  { name: 'INDEXING_BATCH_SIZE', kind: 'integer', docDefault: '64; 16 when EMBEDDING_PROVIDER=ollama', defaultValue: (env) => String(defaultIndexingBatchSize(effectiveStringValue(env, 'EMBEDDING_PROVIDER', 'huggingface'))), min: 1, max: 512, description: 'Number of chunks embedded per provider request during indexing.' },
  { name: 'KB_INDEXING_CONCURRENCY', kind: 'integer', default: '1', min: 1, max: 4, description: 'Number of embedding batches indexed in parallel.' },
  { name: 'KB_CHUNK_SIZE', kind: 'integer', default: '1000', min: 1, description: 'Target character length of each text chunk produced during ingest.' },
  { name: 'KB_CHUNK_OVERLAP', kind: 'integer', docDefault: '200; floor(KB_CHUNK_SIZE / 5) when KB_CHUNK_SIZE is customized', defaultValue: (env) => defaultChunkOverlap(env), min: 0, description: 'Number of overlapping characters carried between adjacent chunks; must be less than KB_CHUNK_SIZE.' },
  { name: 'INGEST_EXTRA_EXTENSIONS', kind: 'csv', default: '', description: 'Additional file extensions to ingest beyond the built-in defaults.' },
  { name: 'INGEST_EXCLUDE_PATHS', kind: 'csv', default: '', description: 'Path globs excluded from ingest.' },
  { name: 'KB_MAX_FILE_BYTES', kind: 'integer', default: String(100 * 1024 * 1024), min: 1, description: 'Maximum source file size accepted for ingest; larger files are handled per KB_LARGE_FILE_POLICY.' },
  { name: 'KB_MAX_EXTRACTED_TEXT_BYTES', kind: 'integer', default: String(16 * 1024 * 1024), min: 1, description: 'Maximum extracted text size per file before KB_LARGE_FILE_POLICY applies.' },
  { name: 'KB_LARGE_FILE_POLICY', kind: 'enum', values: ['skip', 'truncate', 'error'], default: 'skip', description: 'Action taken when a file exceeds the size or extracted-text limits: skip, truncate, or error.' },
  { name: 'KB_REFRESH_QUIESCE_MS', kind: 'duration', default: '0', min: 0, description: 'Minimum file-modification age before a changed file is re-indexed on refresh, to avoid indexing mid-write.' },
  { name: 'KB_INGEST_ENABLED', kind: 'boolean', default: 'on', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Master switch for ingest and mutation tooling; when off, ingest-gated MCP tools are not registered.' },
  { name: 'KB_INGEST_SECRET_SCAN', kind: 'boolean', default: 'off', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Scans content during ingest and quarantines credential-shaped chunks before they are embedded.' },
  { name: 'KB_SECRET_SCAN_BYPASS_KBS', kind: 'csv', default: '', description: 'Knowledge base names exempted from ingest secret scanning.' },

  { name: 'KB_QUERY_CACHE', kind: 'boolean', default: 'on', booleanValues: QUERY_CACHE_BOOL_VALUES, truthyValues: ['on', 'true', '1', 'yes', 'enabled'], description: 'Enables the query embedding cache.' },
  { name: 'KB_QUERY_CACHE_LRU_MAX', kind: 'integer', default: '256', min: 0, description: 'Maximum query-embedding entries retained in the process LRU; 0 disables the memory tier.' },
  { name: 'KB_QUERY_CACHE_DISK_MAX_MB', kind: 'number', default: '64', min: 0.000001, description: 'Disk-size cap (MiB) for the persistent query-embedding cache.' },

  { name: 'KB_CONTEXTUAL_RETRIEVAL', kind: 'boolean', default: 'off', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Enables LLM contextual prefaces during ingest.' },
  { name: 'KB_RETRIEVAL_VIEWS', kind: 'csv', default: '', description: 'Extra per-chunk representations (section, metadata, summary) built and indexed alongside the passage view for multi-view retrieval.' },
  { name: 'KB_CONTEXTUAL_MAX_TOKENS', kind: 'integer', default: '150', min: 20, max: 1000, description: 'Maximum tokens generated for each LLM contextual preface during ingest.' },
  { name: 'KB_CONTEXTUAL_CONCURRENCY', kind: 'integer', default: '10', min: 1, max: 64, description: 'Number of contextual-preface LLM calls issued in parallel during ingest.' },
  { name: 'KB_LLM_ENDPOINT', kind: 'url', protocols: ['http:', 'https:', 'mock:'], description: 'OpenAI-compatible LLM endpoint used by kb ask and contextual retrieval.' },
  { name: 'KB_LLM_MODEL', kind: 'string', description: 'Model name sent to the configured LLM endpoint for kb ask and contextual retrieval.' },
  { name: 'KB_LLM_PROVIDER', kind: 'enum', values: ['local', 'openrouter'], default: 'local', description: 'LLM provider profile: a local OpenAI-compatible server or remote OpenRouter.' },
  { name: 'KB_OPENROUTER_API_KEY', kind: 'secret', secret: true, description: 'API key authenticating LLM requests when KB_LLM_PROVIDER=openrouter.' },
  { name: 'OPENROUTER_API_KEY', kind: 'secret', secret: true, description: 'Fallback OpenRouter API key used when KB_OPENROUTER_API_KEY is unset.' },
  { name: 'KB_LLM_APP_TITLE', kind: 'string', default: 'knowledge-base-mcp', emptyUsesDefault: true, description: 'Value sent as the OpenRouter X-Title attribution header on LLM requests.' },
  { name: 'KB_LLM_HTTP_REFERER', kind: 'string', description: 'Value sent as the OpenRouter HTTP-Referer attribution header on LLM requests.' },
  { name: 'KB_LLM_FAKE', kind: 'boolean', default: 'off', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Routes LLM calls to a deterministic in-process stub instead of a real endpoint; testing only.' },
  { name: 'KB_LLM_FAKE_RULES', kind: 'path', description: 'Path to a rules file scripting the fake LLM stub responses when KB_LLM_FAKE=on.' },
  { name: 'KB_DECOMPOSE_LLM_ENDPOINT', kind: 'url', protocols: ['http:', 'https:', 'mock:'], description: 'OpenAI-compatible endpoint used only by LLM query decomposition; falls back to KB_LLM_ENDPOINT when unset.' },
  { name: 'KB_DECOMPOSE_LLM_MODEL', kind: 'string', description: 'Model override used only by LLM query decomposition; falls back to KB_LLM_MODEL when unset.' },
  { name: 'KB_DECOMPOSE_CACHE_ENABLED', kind: 'boolean', default: 'off', booleanValues: QUERY_CACHE_BOOL_VALUES, truthyValues: ['on', 'true', '1', 'yes', 'enabled'], description: 'Enables the process LRU and persistent disk cache for query-decomposition results.' },
  { name: 'KB_DECOMPOSE_CACHE_LRU_MAX', kind: 'integer', default: '256', min: 0, description: 'Maximum query-decomposition entries retained in the process LRU; 0 disables the memory tier.' },
  { name: 'KB_DECOMPOSE_CACHE_DISK_MAX_BYTES', kind: 'integer', default: String(64 * 1024 * 1024), min: 1, description: 'Maximum bytes retained under $FAISS_INDEX_PATH/cache/query-decompositions.' },
  { name: 'KB_LLM_CONFIG_DIR', kind: 'path', docDefault: '$XDG_CONFIG_HOME/kb/llm or ~/.config/kb/llm', defaultValue: (env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'kb', 'llm'), description: 'Directory holding the managed local LLM configuration.' },
  { name: 'KB_LLM_STATE_DIR', kind: 'path', docDefault: '$XDG_STATE_HOME/kb/llm or ~/.local/state/kb/llm', defaultValue: (env) => path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'kb', 'llm'), description: 'Directory holding managed local LLM runtime state.' },
  { name: 'KB_LLM_SYSTEMD_USER_DIR', kind: 'path', docDefault: '$XDG_CONFIG_HOME/systemd/user or ~/.config/systemd/user', defaultValue: (env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user'), description: 'Directory where managed local LLM systemd user units are written.' },

  { name: 'KB_RELEVANCE_GATE', kind: 'boolean', default: 'off', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Enables recall-negative relevance gating by default.' },
  { name: 'KB_DENSE_DEGRADE_ON_PROVIDER_ERROR', kind: 'boolean', default: 'off', booleanValues: ['on', 'off'], truthyValues: ['on'], description: 'Allows dense and hybrid retrieval to degrade to lexical-only results during transient provider errors.' },
  { name: 'KB_HYBRID_DENSE_WEIGHT', kind: 'number', default: '1', min: 0, description: 'Dense retriever weight for hybrid Reciprocal Rank Fusion. Validate non-default values with BEIR/BRIGHT before deployment.' },
  { name: 'KB_HYBRID_LEXICAL_WEIGHT', kind: 'number', default: '1', min: 0, description: 'Lexical retriever weight for hybrid Reciprocal Rank Fusion. Validate non-default values with BEIR/BRIGHT before deployment.' },
  { name: 'KB_GATE_EMPTY_VERDICT', kind: 'boolean', default: 'off', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Allows the relevance gate to return a terminal empty verdict when nothing is judged relevant; kept opt-in due to false-empty risk.' },
  { name: 'KB_GATE_SCORE_FLOOR', kind: 'number', default: '0.95', min: 0, max: 1, description: 'Similarity-score floor the statistical relevance gate uses to decide whether a result is relevant.' },
  { name: 'KB_GATE_JUDGE_INPUT', kind: 'integer', default: '10', min: 1, max: 1000, description: 'Maximum number of candidate results fed into the relevance-gate LLM judge.' },
  { name: 'KB_GATE_LLM_TIMEOUT_MS', kind: 'duration', default: '8000', min: 1, description: 'Per-call timeout for the relevance-gate LLM judge request.' },
  { name: 'KB_GATE_MIN_TASK_TOKENS', kind: 'integer', default: '8', min: 1, description: 'Minimum token count a task-context string must have before the gate treats it as usable context.' },
  { name: 'KB_GATE_LLM_ENDPOINT', kind: 'url', protocols: ['http:', 'https:', 'mock:'], description: 'LLM judge endpoint for the relevance gate; falls back to KB_LLM_ENDPOINT when unset.' },
  { name: 'KB_GATE_LLM_MODEL', kind: 'string', description: 'Model used by the relevance-gate LLM judge; falls back to KB_LLM_MODEL when unset.' },
  { name: 'KB_GATE_TASK_CONTEXT_MODE', kind: 'enum', values: ['off', 'warn', 'strict'], default: 'warn', description: 'How task context passed to the relevance gate is screened for prompt-injection signals: off (no inspection), warn (advise via stderr), or strict (refuse suspicious input).' },
  { name: 'KB_GATE_TASK_CONTEXT_ARGV_MAX', kind: 'integer', default: '600', min: 1, description: 'Character length above which argv-supplied task context is flagged as prompt-like and better passed via a file.' },
  { name: 'KB_GATE_VERDICT_CACHE_MAX', kind: 'integer', default: '256', min: 0, description: 'Maximum relevance-gate verdict entries retained in the process LRU; 0 disables the memory cache.' },

  { name: 'KB_RERANK', kind: 'boolean', default: 'off', description: 'Enables optional cross-encoder reranking.' },
  { name: 'KB_RERANK_MODEL', kind: 'string', default: DEFAULT_RERANK_MODEL, description: 'Cross-encoder model used for reranking when KB_RERANK=on.' },
  { name: 'KB_RERANK_TOP_N', kind: 'integer', default: String(DEFAULT_RERANK_TOP_N), min: 1, max: MAX_RERANK_TOP_N, integerSyntax: 'digits', description: 'Number of top candidates passed to the cross-encoder reranker.' },
  { name: 'KB_RERANK_BATCH_SIZE', kind: 'integer', default: String(DEFAULT_RERANK_BATCH_SIZE), min: 0, max: MAX_RERANK_BATCH_SIZE, integerSyntax: 'digits', description: 'Sub-batches cross-encoder inference to bound peak memory; 0 = single call (default).' },
  { name: 'KB_RERANK_SKIP_DOMAINS', kind: 'csv', description: 'Knowledge base names for which cross-encoder reranking is skipped.' },
  { name: 'KB_RERANK_CACHE', kind: 'boolean', default: 'off', booleanValues: RERANK_CACHE_BOOL_VALUES, truthyValues: ['on', 'true', '1', 'enabled'], description: 'Enables the persistent disk-tiered rerank-score cache.' },
  { name: 'KB_RERANK_CACHE_DISK_MAX_BYTES', kind: 'integer', default: String(64 * 1024 * 1024), min: 1, description: 'Disk-size cap in bytes for the persistent rerank-score cache.' },
  { name: 'KB_RERANK_DEVICE', kind: 'string', description: 'Optional @huggingface/transformers device override for cross-encoder reranking, such as cuda.' },
  { name: 'KB_RERANK_DTYPE', kind: 'string', description: 'Optional @huggingface/transformers dtype override for cross-encoder reranking, such as fp32.' },

  { name: 'KB_INJECTION_GUARD', kind: 'enum', values: ['off', 'tag', 'wrap', 'both'], default: 'tag', description: 'How retrieved content is guarded against prompt injection: off, tag (annotate signals), wrap (fence in untrusted-doc markers), or both.' },
  { name: 'KB_INJECTION_GUARD_BYPASS_KBS', kind: 'csv', description: 'Knowledge base names exempted from injection guarding.' },
  { name: 'KB_INJECTION_GUARD_WRAP_OPEN', kind: 'string', description: 'Opening marker inserted before untrusted document content when wrapping is enabled.' },
  { name: 'KB_INJECTION_GUARD_WRAP_CLOSE', kind: 'string', description: 'Closing marker inserted after untrusted document content when wrapping is enabled.' },
  { name: 'KB_SHIELD', kind: 'enum', values: ['on', 'off'], default: 'on', description: 'Enables retrieval-time injection signal scanning; set exactly to off to omit injection_signals.' },
  { name: 'KB_EDITOR_URI', kind: 'enum', values: ['vscode', 'cursor', 'file', 'none'], default: 'none', description: 'Editor deep-link scheme used for source links in results: vscode, cursor, file, or none.' },
  { name: 'FRONTMATTER_EXTRAS_WIRE_VISIBLE', kind: 'boolean', default: 'false', description: 'Exposes extra frontmatter fields in the retrieval and ask output payloads.' },

  { name: 'KB_LOG_FORMAT', kind: 'enum', values: ['text', 'canonical', 'both'], default: 'both', description: 'Log output format: human text, structured canonical lines, or both.' },
  { name: 'LOG_LEVEL', kind: 'enum', values: ['debug', 'info', 'warn', 'error'], default: 'info', description: 'Minimum severity of emitted log records.' },
  { name: 'LOG_FILE', kind: 'path', description: 'Path to the runtime log file, also the default source read by kb logs and kb diagnose.' },
  { name: 'KB_LOG_MAX_BYTES', kind: 'integer', min: 1, description: 'Enables size-based LOG_FILE rotation when set to a positive byte cap.' },
  { name: 'KB_LOG_MAX_FILES', kind: 'integer', default: '5', min: 1, description: 'Retained rotated LOG_FILE generations when KB_LOG_MAX_BYTES enables rotation.' },
  { name: 'KB_LOG_VERBOSE', kind: 'boolean', default: 'off', description: 'Emits extra verbose debug logging in MCP server request handlers when set to 1.' },
  { name: 'KB_SLOW_QUERY_MS', kind: 'duration', min: 1, description: 'Latency threshold above which query canonical-log events are flagged slow and upgraded to warn.' },
  { name: 'KB_METRICS_EXPORT', kind: 'boolean', default: 'off', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Exposes the OpenMetrics text endpoint on the loopback HTTP daemon.' },
  { name: 'KB_FLAT_SEARCH_P95_ADVISORY_MS', kind: 'duration', default: String(DEFAULT_FLAT_SEARCH_P95_ADVISORY_MS), min: 1, description: 'Advisory p95 latency bound for flat-index search; kb stats and kb doctor warn when it is exceeded.' },
  { name: 'KB_MUTATION_AUDIT_LOG', kind: 'path', description: 'Path to an append-only log where mutating operations record audit entries.' },
  { name: 'KB_AGE_BUDGET_HOURS', kind: 'integer', min: 1, description: 'Global maximum content-age budget (hours) for staleness checks; per-KB overrides use KB_AGE_BUDGET_HOURS_<KB>.' },

  { name: 'KB_DAEMON_URL', kind: 'url', protocols: ['http:', 'https:'], description: 'Explicit daemon HTTP URL for clients; takes precedence over host/port/socket resolution.' },
  { name: 'KB_DAEMON_SOCKET', kind: 'path', description: 'Unix-domain socket the daemon binds and clients connect to when KB_DAEMON_URL is unset.' },
  { name: 'KB_DAEMON_HOST', kind: 'string', default: '127.0.0.1', emptyUsesDefault: true, description: 'Host the daemon TCP client connects to when no URL or socket is configured.' },
  { name: 'KB_DAEMON_PORT', kind: 'integer', default: '17799', min: 1, max: 65535, description: 'TCP port for the daemon client when no URL or socket is configured.' },
  { name: 'KB_DAEMON_CLIENT_TIMEOUT_MS', kind: 'duration', default: String(DEFAULT_DAEMON_CLIENT_TIMEOUT_MS), min: 1, max: MAX_DAEMON_CLIENT_TIMEOUT_MS, integerSyntax: 'digits', description: 'Timeout in milliseconds for daemon command requests.' },
  { name: 'KB_DAEMON_HEALTH_TIMEOUT_MS', kind: 'duration', default: String(DEFAULT_DAEMON_HEALTH_TIMEOUT_MS), min: 1, max: MAX_DAEMON_CLIENT_TIMEOUT_MS, integerSyntax: 'digits', description: 'Timeout in milliseconds for daemon health requests, capped by any outer autostart deadline.' },
  { name: 'KB_DAEMON_DRAIN_TIMEOUT_MS', kind: 'duration', default: '5000', min: 0, description: 'Bounded wait (ms) for in-flight kb serve requests to finish on SIGINT/SIGTERM before the daemon force-exits. 0 stops immediately.' },
  { name: DAEMON_MAX_CONCURRENCY_ENV, kind: 'integer', default: String(DEFAULT_DAEMON_MAX_CONCURRENCY), min: 1, max: MAX_DAEMON_CONCURRENCY, integerSyntax: 'digits', description: 'Maximum concurrent kb serve daemon requests admitted at once; excess requests queue (up to KB_DAEMON_QUEUE_MAX) then get 429. Tune down on smaller boxes.' },
  { name: DAEMON_QUEUE_MAX_ENV, kind: 'integer', default: String(DEFAULT_DAEMON_QUEUE_MAX), min: 0, max: MAX_DAEMON_QUEUE_MAX, integerSyntax: 'digits', description: 'Bounded backlog of kb serve daemon requests queued beyond the KB_DAEMON_MAX_CONCURRENCY cap; further requests get 429 + Retry-After. 0 rejects immediately once the concurrency slots are full.' },
  { name: 'KB_DAEMON_AUTOSTART', kind: 'boolean', default: 'off', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Lets clients auto-spawn a detached daemon when none is running.' },
  { name: 'KB_DAEMON_PREWARM', kind: 'boolean', default: 'off', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Pre-warms index managers at daemon startup so the first request is not cold.' },
  { name: 'MCP_TRANSPORT', kind: 'enum', values: ['stdio', 'sse', 'http'], default: 'stdio', description: 'MCP server transport.' },
  { name: 'MCP_PORT', kind: 'integer', default: '8765', min: 1, max: 65535, description: 'TCP port for the HTTP/SSE MCP transport.' },
  { name: 'MCP_BIND_ADDR', kind: 'string', default: '127.0.0.1', description: 'Bind address for the HTTP/SSE MCP transport.' },
  { name: 'MCP_AUTH_TOKEN', kind: 'secret', secret: true, description: 'Bearer token required for HTTP/SSE transports.' },
  { name: 'MCP_AUTH_TOKEN_FILE', kind: 'path', description: 'Path to a file containing the bearer token for HTTP/SSE transports; takes precedence over MCP_AUTH_TOKEN.' },
  { name: 'MCP_ALLOWED_ORIGINS', kind: 'csv', description: 'Origin allowlist accepted for CORS/CSRF on the HTTP/SSE transports; * is rejected.' },
  { name: 'MCP_ALLOWED_HOSTS', kind: 'csv', description: 'Extra Host-header values accepted by the HTTP/SSE transports for DNS-rebinding protection. Loopback aliases derived from MCP_BIND_ADDR/MCP_PORT are always allowed; set to * to disable Host validation for reverse-proxy setups.' },
  { name: 'MCP_AUTH_BACKOFF_THRESHOLD', kind: 'integer', default: '5', min: 0, description: 'Failed auth attempts from a client before the transport applies backoff.' },
  { name: 'MCP_AUTH_BACKOFF_MS', kind: 'duration', default: '30000', min: 0, description: 'Backoff delay applied to a client after the auth-failure threshold is reached.' },
  { name: 'MCP_AUTH_BACKOFF_MAX_ENTRIES', kind: 'integer', default: '1024', min: 1, description: 'Maximum client entries tracked in the auth-backoff table.' },
  { name: 'KB_MAX_QUERY_CHARS', kind: 'integer', default: '8192', min: 1, description: 'Maximum query string length accepted by MCP retrieval and ask tools.' },
  { name: 'KB_MAX_FILTER_ITEMS', kind: 'integer', default: '64', min: 1, description: 'Maximum number of filter items accepted by MCP retrieval and diff tools.' },
  { name: 'KB_MAX_GLOB_CHARS', kind: 'integer', default: '1024', min: 1, description: 'Maximum path_glob length accepted by MCP retrieval tools.' },
  { name: 'KB_MAX_GLOB_WILDCARDS', kind: 'integer', default: '64', min: 1, description: 'Maximum wildcard count accepted in MCP retrieval path_glob filters.' },

  { name: 'REINDEX_TRIGGER_PATH', kind: 'path', docDefault: '$KNOWLEDGE_BASES_ROOT_DIR/.reindex-trigger', defaultValue: (env) => path.join(effectiveStringValue(env, 'KNOWLEDGE_BASES_ROOT_DIR', resolveKnowledgeBasesRootDir(undefined)), '.reindex-trigger'), description: 'Trigger file the server watches to initiate a reindex.' },
  { name: 'REINDEX_TRIGGER_POLL_MS', kind: 'duration', default: '5000', min: 0, max: 60000, description: 'Poll interval for the reindex-trigger watcher; 0 disables it.' },
  { name: 'KB_FS_WATCH', kind: 'boolean', default: 'off', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Enables recursive filesystem watching that auto-reindexes on content changes.' },
  { name: 'KB_FS_WATCH_DEBOUNCE_MS', kind: 'duration', default: '250', min: 25, max: 60000, description: 'Debounce window that coalesces filesystem-watch events before triggering a reindex.' },
  { name: 'KB_INDEX_VERSION_RETENTION', kind: 'integer', default: '2', min: 0, integerSyntax: 'digits', description: 'Number of previous inactive index versions retained before older ones are pruned.' },
  { name: 'KB_MIN_FREE_DISK_BYTES', kind: 'integer', default: String(512 * 1024 * 1024), min: 0, description: 'Free-space safety margin retained after write-heavy reindex and ingest estimates.' },

  { name: 'RETRIEVE_KNOWLEDGE_DESCRIPTION', kind: 'string', default: DEFAULT_RETRIEVE_KNOWLEDGE_DESCRIPTION, emptyUsesDefault: true, description: 'Overrides the advertised MCP tool description for retrieve_knowledge.' },
  { name: 'ASK_KNOWLEDGE_DESCRIPTION', kind: 'string', default: DEFAULT_ASK_KNOWLEDGE_DESCRIPTION, emptyUsesDefault: true, description: 'Overrides the advertised MCP tool description for ask_knowledge.' },
  { name: 'LIST_KNOWLEDGE_BASES_DESCRIPTION', kind: 'string', default: DEFAULT_LIST_KNOWLEDGE_BASES_DESCRIPTION, emptyUsesDefault: true, description: 'Overrides the advertised MCP tool description for list_knowledge_bases.' },
  { name: 'LIST_MODELS_DESCRIPTION', kind: 'string', default: DEFAULT_LIST_MODELS_DESCRIPTION, emptyUsesDefault: true, description: 'Overrides the advertised MCP tool description for list_models.' },
  { name: 'KB_STATS_DESCRIPTION', kind: 'string', default: DEFAULT_KB_STATS_DESCRIPTION, emptyUsesDefault: true, description: 'Overrides the advertised MCP tool description for kb_stats.' },
  { name: 'KB_SEARCH_SNIPPET', kind: 'string', description: 'Default kb search snippet mode; accepts off aliases, on aliases, or a positive line count.' },

  { name: 'KB_MCP_PROMPTS', kind: 'boolean', default: 'off', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Advertises the MCP prompts capability with read-only KB prompt templates.' },
  { name: 'KB_ASK_REDACT_OUTBOUND', kind: 'boolean', docDefault: 'on when KB_LLM_PROVIDER=openrouter (remote); off for local', defaultValue: (env) => (((env.KB_LLM_PROVIDER ?? '').trim().toLowerCase() === 'openrouter') ? 'on' : 'off'), booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Scrub secrets (via redactSecrets) from the assembled kb ask prompt before it is sent to a remote LLM. Defaults on for remote providers; set explicitly to scrub (or skip) on the local path.' },
  { name: 'KB_ASK_CACHE', kind: 'boolean', default: 'off', booleanValues: QUERY_CACHE_BOOL_VALUES, truthyValues: ['on', 'true', '1', 'yes', 'enabled'], description: 'Enables the opt-in kb ask / ask_knowledge answer cache keyed by query + retrieved-context fingerprint + embedding model + LLM profile. Invalidates implicitly when the retrieved context changes.' },
  { name: 'KB_ASK_CACHE_DISK_MAX_MB', kind: 'number', default: '64', min: 0.000001, description: 'Disk-size cap (MiB) for the answer cache; oldest entries are evicted first on write.' },

  { name: 'KB_OTEL_TRACES', kind: 'boolean', default: 'off', booleanValues: YES_NO_BOOL_VALUES, truthyValues: YES_NO_TRUTHY_VALUES, description: 'Opt into OpenTelemetry (OTLP) distributed trace export for the retrieve/ask pipeline. Off by default and zero-cost when disabled; when on, the optional @opentelemetry/* packages are lazily loaded and spans are exported via OTLP/HTTP. Honors the standard OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_SERVICE_NAME env vars.' },
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', kind: 'url', protocols: ['http:', 'https:'], description: 'Standard OpenTelemetry OTLP collector endpoint used for trace export when KB_OTEL_TRACES is enabled (e.g. http://localhost:4318).' },
  { name: 'OTEL_SERVICE_NAME', kind: 'string', docDefault: 'knowledge-base-mcp-server', description: 'Standard OpenTelemetry service.name attached to exported traces when KB_OTEL_TRACES is enabled.' },
] as const;

const SCHEMA_NAMES = CONFIG_SCHEMA.map((spec) => spec.name);
const SCHEMA_BY_NAME = new Map(CONFIG_SCHEMA.map((spec) => [spec.name, spec]));

export function validateConfigEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: ValidateOptions = {},
): ConfigValidateReport {
  const source = options.source ?? 'process.env';
  const findings: ConfigFinding[] = [];
  for (const spec of CONFIG_SCHEMA) {
    findings.push(validateSpec(spec, env[spec.name], source, env));
  }
  for (const [name, raw] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    if (SCHEMA_BY_NAME.has(name)) continue;
    const spec = dynamicSpecForName(name);
    if (spec !== null) findings.push(validateSpec(spec, raw, source, env));
  }
  findings.push(...validateDependencies(env, source));
  findings.push(...validateUnknownControlledVars(env, source));

  const counts = countFindings(findings);
  const status: ConfigFindingStatus = counts.error > 0 ? 'error' : counts.warn > 0 ? 'warn' : 'ok';
  return {
    schema_version: 'kb.config-validate.v1',
    status,
    source,
    checked_at: (options.now ?? (() => new Date()))().toISOString(),
    counts,
    findings,
  };
}

export function showConfigEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: {
    nonDefaultOnly?: boolean;
    configFile?: string | null;
    sources?: Record<string, ConfigValueSource | undefined>;
  } = {},
): ConfigShowReport {
  const entries = CONFIG_SCHEMA
    .map((spec) => showSpec(spec, env, options.sources))
    .filter((entry) => !options.nonDefaultOnly || entry.source !== 'default');

  return {
    schema_version: 'kb.config-show.v1',
    ...(options.configFile !== undefined ? { config_file: options.configFile } : {}),
    entries,
  };
}

export function parseDotEnvText(text: string, source = '.env'): DotEnvParseResult {
  const env: Record<string, string> = {};
  const errors: ConfigFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    const eqIndex = withoutExport.indexOf('=');
    if (eqIndex <= 0) {
      errors.push({
        name: `line ${lineNo}`,
        status: 'error',
        kind: 'unknown',
        source,
        value: rawLine,
        message: 'expected KEY=VALUE dotenv assignment',
      });
      continue;
    }
    const key = withoutExport.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push({
        name: `line ${lineNo}`,
        status: 'error',
        kind: 'unknown',
        source,
        value: rawLine,
        message: `invalid dotenv key ${JSON.stringify(key)}`,
      });
      continue;
    }
    env[key] = parseDotEnvValue(withoutExport.slice(eqIndex + 1));
  }
  return { env, errors };
}

function validateSpec(
  spec: ConfigSpec,
  raw: string | undefined,
  source: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ConfigFinding {
  const value = normalizeSpecValue(spec, normalizeRaw(raw));
  const displayValue = displayRawValue(spec, value);
  const defaultValue = defaultForSpec(spec, env);
  if (value === undefined) {
    return finding(spec.name, 'ok', spec.kind, source, null, defaultValue === null
      ? 'unset'
      : `unset; default ${defaultValue} applies`);
  }
  if (value === '' && usesDefaultForEmpty(spec)) {
    return finding(spec.name, 'ok', spec.kind, source, displayValue, 'empty; default applies');
  }
  if (spec.name === 'KB_SEARCH_SNIPPET') {
    return validateSearchSnippetSpec(spec, value, displayValue, source);
  }

  switch (spec.kind) {
    case 'boolean':
      return booleanValuesFor(spec).has(value.toLowerCase())
        ? finding(spec.name, 'ok', spec.kind, source, displayValue, 'valid boolean')
        : finding(spec.name, 'error', spec.kind, source, displayValue, `expected boolean ${Array.from(booleanValuesFor(spec)).join('/')}`);
    case 'enum':
      return spec.values.includes(value)
        ? finding(spec.name, 'ok', spec.kind, source, displayValue, 'valid enum value')
        : finding(spec.name, 'error', spec.kind, source, displayValue, `expected one of: ${spec.values.join(', ')}`);
    case 'integer':
    case 'duration':
      return validateNumberLike(spec, value, displayValue, source, true);
    case 'number':
      return validateNumberLike(spec, value, displayValue, source, false);
    case 'url':
      return validateUrl(spec, value, displayValue, source);
    case 'csv':
      return finding(spec.name, 'ok', spec.kind, source, displayValue, 'valid comma-separated list');
    case 'path':
      return finding(spec.name, value === '' ? 'warn' : 'ok', spec.kind, source, displayValue, value === '' ? 'empty path' : 'valid path string');
    case 'secret':
      return finding(spec.name, value === '' ? 'warn' : 'ok', spec.kind, source, displayValue, value === '' ? 'empty secret' : 'set');
    case 'string':
      return finding(spec.name, 'ok', spec.kind, source, displayValue, value === '' ? 'empty string' : 'set');
  }
}

function showSpec(
  spec: ConfigSpec,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  sources?: Record<string, ConfigValueSource | undefined>,
): ConfigShowEntry {
  const value = effectiveValue(env, spec.name);
  const redacted = isSecretSpec(spec) && value !== null && value !== '';
  return {
    name: spec.name,
    kind: spec.kind,
    value: redacted ? '<redacted>' : value,
    source: sourceForSpec(spec, env, sources),
    redacted,
  };
}

function validateNumberLike(
  spec: ConfigSpec,
  value: string,
  displayValue: string | null,
  source: string,
  integer: boolean,
): ConfigFinding {
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    (integer && (!Number.isInteger(parsed) || (spec.integerSyntax === 'digits' && !/^\d+$/.test(value))))
  ) {
    return finding(spec.name, 'error', spec.kind, source, displayValue, integer ? 'expected integer' : 'expected finite number');
  }
  if (spec.min !== undefined && parsed < spec.min) {
    return finding(spec.name, 'error', spec.kind, source, displayValue, `expected value >= ${spec.min}`);
  }
  if (spec.max !== undefined && parsed > spec.max) {
    return finding(spec.name, 'error', spec.kind, source, displayValue, `expected value <= ${spec.max}`);
  }
  return finding(spec.name, 'ok', spec.kind, source, displayValue, 'valid number');
}

function validateSearchSnippetSpec(
  spec: ConfigSpec,
  value: string,
  displayValue: string | null,
  source: string,
): ConfigFinding {
  if (value === '') {
    return finding(spec.name, 'ok', spec.kind, source, displayValue, 'empty; unset');
  }
  const normalized = value.toLowerCase();
  if (['false', 'off', 'no', '0', 'true', 'on', 'yes'].includes(normalized)) {
    return finding(spec.name, 'ok', spec.kind, source, displayValue, 'valid search snippet mode');
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0) {
    return finding(spec.name, 'error', spec.kind, source, displayValue, 'expected off/on alias or positive integer');
  }
  return finding(spec.name, 'ok', spec.kind, source, displayValue, 'valid search snippet line count');
}

function validateUrl(
  spec: ConfigSpec,
  value: string,
  displayValue: string | null,
  source: string,
): ConfigFinding {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return finding(spec.name, 'error', spec.kind, source, displayValue, 'expected absolute URL');
  }
  const protocols = spec.protocols ?? ['http:', 'https:'];
  if (!protocols.includes(url.protocol)) {
    return finding(spec.name, 'error', spec.kind, source, displayValue, `expected URL protocol ${protocols.join('|')}`);
  }
  return finding(spec.name, 'ok', spec.kind, source, displayValue, 'valid URL');
}

function validateDependencies(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  source: string,
): ConfigFinding[] {
  const findings: ConfigFinding[] = [];
  const chunkSize = effectiveIntegerValue(env, 'KB_CHUNK_SIZE');
  const chunkOverlap = effectiveIntegerValue(env, 'KB_CHUNK_OVERLAP');
  if (chunkSize !== null && chunkSize > 0 && chunkOverlap !== null && chunkOverlap >= 0 && chunkOverlap >= chunkSize) {
    findings.push(finding(
      'KB_CHUNK_OVERLAP',
      'error',
      'dependency',
      source,
      String(chunkOverlap),
      'KB_CHUNK_OVERLAP must be less than KB_CHUNK_SIZE ' +
        `(expected KB_CHUNK_OVERLAP < KB_CHUNK_SIZE; received KB_CHUNK_OVERLAP=${chunkOverlap}, KB_CHUNK_SIZE=${chunkSize})`,
    ));
  }
  if (isOn('KB_RERANK', env.KB_RERANK) && !isNonEmpty(env.KB_RERANK_MODEL)) {
    findings.push(finding(
      'KB_RERANK_MODEL',
      'warn',
      'dependency',
      source,
      null,
      'KB_RERANK=on uses the default reranker model because KB_RERANK_MODEL is not set',
    ));
  }
  if (isOn('KB_RELEVANCE_GATE', env.KB_RELEVANCE_GATE) && !isNonEmpty(env.KB_GATE_LLM_ENDPOINT) && !isNonEmpty(env.KB_LLM_ENDPOINT) && !isOn('KB_LLM_FAKE', env.KB_LLM_FAKE)) {
    findings.push(finding(
      'KB_RELEVANCE_GATE',
      'warn',
      'dependency',
      source,
      displayRawValue({ name: 'KB_RELEVANCE_GATE', kind: 'boolean' }, normalizeRaw(env.KB_RELEVANCE_GATE)),
      'KB_RELEVANCE_GATE=on has no KB_GATE_LLM_ENDPOINT or KB_LLM_ENDPOINT; Stage B will degrade without a judge endpoint',
    ));
  }
  if (isOn('KB_CONTEXTUAL_RETRIEVAL', env.KB_CONTEXTUAL_RETRIEVAL) && !isNonEmpty(env.KB_LLM_ENDPOINT) && !isOn('KB_LLM_FAKE', env.KB_LLM_FAKE)) {
    findings.push(finding(
      'KB_CONTEXTUAL_RETRIEVAL',
      'error',
      'dependency',
      source,
      displayRawValue({ name: 'KB_CONTEXTUAL_RETRIEVAL', kind: 'boolean' }, normalizeRaw(env.KB_CONTEXTUAL_RETRIEVAL)),
      'KB_CONTEXTUAL_RETRIEVAL=on requires KB_LLM_ENDPOINT or KB_LLM_FAKE=on',
    ));
  }
  const transport = normalizeRaw(env.MCP_TRANSPORT);
  if (transport === 'http' || transport === 'sse') {
    const token = normalizeRaw(env.MCP_AUTH_TOKEN);
    const tokenFile = normalizeRaw(env.MCP_AUTH_TOKEN_FILE);
    if (!token && !tokenFile) {
      findings.push(finding(
        'MCP_AUTH_TOKEN',
        'error',
        'dependency',
        source,
        null,
        `MCP_TRANSPORT=${transport} requires MCP_AUTH_TOKEN or MCP_AUTH_TOKEN_FILE`,
      ));
    } else if (!tokenFile && token !== undefined && token.length < 32) {
      findings.push(finding(
        'MCP_AUTH_TOKEN',
        'error',
        'dependency',
        source,
        '<redacted>',
        'MCP_AUTH_TOKEN must be at least 32 characters for HTTP/SSE transport',
      ));
    }
  }
  return findings;
}

function effectiveIntegerValue(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string,
): number | null {
  const value = effectiveValue(env, name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function validateUnknownControlledVars(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  source: string,
): ConfigFinding[] {
  const findings: ConfigFinding[] = [];
  for (const name of Object.keys(env).sort()) {
    if (SCHEMA_BY_NAME.has(name)) continue;
    if (dynamicSpecForName(name) !== null) continue;
    if (!isControlledEnvName(name)) continue;
    const suggestion = suggestSchemaName(name);
    findings.push(finding(
      name,
      'warn',
      'unknown',
      source,
      '<set>',
      'not in kb config schema; check spelling or add it to src/config/schema.ts' +
        (suggestion === undefined ? '' : `. Did you mean ${suggestion}?`),
    ));
  }
  return findings;
}

function suggestSchemaName(name: string): string | undefined {
  // Shared env-name prefixes make distance alone too permissive. Limit hints to
  // typo shapes that do not guess between distinct configuration concepts.
  const candidates = SCHEMA_NAMES.filter((candidate) => isLikelySchemaNameTypo(name, candidate));
  const nearest = closestSuggestion(name, candidates);
  if (nearest === undefined) return undefined;

  const hasTie = candidates.some((candidate) => (
    candidate !== nearest.value
    && levenshteinDistance(name, candidate) === nearest.distance
  ));
  return hasTie ? undefined : nearest.value;
}

function isLikelySchemaNameTypo(input: string, candidate: string): boolean {
  if (Math.abs(input.length - candidate.length) === 1) {
    return levenshteinDistance(input, candidate) === 1;
  }
  if (input.length !== candidate.length) return false;

  let firstMismatch = -1;
  let secondMismatch = -1;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === candidate[i]) continue;
    if (firstMismatch === -1) firstMismatch = i;
    else if (secondMismatch === -1) secondMismatch = i;
    else return false;
  }
  return secondMismatch === firstMismatch + 1
    && input[firstMismatch] === candidate[secondMismatch]
    && input[secondMismatch] === candidate[firstMismatch];
}

function dynamicSpecForName(name: string): ConfigSpec | null {
  if (/^KB_AGE_BUDGET_HOURS_[A-Z0-9_]+$/.test(name)) {
    return { name, kind: 'integer', min: 1 };
  }
  return null;
}

function finding(
  name: string,
  status: ConfigFindingStatus,
  kind: ConfigValueKind,
  source: string,
  value: string | null,
  message: string,
): ConfigFinding {
  return { name, status, kind, source, value, message };
}

function countFindings(findings: readonly ConfigFinding[]): Record<ConfigFindingStatus, number> {
  return findings.reduce<Record<ConfigFindingStatus, number>>(
    (counts, item) => {
      counts[item.status] += 1;
      return counts;
    },
    { ok: 0, warn: 0, error: 0 },
  );
}

function normalizeRaw(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : raw.trim();
}

function effectiveValue(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string,
): string | null {
  const spec = SCHEMA_BY_NAME.get(name);
  if (spec === undefined) return null;
  const value = normalizeSpecValue(spec, normalizeRaw(env[name]));
  if (value === undefined) return defaultForSpec(spec, env);
  if (value === '' && usesDefaultForEmpty(spec)) {
    return defaultForSpec(spec, env);
  }
  return value;
}

function effectiveStringValue(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string,
  fallback: string,
): string {
  return effectiveValue(env, name) ?? fallback;
}

function sourceForSpec(
  spec: ConfigSpec,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  sources?: Record<string, ConfigValueSource | undefined>,
): ConfigValueSource {
  const value = normalizeSpecValue(spec, normalizeRaw(env[spec.name]));
  if (value === undefined) return 'default';
  if (value === '' && usesDefaultForEmpty(spec)) return 'default';
  return sources?.[spec.name] ?? 'env';
}

function defaultForSpec(
  spec: ConfigSpec,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | null {
  if (spec.defaultValue !== undefined) return spec.defaultValue(env);
  return spec.default ?? null;
}

function defaultChunkOverlap(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  const size = Number(effectiveValue(env, 'KB_CHUNK_SIZE'));
  if (!Number.isFinite(size) || size <= 0 || Math.floor(size) === 1000) return '200';
  return String(Math.floor(Math.floor(size) / 5));
}

function normalizeSpecValue(spec: ConfigSpec, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return spec.normalize?.(value) ?? value;
}

function usesDefaultForEmpty(spec: ConfigSpec): boolean {
  return spec.emptyUsesDefault === true || (spec.kind !== 'string' && spec.kind !== 'secret');
}

function lowercase(value: string): string {
  return value.toLowerCase();
}

function isOn(name: string, raw: string | undefined): boolean {
  const spec = SCHEMA_BY_NAME.get(name);
  const normalized = normalizeRaw(raw)?.toLowerCase();
  if (normalized === undefined) return false;
  const truthy = spec?.kind === 'boolean' ? spec.truthyValues ?? STRICT_TRUTHY_VALUES : STRICT_TRUTHY_VALUES;
  return truthy.includes(normalized);
}

function isNonEmpty(raw: string | undefined): boolean {
  return normalizeRaw(raw) !== undefined && normalizeRaw(raw) !== '';
}

function displayRawValue(spec: Pick<ConfigSpec, 'kind' | 'name' | 'secret'>, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (isSecretSpec(spec)) {
    return value === '' ? '' : '<redacted>';
  }
  return value;
}

function isSecretSpec(spec: Pick<ConfigSpec, 'kind' | 'name' | 'secret'>): boolean {
  return Boolean(spec.secret)
    || spec.kind === 'secret'
    || /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|PRIVATE_KEY|CLIENT_SECRET|SECRET|PASSWORD|PASSWD|COOKIE)$/.test(spec.name);
}

function booleanValuesFor(spec: Pick<BaseSpec<'boolean'>, 'booleanValues'>): Set<string> {
  return new Set(spec.booleanValues ?? STRICT_BOOL_VALUES);
}

export function isControlledEnvName(name: string): boolean {
  return CONTROLLED_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix));
}

/**
 * True when `name` is registered with the config system: either an explicit
 * entry in {@link CONFIG_SCHEMA} or a name matched by a dynamic spec pattern
 * (e.g. `KB_AGE_BUDGET_HOURS_<KB>`). Used by the code→schema drift guard
 * (`scripts/check-config-env-usage.mjs`) to distinguish registered reads from
 * contributor drift.
 */
export function isRegisteredConfigName(name: string): boolean {
  return SCHEMA_BY_NAME.has(name) || dynamicSpecForName(name) !== null;
}

function parseDotEnvValue(rawValue: string): string {
  const trimmed = rawValue.trimStart();
  if (trimmed.startsWith('"')) {
    return parseQuotedValue(trimmed, '"');
  }
  if (trimmed.startsWith("'")) {
    return parseQuotedValue(trimmed, "'");
  }
  return stripInlineComment(trimmed).trimEnd();
}

function parseQuotedValue(value: string, quote: '"' | "'"): string {
  let out = '';
  for (let i = 1; i < value.length; i++) {
    const char = value[i];
    if (char === quote) return out;
    if (quote === '"' && char === '\\' && i + 1 < value.length) {
      i += 1;
      const escaped = value[i];
      if (escaped === 'n') out += '\n';
      else if (escaped === 'r') out += '\r';
      else if (escaped === 't') out += '\t';
      else out += escaped;
      continue;
    }
    out += char;
  }
  return out;
}

function stripInlineComment(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i);
    }
  }
  return value;
}
