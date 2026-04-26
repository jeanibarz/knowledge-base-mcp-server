// RFC 014 — atomic FAISS save tests.
//
// These tests use a real on-disk layout (tmpdir) but mock `FaissStore` so we
// can:
//   1. Inject a controlled "version generation" into each save (saveCounter)
//   2. Have load() assert that both files in the loaded directory carry the
//      SAME generation — a docid mismatch would manifest as a thrown error.
//   3. Run 1000 reader/writer iterations in <30s without a real embedder.
//
// The test that catches the F1 docid-mismatch race is "F1 invariant —
// reader during concurrent writer". If that test ever fails, the design
// is broken.

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';

const DEFAULT_MODEL_ID = 'huggingface__BAAI-bge-small-en-v1.5';

// ---------- shared mock state across tests ----------
const saveMock = jest.fn();
const loadMock = jest.fn();
const fromTextsMock = jest.fn();
const addDocumentsMock = jest.fn();
const similaritySearchMock = jest.fn();

// Per-save monotonic generation counter. Incremented every save; the value
// at save-time is written into BOTH `faiss.index` and `docstore.json` so a
// torn read (one file from save N, other from save N+1) is detectable.
let nextGen = 0;

function incrementGen(): number {
  nextGen += 1;
  return nextGen;
}

function resetMockState() {
  saveMock.mockClear();
  loadMock.mockClear();
  fromTextsMock.mockClear();
  addDocumentsMock.mockClear();
  similaritySearchMock.mockClear();
  nextGen = 0;
}

class MockFaissStore {
  // Carries the gen this in-memory store is "valid for" — for asserting
  // post-load consistency.
  loadedGen: number | null = null;

  async addDocuments(...args: unknown[]) {
    return addDocumentsMock(...args);
  }

  async save(directory: string) {
    saveMock(directory);
    const gen = incrementGen();
    await fsp.mkdir(directory, { recursive: true });
    // Two files like real FaissStore.save. Both carry the same gen.
    await fsp.writeFile(path.join(directory, 'faiss.index'), `gen=${gen}\n`, 'utf-8');
    await fsp.writeFile(path.join(directory, 'docstore.json'), `gen=${gen}\n`, 'utf-8');
  }

  async similaritySearchWithScore(...args: unknown[]) {
    return similaritySearchMock(...args);
  }

  static async fromTexts(...args: unknown[]) {
    fromTextsMock(...args);
    return new MockFaissStore();
  }

  // The crucial behavior: load reads BOTH files (like real FaissStore.load
  // doing Promise.all of two opens) and asserts they have the same gen.
  // Mismatched gen = the F1 docid-mismatch bug. The loaded path should be
  // an absolute path (caller pre-resolved any symlink); we DO NOT resolve
  // anything here — if the caller passes a symlink we'd get partial file
  // resolution exactly like the real F1 bug.
  static async load(directory: string, embeddings: unknown) {
    loadMock(directory, embeddings);
    const [a, b] = await Promise.all([
      fsp.readFile(path.join(directory, 'faiss.index'), 'utf-8'),
      fsp.readFile(path.join(directory, 'docstore.json'), 'utf-8'),
    ]);
    const genA = parseInt(/^gen=(\d+)/.exec(a)?.[1] ?? '', 10);
    const genB = parseInt(/^gen=(\d+)/.exec(b)?.[1] ?? '', 10);
    if (!Number.isFinite(genA) || !Number.isFinite(genB)) {
      throw new Error(`MockFaissStore.load: missing gen marker in ${directory}`);
    }
    if (genA !== genB) {
      throw new Error(
        `MockFaissStore.load: TORN READ in ${directory} — faiss.index gen=${genA}, ` +
          `docstore.json gen=${genB}. RFC 014 atomicity violated.`,
      );
    }
    const store = new MockFaissStore();
    store.loadedGen = genA;
    return store;
  }
}

jest.mock('@langchain/community/embeddings/hf', () => ({
  __esModule: true,
  HuggingFaceInferenceEmbeddings: class MockEmbedding {
    constructor(public _config: unknown) {}
  },
}));

