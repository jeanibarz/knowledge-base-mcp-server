// KnowledgeBaseServer.ts
import * as fsp from 'fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  SetLevelRequestSchema,
  type CallToolResult,
  type ListResourcesRequest,
  type ListResourcesResult,
  type ReadResourceResult,
  type ServerNotification,
  type ServerRequest,
  type TextContent,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import type {
  IndexUpdateProgress,
  NeighborContextOptions,
  SearchResultDocument,
  SimilaritySearchTiming,
} from './FaissIndexManager.js';
import { parseModelId } from './model-id.js';
import {
  ActiveModelResolutionError,
  listRegisteredModels,
  resolveActiveModel,
} from './model-resolution.js';
import {
  modelDir,
  readStoredIndexType,
  readStoredModelName,
  resolveFaissIndexBinaryPath,
} from './model-storage-layout.js';
import { ManagerRegistry } from './manager-registry.js';
import {
  ADD_DOCUMENT_DESCRIPTION,
  ASK_KNOWLEDGE_DESCRIPTION,
  DELETE_DOCUMENT_DESCRIPTION,
  DIFF_INDEX_DESCRIPTION,
  EXPORT_CITATIONS_DESCRIPTION,
  FIND_RELATED_DESCRIPTION,
  KB_STATS_DESCRIPTION,
  LIST_FACETS_DESCRIPTION,
  LIST_KNOWLEDGE_BASES_DESCRIPTION,
  LIST_MODELS_DESCRIPTION,
  RECOMMEND_KNOWLEDGE_BASE_DESCRIPTION,
  REINDEX_KNOWLEDGE_BASE_DESCRIPTION,
  RETRIEVE_KNOWLEDGE_DESCRIPTION,
} from './config/mcp-descriptions.js';
import {
  ADD_DOCUMENT_INPUT,
  ASK_KNOWLEDGE_INPUT,
  DELETE_DOCUMENT_INPUT,
  DIFF_INDEX_INPUT,
  EXPORT_CITATIONS_INPUT,
  FIND_RELATED_INPUT,
  LIST_FACETS_INPUT,
  LIST_KNOWLEDGE_BASES_INPUT,
  KB_STATS_INPUT,
  RECOMMEND_KNOWLEDGE_BASE_INPUT,
  REINDEX_KNOWLEDGE_BASE_INPUT,
  RETRIEVE_KNOWLEDGE_INPUT,
  toolAnnotations,
} from './mcp-tool-specs.js';
import {
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  KB_DENSE_DEGRADE_ON_PROVIDER_ERROR,
  resolveHybridRrfWeights,
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
import { KB_READY_TIMEOUT_MS } from './config/provider.js';
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
import { listKnowledgeBaseDocuments } from './kb-document-listing.js';
import {
  buildFacetsJsonPayload,
  collectTagsReport,
  DEFAULT_FACETS,
} from './facets-core.js';
import {
  buildRelatedJsonPayload,
  findRelatedCore,
  parseRelatedTarget,
} from './related-core.js';
import {
  formatCitations,
  resolveCitationEntries,
  type CiteFormat,
} from './citation-core.js';
import {
  buildRecommendKbPayload,
  decideWhere,
  DEFAULT_CONFIDENCE_THRESHOLD as DEFAULT_RECOMMEND_CONFIDENCE_THRESHOLD,
  DEFAULT_K as DEFAULT_RECOMMEND_K,
} from './recommend-kb-core.js';
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
import { logger, closeLogFile } from './logger.js';
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
  createCanonicalRequestId,
  degradationSummaryFields,
  emitCanonicalLog,
  type CanonicalDegradedStage,
  type CanonicalLogInput,
} from './canonical-log.js';
import { formatKbStatsOpenMetrics } from './prometheus-export.js';
import { searchLatencyMetrics } from './search-latency-metrics.js';
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
  resolveAutoSearchMode,
  type DenseDegradationReason,
  type EffectiveSearchMode,
} from './search-core.js';
import { parseRecencyFilterRange } from './search-filters.js';
import { shutdownOtel, withSpan } from './otel-trace.js';
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
import { buildTransportReadinessPayload } from './transport-readiness.js';
import { AskExecutionError, askKnowledge } from './ask-core.js';
import { callChatCompletion } from './llm-client.js';
import { readBuildInfo } from './build-info.js';
import { LexicalIndexCache } from './lexical-index-cache.js';

const SERVER_NAME = 'knowledge-base-server';
const SERVER_BUILD_INFO = readBuildInfo();
const SERVER_VERSION = SERVER_BUILD_INFO.version;

// Issue #795 — the SDK hands every tool callback a per-request `extra`
// (RequestHandlerExtra) as its second argument. We thread it through the tool
// wrapper so long-running handlers can emit `notifications/progress` when the
// client opted in via `_meta.progressToken`.
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Coarse progress update a handler feeds to {@link progressReporter}. */
interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

/**
 * Emits an ordered `notifications/progress` frame per call, or a strict no-op
 * when the client did not opt in. Returns once the frame has been dispatched.
 */
type ProgressReporter = (update: ProgressUpdate) => Promise<void>;

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

/**
 * Issue #975 — resolve the set of KB names a lexical/BM25 leg should query from
 * the full on-disk list and the requested scope. A non-empty subset array wins
 * (order follows the on-disk list; unknown names were already rejected upstream
 * with KB_NOT_FOUND); else the scalar name scopes to one; else all KBs.
 */
