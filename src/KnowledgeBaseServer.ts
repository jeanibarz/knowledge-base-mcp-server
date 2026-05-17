// KnowledgeBaseServer.ts
import * as fsp from 'fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  type CallToolResult,
  type ListResourcesResult,
  type ReadResourceResult,
  type TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import type {
  IndexUpdateProgress,
  NeighborContextOptions,
  SimilaritySearchTiming,
} from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  listRegisteredModels,
  modelDir,
  resolveActiveModel,
  resolveFaissIndexBinaryPath,
} from './active-model.js';
import { ManagerRegistry } from './manager-registry.js';
import {
  ADD_DOCUMENT_DESCRIPTION,
  DELETE_DOCUMENT_DESCRIPTION,
  KB_STATS_DESCRIPTION,
  LIST_KNOWLEDGE_BASES_DESCRIPTION,
  LIST_MODELS_DESCRIPTION,
  REINDEX_KNOWLEDGE_BASE_DESCRIPTION,
  RETRIEVE_KNOWLEDGE_DESCRIPTION,
} from './config/mcp-descriptions.js';
import {
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
} from './config/retrieval.js';
import {
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
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
import {
  loadTransportConfig,
  TransportConfigError,
  type TransportConfig,
} from './transport-config.js';
import { formatRetrievalAsMarkdown } from './formatter.js';
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
  emitCanonicalLog,
  type CanonicalLogInput,
} from './canonical-log.js';
import {
  applyRelevanceGate,
  emitRelevanceGateDecision,
  formatGateVerdictFooter,
  type RelevanceGateOverride,
} from './relevance-gate.js';
import type { RelevanceGateVerdict } from './relevance-gate-schema.js';
import { chunkIdFromMetadata } from './rrf.js';

const SERVER_NAME = 'knowledge-base-server';
const SERVER_VERSION = '0.1.0';

