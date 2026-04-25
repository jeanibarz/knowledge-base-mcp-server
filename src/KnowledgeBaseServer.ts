// KnowledgeBaseServer.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import {
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  KNOWLEDGE_BASES_ROOT_DIR,
  LIST_KNOWLEDGE_BASES_DESCRIPTION,
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
  withWriteLock,
} from './lock.js';
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
  private faissManager: FaissIndexManager;
  private sseHost?: SseHost;
  private triggerWatcher?: ReindexTriggerWatcher;
  private shutdownInstalled = false;

  constructor() {
    this.faissManager = new FaissIndexManager();
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
      },
      async (args) => this.handleRetrieveKnowledge(args)
    );
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

  private async handleRetrieveKnowledge(args: { query: string; knowledge_base_name?: string; threshold?: number; }): Promise<CallToolResult> {
    const query: string = args.query;
    const knowledgeBaseName: string | undefined = args.knowledge_base_name;
    const threshold: number | undefined = args.threshold;

    try {
      const startTime = Date.now();
      logger.debug(`[${startTime}] handleRetrieveKnowledge started`);

      // RFC 012 §4.8.2 — wrap the write-path updateIndex in the short-lived
      // write lock. The MCP server, the trigger watcher, and `kb search
      // --refresh` all serialize through this single primitive.
      await withWriteLock(() => this.faissManager.updateIndex(knowledgeBaseName));
      logger.debug(`[${Date.now()}] FAISS index update completed`);

      // Perform similarity search using the provided query.
      const similaritySearchResults = await this.faissManager.similaritySearch(query, 10, threshold, knowledgeBaseName);
      logger.debug(`[${Date.now()}] Similarity search completed`);

      // Build a nicely formatted markdown response including the similarity score.
      const responseText = formatRetrievalAsMarkdown(
        similaritySearchResults,
        FRONTMATTER_EXTRAS_WIRE_VISIBLE,
      );

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
    await this.faissManager.initialize();
    this.startTriggerWatcher();
  }

  private async runSse(config: TransportConfig): Promise<void> {
    // Block HTTP bind on a ready index so a fast first client cannot race
    // updateIndex (RFC 008 §6.2: "client races init" footgun under HTTP).
    await this.faissManager.initialize();

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

  private startTriggerWatcher(): void {
    if (this.triggerWatcher) return;
    if (REINDEX_TRIGGER_POLL_MS <= 0) {
      logger.info('Reindex trigger watcher disabled (REINDEX_TRIGGER_POLL_MS=0)');
      return;
    }
    this.triggerWatcher = new ReindexTriggerWatcher(
      REINDEX_TRIGGER_PATH,
      // RFC 012 §4.8.2 — trigger-driven updateIndex also serializes through
      // the write lock so a CLI `--refresh` doesn't race a watcher cycle.
      () => withWriteLock(() => this.faissManager.updateIndex(undefined)),
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
