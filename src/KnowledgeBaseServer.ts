// KnowledgeBaseServer.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import type { IndexUpdateProgress } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  listRegisteredModels,
  modelDir,
  parseModelId,
  readStoredModelName,
  resolveActiveModel,
} from './active-model.js';
import type { EmbeddingProvider } from './model-id.js';
import {
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  KNOWLEDGE_BASES_ROOT_DIR,
  LIST_KNOWLEDGE_BASES_DESCRIPTION,
  LIST_MODELS_DESCRIPTION,
  loadTransportConfig,
  REINDEX_TRIGGER_PATH,
  REINDEX_TRIGGER_POLL_MS,
  RETRIEVE_KNOWLEDGE_DESCRIPTION,
  TransportConfigError,
  type TransportConfig,
} from './config.js';
import { formatRetrievalAsMarkdown, sanitizeMetadataForWire } from './formatter.js';
import { listKnowledgeBases } from './kb-fs.js';
import { withWriteLock } from './write-lock.js';
import { logger } from './logger.js';
import { toError } from './utils.js';
import { SseHost } from './transport/sse.js';
import { ReindexTriggerWatcher } from './triggerWatcher.js';
import { KBError, type KBErrorCode } from './errors.js';

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

// Re-export for backward compatibility: existing tests import
// `sanitizeMetadataForWire` from this module. The canonical home is now
// `src/formatter.ts` (RFC 012 §4.9 boundary fix).
export { sanitizeMetadataForWire };

export class KnowledgeBaseServer {
  private mcp: McpServer;
  // RFC 013 M1: per-model manager cache. Lazily populated on first use of
  // each model_id. The active model is resolved per `handleRetrieveKnowledge`
  // call (allows future M3 `model_name` arg without redesign).
  private managerCache: Map<string, FaissIndexManager> = new Map();
  private managerInitCache: Map<string, Promise<FaissIndexManager>> = new Map();
  private activeWarmupPromise: Promise<void> | null = null;
  private sseHost?: SseHost;
  private transportMode: 'stdio' | 'sse' | null = null;
  private triggerWatcher?: ReindexTriggerWatcher;
  private shutdownInstalled = false;

  constructor() {
    logger.info('Initializing KnowledgeBaseServer');

    this.mcp = this.buildMcpServer();

    process.on('SIGINT', async () => {
      await this.shutdown();
      process.exit(0);
    });
  }

  /**
   * Resolve a model_id to a (cached) FaissIndexManager instance.
   * RFC 013 M1: takes the explicit model_id (resolved by the caller via
   * `resolveActiveModel`); constructs the manager on first use, caches it.
   */
  private async getManagerFor(modelId: string): Promise<FaissIndexManager> {
    const cached = this.managerCache.get(modelId);
    if (cached) return cached;
    const initializing = this.managerInitCache.get(modelId);
    if (initializing) return initializing;
    const initPromise = (async () => {
      const { provider } = parseModelId(modelId);
      const modelName = await readStoredModelName(modelId);
      if (modelName === null) {
        throw new Error(`model_name.txt missing for registered model "${modelId}"`);
      }
      const manager = new FaissIndexManager({
        provider: provider as EmbeddingProvider,
        modelName,
      });
      await manager.initialize();
      this.managerCache.set(modelId, manager);
      return manager;
    })();
    this.managerInitCache.set(modelId, initPromise);
    try {
      return await initPromise;
    } finally {
      this.managerInitCache.delete(modelId);
    }
  }

  private buildMcpServer(): McpServer {
    const mcp = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    mcp.server.onerror = (error) => logger.error('[MCP Error]', error);
    this.registerTools(mcp);
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
  }

  /**
   * RFC 013 M3 §4.5 — list registered embedding models. Returns a JSON array
   * of `{ model_id, provider, model_name, active }` objects. `.adding`
   * sentinels are skipped (round-1 failure F6 — half-built models are not
   * surfaced to the agent).
   */
  private async handleListModels(): Promise<CallToolResult> {
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
  }

  private async handleListKnowledgeBases(): Promise<CallToolResult> {
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
  }

