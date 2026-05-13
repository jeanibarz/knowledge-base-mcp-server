import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { FaissIndexManager } from './FaissIndexManager.js';
import {
  handleAddDocument,
  handleDeleteDocument,
  type DocumentMutationHandlerContext,
} from './mcp-document-mutations.js';

describe('mcp-document-mutations', () => {
  beforeEach(() => {
    delete process.env.KB_MUTATION_AUDIT_LOG;
    process.env.KB_LOG_FORMAT = 'text';
  });

  function createManager(tempDir: string) {
    const updateIndex = jest.fn().mockResolvedValue(undefined);
    const reloadPersistedIndex = jest.fn().mockResolvedValue(undefined);
    const getLastIndexUpdateSummary = jest.fn(() => ({
      status: 'never_run',
      scope: null,
      model_id: 'fake__test',
      started_at: null,
      finished_at: null,
      duration_ms: null,
      files_scanned: 0,
      files_changed: 0,
      files_unchanged: 0,
      files_skipped: 0,
      chunks_attempted: 0,
      chunks_added: 0,
      index_mutated: false,
      saved: false,
      sidecars_written: false,
      failure_count: 0,
      failures: [],
    }));
    const manager = {
      modelDir: path.join(tempDir, '.faiss', 'models', 'fake__test'),
      updateIndex,
      reloadPersistedIndex,
      getLastIndexUpdateSummary,
    } as unknown as FaissIndexManager;

    return { manager, updateIndex, reloadPersistedIndex, getLastIndexUpdateSummary };
  }

  function createContext(
    knowledgeBasesRootDir: string,
    manager: FaissIndexManager,
  ): { context: DocumentMutationHandlerContext; canonicalBases: Array<Record<string, unknown>> } {
    const canonicalBases: Array<Record<string, unknown>> = [];
    const context: DocumentMutationHandlerContext = {
      knowledgeBasesRootDir,
      getActiveManagerForMutation: async () => manager,
      withCanonicalTool: async <T extends CallToolResult>(
        base: Parameters<DocumentMutationHandlerContext['withCanonicalTool']>[0],
        operation: () => Promise<T>,
      ): Promise<T> => {
        canonicalBases.push(base);
        return operation();
      },
    };

    return { context, canonicalBases };
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await fsp.stat(target);
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return false;
      }
      throw error;
    }
  }

  function parseTextPayload(result: CallToolResult): any {
    const content = result.content[0];
    expect(content.type).toBe('text');
    return JSON.parse(String(content.text));
  }

  it('handleAddDocument writes the document and refreshes the active index', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-mcp-mutations-add-'));
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    const { manager, updateIndex } = createManager(tempDir);
    const { context, canonicalBases } = createContext(tempDir, manager);

    const result = await handleAddDocument({
      knowledge_base_name: 'alpha',
      path: 'notes/new.md',
      content: '# New note\n',
    }, context);

    const documentPath = path.join(tempDir, 'alpha', 'notes', 'new.md');
    expect(result.isError).toBeUndefined();
    await expect(fsp.readFile(documentPath, 'utf-8')).resolves.toBe('# New note\n');
    expect(updateIndex).toHaveBeenCalledWith('alpha');
    expect(canonicalBases).toEqual([{ tool: 'add_document', kb_scope: 'alpha' }]);
    expect(parseTextPayload(result)).toMatchObject({
      knowledge_base_name: 'alpha',
      path: 'notes/new.md',
      absolute_path: documentPath,
      indexed: true,
    });
  });

  it('handleAddDocument removes a new file when indexing fails after the write', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-mcp-mutations-rollback-'));
    await fsp.mkdir(path.join(tempDir, 'alpha'));
    const { manager, updateIndex } = createManager(tempDir);
    updateIndex.mockRejectedValue(new Error('index boom'));
    const { context } = createContext(tempDir, manager);

    const result = await handleAddDocument({
      knowledge_base_name: 'alpha',
      path: 'notes/new.md',
      content: '# New note\n',
    }, context);

    const documentPath = path.join(tempDir, 'alpha', 'notes', 'new.md');
    expect(result.isError).toBe(true);
    await expect(exists(documentPath)).resolves.toBe(false);
    await expect(exists(path.dirname(documentPath))).resolves.toBe(false);
    const payload = parseTextPayload(result);
    expect(payload.error.message).toContain('index boom');
    expect(payload.error.rollback).toMatchObject({
      attempted: true,
      succeeded: true,
      message: 'removed newly written document',
    });
  });

  it('handleDeleteDocument removes the file and hash sidecar without re-indexing', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-mcp-mutations-delete-'));
    const documentPath = path.join(tempDir, 'alpha', 'notes', 'old.md');
    const sidecarPath = path.join(tempDir, 'alpha', '.index', 'notes', 'old.md');
    await fsp.mkdir(path.dirname(documentPath), { recursive: true });
    await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fsp.writeFile(documentPath, 'old');
    await fsp.writeFile(sidecarPath, 'hash');
    const { manager, updateIndex } = createManager(tempDir);
    const { context, canonicalBases } = createContext(tempDir, manager);

    const result = await handleDeleteDocument({
      knowledge_base_name: 'alpha',
      path: 'notes/old.md',
    }, context);

    expect(result.isError).toBeUndefined();
    await expect(exists(documentPath)).resolves.toBe(false);
    await expect(exists(sidecarPath)).resolves.toBe(false);
    expect(updateIndex).not.toHaveBeenCalled();
    expect(canonicalBases).toEqual([{ tool: 'delete_document', kb_scope: 'alpha' }]);
    expect(parseTextPayload(result)).toMatchObject({
      knowledge_base_name: 'alpha',
      path: 'notes/old.md',
      absolute_path: documentPath,
      sidecar_path: sidecarPath,
      deleted: true,
    });
  });
});
