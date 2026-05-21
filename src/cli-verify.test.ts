import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const originalEnv = {
  KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
  HUGGINGFACE_MODEL_NAME: process.env.HUGGINGFACE_MODEL_NAME,
  HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  KB_ACTIVE_MODEL: process.env.KB_ACTIVE_MODEL,
  KB_INDEX_VERSION_RETENTION: process.env.KB_INDEX_VERSION_RETENTION,
  REINDEX_TRIGGER_PATH: process.env.REINDEX_TRIGGER_PATH,
  REINDEX_TRIGGER_POLL_MS: process.env.REINDEX_TRIGGER_POLL_MS,
  KB_FS_WATCH: process.env.KB_FS_WATCH,
  KB_LLM_ENDPOINT: process.env.KB_LLM_ENDPOINT,
  KB_RERANK: process.env.KB_RERANK,
};

const MODEL_ID = 'huggingface__BAAI-bge-small-en-v1.5';
const MODEL_NAME = 'BAAI/bge-small-en-v1.5';

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function freshModules(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  jest.resetModules();
  const verify = await import('./cli-verify.js');
  const layout = await import('./faiss-store-layout.js');
  const doctor = await import('./cli-doctor.js');
  return { verify, layout, doctor };
}

async function seedCleanFixture(tempDir: string): Promise<{
  rootDir: string;
  faissDir: string;
  modelDir: string;
  versionDir: string;
  sourcePath: string;
}> {
  const rootDir = path.join(tempDir, 'kbs');
  const faissDir = path.join(tempDir, '.faiss');
  const kbPath = path.join(rootDir, 'alpha');
  const modelDir = path.join(faissDir, 'models', MODEL_ID);
  const versionDir = path.join(modelDir, 'index.v1');
  const sourcePath = path.join(kbPath, 'note.md');
  const source = '# Note\n\nIntegrity content.\n';
  const sourceHash = sha256(source);
  const textHash = sha256('Integrity content.');
  const metadataHash = sha256('metadata');

  await fsp.mkdir(path.join(kbPath, '.index'), { recursive: true });
  await fsp.writeFile(sourcePath, source, 'utf-8');
  await fsp.writeFile(path.join(kbPath, '.index', 'note.md'), sourceHash, 'utf-8');
  await fsp.writeFile(
    path.join(kbPath, '.index', 'note.md.chunks.json'),
    JSON.stringify({
      schema_version: 'kb.chunk-manifest.v1',
      source_sha256: sourceHash,
      chunks: [{
        chunkIndex: 0,
        textHash,
        metadataHash,
        vectorDocstoreId: sha256(`0\0${textHash}\0${metadataHash}`),
      }],
    }),
    'utf-8',
  );

  await fsp.mkdir(versionDir, { recursive: true });
  await fsp.writeFile(path.join(faissDir, 'active.txt'), MODEL_ID, 'utf-8');
  await fsp.writeFile(path.join(modelDir, 'model_name.txt'), MODEL_NAME, 'utf-8');
  await fsp.writeFile(path.join(versionDir, 'faiss.index'), 'fake-index', 'utf-8');
  await fsp.writeFile(
    path.join(versionDir, 'docstore.json'),
    JSON.stringify([
      [
        ['doc-1', {
          pageContent: 'Integrity content.',
          metadata: {
            knowledgeBase: 'alpha',
            source: sourcePath,
            relativePath: 'alpha/note.md',
            extension: '.md',
          },
        }],
      ],
      { '0': 'doc-1' },
    ]),
    'utf-8',
  );
  await fsp.symlink('index.v1', path.join(modelDir, 'index'), 'dir');

  await fsp.mkdir(path.join(faissDir, 'lexical', 'alpha'), { recursive: true });
  await fsp.writeFile(
    path.join(faissDir, 'lexical', 'alpha', 'index.json'),
    JSON.stringify({
      version: 2,
      kbName: 'alpha',
      writtenAt: '2026-05-21T00:00:00.000Z',
      files: {
        'note.md': {
          sha256: sourceHash,
          chunks: [{ pageContent: 'Integrity content.', metadata: { knowledgeBase: 'alpha' } }],
        },
      },
    }),
    'utf-8',
  );

  return { rootDir, faissDir, modelDir, versionDir, sourcePath };
}