function mcpErrorContent(error: Error): TextContent {
  const code: KBErrorCode = error instanceof KBError ? error.code : 'INTERNAL';
  return {
    type: 'text',
    text: JSON.stringify({
      error: {
        code,
        message: error.message,
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
    return mcp;
  }

  private registerTools(mcp: McpServer) {
    mcp.tool(
      'list_knowledge_bases',
      LIST_KNOWLEDGE_BASES_DESCRIPTION,
      async () => this.handleListKnowledgeBases()
    );

    mcp.tool(
      'retrieve_knowledge',
      RETRIEVE_KNOWLEDGE_DESCRIPTION,
      {
        query: z.string().describe('The search query to use for retrieving similar chunks from the knowledge base.'),
        knowledge_base_name: z.string().optional().describe('The name of the knowledge base to search. If omitted, all available knowledge bases are considered.'),
        threshold: z.number().optional().describe('The maximum similarity score threshold for returned documents. Defaults to 2 if not specified.'),
        // RFC 013 M3 §4.5 — optional override of the active embedding model.
        // When omitted, the server uses the model recorded in active.txt.
        // When passed, must be a registered model_id (see list_models).
        model_name: z.string().optional().describe('The model_id of an alternate embedding model to query (e.g. "openai__text-embedding-3-small"). If omitted, the active model is used. Run list_models for available ids.'),
        // Issue #53 — metadata POST-filters. Applied after FAISS returns,
        // ANDed with each other and with knowledge_base_name + threshold.
        extensions: z.array(z.string()).optional().describe('Limit results to chunks whose source file has one of these extensions (e.g. [".md", ".pdf"]). Case-insensitive; leading dot optional.'),
        path_glob: z.string().optional().describe('Limit results to chunks whose KB-internal relative path matches this glob (e.g. "runbooks/**"). The KB-name segment is stripped before matching.'),
        tags: z.array(z.string()).optional().describe('Limit results to chunks whose source file has ALL of these tags in its YAML frontmatter.'),
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
      },
      async (args) => this.handleRetrieveKnowledge(args)
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
    mcp.tool(
      'kb_stats',
      KB_STATS_DESCRIPTION,
      {
        knowledge_base_name: z
          .string()
          .optional()
          .describe('Name of a single KB to scope to. If omitted, every registered KB is reported.'),
      },
      async (args) => this.handleKbStats(args)
    );

    mcp.tool(
      'add_document',
      ADD_DOCUMENT_DESCRIPTION,
      {
        knowledge_base_name: z.string().describe('The name of the knowledge base to write into.'),
        path: z.string().describe('KB-relative document path to create or overwrite. Parent directories are created as needed.'),
        content: z.string().describe('UTF-8 text content to write.'),
      },
      async (args) => this.handleAddDocument(args)
    );

    mcp.tool(
      'delete_document',
      DELETE_DOCUMENT_DESCRIPTION,
      {
        knowledge_base_name: z.string().describe('The name of the knowledge base to delete from.'),
        path: z.string().describe('KB-relative document path to delete.'),
      },
      async (args) => this.handleDeleteDocument(args)
    );

    mcp.tool(
      'reindex_knowledge_base',
      REINDEX_KNOWLEDGE_BASE_DESCRIPTION,
      {
        knowledge_base_name: z
          .string()
          .optional()
          .describe('Name of a single KB to force re-index. If omitted, every registered KB is re-indexed.'),
      },
      async (args) => this.handleReindexKnowledgeBase(args)
    );
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
  private async handleListResources(): Promise<ListResourcesResult> {
    return listResources();
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
    context_before?: number;
    context_after?: number;
    context_window?: number;
    search_mode?: 'dense' | 'hybrid';
    task_context?: string;
    gate?: 'on' | 'off';
  }): Promise<CallToolResult> {
    const canonical: Partial<CanonicalLogInput> = {};
    const query: string = args.query;
    const knowledgeBaseName: string | undefined = args.knowledge_base_name;
    const threshold: number | undefined = args.threshold;
    const modelNameOverride: string | undefined = args.model_name;
    const filters = (args.extensions || args.path_glob || args.tags)
      ? { extensions: args.extensions, pathGlob: args.path_glob, tags: args.tags }
      : undefined;
    const searchMode: 'dense' | 'hybrid' = args.search_mode ?? 'dense';
    const taskContext = args.task_context;
    const gateOverride: RelevanceGateOverride = args.gate;
    const neighborContext = resolveNeighborContextOptions(args);

    return this.withCanonicalTool({
      tool: 'retrieve_knowledge',
      query,
      kb_scope: knowledgeBaseName ?? null,
      k: 10,
      threshold: threshold ?? 2,
      search_mode: searchMode,
    }, async () => {
      if (searchMode === 'hybrid') {
        if (hasNeighborContext(neighborContext)) {
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
      let similaritySearchResults = await manager.similaritySearch(
        query,
        10,
        threshold,
        knowledgeBaseName,
        filters,
        timing,
      );
      if (neighborContext) {
        similaritySearchResults = manager.expandWithNeighborContext(
          similaritySearchResults,
          neighborContext,
        );
      }
      const denseDistanceById = new Map<string, number>();
      for (const result of similaritySearchResults) {
        denseDistanceById.set(chunkIdFromMetadata(result.metadata as Record<string, unknown>), result.score);
      }
      const gate = await applyRelevanceGate({
        query,
        taskContext,
        candidates: similaritySearchResults,
        denseDistanceById,
        gateOverride,
        process: 'mcp',
      });
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
      if (process.env.KB_LOG_VERBOSE === '1') {
        logger.debug(`[${Date.now()}] Similarity search completed`);
      }
      canonical.result_count = similaritySearchResults.length;
      canonical.top_score = similaritySearchResults[0]?.score;
      canonical.top_sources = topSourcesForCanonicalLog(similaritySearchResults);
      canonical.embed_ms = timing.embed_query_ms;
      canonical.faiss_ms = timing.faiss_search_ms ?? timing.query_search_ms;

      // Build a nicely formatted markdown response including the similarity score.
      const formatStartedAt = Date.now();
      let responseText = formatRetrievalAsMarkdown(
        similaritySearchResults,
        FRONTMATTER_EXTRAS_WIRE_VISIBLE,
      );
      if (gate.verdict.state !== 'bypassed') {
        responseText = `${responseText}\n\n${formatGateVerdictFooter(gate.verdict)}`;
      }
      canonical.format_ms = Date.now() - formatStartedAt;

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
      return withGateVerdict({ content: [content] }, gate.verdict);
    } catch (error: unknown) {
      const err = toError(error);
      logger.error('Error retrieving knowledge:', err);
      if (err.stack) {
        logger.error(err.stack);
      }
      return { content: [mcpErrorContent(err)], isError: true };
    }
    }, () => canonical);
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
    filters?: { extensions?: string[]; pathGlob?: string; tags?: string[] };
    canonical?: Partial<CanonicalLogInput>;
    taskContext?: string;
    gateOverride?: RelevanceGateOverride;
  }): Promise<CallToolResult> {
    const { query, knowledgeBaseName, modelNameOverride, filters, canonical, taskContext, gateOverride } = input;
    const HYBRID_TOP_K = 10;
    const fetchK = hybridFetchK(HYBRID_TOP_K);

    try {
      let activeModelId: string;
      try {
        activeModelId = await resolveActiveModel({ explicitOverride: modelNameOverride });
      } catch (err) {
        if (err instanceof ActiveModelResolutionError) {
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        throw err;
      }
      if (canonical) canonical.model_id = activeModelId;
      const manager = await this.managers.getOrCreate(activeModelId);
      await withWriteLock(manager.modelDir, () => manager.updateIndex(knowledgeBaseName));

      // Dense leg — over-fetch to give RRF room.
      const denseTiming: SimilaritySearchTiming = {};
      const densePromise = manager
        .similaritySearch(query, fetchK, Number.POSITIVE_INFINITY, knowledgeBaseName, filters, denseTiming)
        .then((rs) => rs.map((r) => ({ pageContent: r.pageContent, metadata: r.metadata, score: r.score })));

      // Lexical leg — BM25 over the same chunks the FAISS path embeds, but
      // managed independently (the lexical index is model-agnostic and lives
      // under `${FAISS_INDEX_PATH}/lexical/<kb>/`). Auto-refresh on first use
      // per KB; explicit refresh is the CLI's job (`kb search --refresh`).
      const kbNames = knowledgeBaseName
        ? [knowledgeBaseName]
        : await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
      const kbs = kbNames.map((kbName) => ({ kbName, kbPath: path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName) }));
      const lexicalPromise = runLexicalLeg({
        kbs,
        query,
        fetchK,
        refresh: 'when-empty',
        onError: (kbName, err) => {
          logger.warn(`hybrid: lexical leg failed for KB "${kbName}": ${err.message}`);
        },
      }).then((res) => res.hits);

      const [denseResults, lexicalResults] = await Promise.all([densePromise, lexicalPromise]);
      if (canonical) {
        canonical.embed_ms = denseTiming.embed_query_ms;
        canonical.faiss_ms = denseTiming.faiss_search_ms ?? denseTiming.query_search_ms;
      }

      const fusion = fuseHybridResultsWithDiagnostics({
        denseResults,
        lexicalResults,
        k: HYBRID_TOP_K,
      });
      let ranked = fusion.results;
      const gate = await applyRelevanceGate({
        query,
        taskContext,
        candidates: ranked,
        denseDistanceById: fusion.denseDistanceById,
        lexicalHitIds: fusion.lexicalHitIds,
        gateOverride,
        process: 'mcp',
      });
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

      const formatStartedAt = Date.now();
      let responseText = formatRetrievalAsMarkdown(ranked as never, FRONTMATTER_EXTRAS_WIRE_VISIBLE);
      if (gate.verdict.state !== 'bypassed') {
        responseText = `${responseText}\n\n${formatGateVerdictFooter(gate.verdict)}`;
      }
      if (canonical) {
        canonical.result_count = ranked.length;
        canonical.top_score = ranked[0]?.score;
        canonical.top_sources = topSourcesForCanonicalLog(ranked);
        canonical.format_ms = Date.now() - formatStartedAt;
      }
      const header = `> _Mode: hybrid (RRF c=${HYBRID_RRF_C}); dense fetched ${denseResults.length}, lexical fetched ${lexicalResults.length} (#206 stage 2)._`;
      responseText = modelNameOverride !== undefined
        ? `> _Model: ${activeModelId}_\n${header}\n\n${responseText}`
        : `${header}\n\n${responseText}`;

      const content: TextContent = { type: 'text', text: responseText };
      return withGateVerdict({ content: [content] }, gate.verdict);
    } catch (error: unknown) {
      const err = toError(error);
      logger.error('Error retrieving knowledge (hybrid):', err);
      if (err.stack) logger.error(err.stack);
      return { content: [mcpErrorContent(err)], isError: true };
    }
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
    });
    this.httpHost = host;
    this.installHttpShutdown();
    await host.start();
    this.transportMode = 'http';
    this.startActiveManagerWarmup();
    this.startTriggerWatcher();
    await this.startFsWatcher();
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