jest.mock('@langchain/community/vectorstores/faiss', () => ({
  __esModule: true,
  FaissStore: MockFaissStore,
}));

// ---------- helpers ----------

function modelDirIn(faissPath: string): string {
  return path.join(faissPath, 'models', DEFAULT_MODEL_ID);
}

async function makeManager(faissPath: string) {
  process.env.NODE_ENV = 'test';
  process.env.FAISS_INDEX_PATH = faissPath;
  // Pin to the huggingface default so DEFAULT_MODEL_ID resolves predictably,
  // regardless of what's in the dev shell env (Ollama vs HF vs OpenAI).
  process.env.EMBEDDING_PROVIDER = 'huggingface';
  process.env.HUGGINGFACE_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
  process.env.HUGGINGFACE_API_KEY = 'test-stub';
  // Re-import the module fresh so it re-reads env vars.
  jest.resetModules();
  const mod = await import('./FaissIndexManager.js');
  return new mod.FaissIndexManager();
}

async function holdWriteLock<T>(modelDir: string, fn: () => Promise<T>): Promise<T> {
  await fsp.mkdir(modelDir, { recursive: true });
  const lockfilePath = path.join(modelDir, '.kb-write.lock');
  const release = await properLockfile.lock(modelDir, {
    lockfilePath,
    update: 5000,
    stale: 10_000,
    retries: { retries: 5, factor: 1.5, minTimeout: 100, maxTimeout: 1000 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

// ---------- tests ----------

describe('RFC 014 atomic save — file-private helpers', () => {
  let nextVersionAfter: (s: string | null) => string;

  beforeAll(async () => {
    const mod = await import('./FaissIndexManager.js');
    nextVersionAfter = mod.nextVersionAfter;
  });

  test('nextVersionAfter(null) returns index.v0', () => {
    expect(nextVersionAfter(null)).toBe('index.v0');
  });

  test('nextVersionAfter increments numerically', () => {
    expect(nextVersionAfter('index.v0')).toBe('index.v1');
    expect(nextVersionAfter('index.v9')).toBe('index.v10');
    expect(nextVersionAfter('index.v999')).toBe('index.v1000');
  });

  test('nextVersionAfter rejects malformed non-empty targets', () => {
    expect(() => nextVersionAfter('faiss.index')).toThrow(/unrecognized symlink target/);
    expect(() => nextVersionAfter('index.foo')).toThrow();
  });

  test('nextVersionAfter treats empty string as no current target', () => {
    // Empty string is falsy and equivalent to null — both indicate no
    // current versioned layout exists yet (fresh install).
    expect(nextVersionAfter('')).toBe('index.v0');
  });
});

describe('RFC 014 atomic save — atomicity smoke', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetMockState();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rfc014-smoke-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('two saves advance the symlink and leave legacy untouched', async () => {
    const mgr = await makeManager(tmpDir);
    const modelDir = modelDirIn(tmpDir);
    await fsp.mkdir(modelDir, { recursive: true });

    // Pre-create a legacy faiss.index/ directory; assert it stays untouched.
    // Use the gen=N format so any incidental load via the mock would succeed
    // (avoids triggering the corruption-recovery branch in initialize, which
    // would rmrf the legacy dir).
    const legacyDir = path.join(modelDir, 'faiss.index');
    await fsp.mkdir(legacyDir);
    await fsp.writeFile(path.join(legacyDir, 'faiss.index'), 'gen=99\n');
    await fsp.writeFile(path.join(legacyDir, 'docstore.json'), 'gen=99\n');
    const legacyMtime = (await fsp.stat(legacyDir)).mtimeMs;

    // Skip initialize() — the mock would load the legacy fixture but we're
    // testing atomicSave specifically. Inject a faissIndex directly.
    (mgr as any).faissIndex = new MockFaissStore();

    await holdWriteLock(modelDir, () => (mgr as any).atomicSave());
    expect(await fsp.readlink(path.join(modelDir, 'index'))).toBe('index.v0');

    await holdWriteLock(modelDir, () => (mgr as any).atomicSave());
    expect(await fsp.readlink(path.join(modelDir, 'index'))).toBe('index.v1');

    // Legacy untouched.
    expect((await fsp.stat(legacyDir)).mtimeMs).toBe(legacyMtime);
    expect(await fsp.readFile(path.join(legacyDir, 'faiss.index'), 'utf-8')).toBe('gen=99\n');
  });
});

describe('RFC 014 atomic save — F1 invariant (reader-during-writer)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetMockState();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rfc014-f1-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('1000 concurrent reads while writer races never observe a torn read', async () => {
    const mgr = await makeManager(tmpDir);
    const modelDir = modelDirIn(tmpDir);
    await fsp.mkdir(modelDir, { recursive: true });
    await mgr.initialize({ readOnly: true });
    (mgr as any).faissIndex = new MockFaissStore();

    // Seed: one initial save so loadAtomic has something to read.
    await holdWriteLock(modelDir, () => (mgr as any).atomicSave());

    let done = false;
    let writerSaves = 0;
    const writerErrors: Error[] = [];
    const readerErrors: Error[] = [];

    const writer = (async () => {
      while (!done) {
        try {
          await holdWriteLock(modelDir, () => (mgr as any).atomicSave());
          writerSaves += 1;
        } catch (err) {
          writerErrors.push(err as Error);
          break;
        }
      }
    })();

    const ITERATIONS = 1000;
    const READERS = 20;
    const readers = Array.from({ length: READERS }, async () => {
      for (let i = 0; i < ITERATIONS / READERS; i += 1) {
        try {
          // We need a fresh manager-like loader because faissIndex is mutated
          // by the writer; instead just call the static load via the symlink.
          // loadAtomic is the function under test — we can call it directly
          // on a fresh manager that doesn't share state with the writer.
          const reader = new (await import('./FaissIndexManager.js')).FaissIndexManager();
          // Force the reader to resolve through OUR pre-resolved path code.
          await reader.initialize({ readOnly: true });
          // initialize calls loadAtomic; if a torn read happened, it would
          // throw with the mock's "TORN READ" message. We don't need to do
          // anything else here.
        } catch (err) {
          readerErrors.push(err as Error);
        }
      }
    });

    await Promise.all(readers);
    done = true;
    await writer;

    // The writer must have made progress (else the test isn't actually exercising the race).
    expect(writerSaves).toBeGreaterThan(5);
    expect(writerErrors).toEqual([]);
    expect(readerErrors).toEqual([]);
  }, 30_000);
});

