// KnowledgeBaseServer.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { FaissIndexManager } from './FaissIndexManager.js';
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
import {
  acquireInstanceAdvisory,
  InstanceAlreadyRunningError,
  releaseInstanceAdvisory,
} from './instance-lock.js';
import { withWriteLock } from './write-lock.js';
import { logger } from './logger.js';
import { SseHost } from './transport/sse.js';
import { ReindexTriggerWatcher } from './triggerWatcher.js';

const SERVER_NAME = 'knowledge-base-server';
const SERVER_VERSION = '0.1.0';

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
  private sseHost?: SseHost;
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
    } catch (error: any) {
      logger.error('Error listing models:', error);
      const content: TextContent = {
        type: 'text',
        text: `Error listing models: ${error.message}`,
      };
      return { content: [content], isError: true };
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
    } catch (error: any) {
      logger.error('Error listing knowledge bases:', error);
      if (error?.stack) {
        logger.error(error.stack);
      }
      const content: TextContent = {
        type: 'text',
        text: `Error listing knowledge bases: ${error.message}`,
      };
      return { content: [content], isError: true };
    }
  }

  private async handleRetrieveKnowledge(args: { query: string; knowledge_base_name?: string; threshold?: number; model_name?: string; }): Promise<CallToolResult> {
    const query: string = args.query;
    const knowledgeBaseName: string | undefined = args.knowledge_base_name;
    const threshold: number | undefined = args.threshold;
    const modelNameOverride: string | undefined = args.model_name;

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
      const similaritySearchResults = await manager.similaritySearch(query, 10, threshold, knowledgeBaseName);
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
    } catch (error: any) {
      logger.error('Error retrieving knowledge:', error);
      if (error?.stack) {
        logger.error(error.stack);
      }
      const content: TextContent = { type: 'text', text: `Error retrieving knowledge: ${error.message}` };
      return { content: [content], isError: true };
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

    // RFC 012 §4.8.1 — claim the single-instance advisory before any
    // index work. Two concurrent MCP servers against the same
    // FAISS_INDEX_PATH would corrupt the index; the PID file makes that
    // impossible (one process wins atomically via O_EXCL).
    try {
      await acquireInstanceAdvisory();
    } catch (err) {
      if (err instanceof InstanceAlreadyRunningError) {
        logger.error(err.message);
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    // RFC 013 §4.8 — bootstrap the layout (one-shot migration from 0.2.x)
    // AFTER acquiring the instance advisory so concurrent migrations are
    // serialized. Round-1 failure F4 + delivery F6.
    try {
      await FaissIndexManager.bootstrapLayout({ hasInstanceAdvisory: true });
    } catch (err) {
      logger.error(`Layout bootstrap failed: ${(err as Error).message}`);
      await releaseInstanceAdvisory();
      process.exitCode = 1;
      return;
    }

    try {
      if (transportConfig.transport === 'stdio') {
        await this.runStdio();
        return;
      }
      await this.runSse(transportConfig);
    } catch (error: any) {
      logger.error('Error during server startup:', error);
      if (error?.stack) {
        logger.error(error.stack);
      }
      // Best-effort release on startup failure so a crashed start doesn't
      // strand the PID file and block the next run for a stale-detection
      // cycle.
      await releaseInstanceAdvisory();
      process.exitCode = 1;
    }
  }

  private async runStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
    logger.info('Knowledge Base MCP server running on stdio');
    // RFC 013: warm up the active model's manager so the first agent call
    // doesn't pay construction cost.
    await this.warmActiveManager();
    this.startTriggerWatcher();
  }

  private async runSse(config: TransportConfig): Promise<void> {
    // Block HTTP bind on a ready index so a fast first client cannot race
    // updateIndex (RFC 008 §6.2: "client races init" footgun under HTTP).
    await this.warmActiveManager();

    const host = new SseHost({
      config,
      createMcpServer: () => this.buildMcpServer(),
    });
    this.sseHost = host;
    this.installHttpShutdown();
    // Start watcher only after the HTTP bind succeeds; a throw from
    // host.start() unwinds without leaving a dangling polling timer.
    await host.start();
    this.startTriggerWatcher();
  }

  /**
   * Warm the manager cache for the active model. Best-effort: a missing
   * active model is logged but doesn't crash the server (the first
   * `handleRetrieveKnowledge` call surfaces the error to the agent via
   * `isError: true` instead of dying at startup).
   */
  private async warmActiveManager(): Promise<void> {
    try {
      const activeId = await resolveActiveModel();
      await this.getManagerFor(activeId);
    } catch (err) {
      if (err instanceof ActiveModelResolutionError) {
        logger.warn(`No active model on startup: ${err.message}`);
        return;
      }
      throw err;
    }
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
    // RFC 012 §4.8.1 — release advisory last so a slow MCP shutdown
    // doesn't cause a fast restart to false-fire "another instance".
    await releaseInstanceAdvisory();
  }
}
