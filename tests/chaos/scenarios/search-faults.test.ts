import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import {
  activeIndexSymlink,
  createChaosWorkspace,
  modelDir,
  restoreChaosEnv,
  saveChaosEnv,
  writeFixtureNote,
  type ChaosWorkspace,
  type SavedEnv,
} from '../fault-harness.js';

class SearchFaultFaissStore {
  public docstore = { _docs: new Map<string, Document>() };
  public index = {
    _n: 0,
    ntotal: () => this.index._n,
    getDimension: () => 2,
  };

  constructor(public embeddings: EmbeddingsInterface) {}

  async addVectors(vectors: number[][], documents: Document[]): Promise<void> {
    const expectedDimension = vectors[0]?.length ?? 0;
    for (const vector of vectors) {
      if (vector.length !== expectedDimension || vector.some((value) => !Number.isFinite(value))) {
        throw new Error('fake FAISS received malformed vectors');
      }
    }
    documents.forEach((document) => {
      this.docstore._docs.set(`doc-${this.index._n}`, document);
      this.index._n += 1;
    });
  }

  async save(directory: string): Promise<void> {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'faiss.index'), `vectors=${this.index._n}\n`, 'utf-8');
    await fsp.writeFile(
      path.join(directory, 'docstore.json'),
      JSON.stringify(Array.from(this.docstore._docs.entries())),
      'utf-8',
    );
  }

  async similaritySearchWithScore(query: string, k: number): Promise<Array<[Document, number]>> {
    const normalizedQuery = query.toLowerCase();
    return Array.from(this.docstore._docs.values())
      .map((document, ordinal): [Document, number] => {
        const haystack = `${document.pageContent}\n${JSON.stringify(document.metadata ?? {})}`.toLowerCase();
        return [document, haystack.includes(normalizedQuery) ? ordinal / 1000 : 1 + ordinal / 1000];
      })
      .sort((a, b) => a[1] - b[1])
      .slice(0, k);
  }

  static async load(directory: string, embeddings: EmbeddingsInterface): Promise<SearchFaultFaissStore> {
    const indexRaw = await fsp.readFile(path.join(directory, 'faiss.index'), 'utf-8');
    const indexMatch = /^vectors=(\d+)\n$/.exec(indexRaw);
    if (indexMatch === null) {
      throw new Error('fake FAISS index is truncated or corrupt');
    }

    const entries = JSON.parse(await fsp.readFile(path.join(directory, 'docstore.json'), 'utf-8')) as unknown;
    if (!Array.isArray(entries) || Number(indexMatch[1]) !== entries.length) {
      throw new Error('fake FAISS index/docstore counts do not match');
    }

    const store = new SearchFaultFaissStore(embeddings);
    for (const [id, document] of entries as Array<[string, Document]>) {
      store.docstore._docs.set(id, document);
    }
    store.index._n = store.docstore._docs.size;
    return store;
  }
}

function vectorForText(text: string): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16_777_619);
  }
  return [text.length, hash >>> 0];
}

