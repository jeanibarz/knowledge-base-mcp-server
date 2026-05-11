// KnowledgeBaseServer.ts
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
import type { IndexUpdateProgress } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  listRegisteredModels,
  modelDir,
  resolveActiveModel,
} from './active-model.js';
import { ManagerRegistry } from './manager-registry.js';
import {
  ADD_DOCUMENT_DESCRIPTION,
  DELETE_DOCUMENT_DESCRIPTION,
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
  KB_FS_WATCH,
  KB_FS_WATCH_DEBOUNCE_MS,
  KB_STATS_DESCRIPTION,
  KNOWLEDGE_BASES_ROOT_DIR,
  LIST_KNOWLEDGE_BASES_DESCRIPTION,
  LIST_MODELS_DESCRIPTION,
  REINDEX_KNOWLEDGE_BASE_DESCRIPTION,
  REINDEX_TRIGGER_PATH,
  REINDEX_TRIGGER_POLL_MS,
  RETRIEVE_KNOWLEDGE_DESCRIPTION,
} from './config.js';
import {
  loadTransportConfig,
  TransportConfigError,
  type TransportConfig,
} from './transport-config.js';
import { formatRetrievalAsMarkdown } from './formatter.js';
import {
  listKnowledgeBases,
  resolveKbPath,
  resolveKnowledgeBaseDir,
} from './kb-fs.js';
import { computeKbStats } from './kb-stats.js';
import {
  listResources,
  readResource,
  registerResources,
} from './mcp-resources.js';
import { withWriteLock } from './write-lock.js';
import { logger } from './logger.js';
import { toError } from './error-utils.js';
import { auditEnabled, recordMutation, sha256OfFileOrNull } from './audit-log.js';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { StreamableHttpHost } from './transport/http.js';
import { SseHost } from './transport/sse.js';
import { ReindexTriggerWatcher } from './triggerWatcher.js';
import { RecursiveKbWatcher } from './recursive-fs-watch.js';
import { KBError, type KBErrorCode } from './errors.js';
import { LexicalIndex, type LexicalSearchResult } from './lexical-index.js';
import { chunkIdFromMetadata, reciprocalRankFusion, type RankedList } from './rrf.js';

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

interface AddDocumentSnapshot {
  existed: boolean;
  content?: Buffer;
  mode?: number;
}

interface RollbackStatus {
  attempted: true;
  succeeded: boolean;
  message: string;
}

class AddDocumentRollbackError extends Error {
  readonly originalError: Error;
  readonly rollback: RollbackStatus;

  constructor(originalError: Error, rollback: RollbackStatus) {
    super(`indexing failed after writing document: ${originalError.message}`, {
      cause: originalError,
    });
    this.name = 'AddDocumentRollbackError';
    this.originalError = originalError;
    this.rollback = rollback;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function addDocumentRollbackErrorContent(error: AddDocumentRollbackError): TextContent {
  const code: KBErrorCode = error.originalError instanceof KBError
    ? error.originalError.code
    : 'INTERNAL';
  return {
    type: 'text',
    text: JSON.stringify({
      error: {
        code,
        message: error.message,
        rollback: error.rollback,
      },
    }),
  };
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function snapshotDocumentForRollback(documentPath: string): Promise<AddDocumentSnapshot> {
  try {
    const [stat, content] = await Promise.all([
      fsp.stat(documentPath),
      fsp.readFile(documentPath),
    ]);
    return {
      existed: true,
      content,
      mode: stat.mode,
    };
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return { existed: false };
    }
    throw error;
  }
}

async function collectExistingAncestorDirs(parentDir: string, stopDir: string): Promise<Set<string>> {
  const existing = new Set<string>();
  let current = parentDir;
  while (current.startsWith(stopDir) && current !== path.dirname(current)) {
    try {
      const stat = await fsp.stat(current);
      if (stat.isDirectory()) {
        existing.add(current);
      }
    } catch (error: unknown) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    if (current === stopDir) {
      break;
    }
    current = path.dirname(current);
  }
  return existing;
}

async function pruneDirsCreatedForDocument(
  parentDir: string,
  stopDir: string,
  existingDirs: Set<string>,
): Promise<void> {
  let current = parentDir;
  while (current !== stopDir && current.startsWith(stopDir)) {
    if (existingDirs.has(current)) {
      break;
    }
    try {
      await fsp.rmdir(current);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        // Already gone is equivalent to a successful cleanup for this path.
      } else if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        break;
      } else {
        throw error;
      }
    }
    current = path.dirname(current);
  }
}

