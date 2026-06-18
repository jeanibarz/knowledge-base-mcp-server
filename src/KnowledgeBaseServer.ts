// KnowledgeBaseServer.ts
import * as fsp from 'fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  type CallToolResult,
  type ListResourcesRequest,
  type ListResourcesResult,
  type ReadResourceResult,
  type TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import type {
  IndexUpdateProgress,
  NeighborContextOptions,
  SearchResultDocument,
  SimilaritySearchTiming,
} from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  listRegisteredModels,
  modelDir,
  parseModelId,
  readStoredModelName,
  resolveActiveModel,
  resolveFaissIndexBinaryPath,
} from './active-model.js';
import { ManagerRegistry } from './manager-registry.js';
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
import {
  ADD_DOCUMENT_INPUT,
  ASK_KNOWLEDGE_INPUT,
  DELETE_DOCUMENT_INPUT,
  DIFF_INDEX_INPUT,
  KB_STATS_INPUT,
  REINDEX_KNOWLEDGE_BASE_INPUT,
  RETRIEVE_KNOWLEDGE_INPUT,
} from './mcp-tool-specs.js';
import {
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  KB_DENSE_DEGRADE_ON_PROVIDER_ERROR,
} from './config/retrieval.js';
import {
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
  KB_INGEST_ENABLED,
} from './config/ingest.js';
import {
  KB_FS_WATCH,
  KB_FS_WATCH_DEBOUNCE_MS,
  REINDEX_TRIGGER_PATH,
  REINDEX_TRIGGER_POLL_MS,
} from './config/watchers.js';
import {
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config/paths.js';
import type { EmbeddingProvider } from './model-id.js';
import {
  loadTransportConfig,
  TransportConfigError,
  type TransportConfig,
} from './transport-config.js';
import {
  formatDegradedStagesFooter,
  formatRetrievalAsMarkdown,
} from './formatter.js';
import {
  listKnowledgeBases,
  resolveKnowledgeBaseDir,
} from './kb-fs.js';
import { computeKbStats } from './kb-stats.js';
import {
  listResources,
  readResource,
  registerResources,
} from './mcp-resources.js';
import { registerCompletions } from './mcp-completions.js';
import { KB_MCP_PROMPTS, registerPrompts } from './mcp-prompts.js';
import {
  handleAddDocument,
  handleDeleteDocument,
  type AddDocumentArgs,
  type DeleteDocumentArgs,
} from './mcp-document-mutations.js';
import { withWriteLock } from './write-lock.js';
import { logger } from './logger.js';
import { toError } from './error-utils.js';
import * as path from 'path';
import { StreamableHttpHost } from './transport/http.js';
import { SseHost } from './transport/sse.js';
import { ReindexTriggerWatcher } from './triggerWatcher.js';
import { RecursiveKbWatcher } from './recursive-fs-watch.js';
import { KBError, type KBErrorCode } from './errors.js';
import {
  HYBRID_RRF_C,
  fuseHybridResultsWithDiagnostics,
  hybridFetchK,
  runLexicalLeg,
} from './hybrid-retrieval.js';
import {
  canonicalErrorFromToolResult,
  classifyCanonicalError,
  canonicalGateStageRecord,
  canonicalRerankStageRecord,
  degradationSummaryFields,
  emitCanonicalLog,
  type CanonicalDegradedStage,
  type CanonicalLogInput,
} from './canonical-log.js';
import { formatKbStatsOpenMetrics } from './prometheus-export.js';
import { searchLatencyMetrics } from './metrics.js';
import {
  searchStageDurationsFromTiming,
  type TimingPayload,
} from './timing-core.js';
import {
  formatDiffIndexMarkdown,
  resolveIndexVersionPath,
  runDiffIndex,
  type DiffIndexQuery,
} from './diff-index-core.js';
import {
  classifyDenseDegradationReason,
  type DenseDegradationReason,
} from './search-core.js';
import { parseRecencyFilterRange } from './search-filters.js';
import { withSpan } from './otel-trace.js';
import {
  applyRelevanceGate,
  emitRelevanceGateDecision,
  formatGateVerdictFooter,
  type RelevanceGateOverride,
} from './relevance-gate.js';
import type { RelevanceGateVerdict } from './relevance-gate-schema.js';
import { chunkIdFromMetadata } from './rrf.js';
import {
  applyRerankerIfEnabled,
  RerankerConfigError,
  resolveRerankerConfig,
  type RerankOverride,
} from './reranker.js';
import type { TransportRuntimeStatsSnapshot } from './transport-runtime-stats.js';
import { AskExecutionError, askKnowledge } from './ask-core.js';
import { callChatCompletion } from './llm-client.js';

const SERVER_NAME = 'knowledge-base-server';
const SERVER_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// MCP tool input bounds (#660).
// Bound the most attacker-influenced free-form tool inputs — query text,
// extensions[]/tags[] filter arrays, and path_glob — so a malformed or hostile
// client cannot drive unbounded work (huge embeddings, pathological minimatch
// evaluation) through retrieve_knowledge and friends, especially over the
// remote HTTP/SSE transport. Mirrors the existing task_context truncation
// (2000 chars, relevance-gate.ts) and the numeric caps (context_window max 5).
// Defaults are generous so legitimate large-but-reasonable inputs are
// unaffected; each is overridable via an env var without touching
// config/schema.ts. Violations surface as zod VALIDATION errors at the MCP
// tool boundary.
// ---------------------------------------------------------------------------

// The input bounds, bounded-string helpers, and per-tool Zod input shapes now
// live in mcp-tool-specs.ts so the doc generator can enumerate the tool surface
// (name + description + input schema) without booting the server. The caps are
// re-exported here to preserve the existing import surface.
export {
  KB_MAX_QUERY_CHARS,
  KB_MAX_FILTER_ITEMS,
  KB_MAX_GLOB_CHARS,
  KB_MAX_GLOB_WILDCARDS,
} from './mcp-tool-specs.js';

function mcpErrorContent(error: Error): TextContent {
  const code = error instanceof KBError
    ? error.code
    : error instanceof AskExecutionError && error.failure !== undefined
      ? error.failure.code
    : error instanceof RerankerConfigError
      ? error.code
      : 'INTERNAL';
  const failure = error instanceof AskExecutionError ? error.failure : undefined;
  return {
    type: 'text',
    text: JSON.stringify({
      error: {
        code,
        message: error.message,
        ...(failure !== undefined ? {
          category: failure.category,
          next_action: failure.next_action,
        } : {}),
      },
    }),
  };
}

function withGateVerdict<T extends CallToolResult>(
  result: T,
  verdict: RelevanceGateVerdict,
): T {
  return {
    ...result,
    structuredContent: {
      ...((result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}),
      gate_verdict: verdict,
    },
  } as T;
}

function withDegradationMetadata<T extends CallToolResult>(
  result: T,
  reason: DenseDegradationReason,
): T {
  return {
    ...result,
    structuredContent: {
      ...((result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}),
      degraded: true,
      degrade_reason: reason,
    },
  } as T;
}

function withDegradationSummary<T extends CallToolResult>(
  result: T,
  stages: readonly CanonicalDegradedStage[] | undefined,
): T {
  if (stages === undefined || stages.length === 0) return result;
  return {
    ...result,
    structuredContent: {
      ...((result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}),
      degraded: true,
      degraded_stages: stages,
    },
  } as T;
}

function resolveNeighborContextOptions(args: {
  context_before?: number;
  context_after?: number;
  context_window?: number;
}): NeighborContextOptions | undefined {
  const before = args.context_before ?? args.context_window ?? 0;
  const after = args.context_after ?? args.context_window ?? 0;
  if (before === 0 && after === 0) return undefined;
  return { before, after };
}

function hasNeighborContext(options: NeighborContextOptions | undefined): boolean {
  return (options?.before ?? 0) > 0 || (options?.after ?? 0) > 0;
}

function hasRetrievalFilters(
  filters: { extensions?: string[]; pathGlob?: string; tags?: string[]; since?: string; until?: string } | undefined,
): boolean {
  return filters !== undefined && (
    (filters.extensions?.length ?? 0) > 0 ||
    filters.pathGlob !== undefined ||
    (filters.tags?.length ?? 0) > 0 ||
    filters.since !== undefined ||
    filters.until !== undefined
  );
}

function topSourcesForCanonicalLog(
  results: ReadonlyArray<{ metadata?: Record<string, unknown> }>,
): string[] {
  const sources: string[] = [];
  for (const result of results) {
    const source = result.metadata?.source;
    if (typeof source === 'string' && !sources.includes(source)) {
      sources.push(source);
    }
    if (sources.length === 3) break;
  }
  return sources;
}

export class KnowledgeBaseServer {
  private mcp: McpServer;
  // RFC 013 M1 (#157 step 3): per-model FaissIndexManager cache. Lazily
  // populates on first use of each model_id. The active model is resolved
  // per call so a future M3 `model_name` override drops in without
  // redesign.
  private readonly managers = new ManagerRegistry();
  private activeWarmupPromise: Promise<void> | null = null;
  private httpHost?: StreamableHttpHost;
  private sseHost?: SseHost;
  private transportMode: 'stdio' | 'sse' | 'http' | null = null;
  private triggerWatcher?: ReindexTriggerWatcher;
  // RFC 007 §6.6 / issue #212 — opt-in recursive `fs.watch` per KB.
  // Complements `triggerWatcher` (root-level dotfile poller); this one
  // observes per-file edits *inside* each KB tree.
  private fsWatcher?: RecursiveKbWatcher;
  private shutdownInstalled = false;
  // Issue #54 — uptime baseline for kb_stats.server.uptime_ms.
  private readonly startedAt: number = Date.now();

  constructor() {
    logger.info('Initializing KnowledgeBaseServer');

    this.mcp = this.buildMcpServer();

    process.on('SIGINT', async () => {
      await this.shutdown();
      process.exit(0);
    });
  }

  private buildMcpServer(): McpServer {
    const mcp = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    mcp.server.onerror = (error) => logger.error('[MCP Error]', error);
    this.registerTools(mcp);
    registerResources(mcp);
    registerCompletions(mcp);
    // #642 — opt-in MCP prompts surface. Off by default; gated by
    // KB_MCP_PROMPTS so the capability is only advertised when enabled.
    if (KB_MCP_PROMPTS) {
      registerPrompts(mcp);
    }
    return mcp;
  }

  // The Zod input shapes now live in mcp-tool-specs.ts (single source of truth
  // for the doc generator). Registering through this helper keeps the original
  // wiring while sidestepping two TypeScript problems that only appear once a
  // shape is a const rather than an inline literal: the SDK's
  // `Args | ToolAnnotations` overload otherwise falls back to a loose
  // ShapeOutput, and inferring the precise arg type generically over the largest
  // shape (retrieve_knowledge) trips TS2589 "excessively deep". We type the
  // handler argument from the handler's own concrete signature (Args) — the
  // runtime zod parse mcp.tool runs against `shape` still validates the input
  // before the handler sees it.
  private registerShapedTool<Args>(
    mcp: McpServer,
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: Args) => Promise<CallToolResult>,
  ): void {
    // Call mcp.tool through a loosened signature: its generic
    // `tool<Args extends ZodRawShapeCompat>` overload instantiates ShapeOutput
    // over the shape, which trips TS2589 once the shape is a runtime value
    // rather than an inline literal. The 4-arg (name, description, shape, cb)
    // runtime form is unchanged; zod still validates `args` against `shape`
    // before the handler runs.
    const registerTool = mcp.tool.bind(mcp) as unknown as (
      name: string,
      description: string,
      shape: z.ZodRawShape,
      cb: (args: unknown) => Promise<CallToolResult>,
    ) => void;
    registerTool(name, description, shape, (args) => handler(args as Args));
  }

  private registerTools(mcp: McpServer) {
    mcp.tool(
      'list_knowledge_bases',
      LIST_KNOWLEDGE_BASES_DESCRIPTION,
      async () => this.handleListKnowledgeBases()
    );

    this.registerShapedTool(
      mcp,
      'retrieve_knowledge',
      RETRIEVE_KNOWLEDGE_DESCRIPTION,
      RETRIEVE_KNOWLEDGE_INPUT,
      this.handleRetrieveKnowledge.bind(this)
    );

    this.registerShapedTool(
      mcp,
      'ask_knowledge',
      ASK_KNOWLEDGE_DESCRIPTION,
      ASK_KNOWLEDGE_INPUT,
      this.handleAskKnowledge.bind(this)
    );

    // RFC 013 M3 §4.5 — list_models surfaces what's registered so an agent
    // can pre-flight a model_name override before invoking retrieve_knowledge.
    mcp.tool(
      'list_models',
      LIST_MODELS_DESCRIPTION,
      async () => this.handleListModels()
    );

    // Issue #54 — kb_stats observability surface (counts, last-index timestamp,
    // active model). Read-only; does not acquire the write lock.
    this.registerShapedTool(
      mcp,
      'kb_stats',
      KB_STATS_DESCRIPTION,
      KB_STATS_INPUT,
      this.handleKbStats.bind(this)
    );

    this.registerShapedTool(
      mcp,
      'diff_index',
      DIFF_INDEX_DESCRIPTION,
      DIFF_INDEX_INPUT,
      this.handleDiffIndex.bind(this)
    );

    if (KB_INGEST_ENABLED) {
      this.registerShapedTool(
        mcp,
        'add_document',
        ADD_DOCUMENT_DESCRIPTION,
        ADD_DOCUMENT_INPUT,
        this.handleAddDocument.bind(this)
      );

      this.registerShapedTool(
        mcp,
        'delete_document',
        DELETE_DOCUMENT_DESCRIPTION,
        DELETE_DOCUMENT_INPUT,
        this.handleDeleteDocument.bind(this)
      );

      this.registerShapedTool(
        mcp,
        'reindex_knowledge_base',
        REINDEX_KNOWLEDGE_BASE_DESCRIPTION,
        REINDEX_KNOWLEDGE_BASE_INPUT,
        this.handleReindexKnowledgeBase.bind(this)
      );
    }
  }

  private async withCanonicalTool<T extends CallToolResult>(
    base: Omit<CanonicalLogInput, 'process' | 'took_ms'>,
    operation: () => Promise<T>,
    enrich?: (result: T) => Partial<CanonicalLogInput>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await operation();
      const extra = enrich?.(result) ?? {};
      emitCanonicalLog({
        process: 'mcp',
        ...base,
        ...extra,
        took_ms: Date.now() - startedAt,
        error: extra.error ?? canonicalErrorFromToolResult(result),
      });
      return result;
    } catch (error: unknown) {
      emitCanonicalLog({
        process: 'mcp',
        ...base,
        took_ms: Date.now() - startedAt,
        error: classifyCanonicalError(error),
      });
      throw error;
    }
  }

  // Issue #157 step 2 — `mcp-resources.ts` owns the wire surface and pure
  // handler bodies. These remain on the class as thin delegates so the
  // existing private-method test surface (KnowledgeBaseServer.test.ts) keeps
  // working without re-plumbing.
  private async handleListResources(
    params?: ListResourcesRequest['params'],
  ): Promise<ListResourcesResult> {
    return listResources(params);
  }

  private async handleReadResource(uri: string): Promise<ReadResourceResult> {
    return readResource(uri);
  }

  /**
   * RFC 013 M3 §4.5 — list registered embedding models. Returns a JSON array
   * of `{ model_id, provider, model_name, active }` objects. `.adding`
   * sentinels are skipped (round-1 failure F6 — half-built models are not
   * surfaced to the agent).
   */
  private async handleListModels(): Promise<CallToolResult> {
    return this.withCanonicalTool({ tool: 'list_models' }, async () => {
      try {
      const models = await listRegisteredModels();
      let activeId: string | null = null;
      try {
        activeId = await resolveActiveModel();
      } catch {
        // No active resolvable; return all models with active: false.
      }
      const enriched = models.map((m) => ({
        model_id: m.model_id,
        provider: m.provider,
        model_name: m.model_name,
        active: m.model_id === activeId,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }],
      };
      } catch (error: unknown) {
      const err = toError(error);
      logger.error('Error listing models:', err);
      return { content: [mcpErrorContent(err)], isError: true };
      }
    });
  }

  private async handleListKnowledgeBases(): Promise<CallToolResult> {
    return this.withCanonicalTool({ tool: 'list_knowledge_bases' }, async () => {
      try {
      const knowledgeBases = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
      const content: TextContent = {
        type: 'text',
        text: JSON.stringify(knowledgeBases, null, 2),
      };
      return { content: [content] };
    } catch (error: unknown) {
      const err = toError(error);
      logger.error('Error listing knowledge bases:', err);
      if (err.stack) {
        logger.error(err.stack);
      }
      return { content: [mcpErrorContent(err)], isError: true };
      }
    });
  }

  /**
   * Issue #54 — kb_stats MCP handler. Thin transport wrapper: resolves the
   * active model, delegates to `computeKbStats` (#157), wraps the payload
   * as a `CallToolResult`. Read-only — does NOT acquire the write lock and
   * does NOT trigger an updateIndex.
   */
  private async handleKbStats(args: {
    knowledge_base_name?: string;
  }): Promise<CallToolResult> {
    return this.withCanonicalTool({
      tool: 'kb_stats',
      kb_scope: args.knowledge_base_name ?? null,
    }, async () => {
      try {
      let activeModelId: string;
      try {
        activeModelId = await resolveActiveModel();
      } catch (err) {
        if (err instanceof ActiveModelResolutionError) {
          return {
            content: [{ type: 'text', text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
      const manager = await this.managers.getOrCreate(activeModelId);
      const payload = await computeKbStats(manager, {
        knowledgeBaseName: args.knowledge_base_name,
        serverVersion: SERVER_VERSION,
        startedAt: this.startedAt,
        remoteTransportStats: this.getRemoteTransportStats(),
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (error: unknown) {
      const err = toError(error);
      logger.error('Error computing kb_stats:', err);
      if (err.stack) {
        logger.error(err.stack);
      }
      return { content: [mcpErrorContent(err)], isError: true };
      }
    });
  }

  private async handleDiffIndex(args: {
    before: string;
    after: string;
    queries: string[];
    model_name?: string;
    knowledge_base_name?: string;
    top_k?: number;
    threshold?: number;
    format?: 'json' | 'markdown';
  }): Promise<CallToolResult> {
    const topK = args.top_k ?? 10;
    const threshold = args.threshold ?? 2;
    const queries = args.queries
      .map((query) => query.trim())
      .filter((query) => query.length > 0)
      .map((query): DiffIndexQuery => ({
        query,
        ...(args.knowledge_base_name !== undefined ? { kb: args.knowledge_base_name } : {}),
      }));

    return this.withCanonicalTool({
      tool: 'diff_index',
      kb_scope: args.knowledge_base_name ?? null,
      k: topK,
      threshold,
    }, async () => {
      try {
        if (queries.length === 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: {
                  code: 'VALIDATION',
                  message: 'diff_index requires at least one non-empty query',
                },
              }),
            }],
            isError: true,
          };
        }

        let activeModelId: string;
        try {
          activeModelId = await resolveActiveModel({ explicitOverride: args.model_name });
        } catch (err) {
          if (err instanceof ActiveModelResolutionError) {
            return {
              content: [{ type: 'text', text: err.message }],
              isError: true,
            };
          }
          throw err;
        }

        const manager = await this.createReadOnlyManagerForModel(activeModelId);
        const beforePath = resolveIndexVersionPath(args.before, manager.modelDir);
        const afterPath = resolveIndexVersionPath(args.after, manager.modelDir);
        const report = await runDiffIndex({
          manager,
          before: beforePath,
          after: afterPath,
          queries,
          topK,
          threshold,
        });
        return {
          content: [{
            type: 'text',
            text: args.format === 'json'
              ? JSON.stringify(report, null, 2)
              : formatDiffIndexMarkdown(report),
          }],
        };
      } catch (error: unknown) {
        const err = toError(error);
        logger.error('Error diffing index versions:', err);
        if (err.stack) {
          logger.error(err.stack);
        }
        return { content: [mcpErrorContent(err)], isError: true };
      }
    });
  }

  private async createReadOnlyManagerForModel(modelId: string): Promise<FaissIndexManager> {
    const { provider } = parseModelId(modelId);
    const modelName = await readStoredModelName(modelId);
    if (modelName === null) {
      throw new Error(`model_name.txt missing for "${modelId}" - corrupt model directory`);
    }
    const manager = new FaissIndexManager({
      provider: provider as EmbeddingProvider,
      modelName,
    });
    await manager.initialize({ readOnly: true });
    return manager;
  }

  private async getActiveManagerForMutation(): Promise<FaissIndexManager> {
    const activeModelId = await resolveActiveModel();
    return this.managers.getOrCreate(activeModelId);
  }

  private async handleAddDocument(args: AddDocumentArgs): Promise<CallToolResult> {
    return handleAddDocument(args, {
      getActiveManagerForMutation: () => this.getActiveManagerForMutation(),
      withCanonicalTool: (base, operation, enrich) =>
        this.withCanonicalTool(base, operation, enrich),
    });
  }

  private async handleDeleteDocument(args: DeleteDocumentArgs): Promise<CallToolResult> {
    return handleDeleteDocument(args, {
      getActiveManagerForMutation: () => this.getActiveManagerForMutation(),
      withCanonicalTool: (base, operation, enrich) =>
        this.withCanonicalTool(base, operation, enrich),
    });
  }

  private async handleReindexKnowledgeBase(args: {
    knowledge_base_name?: string;
  }): Promise<CallToolResult> {
    return this.withCanonicalTool({
      tool: 'reindex_knowledge_base',
      kb_scope: args.knowledge_base_name ?? null,
    }, async () => {
      try {
      const manager = await this.getActiveManagerForMutation();
      await withWriteLock(manager.modelDir, async () => {
        if (args.knowledge_base_name !== undefined) {
          await resolveKnowledgeBaseDir(KNOWLEDGE_BASES_ROOT_DIR, args.knowledge_base_name);
        }
        await manager.updateIndex(args.knowledge_base_name, { force: true });
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            knowledge_base_name: args.knowledge_base_name ?? null,
            reindexed: true,
            // FAISS has no per-vector deletion in this server, so every
            // forced rebuild covers all KBs (see FaissIndexManager.updateIndex).
            scope: 'global',
          }, null, 2),
        }],
      };
    } catch (error: unknown) {
      if (error instanceof ActiveModelResolutionError) {
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
      const err = toError(error);
      logger.error('Error re-indexing knowledge base:', err);
      if (err.stack) {
        logger.error(err.stack);
      }
      return { content: [mcpErrorContent(err)], isError: true };
      }
    });
  }

  private async handleRetrieveKnowledge(args: {
    query: string;
    knowledge_base_name?: string;
    threshold?: number;
    model_name?: string;
    extensions?: string[];
    path_glob?: string;
    tags?: string[];
    since?: string;
    until?: string;
    context_before?: number;
    context_after?: number;
    context_window?: number;
    search_mode?: 'dense' | 'hybrid';
    task_context?: string;
    gate?: 'on' | 'off';
    rerank?: 'on' | 'off';
  }): Promise<CallToolResult> {
    const canonical: Partial<CanonicalLogInput> = {};
    const requestStartedAt = Date.now();
    const query: string = args.query;
    const knowledgeBaseName: string | undefined = args.knowledge_base_name;
    const threshold: number | undefined = args.threshold;
    const modelNameOverride: string | undefined = args.model_name;
    const filters = (args.extensions || args.path_glob || args.tags || args.since || args.until)
      ? { extensions: args.extensions, pathGlob: args.path_glob, tags: args.tags, since: args.since, until: args.until }
      : undefined;
    const searchMode: 'dense' | 'hybrid' = args.search_mode ?? 'dense';
    const taskContext = args.task_context;
    const gateOverride: RelevanceGateOverride = args.gate;
    const rerankOverride: RerankOverride = args.rerank;
    const neighborContext = resolveNeighborContextOptions(args);

    return withSpan('kb.retrieve_knowledge', {
      'kb.scope': knowledgeBaseName ?? null,
      'kb.search_mode': searchMode,
      'kb.k': 10,
    }, () => this.withCanonicalTool({
      tool: 'retrieve_knowledge',
      query,
      kb_scope: knowledgeBaseName ?? null,
      k: 10,
      threshold: threshold ?? 2,
      search_mode: searchMode,
    }, async () => {
      try {
        parseRecencyFilterRange({ since: args.since, until: args.until });
      } catch (err) {
        searchLatencyMetrics.record({
          mode: searchMode,
          status: 'error',
          totalMs: Date.now() - requestStartedAt,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: {
                code: 'VALIDATION',
                message: (err as Error).message,
              },
            }),
          }],
          isError: true,
        };
      }
      if (searchMode === 'hybrid') {
        if (hasNeighborContext(neighborContext)) {
          searchLatencyMetrics.record({
            mode: 'hybrid',
            status: 'error',
            totalMs: Date.now() - requestStartedAt,
          });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: {
                  code: 'VALIDATION',
                  message: 'neighbor context expansion is only supported with dense retrieve_knowledge',
                },
              }),
            }],
            isError: true,
          };
        }
        return this.handleRetrieveKnowledgeHybrid({
          query,
          knowledgeBaseName,
          modelNameOverride,
          filters,
          canonical,
          taskContext,
          gateOverride,
          rerankOverride,
        });
      }

    try {
      const startTime = Date.now();
      if (process.env.KB_LOG_VERBOSE === '1') {
        logger.debug(`[${startTime}] handleRetrieveKnowledge started`);
      }

      // RFC 013 §4.7 — resolve active model per call. M3 honors args.model_name
      // as the explicit per-call override (resolveActiveModel validates it +
      // hard-fails with a registered-list hint if not on disk).
      let activeModelId: string;
      try {
        activeModelId = await resolveActiveModel({ explicitOverride: modelNameOverride });
      } catch (err) {
        if (err instanceof ActiveModelResolutionError) {
          searchLatencyMetrics.record({
            mode: 'dense',
            status: 'error',
            totalMs: Date.now() - requestStartedAt,
          });
          return {
            content: [{ type: 'text', text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
      canonical.model_id = activeModelId;
      const manager = await this.managers.getOrCreate(activeModelId);

      // RFC 013 §4.6 — write lock is per-model (resource = `models/<id>/`).
      // A `kb models add B` against another model never blocks retrievals on A.
      await withWriteLock(manager.modelDir, () => manager.updateIndex(knowledgeBaseName));
      if (process.env.KB_LOG_VERBOSE === '1') {
        logger.debug(`[${Date.now()}] FAISS index update completed`);
      }

      // Perform similarity search using the provided query.
      const timing: SimilaritySearchTiming = {};
      let degradedReason: DenseDegradationReason | null = null;
      let similaritySearchResults: SearchResultDocument[];
      try {
        // `kb.retrieve.dense` covers query embedding + FAISS search.
        similaritySearchResults = await withSpan('kb.retrieve.dense', {
          'kb.k': 10,
          'kb.scope': knowledgeBaseName ?? null,
        }, () => manager.similaritySearch(
          query,
          10,
          threshold,
          knowledgeBaseName,
          filters,
          timing,
        ));
      } catch (error: unknown) {
        const reason = classifyDenseDegradationReason(error);
        if (
          !KB_DENSE_DEGRADE_ON_PROVIDER_ERROR ||
          reason === null ||
          hasRetrievalFilters(filters) ||
          hasNeighborContext(neighborContext)
        ) {
          throw error;
        }
        const degraded = await this.runDegradedLexicalOnly({
          query,
          knowledgeBaseName,
          fetchK: 10,
        });
        if (degraded === null) throw error;
        degradedReason = reason;
        similaritySearchResults = degraded.results;
        searchLatencyMetrics.recordDegraded('dense', reason);
        if (canonical) {
          canonical.degraded = true;
          canonical.degrade_reason = reason;
        }
        logger.warn(`retrieve_knowledge dense degraded to lexical-only: ${reason}`);
      }
      if (neighborContext && degradedReason === null) {
        similaritySearchResults = manager.expandWithNeighborContext(
          similaritySearchResults,
          neighborContext,
        );
      }
      const denseDistanceById = new Map<string, number>();
      const lexicalHitIds = degradedReason === null ? undefined : new Set<string>();
      for (const result of similaritySearchResults) {
        const id = chunkIdFromMetadata(result.metadata as Record<string, unknown>);
        if (degradedReason === null) {
          denseDistanceById.set(id, result.score);
        } else {
          lexicalHitIds?.add(id);
        }
      }
      const gateStartedAt = Date.now();
      const gate = await withSpan('kb.retrieve.gate', {
        'kb.candidates_in': similaritySearchResults.length,
      }, async (gateSpan) => {
        const decision = await applyRelevanceGate({
          query,
          taskContext,
          candidates: similaritySearchResults,
          denseDistanceById,
          lexicalHitIds,
          gateOverride,
          process: 'mcp',
        });
        gateSpan.setAttribute('kb.gate_state', decision.verdict.state);
        gateSpan.setAttribute('kb.candidates_out', decision.results.length);
        return decision;
      });
      const gateMs = Date.now() - gateStartedAt;
      similaritySearchResults = gate.results;
      emitRelevanceGateDecision({
        process: 'mcp',
        query,
        kbScope: knowledgeBaseName ?? null,
        searchMode,
        verdict: gate.verdict,
        taskContext,
        observability: gate.observability,
      });
      canonical.gate = canonicalGateStageRecord(gate.verdict);
      if (process.env.KB_LOG_VERBOSE === '1') {
        logger.debug(`[${Date.now()}] Similarity search completed`);
      }
      canonical.result_count = similaritySearchResults.length;
      canonical.top_score = similaritySearchResults[0]?.score;
      canonical.top_sources = topSourcesForCanonicalLog(similaritySearchResults);
      canonical.embed_ms = timing.embed_query_ms;
      canonical.faiss_ms = timing.faiss_search_ms ?? timing.query_search_ms;
      canonical.cache = timing.query_cache_telemetry?.outcome;
      canonical.query_cache = timing.query_cache_telemetry;

      // Build a nicely formatted markdown response including the similarity score.
      const formatStartedAt = Date.now();
      let responseText = await withSpan('kb.retrieve.format', {
        'kb.result_count': similaritySearchResults.length,
      }, async () => formatRetrievalAsMarkdown(
        similaritySearchResults,
        FRONTMATTER_EXTRAS_WIRE_VISIBLE,
      ));
      if (gate.verdict.state !== 'bypassed') {
        responseText = `${responseText}\n\n${formatGateVerdictFooter(gate.verdict)}`;
      }
      if (degradedReason !== null) {
        responseText = `> _Mode: degraded lexical-only (reason: ${degradedReason}; original mode dense)._` +
          `\n\n${responseText}`;
      }
      const degradation = degradationSummaryFields({
        degraded: degradedReason === null ? undefined : true,
        degrade_reason: degradedReason ?? undefined,
        gate: canonical.gate,
      });
      const degradedFooter = formatDegradedStagesFooter(degradation.degraded_stages);
      if (degradedFooter !== '') {
        responseText = `${responseText}\n\n${degradedFooter}`;
      }
      canonical.format_ms = Date.now() - formatStartedAt;
      const stageTiming: TimingPayload = {
        embed_query_ms: timing.embed_query_ms,
        faiss_search_ms: timing.faiss_search_ms,
        query_search_ms: timing.query_search_ms,
        post_filter_ms: timing.post_filter_ms,
        gate_ms: gateMs,
        format_ms: canonical.format_ms,
      };
      searchLatencyMetrics.record({
        mode: 'dense',
        status: 'success',
        totalMs: Date.now() - requestStartedAt,
        stageDurationsMs: searchStageDurationsFromTiming(stageTiming),
      });

      // RFC 013 M3 §4.5 + round-1 minimalist F5 — emit `model_id` on the
      // response envelope (NOT per-chunk) so an agent comparing two models
      // can attribute results when explicit model_name was passed. When
      // model_name was NOT passed, the wire format is byte-equal to 0.2.x
      // (no envelope field, no per-chunk metadata change) for back-compat.
      if (modelNameOverride !== undefined) {
        responseText = `> _Model: ${activeModelId}_\n\n${responseText}`;
      }

      const endTime = Date.now();
      if (process.env.KB_LOG_VERBOSE === '1') {
        logger.debug(`[${endTime}] handleRetrieveKnowledge completed in ${endTime - startTime}ms`);
      }

      const content: TextContent = { type: 'text', text: responseText };
      const response = withGateVerdict({ content: [content] }, gate.verdict);
      const responseWithSummary = withDegradationSummary(response, degradation.degraded_stages);
      return degradedReason === null
        ? responseWithSummary
        : withDegradationMetadata(responseWithSummary, degradedReason);
    } catch (error: unknown) {
      const err = toError(error);
      searchLatencyMetrics.record({
        mode: 'dense',
        status: 'error',
        totalMs: Date.now() - requestStartedAt,
      });
      logger.error('Error retrieving knowledge:', err);
      if (err.stack) {
        logger.error(err.stack);
      }
      return { content: [mcpErrorContent(err)], isError: true };
    }
    }, () => canonical));
  }

  private async handleAskKnowledge(args: {
    query: string;
    knowledge_base_name?: string;
    model_name?: string;
    llm_profile?: string;
    k?: number;
    context_budget_tokens?: number;
    task_context?: string;
    gate?: 'on' | 'off';
    timing?: boolean;
  }): Promise<CallToolResult> {
    return this.withCanonicalTool({
      tool: 'ask_knowledge',
      query: args.query,
      kb_scope: args.knowledge_base_name ?? null,
      k: args.k ?? 8,
    }, async () => {
      try {
        const payload = await askKnowledge({
          query: args.query,
          knowledge_base_name: args.knowledge_base_name,
          model_name: args.model_name,
          llm_profile: args.llm_profile,
          k: args.k,
          context_budget_tokens: args.context_budget_tokens,
          task_context: args.task_context,
          gate: args.gate,
          timing: args.timing ?? true,
        }, {
          bootstrapLayout: FaissIndexManager.bootstrapLayout.bind(FaissIndexManager),
          resolveActiveModel,
          loadManagerForModel: (modelId) => this.createReadOnlyManagerForModel(modelId),
          loadReadOnlyIndex: async () => {},
          withWriteLock,
          callChatCompletion,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload as unknown as Record<string, unknown>,
        };
      } catch (error: unknown) {
        const err = toError(error);
        logger.error('Error answering knowledge question:', err);
        if (err.stack) {
          logger.error(err.stack);
        }
        return { content: [mcpErrorContent(err)], isError: true };
      }
    }, (result) => {
      const structured = (result as { structuredContent?: unknown }).structuredContent as
        | { retrieval?: { embedding_model?: string }; citations?: unknown[] }
        | undefined;
      return {
        model_id: structured?.retrieval?.embedding_model,
        result_count: structured?.citations?.length,
      };
    });
  }

  /**
   * #206 stage 2 — hybrid retrieval handler. Runs the dense leg (FAISS via
   * the active model) and the lexical leg (per-KB BM25) concurrently, fuses
   * the two ranked lists with Reciprocal Rank Fusion (c=60, see ADR 0006),
   * and returns the fused top-10 in the same `formatRetrievalAsMarkdown`
   * shape as the dense path.
   *
   * Notes:
   * - Threshold and metadata POST-filters are dense-only knobs and are NOT
   *   applied to the hybrid output. They will be re-introduced in a follow-up
   *   if user demand exceeds the byte-compat win — keeping them off here
   *   means hybrid does not silently filter chunks the lexical leg returned.
   * - The lexical index is auto-refreshed on first use per KB (when empty).
   *   `kb search --refresh` (CLI) is the explicit refresh path; the MCP
   *   server keeps the dense `updateIndex` invariant from the dense path.
   * - Returns the same wire envelope as the dense handler with one added
   *   markdown header line `> _Mode: hybrid (RRF c=60)_` so an inspecting
   *   agent can attribute the ranking. JSON-shaped output is unchanged since
   *   the `retrieve_knowledge` tool returns markdown text content.
   */
  private async handleRetrieveKnowledgeHybrid(input: {
    query: string;
    knowledgeBaseName?: string;
    modelNameOverride?: string;
    filters?: { extensions?: string[]; pathGlob?: string; tags?: string[]; since?: string; until?: string };
    canonical?: Partial<CanonicalLogInput>;
    taskContext?: string;
    gateOverride?: RelevanceGateOverride;
    rerankOverride?: RerankOverride;
  }): Promise<CallToolResult> {
    const { query, knowledgeBaseName, modelNameOverride, filters, canonical, taskContext, gateOverride, rerankOverride } = input;
    const HYBRID_TOP_K = 10;
    const fetchK = hybridFetchK(HYBRID_TOP_K);
    const requestStartedAt = Date.now();

    try {
      let activeModelId: string;
      try {
        activeModelId = await resolveActiveModel({ explicitOverride: modelNameOverride });
      } catch (err) {
        if (err instanceof ActiveModelResolutionError) {
          searchLatencyMetrics.record({
            mode: 'hybrid',
            status: 'error',
            totalMs: Date.now() - requestStartedAt,
          });
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        throw err;
      }
      if (canonical) canonical.model_id = activeModelId;
      const manager = await this.managers.getOrCreate(activeModelId);
      await withWriteLock(manager.modelDir, () => manager.updateIndex(knowledgeBaseName));

      // Dense leg — over-fetch to give RRF room.
      const denseTiming: SimilaritySearchTiming = {};
      let denseError: unknown = null;
      const densePromise = withSpan('kb.retrieve.dense', {
        'kb.k': fetchK,
        'kb.scope': knowledgeBaseName ?? null,
      }, () => manager
        .similaritySearch(query, fetchK, Number.POSITIVE_INFINITY, knowledgeBaseName, filters, denseTiming))
        .then((rs) => rs.map((r) => ({ pageContent: r.pageContent, metadata: r.metadata, score: r.score })))
        .catch((err) => {
          denseError = err;
          return [];
        });

      // Lexical leg — BM25 over the same chunks the FAISS path embeds, but
      // managed independently (the lexical index is model-agnostic and lives
      // under `${FAISS_INDEX_PATH}/lexical/<kb>/`). Auto-refresh on first use
      // per KB; explicit refresh is the CLI's job (`kb search --refresh`).
      const allKbNames = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
      const kbNames = knowledgeBaseName
        ? allKbNames.filter((name) => name === knowledgeBaseName)
        : allKbNames;
      const kbs = kbNames.map((kbName) => ({ kbName, kbPath: path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName) }));
      let lexicalSearchMs = 0;
      const lexicalStartedAt = Date.now();
      const lexicalPromise = withSpan('kb.retrieve.lexical', {
        'kb.k': fetchK,
        'kb.kb_count': kbs.length,
      }, () => runLexicalLeg({
        kbs,
        query,
        fetchK,
        refresh: 'when-empty',
        onError: (kbName, err) => {
          logger.warn(`hybrid: lexical leg failed for KB "${kbName}": ${err.message}`);
        },
      })).then((res) => {
        lexicalSearchMs = Date.now() - lexicalStartedAt;
        return res;
      });

      const [denseResults, lexicalLegResult] = await Promise.all([densePromise, lexicalPromise]);
      const lexicalResults = lexicalLegResult.hits;
      if (canonical) {
        canonical.embed_ms = denseTiming.embed_query_ms;
        canonical.faiss_ms = denseTiming.faiss_search_ms ?? denseTiming.query_search_ms;
      }
      let degradedReason: DenseDegradationReason | null = null;
      if (denseError !== null) {
        const reason = classifyDenseDegradationReason(denseError);
        if (
          !KB_DENSE_DEGRADE_ON_PROVIDER_ERROR ||
          reason === null ||
          hasRetrievalFilters(filters) ||
          kbs.length === 0 ||
          lexicalLegResult.failed >= kbs.length
        ) {
          throw denseError;
        }
        degradedReason = reason;
        searchLatencyMetrics.recordDegraded('hybrid', reason);
        if (canonical) {
          canonical.degraded = true;
          canonical.degrade_reason = reason;
        }
        logger.warn(`retrieve_knowledge hybrid degraded to lexical-only: ${reason}`);
      }

      const rerankConfig = resolveRerankerConfig(process.env, rerankOverride, knowledgeBaseName ?? null);
      const fusionStartedAt = Date.now();
      const fusion = await withSpan('kb.retrieve.fusion', {
        'kb.dense_in': denseResults.length,
        'kb.lexical_in': lexicalResults.length,
      }, async () => (degradedReason === null
        ? fuseHybridResultsWithDiagnostics({
            denseResults,
            lexicalResults,
            k: rerankConfig.enabled ? Math.max(HYBRID_TOP_K, rerankConfig.topN) : HYBRID_TOP_K,
          })
        : {
            results: lexicalResults.slice(0, rerankConfig.enabled ? Math.max(HYBRID_TOP_K, rerankConfig.topN) : HYBRID_TOP_K),
            denseDistanceById: new Map<string, number>(),
            lexicalHitIds: new Set(lexicalResults.map((r) => chunkIdFromMetadata(r.metadata))),
          }));
      const fusionMs = Date.now() - fusionStartedAt;
      let ranked = fusion.results;
      const rerankStartedAt = Date.now();
      const rerankResult = await withSpan('kb.retrieve.rerank', {
        'kb.candidates_in': ranked.length,
        'kb.rerank_enabled': rerankConfig.enabled,
      }, () => applyRerankerIfEnabled({
        query,
        results: ranked,
        k: HYBRID_TOP_K,
        override: rerankOverride,
        config: rerankConfig,
        process: 'mcp',
        searchMode: 'hybrid',
        kbScope: knowledgeBaseName ?? null,
      }));
      const rerankMs = rerankResult.tookMs ?? Date.now() - rerankStartedAt;
      ranked = rerankResult.results;
      if (canonical) {
        canonical.rerank = canonicalRerankStageRecord(rerankResult);
      }
      const gateStartedAt = Date.now();
      const gate = await withSpan('kb.retrieve.gate', {
        'kb.candidates_in': ranked.length,
      }, async (gateSpan) => {
        const decision = await applyRelevanceGate({
          query,
          taskContext,
          candidates: ranked,
          denseDistanceById: fusion.denseDistanceById,
          lexicalHitIds: fusion.lexicalHitIds,
          gateOverride,
          process: 'mcp',
        });
        gateSpan.setAttribute('kb.gate_state', decision.verdict.state);
        gateSpan.setAttribute('kb.candidates_out', decision.results.length);
        return decision;
      });
      const gateMs = Date.now() - gateStartedAt;
      ranked = gate.results;
      emitRelevanceGateDecision({
        process: 'mcp',
        query,
        kbScope: knowledgeBaseName ?? null,
        searchMode: 'hybrid',
        verdict: gate.verdict,
        taskContext,
        observability: gate.observability,
      });
      if (canonical) {
        canonical.gate = canonicalGateStageRecord(gate.verdict);
      }

      const formatStartedAt = Date.now();
      let responseText = await withSpan('kb.retrieve.format', {
        'kb.result_count': ranked.length,
      }, async () => formatRetrievalAsMarkdown(ranked as never, FRONTMATTER_EXTRAS_WIRE_VISIBLE));
      if (gate.verdict.state !== 'bypassed') {
        responseText = `${responseText}\n\n${formatGateVerdictFooter(gate.verdict)}`;
      }
      if (canonical) {
        canonical.result_count = ranked.length;
        canonical.top_score = ranked[0]?.score;
        canonical.top_sources = topSourcesForCanonicalLog(ranked);
        canonical.format_ms = Date.now() - formatStartedAt;
      }
      const stageTiming: TimingPayload = {
        dense_search_ms: denseTiming.total_ms,
        embed_query_ms: denseTiming.embed_query_ms,
        faiss_search_ms: denseTiming.faiss_search_ms,
        query_search_ms: denseTiming.query_search_ms,
        post_filter_ms: denseTiming.post_filter_ms,
        lexical_search_ms: lexicalSearchMs,
        fusion_ms: fusionMs,
        rerank_ms: rerankMs,
        gate_ms: gateMs,
        format_ms: canonical?.format_ms,
      };
      searchLatencyMetrics.record({
        mode: 'hybrid',
        status: 'success',
        totalMs: Date.now() - requestStartedAt,
        stageDurationsMs: searchStageDurationsFromTiming(stageTiming),
      });
      const rerankHeader = rerankResult.candidatesIn > 0
        ? `; rerank ${rerankResult.model}${rerankResult.degraded ? ' degraded' : ''}`
        : '';
      const modeHeader = degradedReason === null
        ? `hybrid (RRF c=${HYBRID_RRF_C})`
        : `degraded lexical-only (reason: ${degradedReason}; original mode hybrid)`;
      const header = `> _Mode: ${modeHeader}; dense fetched ${denseResults.length}, lexical fetched ${lexicalResults.length}${rerankHeader} (#206 stage 2)._`;
      responseText = modelNameOverride !== undefined
        ? `> _Model: ${activeModelId}_\n${header}\n\n${responseText}`
        : `${header}\n\n${responseText}`;
      const degradation = degradationSummaryFields({
        degraded: degradedReason === null ? undefined : true,
        degrade_reason: degradedReason ?? undefined,
        rerank: canonical?.rerank,
        gate: canonical?.gate,
      });
      const degradedFooter = formatDegradedStagesFooter(degradation.degraded_stages);
      if (degradedFooter !== '') {
        responseText = `${responseText}\n\n${degradedFooter}`;
      }

      const content: TextContent = { type: 'text', text: responseText };
      const response = withGateVerdict({ content: [content] }, gate.verdict);
      const responseWithSummary = withDegradationSummary(response, degradation.degraded_stages);
      return degradedReason === null
        ? responseWithSummary
        : withDegradationMetadata(responseWithSummary, degradedReason);
    } catch (error: unknown) {
      const err = toError(error);
      searchLatencyMetrics.record({
        mode: 'hybrid',
        status: 'error',
        totalMs: Date.now() - requestStartedAt,
      });
      logger.error('Error retrieving knowledge (hybrid):', err);
      if (err.stack) logger.error(err.stack);
      return { content: [mcpErrorContent(err)], isError: true };
    }
  }

  private async runDegradedLexicalOnly(input: {
    query: string;
    knowledgeBaseName?: string;
    fetchK: number;
  }): Promise<{ results: Array<{ pageContent: string; metadata: Record<string, unknown>; score: number }> } | null> {
    const allKbNames = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
    const kbNames = input.knowledgeBaseName
      ? allKbNames.filter((name) => name === input.knowledgeBaseName)
      : allKbNames;
    if (kbNames.length === 0) return null;
    const kbs = kbNames.map((kbName) => ({
      kbName,
      kbPath: path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName),
    }));
    const row = await runLexicalLeg({
      kbs,
      query: input.query,
      fetchK: input.fetchK,
      refresh: 'when-empty',
      onError: (kbName, err) => {
        logger.warn(`degraded lexical-only: lexical leg failed for KB "${kbName}": ${err.message}`);
      },
    });
    if (row.failed >= kbs.length) return null;
    return { results: row.hits };
  }

  async run() {
    let transportConfig: TransportConfig;
    try {
      transportConfig = loadTransportConfig();
    } catch (err) {
      if (err instanceof TransportConfigError) {
        // Fail fast on bad transport config — no partial startup state.
        logger.error(`Invalid transport configuration: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    // RFC 013 §4.8 — bootstrap the layout (one-shot migration from 0.2.x).
    // The migration coordinator (proper-lockfile at
    // ${FAISS_INDEX_PATH}/.kb-migration.lock) serializes concurrent
    // migrations across processes. Pre-RFC-014 a single-instance MCP
    // advisory at .kb-mcp.pid was held during the server lifetime and
    // bootstrapLayout piggybacked on it; that advisory was removed once
    // RFC 014 made save+load directory-atomic.
    try {
      await FaissIndexManager.bootstrapLayout();
    } catch (err) {
      logger.error(`Layout bootstrap failed: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    try {
      if (transportConfig.transport === 'stdio') {
        await this.runStdio();
        return;
      }
      if (transportConfig.transport === 'sse') {
        await this.runSse(transportConfig);
        return;
      }
      await this.runHttp(transportConfig);
    } catch (error: unknown) {
      const err = toError(error);
      logger.error('Error during server startup:', err);
      if (err.stack) {
        logger.error(err.stack);
      }
      process.exitCode = 1;
    }
  }

  private async runStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
    this.transportMode = 'stdio';
    logger.info('Knowledge Base MCP server running on stdio');
    this.startActiveManagerWarmup();
    this.startTriggerWatcher();
    await this.startFsWatcher();
  }

  private async runSse(config: TransportConfig): Promise<void> {
    const host = new SseHost({
      config,
      createMcpServer: () => this.buildMcpServer(),
      metricsExporter: () => this.handleMetricsExport(),
    });
    this.sseHost = host;
    this.installHttpShutdown();
    // Start watcher only after the HTTP bind succeeds; a throw from
    // host.start() unwinds without leaving a dangling polling timer.
    await host.start();
    this.transportMode = 'sse';
    this.startActiveManagerWarmup();
    this.startTriggerWatcher();
    await this.startFsWatcher();
  }

  private async runHttp(config: TransportConfig): Promise<void> {
    const host = new StreamableHttpHost({
      config,
      createMcpServer: () => this.buildMcpServer(),
      metricsExporter: () => this.handleMetricsExport(),
    });
    this.httpHost = host;
    this.installHttpShutdown();
    await host.start();
    this.transportMode = 'http';
    this.startActiveManagerWarmup();
    this.startTriggerWatcher();
    await this.startFsWatcher();
  }

  private getRemoteTransportStats(): TransportRuntimeStatsSnapshot | undefined {
    if (this.transportMode === 'sse') return this.sseHost?.getRuntimeStats();
    if (this.transportMode === 'http') return this.httpHost?.getRuntimeStats();
    return undefined;
  }

  private async handleMetricsExport(): Promise<string> {
    const activeModelId = await resolveActiveModel();
    const manager = await this.managers.getOrCreate(activeModelId);
    const payload = await computeKbStats(manager, {
      serverVersion: SERVER_VERSION,
      startedAt: this.startedAt,
      remoteTransportStats: this.getRemoteTransportStats(),
    });
    return formatKbStatsOpenMetrics(payload);
  }

  /**
   * Warm the manager cache for the active model. Best-effort: a missing
   * active model is logged but doesn't crash the server (the first
   * `handleRetrieveKnowledge` call surfaces the error to the agent via
   * `isError: true` instead of dying at startup).
   */
  private startActiveManagerWarmup(): void {
    if (this.activeWarmupPromise) return;
    this.activeWarmupPromise = this.warmActiveManager();
  }

  private async warmActiveManager(): Promise<void> {
    try {
      const activeId = await resolveActiveModel();
      const manager = await this.managers.getOrCreate(activeId);
      if (manager.hasLoadedIndex) {
        logger.info(`Active FAISS index ${activeId} loaded; startup rebuild not needed`);
        return;
      }

      await this.sendWarmupLoggingMessage(
        'info',
        `Rebuilding FAISS index for active model ${activeId}`,
      );
      await withWriteLock(manager.modelDir, () =>
        manager.updateIndex(undefined, {
          onProgress: (progress) => this.sendRebuildProgress(progress),
        }),
      );
      await this.sendWarmupLoggingMessage(
        'info',
        `Finished rebuilding FAISS index for active model ${activeId}`,
      );
    } catch (err) {
      if (err instanceof ActiveModelResolutionError) {
        logger.warn(`No active model on startup: ${err.message}`);
        return;
      }
      const error = toError(err);
      logger.error(`Startup FAISS warm-up failed: ${error.message}`);
      if (error.stack) {
        logger.error(error.stack);
      }
    }
  }

  private async sendRebuildProgress(progress: IndexUpdateProgress): Promise<void> {
    await this.sendWarmupLoggingMessage(
      'info',
      `Embedded ${progress.processedFiles}/${progress.totalFiles} files for ${progress.modelId}`,
    );
  }

  private async sendWarmupLoggingMessage(
    level: 'info' | 'warning' | 'error',
    data: string,
  ): Promise<void> {
    // Issue #157 step 4 — hosts own the per-session fanout. In stdio mode
    // the root `this.mcp` is the live transport target; in SSE/HTTP mode
    // the host iterates its own session map. The server no longer pulls
    // the session list out (see `SseHost.notify` / `StreamableHttpHost.
    // notify`). The root `this.mcp` is unconnected in SSE/HTTP mode, so
    // routing through it would silently drop notifications — keeping the
    // dispatch tied to `transportMode` is what prevents that.
    if (this.transportMode === 'sse') {
      if (this.sseHost) await this.sseHost.notify(level, SERVER_NAME, data);
      return;
    }
    if (this.transportMode === 'http') {
      if (this.httpHost) await this.httpHost.notify(level, SERVER_NAME, data);
      return;
    }
    try {
      await this.mcp.sendLoggingMessage({ level, logger: SERVER_NAME, data });
    } catch (err) {
      logger.debug(`Unable to emit MCP warm-up log: ${toError(err).message}`);
    }
  }

  /**
   * RFC 007 §6.6 / issue #212 — opt-in recursive `fs.watch` watcher.
   * Off by default; `KB_FS_WATCH=1` enables it. Failure to enumerate
   * KBs or attach watchers is logged and swallowed so a partial
   * filesystem doesn't prevent the server from coming up.
   */
  private async startFsWatcher(): Promise<void> {
    if (this.fsWatcher) return;
    if (!KB_FS_WATCH) return;

    let kbNames: string[];
    try {
      kbNames = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
    } catch (err) {
      logger.warn(
        `RecursiveKbWatcher: could not enumerate KBs under ${KNOWLEDGE_BASES_ROOT_DIR}: ${(err as Error).message}`,
      );
      return;
    }
    if (kbNames.length === 0) {
      logger.info('RecursiveKbWatcher: no KBs to watch (skipped)');
      return;
    }
    const targets = kbNames.map((kbName) => ({
      kbName,
      kbPath: path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName),
    }));
    this.fsWatcher = new RecursiveKbWatcher({
      targets,
      onChange: async (kbName) => {
        try {
          const activeId = await resolveActiveModel();
          const manager = await this.managers.getOrCreate(activeId);
          await withWriteLock(manager.modelDir, () => manager.updateIndex(kbName));
        } catch (err) {
          logger.warn(
            `RecursiveKbWatcher updateIndex(${kbName}) failed: ${(err as Error).message}`,
          );
        }
      },
      debounceMs: KB_FS_WATCH_DEBOUNCE_MS,
      ingestFilter: {
        extraExtensions: INGEST_EXTRA_EXTENSIONS,
        excludePaths: INGEST_EXCLUDE_PATHS,
      },
    });
    await this.fsWatcher.start();
  }

  private startTriggerWatcher(): void {
    if (this.triggerWatcher) return;
    if (REINDEX_TRIGGER_POLL_MS <= 0) {
      logger.info('Reindex trigger watcher disabled (REINDEX_TRIGGER_POLL_MS=0)');
      return;
    }
    this.triggerWatcher = new ReindexTriggerWatcher(
      REINDEX_TRIGGER_PATH,
      // RFC 013 §4.6 — trigger-driven updateIndex resolves the active model
      // per fire (long-lived watcher; picks up `set-active` changes on next
      // tick) and serializes through the per-model write lock.
      async () => {
        try {
          const activeId = await resolveActiveModel();
          const manager = await this.managers.getOrCreate(activeId);
          await withWriteLock(manager.modelDir, () => manager.updateIndex(undefined));
        } catch (err) {
          logger.warn(`Trigger watcher updateIndex failed: ${(err as Error).message}`);
        }
      },
      REINDEX_TRIGGER_POLL_MS,
      // Issue #356 — let the watcher catch up on a pending trigger at
      // startup. Returns the active model's FAISS index mtime in ms,
      // or null if the active model / index can't be resolved (e.g.
      // no model is registered, or the index hasn't been built yet).
      // The watcher fires once if the trigger is newer than this.
      async () => {
        try {
          const activeId = await resolveActiveModel();
          const binaryPath = await resolveFaissIndexBinaryPath(activeId);
          if (binaryPath === null) return null;
          const st = await fsp.stat(binaryPath);
          return st.mtimeMs;
        } catch {
          // Active model unresolved, index missing, or stat failed —
          // skip the catch-up. The watcher's normal poll loop still
          // covers any post-startup trigger touches.
          return null;
        }
      },
    );
    void this.triggerWatcher.start();
  }

  private installHttpShutdown(): void {
    if (this.shutdownInstalled) return;
    this.shutdownInstalled = true;
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, draining...');
      void this.shutdown().then(() => process.exit(0));
    });
  }

  private async shutdown(): Promise<void> {
    if (this.triggerWatcher) {
      try {
        await this.triggerWatcher.stop();
      } catch (err) {
        logger.warn(`Error stopping reindex trigger watcher: ${(err as Error).message}`);
      }
      this.triggerWatcher = undefined;
    }
    if (this.fsWatcher) {
      try {
        await this.fsWatcher.stop();
      } catch (err) {
        logger.warn(`Error stopping recursive fs watcher: ${(err as Error).message}`);
      }
      this.fsWatcher = undefined;
    }
    if (this.sseHost) {
      try {
        await this.sseHost.stop();
      } catch (err) {
        logger.warn(`Error during SSE host shutdown: ${(err as Error).message}`);
      }
      this.sseHost = undefined;
    }
    if (this.httpHost) {
      try {
        await this.httpHost.stop();
      } catch (err) {
        logger.warn(`Error during HTTP host shutdown: ${(err as Error).message}`);
      }
      this.httpHost = undefined;
    }
    try {
      await this.mcp.close();
    } catch (err) {
      logger.warn(`Error closing root mcp: ${(err as Error).message}`);
    }
  }
}
