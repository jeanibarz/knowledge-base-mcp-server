import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const originalEnv = {
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
  HUGGINGFACE_MODEL_NAME: process.env.HUGGINGFACE_MODEL_NAME,
  OLLAMA_MODEL: process.env.OLLAMA_MODEL,
  OPENAI_MODEL_NAME: process.env.OPENAI_MODEL_NAME,
  KB_ACTIVE_MODEL: process.env.KB_ACTIVE_MODEL,
};

afterEach(() => {
  for (const k of Object.keys(originalEnv) as Array<keyof typeof originalEnv>) {
    const v = originalEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const REGISTERED_ID = 'huggingface__BAAI-bge-small-en-v1.5';

async function seedRegistered(faissDir: string, modelId = REGISTERED_ID, modelName = 'BAAI/bge-small-en-v1.5'): Promise<void> {
  const dir = path.join(faissDir, 'models', modelId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'model_name.txt'), modelName);
}

describe('model-storage-layout: writeActiveModelAtomic / robust reader', () => {
  let faissDir: string;
  beforeEach(async () => {
    faissDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-active-'));
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
    delete process.env.KB_ACTIVE_MODEL;
  });

  it('writes and reads back the active model id', async () => {
    jest.resetModules();
    const { writeActiveModelAtomic, activeFileExists } = await import('./model-storage-layout.js');
    await seedRegistered(faissDir);
    await writeActiveModelAtomic(REGISTERED_ID);
    expect(await activeFileExists()).toBe(true);
    expect(await fsp.readFile(path.join(faissDir, 'active.txt'), 'utf-8')).toBe(REGISTERED_ID);
  });

  it('refuses to write an invalid model_id (would corrupt active.txt)', async () => {
    jest.resetModules();
    const { writeActiveModelAtomic } = await import('./model-storage-layout.js');
    await expect(writeActiveModelAtomic('Invalid Model')).rejects.toThrow(/invalid model_id/i);
  });

  it('stores per-model index type and defaults old models to flat', async () => {
    jest.resetModules();
    const { readStoredIndexType, writeIndexTypeAtomic } = await import('./model-storage-layout.js');
    await seedRegistered(faissDir);

    expect(await readStoredIndexType(REGISTERED_ID)).toBe('flat');

    await writeIndexTypeAtomic(REGISTERED_ID, 'sq8');
    expect(await fsp.readFile(path.join(faissDir, 'models', REGISTERED_ID, 'index-type.txt'), 'utf-8'))
      .toBe('sq8\n');
    expect(await readStoredIndexType(REGISTERED_ID)).toBe('sq8');
  });
});

describe('model-storage-layout: isRegisteredModel', () => {
  let faissDir: string;
  beforeEach(async () => {
    faissDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-registered-'));
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
  });

  it('returns false when models/<id>/ is missing', async () => {
    jest.resetModules();
    const { isRegisteredModel } = await import('./model-storage-layout.js');
    expect(await isRegisteredModel(REGISTERED_ID)).toBe(false);
  });

  it('returns false when model_name.txt is missing (just a directory)', async () => {
    jest.resetModules();
    const { isRegisteredModel } = await import('./model-storage-layout.js');
    await fsp.mkdir(path.join(faissDir, 'models', REGISTERED_ID), { recursive: true });
    expect(await isRegisteredModel(REGISTERED_ID)).toBe(false);
  });

  it('returns false when .adding sentinel is present (mid-add)', async () => {
    jest.resetModules();
    const { isRegisteredModel } = await import('./model-storage-layout.js');
    await seedRegistered(faissDir);
    await fsp.writeFile(path.join(faissDir, 'models', REGISTERED_ID, '.adding'), `${process.pid}\n`);
    expect(await isRegisteredModel(REGISTERED_ID)).toBe(false);
  });

  it('returns true for a fully-set-up model', async () => {
    jest.resetModules();
    const { isRegisteredModel } = await import('./model-storage-layout.js');
    await seedRegistered(faissDir);
    expect(await isRegisteredModel(REGISTERED_ID)).toBe(true);
  });
});

describe('model-storage-layout: .adding sentinel + classifyIncompleteModelState', () => {
  let faissDir: string;
  beforeEach(async () => {
    faissDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-registered-'));
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
  });

  it('writes and reads structured .adding sentinel metadata', async () => {
    jest.resetModules();
    const {
      buildAddingSentinelMetadata,
      readAddingSentinel,
      writeAddingSentinel,
    } = await import('./model-storage-layout.js');
    await fsp.mkdir(path.join(faissDir, 'models', REGISTERED_ID), { recursive: true });

    const metadata = buildAddingSentinelMetadata({
      modelId: REGISTERED_ID,
      provider: 'huggingface',
      modelName: 'BAAI/bge-small-en-v1.5',
      pid: 123,
      startedAt: new Date('2026-05-11T10:00:00.000Z'),
    });
    await writeAddingSentinel(metadata);

    expect(await readAddingSentinel(REGISTERED_ID)).toMatchObject({
      kind: 'metadata',
      metadata,
    });
  });

  it('classifies live, dead, legacy PID, and malformed .adding sentinels conservatively', async () => {
    jest.resetModules();
    const {
      buildAddingSentinelMetadata,
      classifyIncompleteModelState,
      writeAddingSentinel,
    } = await import('./model-storage-layout.js');

    await fsp.mkdir(path.join(faissDir, 'models', REGISTERED_ID), { recursive: true });
    await writeAddingSentinel(buildAddingSentinelMetadata({
      modelId: REGISTERED_ID,
      provider: 'huggingface',
      modelName: 'BAAI/bge-small-en-v1.5',
      pid: 123,
      startedAt: new Date('2026-05-11T10:00:00.000Z'),
    }));
    await expect(classifyIncompleteModelState(REGISTERED_ID, () => true))
      .resolves.toMatchObject({ status: 'in_progress', pid: 123, recovery_command: null });
    await expect(classifyIncompleteModelState(REGISTERED_ID, () => false))
      .resolves.toMatchObject({
        status: 'stale_interrupted',
        pid: 123,
        provider: 'huggingface',
        model_name: 'BAAI/bge-small-en-v1.5',
        recovery_command: 'kb models add huggingface BAAI/bge-small-en-v1.5 --recover --yes',
      });

    const legacyId = 'ollama__nomic-embed-text';
    await fsp.mkdir(path.join(faissDir, 'models', legacyId), { recursive: true });
    await fsp.writeFile(path.join(faissDir, 'models', legacyId, '.adding'), '456\n');
    await expect(classifyIncompleteModelState(legacyId, () => false))
      .resolves.toMatchObject({ status: 'stale_interrupted', pid: 456, provider: 'ollama' });

    const malformedId = 'openai__text-embedding-3-small';
    await fsp.mkdir(path.join(faissDir, 'models', malformedId), { recursive: true });
    await fsp.writeFile(path.join(faissDir, 'models', malformedId, '.adding'), '{not-json');
    await expect(classifyIncompleteModelState(malformedId, () => false))
      .resolves.toMatchObject({ status: 'unknown', pid: null, recovery_command: null });
  });
});