jest.mock('@langchain/community/vectorstores/faiss', () => ({
  __esModule: true,
  FaissStore: SearchFaultFaissStore,
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

describe('search chaos suite', () => {
  let workspace: ChaosWorkspace;
  let savedEnv: SavedEnv;

  beforeEach(async () => {
    savedEnv = saveChaosEnv();
    jest.resetModules();
    workspace = await createChaosWorkspace();
    process.env.KB_CONTEXTUAL_RETRIEVAL = 'off';
  });

  afterEach(async () => {
    restoreChaosEnv(savedEnv);
    await fsp.rm(workspace.tempDir, { recursive: true, force: true });
  });

  async function buildDenseIndex(): Promise<import('../../../src/FaissIndexManager.js').FaissIndexManager> {
    const { FaissIndexManager } = await import('../../../src/FaissIndexManager.js');
    const manager = new FaissIndexManager();
    await manager.initialize();
    await manager.updateIndex(workspace.kbName);
    return manager;
  }

  async function buildLexicalIndex(): Promise<string> {
    const { LexicalIndex, lexicalIndexFilePath } = await import('../../../src/lexical-index.js');
    const index = await LexicalIndex.load(workspace.kbName, workspace.kbPath);
    await index.refresh();
    await index.save();
    return lexicalIndexFilePath(workspace.kbName);
  }

  async function captureSearchOutput(
    runSearch: (args: string[], deps: import('../../../src/cli-search.js').RunSearchDeps) => Promise<number>,
    args: string[],
    deps: import('../../../src/cli-search.js').RunSearchDeps,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    try {
      const code = await runSearch(args, deps);
      return { code, stdout: stdout.join(''), stderr: stderr.join('') };
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  }

  it('classifies a corrupt FAISS artifact instead of throwing from the search command', async () => {
    await writeFixtureNote(workspace);
    await buildDenseIndex();

    const activeVersion = await fsp.realpath(activeIndexSymlink(workspace));
    await fsp.writeFile(path.join(activeVersion, 'faiss.index'), 'vectors=', 'utf-8');

    const { FaissIndexManager } = await import('../../../src/FaissIndexManager.js');
    const { createRunSearchDeps, runSearch } = await import('../../../src/cli-search.js');
    const manager = new FaissIndexManager();
    const deps = createRunSearchDeps({
      bootstrapLayout: jest.fn(async () => {}),
      resolveActiveModel: jest.fn(async () => 'huggingface__BAAI-bge-small-en-v1.5'),
      loadManagerForModel: jest.fn(async () => manager),
      loadWithJsonRetry: jest.fn(async () => {
        await manager.initialize({ readOnly: true });
      }),
    });

    const output = await captureSearchOutput(runSearch, [
      'queue recovery',
      '--format=json',
      '--no-freshness',
    ], deps);

    expect(output.code).toBe(1);
    expect(output.stderr).toContain('corrupt or unreadable');
    expect(output.stderr).not.toContain('UnhandledPromiseRejection');
    expect(JSON.parse(output.stdout)).toMatchObject({
      error: {
        code: 'INDEX_NOT_INITIALIZED',
        category: 'indexing',
      },
    });
  });

  it('surfaces torn lexical JSON as a classified per-KB partial failure', async () => {
    await writeFixtureNote(workspace);
    const lexicalPath = await buildLexicalIndex();
    const raw = await fsp.readFile(lexicalPath, 'utf-8');
    await fsp.writeFile(lexicalPath, raw.slice(0, -2), 'utf-8');

    const { runLexicalLeg } = await import('../../../src/hybrid-retrieval.js');
    const { classifyKbSearchError } = await import('../../../src/search-errors-core.js');
    const failures: Error[] = [];
    const result = await runLexicalLeg({
      kbs: [{ kbName: workspace.kbName, kbPath: workspace.kbPath }],
      query: 'queue recovery',
      fetchK: 10,
      refresh: 'when-empty',
      onError: (_kbName, error) => failures.push(error),
    });

    expect(result).toEqual({
      hits: [],
      refreshed: 0,
      failed: 1,
      failedKbs: [workspace.kbName],
    });
    expect(failures).toHaveLength(1);
    expect(classifyKbSearchError(failures[0])).toMatchObject({
      code: 'CORRUPT_INDEX',
      category: 'indexing',
    });
  });

  it.each(['missing', 'short'] as const)(
    'falls back to dense post-filtering when the metadata sidecar is %s',
    async (corruption) => {
      await writeFixtureNote(workspace);
      const manager = await buildDenseIndex();
      const sidecarPath = path.join(modelDir(workspace), 'metadata-sidecar.jsonl');

      if (corruption === 'missing') {
        await fsp.rm(sidecarPath);
      } else {
        const header = (await fsp.readFile(sidecarPath, 'utf-8')).split('\n')[0];
        await fsp.writeFile(sidecarPath, `${header}\n`, 'utf-8');
      }

      const timing: import('../../../src/FaissIndexManager.js').SimilaritySearchTiming = {};
      const results = await manager.similaritySearch(
        'queue worker',
        1,
        2,
        workspace.kbName,
        { extensions: ['.md'] },
        timing,
      );

      expect(results).toHaveLength(1);
      expect(results[0].metadata.relativePath).toBe(`${workspace.kbName}/runbook.md`);
      expect(timing.sidecar_fast_path).toBe('missing');
    },
  );
});
