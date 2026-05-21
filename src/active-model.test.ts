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

describe('active-model: legacy env-derived model spec', () => {
  it('keeps the exact configured model name while deriving the safe id', async () => {
    jest.resetModules();
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_MODEL_NAME = 'BAAI/bge-base-en-v1.5';

    const { computeLegacyEnvDerivedId, computeLegacyEnvModelSpec } = await import('./active-model.js');

    expect(computeLegacyEnvModelSpec()).toEqual({
      provider: 'huggingface',
      modelName: 'BAAI/bge-base-en-v1.5',
      modelId: 'huggingface__BAAI-bge-base-en-v1.5',
    });
    expect(computeLegacyEnvDerivedId()).toBe('huggingface__BAAI-bge-base-en-v1.5');
  });

  it('preserves slash and tag characters in the Ollama model name', async () => {
    jest.resetModules();
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_MODEL = 'dengcao/Qwen3-Embedding-0.6B:Q8_0';

    const { computeLegacyEnvModelSpec } = await import('./active-model.js');

    expect(computeLegacyEnvModelSpec()).toEqual({
      provider: 'ollama',
      modelName: 'dengcao/Qwen3-Embedding-0.6B:Q8_0',
      modelId: 'ollama__dengcao-Qwen3-Embedding-0.6B-Q8_0',
    });
  });
});

describe('active-model: writeActiveModelAtomic / robust reader', () => {
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
    const { writeActiveModelAtomic, resolveActiveModel } = await import('./active-model.js');
    await seedRegistered(faissDir);
    await writeActiveModelAtomic(REGISTERED_ID);
    expect(await resolveActiveModel()).toBe(REGISTERED_ID);
  });

  it('refuses to write an invalid model_id (would corrupt active.txt)', async () => {
    jest.resetModules();
    const { writeActiveModelAtomic } = await import('./active-model.js');
    await expect(writeActiveModelAtomic('Invalid Model')).rejects.toThrow(/invalid model_id/i);
  });

  it('stores per-model index type and defaults old models to flat', async () => {
    jest.resetModules();
    const { readStoredIndexType, writeIndexTypeAtomic } = await import('./active-model.js');
    await seedRegistered(faissDir);

    expect(await readStoredIndexType(REGISTERED_ID)).toBe('flat');

    await writeIndexTypeAtomic(REGISTERED_ID, 'sq8');
    expect(await fsp.readFile(path.join(faissDir, 'models', REGISTERED_ID, 'index-type.txt'), 'utf-8'))
      .toBe('sq8\n');
    expect(await readStoredIndexType(REGISTERED_ID)).toBe('sq8');
  });

  it('robust reader strips trailing newline / CRLF', async () => {
    jest.resetModules();
    const { resolveActiveModel } = await import('./active-model.js');
    await seedRegistered(faissDir);
    await fsp.writeFile(path.join(faissDir, 'active.txt'), `${REGISTERED_ID}\r\n`);
    expect(await resolveActiveModel()).toBe(REGISTERED_ID);
  });

  it('robust reader strips UTF-8 BOM', async () => {
    jest.resetModules();
    const { resolveActiveModel } = await import('./active-model.js');
    await seedRegistered(faissDir);
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(REGISTERED_ID, 'utf-8')]);
    await fsp.writeFile(path.join(faissDir, 'active.txt'), withBom);
    expect(await resolveActiveModel()).toBe(REGISTERED_ID);
  });

  it('falls through to env when active.txt is absent (RFC §4.7 step 4)', async () => {
    jest.resetModules();
    const { resolveActiveModel } = await import('./active-model.js');
    await seedRegistered(faissDir); // env-derived model is registered.
    expect(await resolveActiveModel()).toBe(REGISTERED_ID);
  });

  it('falls through to env when active.txt is empty / whitespace-only', async () => {
    jest.resetModules();
    const { resolveActiveModel } = await import('./active-model.js');
    await seedRegistered(faissDir);
    await fsp.writeFile(path.join(faissDir, 'active.txt'), '   \n\r\n  ');
    expect(await resolveActiveModel()).toBe(REGISTERED_ID);
  });

  it('HARD-FAILS on regex-fail (round-2 failure N3 — not silent fallthrough)', async () => {
    jest.resetModules();
    const { resolveActiveModel } = await import('./active-model.js');
    await seedRegistered(faissDir);
    await fsp.writeFile(path.join(faissDir, 'active.txt'), 'Invalid With Spaces');
    await expect(resolveActiveModel()).rejects.toThrow(/active\.txt is malformed/);
  });
});