function selectScopedKbNames(
  allKbNames: readonly string[],
  knowledgeBaseName: string | undefined,
  knowledgeBaseNames: readonly string[] | undefined,
): string[] {
  if (knowledgeBaseNames !== undefined && knowledgeBaseNames.length > 0) {
    const want = new Set(knowledgeBaseNames);
    return allKbNames.filter((name) => want.has(name));
  }
  if (knowledgeBaseName) {
    return allKbNames.filter((name) => name === knowledgeBaseName);
  }
  return [...allKbNames];
}

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
    (filters.extensions?.some((value) => value.trim().length > 0) ?? false) ||
    (typeof filters.pathGlob === 'string' && filters.pathGlob.length > 0) ||
    (filters.tags?.some((value) => value.trim().length > 0) ?? false) ||
    (typeof filters.since === 'string' && filters.since.length > 0) ||
    (typeof filters.until === 'string' && filters.until.length > 0)
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
  private readonly lexicalIndexCache = new LexicalIndexCache();
  private readonly loadLexicalIndex = this.lexicalIndexCache.load.bind(this.lexicalIndexCache);
  private readonly loadFreshLexicalIndex = this.lexicalIndexCache.loadFresh.bind(this.lexicalIndexCache);
  private readonly invalidateLexicalIndex = this.lexicalIndexCache.invalidate.bind(this.lexicalIndexCache);
  private activeWarmupPromise: Promise<void> | null = null;
  private httpHost?: StreamableHttpHost;
  private sseHost?: SseHost;
  private transportMode: 'stdio' | 'sse' | 'http' | null = null;
  private triggerWatcher?: ReindexTriggerWatcher;
  // RFC 007 §6.6 / issue #212 — opt-in recursive `fs.watch` per KB.
  // Complements `triggerWatcher` (root-level dotfile poller); this one
  // observes per-file edits *inside* each KB tree.
  private fsWatcher?: RecursiveKbWatcher;
  private resourceListFingerprint: string | null = null;
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
    // #796 — advertise the MCP `logging` capability and own the
    // `logging/setLevel` request. `registerCapabilities` must run before
    // `setRequestHandler` (the SDK gates the handler on the capability) and
    // before `connect` (it throws once a transport is attached), so both
    // happen here at build time. The client-chosen minimum level is stored on
    // the HTTP/SSE host's per-session map and enforced in `notify()`; stdio
    // has a single session and no host, so `setLevel` is a no-op there
    // (per-session filtering only matters where sessions exist).
    mcp.server.registerCapabilities({ logging: {} });
    mcp.server.setRequestHandler(SetLevelRequestSchema, async (request, extra) => {
      const host = this.transportMode === 'sse'
        ? this.sseHost
        : this.transportMode === 'http'
          ? this.httpHost
          : undefined;
      // Prefer the transport session id; fall back to the request header the
      // same way the SDK's default handler does, since streamable HTTP can
      // route a request without `extra.sessionId` set. Array-valued headers
      // are collapsed to the first entry (session ids are single-valued).
      const headerSessionId = extra.requestInfo?.headers['mcp-session-id'];
      const sessionId = extra.sessionId
        ?? (Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId);
      if (host !== undefined && sessionId !== undefined) {
        host.setSessionLevel(sessionId, request.params.level);
      }
      return {};
    });
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
    annotations: ToolAnnotations,
    handler: (args: Args, extra: ToolExtra) => Promise<CallToolResult>,
  ): void {
    // Call mcp.tool through a loosened signature: its generic
    // `tool<Args extends ZodRawShapeCompat>` overload instantiates ShapeOutput
    // over the shape, which trips TS2589 once the shape is a runtime value
    // rather than an inline literal. The 5-arg
    // (name, description, shape, annotations, cb) runtime form is unchanged;
    // zod still validates `args` against `shape` before the handler runs.
    //
    // Issue #798 — restore the SDK's
    // `tool(name, description, paramsSchema, annotations, cb)` overload so each
    // tool advertises its `ToolAnnotations` (readOnlyHint / destructiveHint /
    // idempotentHint). The earlier loosening dropped that overload.
    //
    // Issue #795 — forward the SDK's trailing `extra` argument so handlers can
    // reach `_meta.progressToken` / `sendNotification`. Handlers that don't
    // emit progress simply omit the second parameter (fewer params stay
    // assignable), so the change is a no-op for them.
    const registerTool = mcp.tool.bind(mcp) as unknown as (
      name: string,
      description: string,
      shape: z.ZodRawShape,
      annotations: ToolAnnotations,
      cb: (args: unknown, extra: ToolExtra) => Promise<CallToolResult>,
    ) => void;
    registerTool(name, description, shape, annotations, (args, extra) => handler(args as Args, extra));
  }

  /**
   * Issue #795 — build a progress reporter bound to the current request. When
   * the client did NOT supply `_meta.progressToken` this is a strict no-op, so
   * calls that don't opt in behave exactly as before (the MCP spec forbids
   * unsolicited progress frames). Otherwise each call emits an ordered
   * `notifications/progress` frame; a monotonic guard drops any non-increasing
   * update so the wire stream always carries strictly increasing `progress`.
   * A failed dispatch is swallowed (debug-logged) — progress is best-effort and
   * must never fail the underlying tool call.
   */
  private progressReporter(extra?: ToolExtra): ProgressReporter {
    const progressToken = extra?._meta?.progressToken;
    if (progressToken === undefined || progressToken === null) {
      return async () => {};
    }
    let last = Number.NEGATIVE_INFINITY;
    return async ({ progress, total, message }) => {
      if (!(progress > last)) return;
      last = progress;
      try {
        await extra!.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress,
            ...(total !== undefined ? { total } : {}),
            ...(message !== undefined ? { message } : {}),
          },
        });
      } catch (err) {
        logger.debug(`Unable to emit MCP progress notification: ${toError(err).message}`);
      }
    };
  }

  private registerTools(mcp: McpServer) {
    // Issue #798 — each registration advertises its advisory ToolAnnotations
    // (readOnlyHint / destructiveHint / idempotentHint) from the spec registry
    // so MCP clients can gate auto-approval and confirm destructive writes. The
    // zero-arg readers use the SDK's (name, description, annotations, cb)
    // overload; shaped tools thread annotations through registerShapedTool.
    // Issue #1159 — list_knowledge_bases now takes an optional include_counts
    // flag, so it registers through registerShapedTool (which threads the input
    // schema) rather than the zero-arg overload. The default call still sends no
    // arguments and returns the historical bare-names array.
    this.registerShapedTool(
      mcp,
      'list_knowledge_bases',
      LIST_KNOWLEDGE_BASES_DESCRIPTION,
      LIST_KNOWLEDGE_BASES_INPUT,
      toolAnnotations('list_knowledge_bases'),
      this.handleListKnowledgeBases.bind(this)
    );

    this.registerShapedTool(
      mcp,
      'retrieve_knowledge',
      RETRIEVE_KNOWLEDGE_DESCRIPTION,
      RETRIEVE_KNOWLEDGE_INPUT,
      toolAnnotations('retrieve_knowledge'),
      this.handleRetrieveKnowledge.bind(this)
    );

    this.registerShapedTool(
      mcp,
      'ask_knowledge',
      ASK_KNOWLEDGE_DESCRIPTION,
      ASK_KNOWLEDGE_INPUT,
      toolAnnotations('ask_knowledge'),
      this.handleAskKnowledge.bind(this)
    );

    // RFC 013 M3 §4.5 — list_models surfaces what's registered so an agent
    // can pre-flight a model_name override before invoking retrieve_knowledge.
    mcp.tool(
      'list_models',
      LIST_MODELS_DESCRIPTION,
      toolAnnotations('list_models'),
      async () => this.handleListModels()
    );

    // Issue #54 — kb_stats observability surface (counts, last-index timestamp,
    // active model). Read-only; does not acquire the write lock.
    this.registerShapedTool(
      mcp,
      'kb_stats',
      KB_STATS_DESCRIPTION,
      KB_STATS_INPUT,
      toolAnnotations('kb_stats'),
      this.handleKbStats.bind(this)
    );

    this.registerShapedTool(
      mcp,
      'diff_index',
      DIFF_INDEX_DESCRIPTION,
      DIFF_INDEX_INPUT,
      toolAnnotations('diff_index'),
      this.handleDiffIndex.bind(this)
    );

    // Issue #1133 — find_related: read-only seed-chunk "more-like-this"
    // expansion mirroring `kb related`. Always registered (not ingest-gated).
    this.registerShapedTool(
      mcp,
      'find_related',
      FIND_RELATED_DESCRIPTION,
      FIND_RELATED_INPUT,
      toolAnnotations('find_related'),
      this.handleFindRelated.bind(this)
    );

    // Issue #1151 — list_facets: read-only frontmatter-facet enumeration
    // mirroring `kb tags`. Always registered (not ingest-gated).
    this.registerShapedTool(
      mcp,
      'list_facets',
      LIST_FACETS_DESCRIPTION,
      LIST_FACETS_INPUT,
      toolAnnotations('list_facets'),
      this.handleListFacets.bind(this)
    );

    // Issue #1152 — recommend_knowledge_base: read-only topic→shelf routing
    // mirroring `kb where`. Always registered (not ingest-gated).
    this.registerShapedTool(
      mcp,
      'recommend_knowledge_base',
      RECOMMEND_KNOWLEDGE_BASE_DESCRIPTION,
      RECOMMEND_KNOWLEDGE_BASE_INPUT,
      toolAnnotations('recommend_knowledge_base'),
      this.handleRecommendKnowledgeBase.bind(this)
    );

    // Issue #1153 — export_citations: read-only, index-independent citation
    // export mirroring `kb cite`. Always registered (not ingest-gated).
    this.registerShapedTool(
      mcp,
      'export_citations',
      EXPORT_CITATIONS_DESCRIPTION,
      EXPORT_CITATIONS_INPUT,
      toolAnnotations('export_citations'),
      this.handleExportCitations.bind(this)
    );

    if (KB_INGEST_ENABLED) {
      this.registerShapedTool(
        mcp,
        'add_document',
        ADD_DOCUMENT_DESCRIPTION,
        ADD_DOCUMENT_INPUT,
        toolAnnotations('add_document'),
        this.handleAddDocument.bind(this)
      );

      this.registerShapedTool(
        mcp,
        'delete_document',
        DELETE_DOCUMENT_DESCRIPTION,
        DELETE_DOCUMENT_INPUT,
        toolAnnotations('delete_document'),
        this.handleDeleteDocument.bind(this)
      );

      this.registerShapedTool(
        mcp,
        'reindex_knowledge_base',
        REINDEX_KNOWLEDGE_BASE_DESCRIPTION,
        REINDEX_KNOWLEDGE_BASE_INPUT,
        toolAnnotations('reindex_knowledge_base'),
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

  private async handleListKnowledgeBases(
    args: { include_counts?: boolean } = {},
  ): Promise<CallToolResult> {
    return this.withCanonicalTool({ tool: 'list_knowledge_bases' }, async () => {
      try {
      const knowledgeBases = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
      if (args.include_counts !== true) {
        const content: TextContent = {
          type: 'text',
          text: JSON.stringify(knowledgeBases, null, 2),
        };
        return { content: [content] };
      }
      // Issue #1159 — one filesystem walk across every shelf, then group the
      // returned documents by KB so each name reports its ingestable-document
      // count (an empty, or non-walkable, shelf defaults to 0). The name set is
      // taken from listKnowledgeBases above so include_counts and the default
      // output always agree on which shelves exist; listKnowledgeBaseDocuments
      // only ever narrows that set (it drops symlinked/invalid dirs), so every
      // name here is well-defined with a 0 fallback.
      const { documents } = await listKnowledgeBaseDocuments({
        rootDir: KNOWLEDGE_BASES_ROOT_DIR,
      });
      const counts = new Map<string, number>();
      for (const document of documents) {
        counts.set(document.kbName, (counts.get(document.kbName) ?? 0) + 1);
      }
      const content: TextContent = {
        type: 'text',
        text: JSON.stringify(
          knowledgeBases.map((name) => ({ name, document_count: counts.get(name) ?? 0 })),
          null,
          2,
        ),
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
        serverCommit: SERVER_BUILD_INFO.commit,
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

  /**
   * Issue #1133 — find_related MCP handler. The read-only MCP equivalent of
   * `kb related`: seed-chunk "more-like-this" expansion from an existing
   * result's chunk id / kb:// URI (no text query). A thin transport wrapper —
   * it validates the seed reference, loads a read-only manager for the active
   * model, and delegates the retrieval to the shared `findRelatedCore` (the
   * same core `kb related` uses), returning the byte-identical `kb.related.v1`
   * JSON payload. Does NOT acquire the write lock or trigger an index update.
   */
  private async handleFindRelated(args: {
    chunk_id: string;
    knowledge_base_name?: string;
    all_kbs?: boolean;
    k?: number;
    threshold?: number;
    include_self?: boolean;
  }): Promise<CallToolResult> {
    const allKbs = args.all_kbs ?? false;
    const includeSelf = args.include_self ?? false;
    const k = args.k ?? 10;
    const threshold = args.threshold ?? 2;
    // Normalize an empty/whitespace-only knowledge_base_name to "no scope" so
    // it falls back to the seed chunk's own KB (the documented default). The
    // Zod field is an unbounded optional string (matching retrieve/ask), so a
    // client could send ""; without this, `kb: ''` would reach findRelatedCore,
    // and since `options.kb ?? reference.knowledgeBase` only coalesces
    // null/undefined, "" would be treated as a real KB name and silently scope
    // the search to a nonexistent base (zero results). The CLI rejects an empty
    // --kb outright; here we treat it as "unset" rather than erroring.
    const knowledgeBaseName = args.knowledge_base_name !== undefined && args.knowledge_base_name.trim().length > 0
      ? args.knowledge_base_name
      : undefined;

    return this.withCanonicalTool({
      tool: 'find_related',
      kb_scope: allKbs ? null : (knowledgeBaseName ?? null),
      k,
      threshold,
    }, async () => {
      // Mirror the CLI's `--all-kbs cannot be combined with --kb` guard.
      if (allKbs && knowledgeBaseName !== undefined) {
        return {
          content: [mcpErrorContent(new KBError(
            'VALIDATION',
            'Pass either knowledge_base_name (one base) or all_kbs (every base), not both.',
          ))],
          isError: true,
        };
      }

      const reference = parseRelatedTarget(args.chunk_id);
      if ('error' in reference) {
        return {
          content: [mcpErrorContent(new KBError('VALIDATION', reference.error))],
          isError: true,
        };
      }

      try {
        let activeModelId: string;
        try {
          activeModelId = await resolveActiveModel();
        } catch (err) {
          if (err instanceof ActiveModelResolutionError) {
            return { content: [{ type: 'text', text: err.message }], isError: true };
          }
          throw err;
        }

        const manager = await this.createReadOnlyManagerForModel(activeModelId);
        const outcome = await findRelatedCore(manager, reference.value, {
          k,
          threshold,
          includeSelf,
          noCache: false,
          kb: knowledgeBaseName,
          allKbs,
        });
        if ('seedNotFound' in outcome) {
          return {
            content: [mcpErrorContent(new KBError(
              'KB_NOT_FOUND',
              `no indexed chunk matched '${args.chunk_id}'`,
            ))],
            isError: true,
          };
        }

        const payload = buildRelatedJsonPayload({
          target: args.chunk_id,
          seed: outcome.seed,
          scopedKb: outcome.scopedKb,
          includeSelf,
          results: outcome.results,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error: unknown) {
        const err = toError(error);
        logger.error('Error finding related chunks:', err);
        if (err.stack) {
          logger.error(err.stack);
        }
        return { content: [mcpErrorContent(err)], isError: true };
      }
    });
  }

  /**
   * Issue #1151 — list_facets MCP handler. The read-only MCP equivalent of
   * `kb tags`: enumerate the frontmatter facet values that actually exist so a
   * client can discover the valid tags/status/type filter vocabulary accepted
   * by retrieve_knowledge / ask_knowledge. A thin transport wrapper — it
   * normalizes the optional scope/facet inputs and delegates the scan to the
   * shared `collectTagsReport` (the same core `kb tags` uses), returning the
   * byte-identical `kb.tags.v1` JSON payload. Does NOT touch the index: it
   * reads notes straight off disk under KNOWLEDGE_BASES_ROOT_DIR.
   */
  private async handleListFacets(args: {
    knowledge_base_name?: string;
    facet?: string;
  }): Promise<CallToolResult> {
    // Normalize empty/whitespace-only inputs to "unset" so they fall back to
    // the documented defaults (all KBs / tags-status-type) rather than scoping
    // to a literal empty KB or facet name — the Zod fields are unbounded
    // optional strings, so a client could send "". The CLI rejects an empty
    // --kb / --facet outright; here we treat them as unset instead of erroring.
    const knowledgeBaseName = args.knowledge_base_name !== undefined && args.knowledge_base_name.trim().length > 0
      ? args.knowledge_base_name
      : undefined;
    const facet = args.facet !== undefined && args.facet.trim().length > 0
      ? args.facet
      : undefined;
    const facets = facet !== undefined ? [facet] : [...DEFAULT_FACETS];

    return this.withCanonicalTool({
      tool: 'list_facets',
      kb_scope: knowledgeBaseName ?? null,
    }, async () => {
      try {
        // collectTagsReport resolves an unknown knowledge_base_name through
        // resolveKnowledgeBaseDir, which throws KBError('KB_NOT_FOUND', …) —
        // the same fail-closed contract the other tools use. mcpErrorContent
        // preserves that code on the wire.
        const report = await collectTagsReport({
          rootDir: KNOWLEDGE_BASES_ROOT_DIR,
          kbFilter: knowledgeBaseName,
          facets,
        });
        const payload = buildFacetsJsonPayload(report);
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error: unknown) {
        const err = toError(error);
        logger.error('Error listing facets:', err);
        if (err.stack) {
          logger.error(err.stack);
        }
        return { content: [mcpErrorContent(err)], isError: true };
      }
    });
  }

  /**
   * Issue #1152 — recommend_knowledge_base MCP handler. The read-only MCP
   * equivalent of `kb where`: route a topic to the best knowledge base and the
   * best existing file inside it, so an MCP-only client can scope a search or
   * pick an add_document destination without guessing a shelf. A thin transport
   * wrapper — it loads a read-only manager for the active model, runs one
   * cross-KB similarity search for the topic (no KB filter, like the CLI), and
   * delegates the reduction + serialization to the shared `decideWhere` /
   * `buildRecommendKbPayload` core so the score/threshold semantics are
   * identical to `kb where --format=json`. The CLI-only `kb remember`
   * copy-paste is omitted so the MCP tool stays a pure recommendation. Does NOT
   * acquire the write lock or trigger an index update.
   */
  private async handleRecommendKnowledgeBase(args: {
    topic: string;
    k?: number;
    threshold?: number;
    model_name?: string;
  }): Promise<CallToolResult> {
    const k = args.k ?? DEFAULT_RECOMMEND_K;
    // The `threshold` input is the CONFIDENCE cutoff applied by decideWhere, not
    // a search-level distance cap: the cross-KB search always over-fetches with
    // an infinite threshold and the confidence check is applied afterwards —
    // exactly as `kb where` does.
    const confidenceThreshold = args.threshold ?? DEFAULT_RECOMMEND_CONFIDENCE_THRESHOLD;

    return this.withCanonicalTool({
      tool: 'recommend_knowledge_base',
      kb_scope: null,
      k,
      threshold: confidenceThreshold,
    }, async () => {
      try {
        let activeModelId: string;
        try {
          activeModelId = await resolveActiveModel({ explicitOverride: args.model_name });
        } catch (err) {
          if (err instanceof ActiveModelResolutionError) {
            return { content: [{ type: 'text', text: err.message }], isError: true };
          }
          throw err;
        }

        const manager = await this.createReadOnlyManagerForModel(activeModelId);
        // No KB filter — we want the cross-KB ranking, like `kb where`.
        const results = await manager.similaritySearch(
          args.topic,
          k,
          Number.POSITIVE_INFINITY,
        );
        const decision = decideWhere(results, confidenceThreshold);
        const payload = buildRecommendKbPayload(decision);
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error: unknown) {
        const err = toError(error);
        logger.error('Error recommending a knowledge base:', err);
        if (err.stack) {
          logger.error(err.stack);
        }
        return { content: [mcpErrorContent(err)], isError: true };
      }
    });
  }

  /**
   * Issue #1153 — export_citations MCP handler. The read-only MCP equivalent of
   * `kb cite`: turn one retrieval selector (chunk id / kb:// URI / KB-relative
   * path) into a bibliography entry from the note's YAML frontmatter. A thin
   * transport wrapper — it delegates selector resolution, frontmatter parsing,
   * and formatting to the SAME `resolveCitationEntry` / `formatCitation` the CLI
   * uses, so the two surfaces produce byte-identical citations. Index- and
   * service-independent: it reads exactly one note and never touches the index,
   * the write lock, or an LLM. Errors mirror the shared resolution the CLI uses:
   * a malformed selector surfaces as VALIDATION; an unknown knowledge base as
   * KB_NOT_FOUND; a missing note at an otherwise valid path as a plain
   * "path not found" error (stamped INTERNAL by mcpErrorContent, since
   * resolveKbPath throws a non-KBError there). A note with missing/invalid
   * frontmatter is NOT an error — it returns a citation keyed from the note
   * path, exactly as `kb cite` does.
   */
  private async handleExportCitations(args: {
    selector: string | string[];
    format?: CiteFormat;
  }): Promise<CallToolResult> {
    const format: CiteFormat = args.format ?? 'bibtex';
    // #1158 — `selector` accepts a single string (byte-identical to #1153) or an
    // array; both resolve to one merged bibliography. Resolution is all-or-
    // nothing and in order, so a malformed/unreadable selector surfaces the same
    // VALIDATION/KB_NOT_FOUND/path-not-found error the single-selector call did.
    const selectors = Array.isArray(args.selector) ? args.selector : [args.selector];

    return this.withCanonicalTool({ tool: 'export_citations' }, async () => {
      try {
        const entries = await resolveCitationEntries(selectors);
        return {
          content: [{ type: 'text', text: formatCitations(entries, format) }],
        };
      } catch (error: unknown) {
        const err = toError(error);
        logger.error('Error exporting citation:', err);
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
      indexType: await readStoredIndexType(modelId),
    });
    await manager.initialize({ readOnly: true });
    return manager;
  }

  private async getActiveManagerForMutation(): Promise<FaissIndexManager> {
    const activeModelId = await resolveActiveModel();
    return this.managers.getOrCreate(activeModelId);
  }

  private async handleAddDocument(args: AddDocumentArgs): Promise<CallToolResult> {
    const result = await handleAddDocument(args, {
      getActiveManagerForMutation: () => this.getActiveManagerForMutation(),
      withCanonicalTool: (base, operation, enrich) =>
        this.withCanonicalTool(base, operation, enrich),
    });
    if (!result.isError) {
      await this.notifyResourceListChangedIfListingChanged();
    }
    return result;
  }

  private async handleDeleteDocument(args: DeleteDocumentArgs): Promise<CallToolResult> {
    const result = await handleDeleteDocument(args, {
      getActiveManagerForMutation: () => this.getActiveManagerForMutation(),
      withCanonicalTool: (base, operation, enrich) =>
        this.withCanonicalTool(base, operation, enrich),
    });
    if (!result.isError) {
      await this.notifyResourceListChangedIfListingChanged();
    }
    return result;
  }

  private async handleReindexKnowledgeBase(args: {
    knowledge_base_name?: string;
  }, extra?: ToolExtra): Promise<CallToolResult> {
    const report = this.progressReporter(extra);
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
          // Issue #795 — drive MCP progress off the existing reindex plumbing.
          // `processedFiles` climbs within a phase; the reporter's monotonic
          // guard coalesces the per-phase resets (scan → load → embed) into a
          // strictly increasing wire stream.
          await manager.updateIndex(args.knowledge_base_name, {
            force: true,
            onProgress: (p) => report({
              progress: p.processedFiles,
              total: p.totalFiles,
              message: `Embedded ${p.processedFiles}/${p.totalFiles} files`,
            }),
          });
        });
        await this.notifyResourceListChangedIfListingChanged();

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

  /**
   * Issue #975 — validate and resolve the `knowledge_base_name` /
   * `knowledge_base_names` scope pair shared by retrieve_knowledge and
   * ask_knowledge. Returns either the validated subset (`names`, or `undefined`
   * when no subset was requested) or an error `CallToolResult`:
   *   - both the scalar name and a non-empty array set → VALIDATION
   *   - any name in the array that is not a registered KB → KB_NOT_FOUND
   * An empty/whitespace-only array is treated as "no subset" (same as omitting
   * it), so omitting the argument preserves the exact single-or-all scope.
   */
  private async resolveKbSubsetScope(
    knowledgeBaseName: string | undefined,
    knowledgeBaseNames: readonly string[] | undefined,
  ): Promise<{ names?: string[] } | { error: CallToolResult }> {
    const requested = (knowledgeBaseNames ?? []).filter(
      (name): name is string => typeof name === 'string' && name.length > 0,
    );
    if (requested.length === 0) return { names: undefined };
    if (typeof knowledgeBaseName === 'string' && knowledgeBaseName.length > 0) {
      return {
        error: {
          content: [mcpErrorContent(new KBError(
            'VALIDATION',
            'Pass either knowledge_base_name (one base) or knowledge_base_names (a subset), not both.',
          ))],
          isError: true,
        },
      };
    }
    const available = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
    const availableSet = new Set(available);
    const deduped = [...new Set(requested)];
    const unknown = deduped.filter((name) => !availableSet.has(name));
    if (unknown.length > 0) {
      const known = [...available].sort((a, b) => a.localeCompare(b)).join(', ') || '(none)';
      return {
        error: {
          content: [mcpErrorContent(new KBError(
            'KB_NOT_FOUND',
            `Unknown knowledge base(s) in knowledge_base_names: ${unknown.join(', ')}. Known: ${known}.`,
          ))],
          isError: true,
        },
      };
    }
    return { names: deduped };
  }

  private async handleRetrieveKnowledge(args: {
    query: string;
    knowledge_base_name?: string;
    knowledge_base_names?: string[];
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
    k?: number;
    search_mode?: 'dense' | 'hybrid' | 'lexical' | 'auto';
    task_context?: string;
    gate?: 'on' | 'off';
    rerank?: 'on' | 'off';
  }, extra?: ToolExtra): Promise<CallToolResult> {
    // Issue #795 — coarse stage progress for the dense retrieval path. Hybrid
    // delegates to handleRetrieveKnowledgeHybrid which is left as a no-op for
    // now (the reporter is a no-op unless the client opted in either way).
    const report = this.progressReporter(extra);
    const RETRIEVE_STAGES = 4;
    const canonical: Partial<CanonicalLogInput> = {};
    const requestStartedAt = Date.now();
    const query: string = args.query;
    const knowledgeBaseName: string | undefined = args.knowledge_base_name;
    // Issue #975 — resolve the optional named-subset scope. Validation errors
    // (both scope args set → VALIDATION; unknown name → KB_NOT_FOUND) short out
    // before any retrieval work and before the canonical span opens.
    const scope = await this.resolveKbSubsetScope(args.knowledge_base_name, args.knowledge_base_names);
    if ('error' in scope) return scope.error;
    const knowledgeBaseNames: string[] | undefined = scope.names;
    // A single scope label for spans, canonical logs, and the relevance gate:
    // the scalar name, else the comma-joined subset, else null (all KBs). When
    // no subset is requested this is identical to the pre-#975 `name ?? null`.
    const kbScope: string | null = knowledgeBaseName && knowledgeBaseName.length > 0
      ? knowledgeBaseName
      : (knowledgeBaseNames !== undefined ? knowledgeBaseNames.join(',') : null);
    const threshold: number | undefined = args.threshold;
    const modelNameOverride: string | undefined = args.model_name;
    const candidateFilters = {
      extensions: args.extensions,
      pathGlob: args.path_glob,
      tags: args.tags,
      since: args.since,
      until: args.until,
    };
    const filters = hasRetrievalFilters(candidateFilters) ? candidateFilters : undefined;
    // Issue #973 — effectiveK replaces the hardcoded top-K of 10; omitting
    // `k` preserves the previous behavior exactly. `auto` (same heuristic as
    // ask_knowledge, #732) resolves to dense or hybrid before any retrieval
    // work starts; omitting `search_mode` still defaults to 'dense'.
    const effectiveK = args.k ?? 10;
    const requestedSearchMode: 'dense' | 'hybrid' | 'lexical' | 'auto' = args.search_mode ?? 'dense';
    const searchMode: EffectiveSearchMode = requestedSearchMode === 'auto'
      ? resolveAutoSearchMode(query).mode
      : requestedSearchMode;
    const taskContext = args.task_context;
    const gateOverride: RelevanceGateOverride = args.gate;
    const rerankOverride: RerankOverride = args.rerank;
    const neighborContext = resolveNeighborContextOptions(args);
    // Mint before the span so the trace and the canonical log share one id
    // (issue #900). withCanonicalTool would otherwise mint later, after the
    // span is already open, leaving two unlinkable identifiers.
    const requestId = createCanonicalRequestId();

    return withSpan('kb.retrieve_knowledge', {
      'kb.scope': kbScope,
      'kb.search_mode': searchMode,
      'kb.k': effectiveK,
      'kb.request_id': requestId,
    }, () => this.withCanonicalTool({
      tool: 'retrieve_knowledge',
      request_id: requestId,
      query,
      kb_scope: kbScope,
      k: effectiveK,
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
      if (searchMode === 'hybrid' || searchMode === 'lexical') {
        // Neighbour expansion needs the dense FAISS docstore, so it works for
        // dense and hybrid; BM25-only (lexical) has no docstore to widen from.
        if (searchMode === 'lexical' && hasNeighborContext(neighborContext)) {
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
                  message: 'neighbor context expansion is only supported with dense or hybrid retrieve_knowledge',
                },
              }),
            }],
            isError: true,
          };
        }
        if (searchMode === 'lexical') {
          return this.handleRetrieveKnowledgeLexical({
            query,
            knowledgeBaseName,
            knowledgeBaseNames,
            filters,
            canonical,
            taskContext,
            gateOverride,
            k: effectiveK,
            requestStartedAt,
          });
        }
        return this.handleRetrieveKnowledgeHybrid({
          query,
          knowledgeBaseName,
          knowledgeBaseNames,
          modelNameOverride,
          filters,
          canonical,
          taskContext,
          gateOverride,
          rerankOverride,
          k: effectiveK,
          ...(neighborContext !== undefined ? { neighborContext } : {}),
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
        activeModelId = await resolveActiveModel({ explicitOverride: modelNameOverride, registerFirstModel: true });
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
      // Issue #975 — a subset refreshes each named KB under the one lock.
      await withWriteLock(manager.modelDir, async () => {
        if (knowledgeBaseNames !== undefined) {
          for (const name of knowledgeBaseNames) {
            await manager.updateIndex(name);
          }
        } else {
          await manager.updateIndex(knowledgeBaseName);
        }
      });
      if (process.env.KB_LOG_VERBOSE === '1') {
        logger.debug(`[${Date.now()}] FAISS index update completed`);
      }
      await report({ progress: 1, total: RETRIEVE_STAGES, message: 'index ready' });

      // Perform similarity search using the provided query.
      const timing: SimilaritySearchTiming = {};
      let degradedReason: DenseDegradationReason | null = null;
      let similaritySearchResults: SearchResultDocument[];
      try {
        // `kb.retrieve.dense` covers query embedding + FAISS search.
        similaritySearchResults = await withSpan('kb.retrieve.dense', {
          'kb.k': effectiveK,
          'kb.scope': kbScope,
        }, () => manager.similaritySearch(
          query,
          effectiveK,
          threshold,
          knowledgeBaseName,
          filters,
          timing,
          // Pass opts only for a subset so the single/all path keeps its exact
          // pre-#975 call shape.
          ...(knowledgeBaseNames ? [{ knowledgeBaseNames }] as const : [] as const),
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
          knowledgeBaseNames,
          fetchK: effectiveK,
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
      await report({ progress: 2, total: RETRIEVE_STAGES, message: 'search complete' });
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
      await report({ progress: 3, total: RETRIEVE_STAGES, message: 'relevance gate complete' });
      emitRelevanceGateDecision({
        process: 'mcp',
        query,
        kbScope,
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

      await report({ progress: 4, total: RETRIEVE_STAGES, message: 'response ready' });
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
    knowledge_base_names?: string[];
    model_name?: string;
    llm_profile?: string;
    k?: number;
    context_budget_tokens?: number;
    // Issue #974 — metadata POST-filters + neighbor windows, mirroring
    // retrieve_knowledge. Threaded straight into askKnowledge (ask-core.ts),
    // which builds/validates them and scopes retrieval before context packing.
    extensions?: string[];
    path_glob?: string;
    tags?: string[];
    since?: string;
    until?: string;
    context_before?: number;
    context_after?: number;
    context_window?: number;
    task_context?: string;
    gate?: 'on' | 'off';
    search_mode?: 'dense' | 'hybrid' | 'lexical' | 'auto';
    rerank?: 'on' | 'off';
    timing?: boolean;
  }, extra?: ToolExtra): Promise<CallToolResult> {
    const report = this.progressReporter(extra);
    // Issue #975 — resolve the optional named-subset scope (VALIDATION when both
    // scope args are set; KB_NOT_FOUND for an unknown name) before the span.
    const scope = await this.resolveKbSubsetScope(args.knowledge_base_name, args.knowledge_base_names);
    if ('error' in scope) return scope.error;
    const knowledgeBaseNames = scope.names;
    const kbScope: string | null = args.knowledge_base_name && args.knowledge_base_name.length > 0
      ? args.knowledge_base_name
      : (knowledgeBaseNames !== undefined ? knowledgeBaseNames.join(',') : null);
    // Same mint-early pattern as retrieve_knowledge (issue #900): the kb.ask
    // span opens inside executeAsk, so the id has to travel in as request_id.
    const requestId = createCanonicalRequestId();
    return this.withCanonicalTool({
      tool: 'ask_knowledge',
      request_id: requestId,
      query: args.query,
      kb_scope: kbScope,
      k: args.k ?? 8,
    }, async () => {
      try {
        const payload = await askKnowledge({
          query: args.query,
          knowledge_base_name: args.knowledge_base_name,
          knowledge_base_names: knowledgeBaseNames,
          model_name: args.model_name,
          llm_profile: args.llm_profile,
          k: args.k,
          context_budget_tokens: args.context_budget_tokens,
          extensions: args.extensions,
          path_glob: args.path_glob,
          tags: args.tags,
          since: args.since,
          until: args.until,
          context_before: args.context_before,
          context_after: args.context_after,
          context_window: args.context_window,
          task_context: args.task_context,
          gate: args.gate,
          search_mode: args.search_mode,
          rerank: args.rerank,
          timing: args.timing ?? true,
          request_id: requestId,
        }, {
          bootstrapLayout: FaissIndexManager.bootstrapLayout.bind(FaissIndexManager),
          resolveActiveModel,
          loadManagerForModel: (modelId) => this.createReadOnlyManagerForModel(modelId),
          loadReadOnlyIndex: async () => {},
          withWriteLock,
          callChatCompletion,
          loadLexicalIndex: this.loadLexicalIndex,
          loadFreshLexicalIndex: this.loadFreshLexicalIndex,
          invalidateLexicalIndex: this.invalidateLexicalIndex,
        }, report);
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
   * - Hybrid overfetches both legs for fusion, so the similarity threshold is
   *   not applied in hybrid mode because fused scores are not dense scores.
   *   Metadata POST-filters are applied to both legs before fusion, so hybrid
   *   cannot return a lexical-only chunk outside the requested boundary.
   * - Unfiltered lexical retrieval is auto-refreshed on first use per KB
   *   (when empty). Filtered hybrid retrieval refreshes every KB so persisted
   *   tags, extensions, and paths reflect current source files; `kb search
   *   --refresh` (CLI) remains the explicit unfiltered refresh path.
   * - Returns the same wire envelope as the dense handler with one added
   *   markdown header line `> _Mode: hybrid (RRF c=60)_` so an inspecting
   *   agent can attribute the ranking. JSON-shaped output is unchanged since
   *   the `retrieve_knowledge` tool returns markdown text content.
   */
  private async handleRetrieveKnowledgeHybrid(input: {
    query: string;
    knowledgeBaseName?: string;
    /** Issue #975 — named subset scope (mutually exclusive with the scalar name). */
    knowledgeBaseNames?: readonly string[];
    modelNameOverride?: string;
    filters?: { extensions?: string[]; pathGlob?: string; tags?: string[]; since?: string; until?: string };
    canonical?: Partial<CanonicalLogInput>;
    taskContext?: string;
    gateOverride?: RelevanceGateOverride;
    rerankOverride?: RerankOverride;
    /** Issue #973 — retrieval top-K before fusion/rerank. Default 10. */
    k?: number;
    /** Opt-in neighbour windows, applied after fusion + rerank + gate. */
    neighborContext?: NeighborContextOptions;
  }): Promise<CallToolResult> {
    const { query, knowledgeBaseName, knowledgeBaseNames, modelNameOverride, filters, canonical, taskContext, gateOverride, rerankOverride } = input;
    const kbScope: string | null = knowledgeBaseName && knowledgeBaseName.length > 0
      ? knowledgeBaseName
      : (knowledgeBaseNames !== undefined && knowledgeBaseNames.length > 0 ? knowledgeBaseNames.join(',') : null);
    const HYBRID_TOP_K = input.k ?? 10;
    const fetchK = hybridFetchK(HYBRID_TOP_K);
    const requestStartedAt = Date.now();

    try {
      let activeModelId: string;
      try {
        activeModelId = await resolveActiveModel({ explicitOverride: modelNameOverride, registerFirstModel: true });
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
      // Issue #975 — a subset refreshes each named KB under the one lock.
      await withWriteLock(manager.modelDir, async () => {
        if (knowledgeBaseNames !== undefined && knowledgeBaseNames.length > 0) {
          for (const name of knowledgeBaseNames) {
            await manager.updateIndex(name);
          }
        } else {
          await manager.updateIndex(knowledgeBaseName);
        }
      });

      // Dense leg — over-fetch to give RRF room.
      const denseTiming: SimilaritySearchTiming = {};
      let denseError: unknown = null;
      const densePromise = withSpan('kb.retrieve.dense', {
        'kb.k': fetchK,
        'kb.scope': kbScope,
      }, () => manager
        .similaritySearch(query, fetchK, Number.POSITIVE_INFINITY, knowledgeBaseName, filters, denseTiming, ...(knowledgeBaseNames && knowledgeBaseNames.length > 0 ? [{ knowledgeBaseNames }] as const : [] as const)))
        .then((rs) => rs.map((r) => ({ pageContent: r.pageContent, metadata: r.metadata, score: r.score })))
        .catch((err) => {
          denseError = err;
          return [];
        });

      // Lexical leg — BM25 over the same chunks the FAISS path embeds, but
      // managed independently (the lexical index is model-agnostic and lives
      // under `${FAISS_INDEX_PATH}/lexical/<kb>/`). Unfiltered calls refresh
      // on first use per KB; filtered calls refresh every KB so persisted
      // metadata is current. Explicit unfiltered refresh is the CLI's job
      // (`kb search --refresh`).
      const allKbNames = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
      const kbNames = selectScopedKbNames(allKbNames, knowledgeBaseName, knowledgeBaseNames);
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
        filters,
        loadIndex: this.loadLexicalIndex,
        loadFreshIndex: this.loadFreshLexicalIndex,
        invalidateIndex: this.invalidateLexicalIndex,
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

      const rerankConfig = resolveRerankerConfig(process.env, rerankOverride, kbScope);
      const fusionStartedAt = Date.now();
      const fusion = await withSpan('kb.retrieve.fusion', {
        'kb.dense_in': denseResults.length,
        'kb.lexical_in': lexicalResults.length,
      }, async () => (degradedReason === null
        ? fuseHybridResultsWithDiagnostics({
            denseResults,
            lexicalResults,
            k: rerankConfig.enabled ? Math.max(HYBRID_TOP_K, rerankConfig.topN) : HYBRID_TOP_K,
            weights: resolveHybridRrfWeights(),
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
        kbScope,
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
      if (input.neighborContext && hasNeighborContext(input.neighborContext) && degradedReason === null) {
        // Expand after fusion + rerank + gate so context chunks never affect
        // ranking. Skipped when the dense leg degraded (no FAISS docstore).
        ranked = manager.expandWithNeighborContext(ranked as never, input.neighborContext) as never;
      }
      emitRelevanceGateDecision({
        process: 'mcp',
        query,
        kbScope,
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

  /**
   * Issue #973 — BM25-only retrieval path for `retrieve_knowledge`, mirroring
   * `ask_knowledge`'s lexical leg (ask-core.ts `retrieveHybridOrLexical`).
   * Runs only the per-KB lexical leg (no FAISS leg, no fusion, no reranker —
   * the reranker is opt-in for hybrid only), applies the same relevance gate
   * as the dense/hybrid paths, and returns the same wire envelope.
   */
  private async handleRetrieveKnowledgeLexical(input: {
    query: string;
    knowledgeBaseName?: string;
    /** Issue #975 — named subset scope (mutually exclusive with the scalar name). */
    knowledgeBaseNames?: readonly string[];
    filters?: { extensions?: string[]; pathGlob?: string; tags?: string[]; since?: string; until?: string };
    canonical?: Partial<CanonicalLogInput>;
    taskContext?: string;
    gateOverride?: RelevanceGateOverride;
    /** Retrieval top-K. Default 10. */
    k?: number;
    requestStartedAt: number;
  }): Promise<CallToolResult> {
    const { query, knowledgeBaseName, knowledgeBaseNames, filters, canonical, taskContext, gateOverride, requestStartedAt } = input;
    const kbScope: string | null = knowledgeBaseName && knowledgeBaseName.length > 0
      ? knowledgeBaseName
      : (knowledgeBaseNames !== undefined && knowledgeBaseNames.length > 0 ? knowledgeBaseNames.join(',') : null);
    const topK = input.k ?? 10;
    const fetchK = hybridFetchK(topK);

    try {
      const allKbNames = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
      const kbNames = selectScopedKbNames(allKbNames, knowledgeBaseName, knowledgeBaseNames);
      const kbs = kbNames.map((kbName) => ({ kbName, kbPath: path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName) }));

      let lexicalSearchMs = 0;
      const lexicalStartedAt = Date.now();
      const lexicalLegResult = await withSpan('kb.retrieve.lexical', {
        'kb.k': fetchK,
        'kb.kb_count': kbs.length,
      }, () => runLexicalLeg({
        kbs,
        query,
        fetchK,
        refresh: 'when-empty',
        filters,
        loadIndex: this.loadLexicalIndex,
        loadFreshIndex: this.loadFreshLexicalIndex,
        invalidateIndex: this.invalidateLexicalIndex,
        onError: (kbName, err) => {
          logger.warn(`retrieve_knowledge lexical: lexical leg failed for KB "${kbName}": ${err.message}`);
        },
      }));
      lexicalSearchMs = Date.now() - lexicalStartedAt;
      let ranked = lexicalLegResult.hits.slice(0, topK);
      const lexicalHitIds = new Set(ranked.map((r) => chunkIdFromMetadata(r.metadata)));

      const gateStartedAt = Date.now();
      const gate = await withSpan('kb.retrieve.gate', {
        'kb.candidates_in': ranked.length,
      }, async (gateSpan) => {
        const decision = await applyRelevanceGate({
          query,
          taskContext,
          candidates: ranked,
          denseDistanceById: new Map<string, number>(),
          lexicalHitIds,
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
        kbScope,
        searchMode: 'lexical',
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
      const formatMs = Date.now() - formatStartedAt;
      if (canonical) {
        canonical.result_count = ranked.length;
        canonical.top_score = ranked[0]?.score;
        canonical.top_sources = topSourcesForCanonicalLog(ranked);
        canonical.format_ms = formatMs;
      }
      searchLatencyMetrics.record({
        mode: 'lexical',
        status: 'success',
        totalMs: Date.now() - requestStartedAt,
        stageDurationsMs: searchStageDurationsFromTiming({
          lexical_search_ms: lexicalSearchMs,
          gate_ms: gateMs,
          format_ms: formatMs,
        }),
      });
      const header = `> _Mode: lexical (BM25); fetched ${lexicalLegResult.hits.length} (#973)._`;
      responseText = `${header}\n\n${responseText}`;
      const degradation = degradationSummaryFields({
        gate: canonical?.gate,
      });
      const degradedFooter = formatDegradedStagesFooter(degradation.degraded_stages);
      if (degradedFooter !== '') {
        responseText = `${responseText}\n\n${degradedFooter}`;
      }

      const content: TextContent = { type: 'text', text: responseText };
      const response = withGateVerdict({ content: [content] }, gate.verdict);
      return withDegradationSummary(response, degradation.degraded_stages);
    } catch (error: unknown) {
      const err = toError(error);
      searchLatencyMetrics.record({
        mode: 'lexical',
        status: 'error',
        totalMs: Date.now() - requestStartedAt,
      });
      logger.error('Error retrieving knowledge (lexical):', err);
      if (err.stack) logger.error(err.stack);
      return { content: [mcpErrorContent(err)], isError: true };
    }
  }

  private async runDegradedLexicalOnly(input: {
    query: string;
    knowledgeBaseName?: string;
    /** Issue #975 — named subset scope (mutually exclusive with the scalar name). */
    knowledgeBaseNames?: readonly string[];
    fetchK: number;
  }): Promise<{ results: Array<{ pageContent: string; metadata: Record<string, unknown>; score: number }> } | null> {
    const allKbNames = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
    const kbNames = selectScopedKbNames(allKbNames, input.knowledgeBaseName, input.knowledgeBaseNames);
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
      loadIndex: this.loadLexicalIndex,
      loadFreshIndex: this.loadFreshLexicalIndex,
      invalidateIndex: this.invalidateLexicalIndex,
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
    await this.refreshResourceListFingerprint();
    this.startActiveManagerWarmup();
    this.startTriggerWatcher();
    await this.startFsWatcher();
  }

  private async runSse(config: TransportConfig): Promise<void> {
    const host = new SseHost({
      config,
      createMcpServer: () => this.buildMcpServer(),
      metricsExporter: () => this.handleMetricsExport(),
      readinessProbe: () => buildTransportReadinessPayload(),
      readinessTimeoutMs: KB_READY_TIMEOUT_MS,
    });
    this.sseHost = host;
    this.installHttpShutdown();
    // Start watcher only after the HTTP bind succeeds; a throw from
    // host.start() unwinds without leaving a dangling polling timer.
    await host.start();
    this.transportMode = 'sse';
    await this.refreshResourceListFingerprint();
    this.startActiveManagerWarmup();
    this.startTriggerWatcher();
    await this.startFsWatcher();
  }

  private async runHttp(config: TransportConfig): Promise<void> {
    const host = new StreamableHttpHost({
      config,
      createMcpServer: () => this.buildMcpServer(),
      metricsExporter: () => this.handleMetricsExport(),
      readinessProbe: () => buildTransportReadinessPayload(),
      readinessTimeoutMs: KB_READY_TIMEOUT_MS,
    });
    this.httpHost = host;
    this.installHttpShutdown();
    await host.start();
    this.transportMode = 'http';
    await this.refreshResourceListFingerprint();
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
      serverVersion: SERVER_BUILD_INFO.version,
      serverCommit: SERVER_BUILD_INFO.commit,
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
      const activeId = await resolveActiveModel({ registerFirstModel: true });
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

  private async readResourceListFingerprint(): Promise<string> {
    const result = await listResources();
    return result.resources.map((resource) => resource.uri).sort((a, b) => a.localeCompare(b)).join('\0');
  }

  private async refreshResourceListFingerprint(): Promise<void> {
    try {
      this.resourceListFingerprint = await this.readResourceListFingerprint();
    } catch (err) {
      logger.warn(`Unable to snapshot MCP resource list: ${toError(err).message}`);
      this.resourceListFingerprint = null;
    }
  }

  private async notifyResourceListChangedIfListingChanged(): Promise<void> {
    let nextFingerprint: string;
    try {
      nextFingerprint = await this.readResourceListFingerprint();
    } catch (err) {
      logger.warn(`Unable to compare MCP resource list after mutation: ${toError(err).message}`);
      // The mutation already succeeded; fail open so clients drop stale
      // listing caches instead of missing a possible create/delete.
      await this.sendResourceListChanged();
      this.resourceListFingerprint = null;
      return;
    }

    const previousFingerprint = this.resourceListFingerprint;
    this.resourceListFingerprint = nextFingerprint;
    if (previousFingerprint !== null && previousFingerprint === nextFingerprint) {
      return;
    }
    await this.sendResourceListChanged();
  }

  private async sendResourceListChanged(): Promise<void> {
    if (this.transportMode === 'sse') {
      if (this.sseHost) await this.sseHost.notifyResourceListChanged();
      return;
    }
    if (this.transportMode === 'http') {
      if (this.httpHost) await this.httpHost.notifyResourceListChanged();
      return;
    }
    try {
      this.mcp.sendResourceListChanged();
    } catch (err) {
      logger.debug(`Unable to emit MCP resource list change: ${toError(err).message}`);
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
          await this.notifyResourceListChangedIfListingChanged();
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
          await this.notifyResourceListChangedIfListingChanged();
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
    // Flush pending OTLP spans before process exit (issue #879). Bounded so a
    // dead collector cannot hang SIGINT/SIGTERM drain.
    try {
      await shutdownOtel();
    } catch (err) {
      logger.warn(`Error during OpenTelemetry shutdown: ${(err as Error).message}`);
    }
    // Drain the LOG_FILE stream last — everything above may still log (issue
    // #979). Best effort: callers exit immediately after.
    try {
      await closeLogFile();
    } catch {
      // logging teardown is best-effort; never block shutdown on it
    }
  }
}