describe('RFC 014 atomic save — GC retention (N=3)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetMockState();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rfc014-gc-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('after 6 saves, only index.v3, v4, v5 remain', async () => {
    const mgr = await makeManager(tmpDir);
    const modelDir = modelDirIn(tmpDir);
    await fsp.mkdir(modelDir, { recursive: true });
    await mgr.initialize({ readOnly: true });
    (mgr as any).faissIndex = new MockFaissStore();

    for (let i = 0; i < 6; i += 1) {
      await holdWriteLock(modelDir, () => (mgr as any).atomicSave());
    }

    const entries = await fsp.readdir(modelDir);
    const versions = entries.filter((e) => /^index\.v\d+$/.test(e)).sort();
    expect(versions).toEqual(['index.v3', 'index.v4', 'index.v5']);
    expect(await fsp.readlink(path.join(modelDir, 'index'))).toBe('index.v5');
  });
});

describe('RFC 014 atomic save — lstat-vs-pathExists regression', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetMockState();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rfc014-lstat-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('dangling symlink (target rm-ed) throws loud error, not silent legacy fallthrough', async () => {
    const modelDir = modelDirIn(tmpDir);
    await fsp.mkdir(modelDir, { recursive: true });

    // Set up a dangling symlink: index → index.v0 but index.v0/ does not exist.
    await fsp.symlink('index.v0', path.join(modelDir, 'index'));
    // Also create a legacy directory with content — if loadAtomic falls through
    // silently (the bug), it would load THIS instead of throwing.
    const legacyDir = path.join(modelDir, 'faiss.index');
    await fsp.mkdir(legacyDir);
    await fsp.writeFile(path.join(legacyDir, 'faiss.index'), 'gen=999\n');
    await fsp.writeFile(path.join(legacyDir, 'docstore.json'), 'gen=999\n');

    const mgr = await makeManager(tmpDir);
    // initialize() catches and logs, but the corruption-recovery branch in
    // FaissIndexManager will rm the symlink and then load null. We're
    // testing that loadAtomic itself raises on the dangling case, so call
    // it directly via the corruption-recovery contract.
    let raised: Error | null = null;
    try {
      await (mgr as any).loadAtomic();
    } catch (err) {
      raised = err as Error;
    }
    expect(raised).not.toBeNull();
    expect(raised!.message).toMatch(/N=3 retention contract violated/);
  });
});