  private async handleRetrieveKnowledge(args: {
    query: string;
    knowledge_base_name?: string;
    threshold?: number;
    model_name?: string;
    extensions?: string[];
    path_glob?: string;
    tags?: string[];
  }): Promise<CallToolResult> {
    const query: string = args.query;
    const knowledgeBaseName: string | undefined = args.knowledge_base_name;
    const threshold: number | undefined = args.threshold;
    const modelNameOverride: string | undefined = args.model_name;
    const filters = (args.extensions || args.path_glob || args.tags)
      ? { extensions: args.extensions, pathGlob: args.path_glob, tags: args.tags }
      : undefined;

    try {
      const startTime = Date.now();
      logger.debug(`[${startTime}] handleRetrieveKnowledge started`);

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
      const manager = await this.getManagerFor(activeModelId);

      // RFC 013 §4.6 — write lock is per-model (resource = `models/<id>/`).
      // A `kb models add B` against another model never blocks retrievals on A.
      await withWriteLock(manager.modelDir, () => manager.updateIndex(knowledgeBaseName));
      logger.debug(`[${Date.now()}] FAISS index update completed`);

      // Perform similarity search using the provided query.
      const similaritySearchResults = await manager.similaritySearch(
        query,
        10,
        threshold,
        knowledgeBaseName,
        filters,
      );
      logger.debug(`[${Date.now()}] Similarity search completed`);

      // Build a nicely formatted markdown response including the similarity score.
      let responseText = formatRetrievalAsMarkdown(
        similaritySearchResults,
        FRONTMATTER_EXTRAS_WIRE_VISIBLE,
      );

      // RFC 013 M3 §4.5 + round-1 minimalist F5 — emit `model_id` on the
      // response envelope (NOT per-chunk) so an agent comparing two models
      // can attribute results when explicit model_name was passed. When
      // model_name was NOT passed, the wire format is byte-equal to 0.2.x
      // (no envelope field, no per-chunk metadata change) for back-compat.
      if (modelNameOverride !== undefined) {
        responseText = `> _Model: ${activeModelId}_\n\n${responseText}`;
      }

      const endTime = Date.now();
      logger.debug(`[${endTime}] handleRetrieveKnowledge completed in ${endTime - startTime}ms`);

      const content: TextContent = { type: 'text', text: responseText };
      return { content: [content] };
    } catch (error: unknown) {
      const err = toError(error);
      logger.error('Error retrieving knowledge:', err);
      if (err.stack) {
        logger.error(err.stack);
      }
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
      await this.runSse(transportConfig);
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
      const manager = await this.getManagerFor(activeId);
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
    // In stdio mode, `this.mcp` is the connected server. In SSE mode, every
    // session has its own connected `McpServer` (built via `createMcpServer`)
    // and `this.mcp` is unconnected — calling `sendLoggingMessage` on it
    // would silently drop the notification. Fan out across the live sessions
    // so each connected client sees the warm-up progress.
    const targets =
      this.transportMode === 'sse'
        ? (this.sseHost?.getConnectedMcpServers() ?? [])
        : [this.mcp];
    if (targets.length === 0) {
      logger.debug(
        `MCP warm-up log skipped (no connected ${this.transportMode ?? 'transport'} clients): ${data}`,
      );
      return;
    }
    await Promise.all(
      targets.map(async (target) => {
        try {
          await target.sendLoggingMessage({ level, logger: SERVER_NAME, data });
        } catch (err) {
          logger.debug(`Unable to emit MCP warm-up log: ${toError(err).message}`);
        }
      }),
    );
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
          const manager = await this.getManagerFor(activeId);
          await withWriteLock(manager.modelDir, () => manager.updateIndex(undefined));
        } catch (err) {
          logger.warn(`Trigger watcher updateIndex failed: ${(err as Error).message}`);
        }
      },
      REINDEX_TRIGGER_POLL_MS,
    );
    this.triggerWatcher.start();
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
    if (this.sseHost) {
      try {
        await this.sseHost.stop();
      } catch (err) {
        logger.warn(`Error during SSE host shutdown: ${(err as Error).message}`);
      }
      this.sseHost = undefined;
    }
    try {
      await this.mcp.close();
    } catch (err) {
      logger.warn(`Error closing root mcp: ${(err as Error).message}`);
    }
  }
}
