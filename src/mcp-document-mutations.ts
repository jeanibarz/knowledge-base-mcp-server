import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { ActiveModelResolutionError } from './active-model.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import type { FaissIndexManager } from './FaissIndexManager.js';
import { auditEnabled, recordMutation, sha256OfFileOrNull } from './audit-log.js';
import { toError } from './error-utils.js';
import { KBError, type KBErrorCode } from './errors.js';
import { resolveKbPath, resolveKnowledgeBaseDir } from './kb-fs.js';
import { assertKbWritePolicyAllowsMutation } from './kb-write-policy.js';
import { logger } from './logger.js';
import { withWriteLock } from './write-lock.js';
import type { CanonicalLogInput } from './canonical-log.js';

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

export interface DocumentMutationHandlerContext {
  getActiveManagerForMutation(): Promise<FaissIndexManager>;
  withCanonicalTool<T extends CallToolResult>(
    base: Omit<CanonicalLogInput, 'process' | 'took_ms'>,
    operation: () => Promise<T>,
    enrich?: (result: T) => Partial<CanonicalLogInput>,
  ): Promise<T>;
  knowledgeBasesRootDir?: string;
}

export interface AddDocumentArgs {
  knowledge_base_name: string;
  path: string;
  content: string;
}

export interface DeleteDocumentArgs {
  knowledge_base_name: string;
  path: string;
}

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

export async function handleAddDocument(
  args: AddDocumentArgs,
  context: DocumentMutationHandlerContext,
): Promise<CallToolResult> {
  return context.withCanonicalTool({
    tool: 'add_document',
    kb_scope: args.knowledge_base_name,
  }, async () => {
    const knowledgeBasesRootDir = context.knowledgeBasesRootDir ?? KNOWLEDGE_BASES_ROOT_DIR;
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
      const manager = await context.getActiveManagerForMutation();
      await withWriteLock(manager.modelDir, async () => {
        documentPath = await resolveKbPath(
          knowledgeBasesRootDir,
          args.knowledge_base_name,
          args.path,
          { mustExist: false },
        );
        if (auditing) {
          beforeHash = await sha256OfFileOrNull(documentPath);
        }
        const kbDir = await resolveKnowledgeBaseDir(
          knowledgeBasesRootDir,
          args.knowledge_base_name,
        );
        await assertKbWritePolicyAllowsMutation(kbDir, documentPath);
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
  });
}

export async function handleDeleteDocument(
  args: DeleteDocumentArgs,
  context: DocumentMutationHandlerContext,
): Promise<CallToolResult> {
  return context.withCanonicalTool({
    tool: 'delete_document',
    kb_scope: args.knowledge_base_name,
  }, async () => {
    const knowledgeBasesRootDir = context.knowledgeBasesRootDir ?? KNOWLEDGE_BASES_ROOT_DIR;
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
      const manager = await context.getActiveManagerForMutation();
      await withWriteLock(manager.modelDir, async () => {
        const kbDir = await resolveKnowledgeBaseDir(
          knowledgeBasesRootDir,
          args.knowledge_base_name,
        );
        documentPath = await resolveKbPath(
          knowledgeBasesRootDir,
          args.knowledge_base_name,
          args.path,
          { mustExist: false },
        );
        if (auditing) {
          beforeHash = await sha256OfFileOrNull(documentPath);
        }
        await assertKbWritePolicyAllowsMutation(kbDir, documentPath);
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
  });
}