describe('RFC 014 atomic save — lazy migration (legacy load + first save creates versioned)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetMockState();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rfc014-lazy-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('initialize on a legacy-only model loads from faiss.index/, first save creates index.v0', async () => {
    const modelDir = modelDirIn(tmpDir);
    await fsp.mkdir(modelDir, { recursive: true });

    // Build a "0.3.0" fixture: faiss.index/ directory with the two files.
    const legacyDir = path.join(modelDir, 'faiss.index');
    await fsp.mkdir(legacyDir);
    await fsp.writeFile(path.join(legacyDir, 'faiss.index'), 'gen=42\n');
    await fsp.writeFile(path.join(legacyDir, 'docstore.json'), 'gen=42\n');

    const mgr = await makeManager(tmpDir);
    await mgr.initialize({ readOnly: true });
    // loadAtomic should have read from legacy.
    expect(loadMock).toHaveBeenCalledWith(legacyDir, expect.anything());

    // Now do a save — should create index.v0 and the symlink.
    (mgr as any).faissIndex = new MockFaissStore();
    await holdWriteLock(modelDir, () => (mgr as any).atomicSave());

    expect(await fsp.readlink(path.join(modelDir, 'index'))).toBe('index.v0');
    // Legacy untouched (no migration step).
    expect(await fsp.readFile(path.join(legacyDir, 'faiss.index'), 'utf-8')).toBe('gen=42\n');
  });
});

describe('RFC 014 atomic save — downgrade-hazard surfacing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetMockState();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rfc014-hazard-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('marker file is written when both versioned + legacy coexist, cleared when legacy removed', async () => {
    const modelDir = modelDirIn(tmpDir);
    await fsp.mkdir(modelDir, { recursive: true });

    // Build both layouts.
    const legacyDir = path.join(modelDir, 'faiss.index');
    await fsp.mkdir(legacyDir);
    await fsp.writeFile(path.join(legacyDir, 'faiss.index'), 'gen=99\n');
    await fsp.writeFile(path.join(legacyDir, 'docstore.json'), 'gen=99\n');

    const v0 = path.join(modelDir, 'index.v0');
    await fsp.mkdir(v0);
    await fsp.writeFile(path.join(v0, 'faiss.index'), 'gen=1\n');
    await fsp.writeFile(path.join(v0, 'docstore.json'), 'gen=1\n');
    await fsp.symlink('index.v0', path.join(modelDir, 'index'));

    const mgr = await makeManager(tmpDir);
    await (mgr as any).loadAtomic();

    // Marker file written.
    const marker = path.join(modelDir, '.downgrade-hazard');
    expect(await fsp.access(marker).then(() => true)).toBe(true);

    // Now remove legacy and re-load — marker should be cleared.
    await fsp.rm(legacyDir, { recursive: true, force: true });
    await (mgr as any).loadAtomic();

    let stillThere = false;
    try {
      await fsp.access(marker);
      stillThere = true;
    } catch {
      // expected — marker cleared
    }
    expect(stillThere).toBe(false);
  });
});
