import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  createManualGate,
  createStressWorkspace,
  FakeFaissStore,
  pathExists,
  resetStressFakes,
  restoreStressEnv,
  saveStressEnv,
  setFakeFaissSaveGate,
  vectorForText,
  writeStressNote,
  type SavedStressEnv,
  type StressWorkspace,
} from '../stress-harness.js';

const stressDescribe = process.env.KB_RUN_STRESS === '1' ? describe : describe.skip;

jest.mock('@langchain/community/vectorstores/faiss', () => ({
  __esModule: true,
  FaissStore: FakeFaissStore,
}));

jest.mock('@langchain/community/embeddings/hf', () => ({
  __esModule: true,
  HuggingFaceInferenceEmbeddings: class MockEmbedding {
    async embedDocuments(texts: string[]): Promise<number[][]> {
      return texts.map(vectorForText);
    }

    async embedQuery(text: string): Promise<number[]> {
      return vectorForText(text);
    }
  },
}));

stressDescribe('search-during-refresh stress suite', () => {
  let workspace: StressWorkspace;
  let savedEnv: SavedStressEnv;

  beforeEach(async () => {
    savedEnv = saveStressEnv();
    resetStressFakes();
    jest.resetModules();
    workspace = await createStressWorkspace();
  });

  afterEach(async () => {
    resetStressFakes();
    restoreStressEnv(savedEnv);
    await fsp.rm(workspace.tempDir, { recursive: true, force: true });
  });

  it('serves invariant-safe searches while a refresh is blocked at atomic save', async () => {
    await writeStressNote(
      workspace,
      'seed.md',
      '# Alpha runbook\n\nalpha queue recovery stays searchable during refresh.\n',
    );

    const { FaissIndexManager } = await import('../../../src/FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex(workspace.kbName);

    const before = await manager.similaritySearch('alpha', 5, 2, workspace.kbName);
    expect(before.map((result) => result.metadata.relativePath)).toContain(`${workspace.kbName}/seed.md`);

    await writeStressNote(
      workspace,
      'refresh.md',
      '# Bravo runbook\n\nbravo deploy rollback arrives while readers are active.\n',
    );
    const saveGate = createManualGate();
    setFakeFaissSaveGate(saveGate);
    const refresh = manager.updateIndex(workspace.kbName);
    await saveGate.waitUntilBlocked();

    const searches = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const query = index % 2 === 0 ? 'alpha' : 'bravo';
        return manager.similaritySearch(query, 5, 2, workspace.kbName);
      }),
    );

    for (const results of searches) {
      expect(results.length).toBeGreaterThan(0);
      const relativePaths = results.map((result) => result.metadata.relativePath);
      expect(new Set(relativePaths).size).toBe(relativePaths.length);
      expect(relativePaths.every((relativePath) =>
        relativePath === `${workspace.kbName}/seed.md` ||
        relativePath === `${workspace.kbName}/refresh.md`,
      )).toBe(true);
      expect(results.every((result) =>
        Number.isFinite(result.score) &&
        result.metadata.knowledgeBase === workspace.kbName &&
        typeof result.metadata.source === 'string',
      )).toBe(true);
    }

    saveGate.release();
    await refresh;

    const after = await manager.similaritySearch('bravo', 5, 2, workspace.kbName);
    expect(after.map((result) => result.metadata.relativePath)).toContain(`${workspace.kbName}/refresh.md`);
    await expect(pathExists(path.join(workspace.faissPath, 'models', 'fake__stress-fake', 'index'))).resolves.toBe(true);
  }, 20_000);
});