describe('kb verify --integrity', () => {
  it('parses verify flags and reports argument errors through runVerify', async () => {
    const { verify } = await freshModules({});
    expect(verify.parseVerifyArgs(['--integrity', '--format=json', '--all-versions', `--model=${MODEL_ID}`]))
      .toEqual({
        integrity: true,
        format: 'json',
        allVersions: true,
        modelId: MODEL_ID,
      });

    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(verify.runVerify(['--format=xml'])).resolves.toBe(2);
      expect(stderr.mock.calls.flat().join('')).toContain('invalid --format');
    } finally {
      stderr.mockRestore();
    }
  });

  it('runs the CLI verifier path and emits JSON with the documented exit code', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-verify-cli-'));
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const fixture = await seedCleanFixture(tempDir);
      const { verify, layout } = await freshModules({
        KNOWLEDGE_BASES_ROOT_DIR: fixture.rootDir,
        FAISS_INDEX_PATH: fixture.faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });
      await layout.writeIndexIntegrityManifest(fixture.versionDir, MODEL_ID);

      await expect(verify.runVerify(['--integrity', '--format=json'])).resolves.toBe(0);
      expect(stderr).not.toHaveBeenCalled();
      const output = stdout.mock.calls.flat().join('');
      const parsed = JSON.parse(output) as { schema_version: string; status: string; checked_versions: unknown[] };
      expect(parsed.schema_version).toBe('kb.verify.integrity.v1');
      expect(parsed.status).toBe('clean');
      expect(parsed.checked_versions).toHaveLength(1);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('maps invalid model identifiers to the documented argument exit code', async () => {
    const { verify } = await freshModules({});
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(verify.runVerify(['--integrity', '--model=../../x'])).resolves.toBe(2);
      expect(stderr.mock.calls.flat().join('')).toContain('Invalid model_id');
    } finally {
      stderr.mockRestore();
    }
  });

  it('requires --integrity on the runtime CLI path', async () => {
    const { verify } = await freshModules({});
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(verify.runVerify([])).resolves.toBe(2);
      expect(stderr.mock.calls.flat().join('')).toContain('--integrity is required');
    } finally {
      stderr.mockRestore();
    }
  });

  it('returns clean for matching index manifests, sidecars, chunk manifests, and lexical counts', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-verify-clean-'));
    try {
      const fixture = await seedCleanFixture(tempDir);
      const { verify, layout } = await freshModules({
        KNOWLEDGE_BASES_ROOT_DIR: fixture.rootDir,
        FAISS_INDEX_PATH: fixture.faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });
      await layout.writeIndexIntegrityManifest(fixture.versionDir, MODEL_ID);
      await fsp.writeFile(
        path.join(fixture.rootDir, 'alpha', '.index', 'quarantine.jsonl'),
        JSON.stringify({ schema_version: 'ingest-quarantine.v1' }) + '\n',
        'utf-8',
      );

      const report = await verify.verifyIntegrity();

      expect(report.status).toBe('clean');
      expect(report.checked_versions).toHaveLength(1);
      expect(report.checked_versions[0]).toMatchObject({
        version: 'index.v1',
        active: true,
        dense_chunks: 1,
      });
      expect(report.dense_chunks_by_kb).toEqual({ alpha: 1 });
      expect(report.lexical_chunks_by_kb).toEqual({ alpha: 1 });
      expect(report.findings).toEqual([]);
      expect(verify.integrityExitCode(report)).toBe(0);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('classifies an index hash mismatch as corruption', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-verify-corrupt-'));
    try {
      const fixture = await seedCleanFixture(tempDir);
      const { verify, layout } = await freshModules({
        KNOWLEDGE_BASES_ROOT_DIR: fixture.rootDir,
        FAISS_INDEX_PATH: fixture.faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });
      await layout.writeIndexIntegrityManifest(fixture.versionDir, MODEL_ID);
      await fsp.writeFile(path.join(fixture.versionDir, 'faiss.index'), 'tampered-index', 'utf-8');

      const report = await verify.verifyIntegrity();

      expect(report.status).toBe('corruption');
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: 'corruption', code: 'INDEX_HASH_MISMATCH' }),
      ]));
      expect(verify.integrityExitCode(report)).toBe(2);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('classifies stale source sidecars and orphan sidecars as drift', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-verify-drift-'));
    try {
      const fixture = await seedCleanFixture(tempDir);
      const { verify, layout } = await freshModules({
        KNOWLEDGE_BASES_ROOT_DIR: fixture.rootDir,
        FAISS_INDEX_PATH: fixture.faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
      });
      await layout.writeIndexIntegrityManifest(fixture.versionDir, MODEL_ID);
      await fsp.writeFile(fixture.sourcePath, '# Note\n\nChanged content.\n', 'utf-8');
      await fsp.writeFile(
        path.join(fixture.rootDir, 'alpha', '.index', 'removed.md'),
        '0'.repeat(64),
        'utf-8',
      );

      const report = await verify.verifyIntegrity();

      expect(report.status).toBe('drift');
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: 'drift', code: 'CONTENT_HASH_MISMATCH' }),
        expect.objectContaining({ severity: 'drift', code: 'CHUNK_MANIFEST_SOURCE_HASH_MISMATCH' }),
        expect.objectContaining({ severity: 'drift', code: 'ORPHAN_SIDECAR' }),
      ]));
      expect(verify.integrityExitCode(report)).toBe(1);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('wires the slow integrity audit into doctor only when requested', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-doctor-integrity-'));
    try {
      const fixture = await seedCleanFixture(tempDir);
      const { layout, doctor } = await freshModules({
        KNOWLEDGE_BASES_ROOT_DIR: fixture.rootDir,
        FAISS_INDEX_PATH: fixture.faissDir,
        EMBEDDING_PROVIDER: 'huggingface',
        HUGGINGFACE_MODEL_NAME: MODEL_NAME,
        HUGGINGFACE_API_KEY: 'test-key',
        KB_LLM_ENDPOINT: 'http://127.0.0.1:8080',
      });
      await layout.writeIndexIntegrityManifest(fixture.versionDir, MODEL_ID);

      expect(doctor.parseDoctorArgs(['--slow'])).toMatchObject({ integrity: true });

      const report = await doctor.buildDoctorReport({
        integrity: true,
        backendHealthCheck: async () => ({ healthy: true, detail: 'backend ok' }),
        packageRoot: tempDir,
        invokedPath: null,
        packageVersion: '9.9.9',
        llmEndpointProbe: async (endpoint: string) => ({
          endpoint,
          health_url: 'http://127.0.0.1:8080/health',
          health_ok: true,
          chat_ok: true,
          detail: 'health and chat completion succeeded',
        }),
      });

      expect(report.integrity?.status).toBe('clean');
      expect(report.checks).toContainEqual({
        name: 'integrity',
        status: 'ok',
        detail: 'deep integrity audit found no drift',
      });
      expect(doctor.formatDoctorMarkdown(report)).toContain('Integrity:\n  Status: CLEAN');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