describe('active-model: resolveActiveModel precedence (RFC §4.7)', () => {
  let faissDir: string;
  beforeEach(async () => {
    faissDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-active-prec-'));
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
    delete process.env.KB_ACTIVE_MODEL;
  });

  it('explicitOverride wins over KB_ACTIVE_MODEL, active.txt, and env', async () => {
    jest.resetModules();
    const { resolveActiveModel } = await import('./active-model.js');
    const otherId = 'ollama__nomic-embed-text-latest';
    await seedRegistered(faissDir, REGISTERED_ID, 'BAAI/bge-small-en-v1.5');
    await seedRegistered(faissDir, otherId, 'nomic-embed-text:latest');
    await fsp.writeFile(path.join(faissDir, 'active.txt'), REGISTERED_ID);
    process.env.KB_ACTIVE_MODEL = REGISTERED_ID;
    expect(await resolveActiveModel({ explicitOverride: otherId })).toBe(otherId);
  });

  it('KB_ACTIVE_MODEL wins over active.txt', async () => {
    jest.resetModules();
    process.env.KB_ACTIVE_MODEL = 'ollama__nomic-embed-text-latest';
    const { resolveActiveModel } = await import('./active-model.js');
    const otherId = 'ollama__nomic-embed-text-latest';
    await seedRegistered(faissDir, REGISTERED_ID, 'BAAI/bge-small-en-v1.5');
    await seedRegistered(faissDir, otherId, 'nomic-embed-text:latest');
    await fsp.writeFile(path.join(faissDir, 'active.txt'), REGISTERED_ID);
    expect(await resolveActiveModel()).toBe(otherId);
  });

  it('active.txt wins over legacy env when both registered', async () => {
    jest.resetModules();
    const { resolveActiveModel } = await import('./active-model.js');
    const otherId = 'ollama__nomic-embed-text-latest';
    await seedRegistered(faissDir, REGISTERED_ID, 'BAAI/bge-small-en-v1.5');
    await seedRegistered(faissDir, otherId, 'nomic-embed-text:latest');
    await fsp.writeFile(path.join(faissDir, 'active.txt'), otherId);
    expect(await resolveActiveModel()).toBe(otherId);
  });

  it('legacy env fallback when no active.txt', async () => {
    jest.resetModules();
    const { resolveActiveModel } = await import('./active-model.js');
    await seedRegistered(faissDir);
    expect(await resolveActiveModel()).toBe(REGISTERED_ID);
  });

  it('explicit override that is not registered → throws with hint', async () => {
    jest.resetModules();
    const { ActiveModelResolutionError, resolveActiveModel } = await import('./active-model.js');
    await seedRegistered(faissDir);
    await expect(resolveActiveModel({ explicitOverride: 'ollama__not-here' }))
      .rejects.toBeInstanceOf(ActiveModelResolutionError);
  });

  it('rejects path-traversal in explicitOverride before any FS lookup', async () => {
    jest.resetModules();
    const { resolveActiveModel } = await import('./active-model.js');
    await expect(resolveActiveModel({ explicitOverride: 'ollama__../etc/passwd' }))
      .rejects.toThrow(/Invalid --model/);
  });

  it('active.txt pointing at a stale incomplete model gives the recover command', async () => {
    jest.resetModules();
    const { resolveActiveModel } = await import('./active-model.js');
    const staleId = 'ollama__nomic-embed-text';
    await fsp.mkdir(path.join(faissDir, 'models', staleId), { recursive: true });
    await fsp.writeFile(path.join(faissDir, 'active.txt'), staleId);
    await fsp.writeFile(path.join(faissDir, 'models', staleId, '.adding'), JSON.stringify({
      schema_version: 'kb.model-adding.v1',
      model_id: staleId,
      provider: 'ollama',
      model_name: 'nomic-embed-text',
      pid: 999999999,
      started_at: '2026-05-11T10:00:00.000Z',
    }));

    await expect(resolveActiveModel()).rejects.toThrow(
      /kb models add ollama nomic-embed-text --recover --yes/,
    );
  });
});

describe('active-model: isRegisteredModel / listRegisteredModels', () => {
  let faissDir: string;
  beforeEach(async () => {
    faissDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-registered-'));
    process.env.FAISS_INDEX_PATH = faissDir;
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
  });

  it('returns false when models/<id>/ is missing', async () => {
    jest.resetModules();
    const { isRegisteredModel } = await import('./active-model.js');
    expect(await isRegisteredModel(REGISTERED_ID)).toBe(false);
  });

  it('returns false when model_name.txt is missing (just a directory)', async () => {
    jest.resetModules();
    const { isRegisteredModel } = await import('./active-model.js');
    await fsp.mkdir(path.join(faissDir, 'models', REGISTERED_ID), { recursive: true });
    expect(await isRegisteredModel(REGISTERED_ID)).toBe(false);
  });

  it('returns false when .adding sentinel is present (mid-add)', async () => {
    jest.resetModules();
    const { isRegisteredModel } = await import('./active-model.js');
    await seedRegistered(faissDir);
    await fsp.writeFile(path.join(faissDir, 'models', REGISTERED_ID, '.adding'), `${process.pid}\n`);
    expect(await isRegisteredModel(REGISTERED_ID)).toBe(false);
  });

  it('returns true for a fully-set-up model', async () => {
    jest.resetModules();
    const { isRegisteredModel } = await import('./active-model.js');
    await seedRegistered(faissDir);
    expect(await isRegisteredModel(REGISTERED_ID)).toBe(true);
  });

  it('listRegisteredModels skips .adding entries', async () => {
    jest.resetModules();
    const { listRegisteredModels } = await import('./active-model.js');
    await seedRegistered(faissDir, REGISTERED_ID, 'BAAI/bge-small-en-v1.5');
    const otherId = 'ollama__nomic-embed-text-latest';
    await seedRegistered(faissDir, otherId, 'nomic-embed-text:latest');
    await fsp.writeFile(path.join(faissDir, 'models', otherId, '.adding'), `${process.pid}\n`);

    const models = await listRegisteredModels();
    expect(models.map((m) => m.model_id)).toEqual([REGISTERED_ID]);
  });

  it('listRegisteredModels skips entries with invalid slug names', async () => {
    jest.resetModules();
    const { listRegisteredModels } = await import('./active-model.js');
    await seedRegistered(faissDir);
    // Invalid slug — should be filtered.
    await fsp.mkdir(path.join(faissDir, 'models', 'NotASlug'), { recursive: true });

    const models = await listRegisteredModels();
    expect(models.map((m) => m.model_id)).toEqual([REGISTERED_ID]);
  });

  it('writes and reads structured .adding sentinel metadata', async () => {
    jest.resetModules();
    const {
      buildAddingSentinelMetadata,
      readAddingSentinel,
      writeAddingSentinel,
    } = await import('./active-model.js');
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
    } = await import('./active-model.js');

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
