import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { FaissIndexManager } from '../../../src/FaissIndexManager.js';
import type { DocumentMutationHandlerContext } from '../../../src/mcp-document-mutations.js';
import {
  createStressWorkspace,
  parseTextPayload,
  restoreStressEnv,
  saveStressEnv,
  type SavedStressEnv,
  type StressWorkspace,
} from '../stress-harness.js';

const stressDescribe = process.env.KB_RUN_STRESS === '1' ? describe : describe.skip;

interface MutationProbe {
  readonly calls: string[];
  readonly maxConcurrent: number;
  updateIndex: (kb: string | undefined) => Promise<void>;
  waitForCallCount(count: number): Promise<void>;
  releaseOne(): void;
}

function createMutationProbe(): MutationProbe {
  let active = 0;
  let maxConcurrent = 0;
  const calls: string[] = [];
  const waiters: Array<() => void> = [];
  const releases: Array<() => void> = [];
  const notify = (): void => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      waiters.splice(i, 1)[0]();
    }
  };

  const updateIndex = jest.fn(async (kb: string | undefined): Promise<void> => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    calls.push(kb ?? '<global>');
    notify();
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
  });

  return {
    calls,
    get maxConcurrent() {
      return maxConcurrent;
    },
    updateIndex,
    async waitForCallCount(count: number): Promise<void> {
      while (calls.length < count) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    releaseOne(): void {
      const release = releases.shift();
      if (release === undefined) {
        throw new Error('no blocked mutation update to release');
      }
      release();
    },
  };
}

stressDescribe('parallel MCP mutation stress suite', () => {
  let workspace: StressWorkspace;
  let savedEnv: SavedStressEnv;

  beforeEach(async () => {
    savedEnv = saveStressEnv();
    jest.resetModules();
    workspace = await createStressWorkspace();
  });

  afterEach(async () => {
    restoreStressEnv(savedEnv);
    await fsp.rm(workspace.tempDir, { recursive: true, force: true });
  });

  it('serializes concurrent add_document mutations through the per-model write lock', async () => {
    const probe = createMutationProbe();
    const manager = {
      modelDir: path.join(workspace.faissPath, 'models', 'fake__stress-fake'),
      updateIndex: probe.updateIndex,
      reloadPersistedIndex: jest.fn(async () => undefined),
      getLastIndexUpdateSummary: jest.fn(() => ({
        status: 'success',
        scope: workspace.kbName,
        model_id: 'fake__stress-fake',
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
        warning_count: 0,
        warnings: [],
        failure_count: 0,
        failures: [],
      })),
    } as unknown as FaissIndexManager;
    const canonicalBases: Array<Record<string, unknown>> = [];
    const context: DocumentMutationHandlerContext = {
      knowledgeBasesRootDir: workspace.kbRoot,
      getActiveManagerForMutation: async () => manager,
      withCanonicalTool: async <T extends CallToolResult>(
        base: Parameters<DocumentMutationHandlerContext['withCanonicalTool']>[0],
        operation: () => Promise<T>,
      ): Promise<T> => {
        canonicalBases.push(base);
        return operation();
      },
    };
    const { handleAddDocument } = await import('../../../src/mcp-document-mutations.js');
    const mutationCount = 6;
    const mutations = Array.from({ length: mutationCount }, (_, index) => ({
      knowledge_base_name: workspace.kbName,
      path: `parallel/doc-${index}.md`,
      content: `# Parallel ${index}\n\nmutation ${index}\n`,
    }));

    const pending = mutations.map((mutation) => handleAddDocument(mutation, context));
    for (let expectedCalls = 1; expectedCalls <= mutationCount; expectedCalls += 1) {
      await probe.waitForCallCount(expectedCalls);
      expect(probe.maxConcurrent).toBe(1);
      probe.releaseOne();
    }

    const results = await Promise.all(pending);

    expect(results.every((result) => result.isError !== true)).toBe(true);
    expect(probe.calls).toHaveLength(mutationCount);
    expect(probe.calls.every((kb) => kb === workspace.kbName)).toBe(true);
    expect(probe.maxConcurrent).toBe(1);
    expect(canonicalBases).toEqual(
      Array.from({ length: mutationCount }, () => ({ tool: 'add_document', kb_scope: workspace.kbName })),
    );

    for (let index = 0; index < mutationCount; index += 1) {
      const documentPath = path.join(workspace.kbPath, 'parallel', `doc-${index}.md`);
      await expect(fsp.readFile(documentPath, 'utf-8')).resolves.toBe(`# Parallel ${index}\n\nmutation ${index}\n`);
      expect(parseTextPayload<{ indexed: boolean; path: string }>(results[index])).toMatchObject({
        indexed: true,
        path: `parallel/doc-${index}.md`,
      });
    }
  }, 20_000);
});