async function rollbackAddDocumentWrite(options: {
  documentPath: string;
  kbDir: string;
  snapshot: AddDocumentSnapshot;
  existingDirs: Set<string>;
}): Promise<RollbackStatus> {
  const { documentPath, kbDir, snapshot, existingDirs } = options;
  try {
    if (snapshot.existed) {
      await fsp.writeFile(documentPath, snapshot.content ?? Buffer.alloc(0));
      if (snapshot.mode !== undefined) {
        await fsp.chmod(documentPath, snapshot.mode);
      }
      return {
        attempted: true,
        succeeded: true,
        message: 'restored previous document content',
      };
    }

    await fsp.unlink(documentPath);
    await pruneDirsCreatedForDocument(path.dirname(documentPath), kbDir, existingDirs);
    return {
      attempted: true,
      succeeded: true,
      message: 'removed newly written document',
    };
  } catch (error: unknown) {
    const err = toError(error);
    return {
      attempted: true,
      succeeded: false,
      message: err.message,
    };
  }
}

async function restoreIndexAfterAddDocumentRollback(
  manager: FaissIndexManager,
  rollback: RollbackStatus,
): Promise<RollbackStatus> {
  if (!rollback.succeeded) {
    return rollback;
  }

  const summary = manager.getLastIndexUpdateSummary();
  if (!summary.index_mutated) {
    return rollback;
  }

  try {
    if (summary.saved) {
      await manager.updateIndex(undefined, { force: true });
      return {
        ...rollback,
        message: `${rollback.message}; rebuilt FAISS index from rolled-back files`,
      };
    }

    await manager.reloadPersistedIndex();
    return {
      ...rollback,
      message: `${rollback.message}; reloaded previous FAISS index state`,
    };
  } catch (error: unknown) {
    const err = toError(error);
    return {
      attempted: true,
      succeeded: false,
      message: `${rollback.message}; FAISS index restore failed: ${err.message}`,
    };
  }
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
        // #206 stage 2 — sparse+dense hybrid retrieval. Default 'dense' is
        // wire-compatible with 0.x clients: when the field is absent the
        // server runs the unmodified dense path. 'hybrid' fuses dense FAISS
        // top-N with per-KB BM25 top-N via Reciprocal Rank Fusion (c=60,
        // Cormack 2009); see RFC 006 §4 + #206 + ADR 0006.
        search_mode: z.enum(['dense', 'hybrid']).optional().describe('Retrieval mode. "dense" (default) uses FAISS only. "hybrid" fuses FAISS top-N with per-KB BM25 top-N via Reciprocal Rank Fusion. See #206.'),
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

  /**
   * Issue #54 — kb_stats MCP handler. Thin transport wrapper: resolves the
   * active model, delegates to `computeKbStats` (#157), wraps the payload
   * as a `CallToolResult`. Read-only — does NOT acquire the write lock and
   * does NOT trigger an updateIndex.
   */
  private async handleKbStats(args: {
    knowledge_base_name?: string;
  }): Promise<CallToolResult> {
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
  }

  private async getActiveManagerForMutation(): Promise<FaissIndexManager> {
    const activeModelId = await resolveActiveModel();
    return this.managers.getOrCreate(activeModelId);
  }

  private async handleAddDocument(args: {
    knowledge_base_name: string;
    path: string;
    content: string;
  }): Promise<CallToolResult> {
    const auditing = auditEnabled();
    let documentPath = '';
    let beforeHash: string | null = null;
    let writePerformed = false;
    let indexingFailed = false;

    const auditOnExit = async (error?: Error): Promise<void> => {
      if (!auditing) return;
      const afterHash = documentPath !== ''
        ? await sha256OfFileOrNull(documentPath)
        : null;
      await recordMutation({
        surface: 'mcp.add_document',
        operation: 'add',
        kb: args.knowledge_base_name,
        relative_path: args.path,
        before_sha256: beforeHash,
        after_sha256: afterHash,
        write_performed: writePerformed,
        refresh_requested: true,
        refresh_status: writePerformed ? 'ok' : (indexingFailed ? 'failed' : null),
        decision_flags: { content_bytes: Buffer.byteLength(args.content, 'utf-8') },
        error: error?.message,
      });
    };

    try {
      const manager = await this.getActiveManagerForMutation();
      await withWriteLock(manager.modelDir, async () => {
        documentPath = await resolveKbPath(
          KNOWLEDGE_BASES_ROOT_DIR,
          args.knowledge_base_name,
          args.path,
          { mustExist: false },
        );
        if (auditing) {
          beforeHash = await sha256OfFileOrNull(documentPath);
        }
        const kbDir = await resolveKnowledgeBaseDir(
          KNOWLEDGE_BASES_ROOT_DIR,
          args.knowledge_base_name,
        );
        const existingDirs = await collectExistingAncestorDirs(path.dirname(documentPath), kbDir);
        const snapshot = await snapshotDocumentForRollback(documentPath);
        await fsp.mkdir(path.dirname(documentPath), { recursive: true });
        await fsp.writeFile(documentPath, args.content, 'utf-8');
        try {
          await manager.updateIndex(args.knowledge_base_name);
        } catch (error: unknown) {
          indexingFailed = true;
          const originalError = toError(error);
          const fileRollback = await rollbackAddDocumentWrite({
            documentPath,
            kbDir,
            snapshot,
            existingDirs,
          });
          const rollback = await restoreIndexAfterAddDocumentRollback(manager, fileRollback);
          throw new AddDocumentRollbackError(originalError, rollback);
        }
        writePerformed = true;
      });

      await auditOnExit();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            knowledge_base_name: args.knowledge_base_name,
            path: args.path,
            absolute_path: documentPath,
            indexed: true,
          }, null, 2),
        }],
      };
    } catch (error: unknown) {
      if (error instanceof ActiveModelResolutionError) {
        await auditOnExit(error);
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
      if (error instanceof AddDocumentRollbackError) {
        logger.error('Error adding document:', error);
        if (error.stack) {
          logger.error(error.stack);
        }
        await auditOnExit(error);
        return { content: [addDocumentRollbackErrorContent(error)], isError: true };
      }
      const err = toError(error);
      logger.error('Error adding document:', err);
      if (err.stack) {
        logger.error(err.stack);
      }
      await auditOnExit(err);
      return { content: [mcpErrorContent(err)], isError: true };
    }
  }

  private async handleDeleteDocument(args: {
    knowledge_base_name: string;
    path: string;
  }): Promise<CallToolResult> {
    const auditing = auditEnabled();
    let documentPath = '';
    let sidecarPath = '';
    let beforeHash: string | null = null;
    let writePerformed = false;

    const auditOnExit = async (error?: Error): Promise<void> => {
      if (!auditing) return;
      const afterHash = documentPath !== ''
        ? await sha256OfFileOrNull(documentPath)
        : null;
      await recordMutation({
        surface: 'mcp.delete_document',
        operation: 'delete',
        kb: args.knowledge_base_name,
        relative_path: args.path,
        before_sha256: beforeHash,
        after_sha256: afterHash,
        write_performed: writePerformed,
        refresh_requested: false,
        refresh_status: null,
        decision_flags: { sidecar_path: sidecarPath },
        error: error?.message,
      });
    };

    try {
      const manager = await this.getActiveManagerForMutation();
      await withWriteLock(manager.modelDir, async () => {
        const kbDir = await resolveKnowledgeBaseDir(
          KNOWLEDGE_BASES_ROOT_DIR,
          args.knowledge_base_name,
        );
        documentPath = await resolveKbPath(
          KNOWLEDGE_BASES_ROOT_DIR,
          args.knowledge_base_name,
          args.path,
          { mustExist: false },
        );
        if (auditing) {
          beforeHash = await sha256OfFileOrNull(documentPath);
        }
        const relativePath = path.relative(kbDir, documentPath);
        sidecarPath = path.join(
          kbDir,
          '.index',
          path.dirname(relativePath),
          path.basename(relativePath),
        );
        await fsp.rm(documentPath);
        await fsp.rm(sidecarPath, { force: true });
        writePerformed = true;
      });

      await auditOnExit();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            knowledge_base_name: args.knowledge_base_name,
            path: args.path,
            absolute_path: documentPath,
            sidecar_path: sidecarPath,
            deleted: true,
            faiss_orphan_vectors: 'Orphan vectors may persist until a full reindex_knowledge_base rebuild.',
          }, null, 2),
        }],
      };
    } catch (error: unknown) {
      if (error instanceof ActiveModelResolutionError) {
        await auditOnExit(error);
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
      const err = toError(error);
      logger.error('Error deleting document:', err);
      if (err.stack) {
        logger.error(err.stack);
      }
      await auditOnExit(err);
      return { content: [mcpErrorContent(err)], isError: true };
    }
  }

  private async handleReindexKnowledgeBase(args: {
    knowledge_base_name?: string;
  }): Promise<CallToolResult> {
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
  }

  private async handleRetrieveKnowledge(args: {
    query: string;
    knowledge_base_name?: string;
    threshold?: number;
    model_name?: string;
    extensions?: string[];
    path_glob?: string;
    tags?: string[];
    search_mode?: 'dense' | 'hybrid';
  }): Promise<CallToolResult> {
    const query: string = args.query;
    const knowledgeBaseName: string | undefined = args.knowledge_base_name;
    const threshold: number | undefined = args.threshold;
    const modelNameOverride: string | undefined = args.model_name;
    const filters = (args.extensions || args.path_glob || args.tags)
      ? { extensions: args.extensions, pathGlob: args.path_glob, tags: args.tags }
      : undefined;
    const searchMode: 'dense' | 'hybrid' = args.search_mode ?? 'dense';

    if (searchMode === 'hybrid') {
      return this.handleRetrieveKnowledgeHybrid({
        query,
        knowledgeBaseName,
        modelNameOverride,
        filters,
      });
    }

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
      const manager = await this.managers.getOrCreate(activeModelId);

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
  }): Promise<CallToolResult> {
    const { query, knowledgeBaseName, modelNameOverride, filters } = input;
    const HYBRID_FETCH_K = 40;
    const HYBRID_TOP_K = 10;
    const HYBRID_RRF_C = 60;

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
      const manager = await this.managers.getOrCreate(activeModelId);
      await withWriteLock(manager.modelDir, () => manager.updateIndex(knowledgeBaseName));

      // Dense leg — over-fetch to give RRF room.
      const densePromise = manager
        .similaritySearch(query, HYBRID_FETCH_K, Number.POSITIVE_INFINITY, knowledgeBaseName, filters)
        .then((rs) => rs.map((r) => ({ pageContent: r.pageContent, metadata: r.metadata, score: r.score })));

      // Lexical leg — BM25 over the same chunks the FAISS path embeds, but
      // managed independently (the lexical index is model-agnostic and lives
      // under `${FAISS_INDEX_PATH}/lexical/<kb>/`). Auto-refresh on first use
      // per KB; explicit refresh is the CLI's job (`kb search --refresh`).
      const lexicalPromise: Promise<LexicalSearchResult[]> = (async () => {
        const all: LexicalSearchResult[] = [];
        const kbNames = knowledgeBaseName
          ? [knowledgeBaseName]
          : await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
        for (const kbName of kbNames) {
          const kbPath = path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName);
          try {
            const idx = await LexicalIndex.load(kbName, kbPath);
            if (idx.numFiles() === 0) {
              await idx.refresh();
              await idx.save();
            }
            const hits = await idx.query(query, HYBRID_FETCH_K);
            for (const h of hits) all.push(h);
          } catch (err) {
            // Per-KB lexical failure is non-fatal; the dense leg still runs.
            logger.warn(`hybrid: lexical leg failed for KB "${kbName}": ${(err as Error).message}`);
          }
        }
        all.sort((a, b) => b.score - a.score);
        return all.slice(0, HYBRID_FETCH_K);
      })();

      const [denseResults, lexicalResults] = await Promise.all([densePromise, lexicalPromise]);

      const denseList: RankedList = {
        retriever: 'dense',
        results: denseResults.map((r, i) => ({ id: chunkIdFromMetadata(r.metadata), rank: i + 1 })),
      };
      const lexicalList: RankedList = {
        retriever: 'lexical',
        results: lexicalResults.map((r, i) => ({ id: chunkIdFromMetadata(r.metadata), rank: i + 1 })),
      };
      const fused = reciprocalRankFusion([denseList, lexicalList], { c: HYBRID_RRF_C });

      const byId = new Map<string, { pageContent: string; metadata: Record<string, unknown>; score: number }>();
      for (const r of lexicalResults) byId.set(chunkIdFromMetadata(r.metadata), { pageContent: r.pageContent, metadata: r.metadata, score: r.score });
      for (const r of denseResults) byId.set(chunkIdFromMetadata(r.metadata), { pageContent: r.pageContent, metadata: r.metadata, score: r.score });

      const ranked = fused.slice(0, HYBRID_TOP_K).map((f) => {
        const chunk = byId.get(f.id);
        return chunk ? { ...chunk, score: f.fusedScore } : null;
      }).filter((x): x is { pageContent: string; metadata: Record<string, unknown>; score: number } => x !== null);

      let responseText = formatRetrievalAsMarkdown(ranked as never, FRONTMATTER_EXTRAS_WIRE_VISIBLE);
      const header = `> _Mode: hybrid (RRF c=${HYBRID_RRF_C}); dense fetched ${denseResults.length}, lexical fetched ${lexicalResults.length} (#206 stage 2)._`;
      responseText = modelNameOverride !== undefined
        ? `> _Model: ${activeModelId}_\n${header}\n\n${responseText}`
        : `${header}\n\n${responseText}`;

      const content: TextContent = { type: 'text', text: responseText };
      return { content: [content] };
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
