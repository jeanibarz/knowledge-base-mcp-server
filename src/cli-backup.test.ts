import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const originalEnv = {
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
  KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
  HUGGINGFACE_MODEL_NAME: process.env.HUGGINGFACE_MODEL_NAME,
  KB_ACTIVE_MODEL: process.env.KB_ACTIVE_MODEL,
  KB_MIN_FREE_DISK_BYTES: process.env.KB_MIN_FREE_DISK_BYTES,
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

async function freshBackupModule(faissDir: string) {
  process.env.FAISS_INDEX_PATH = faissDir;
  process.env.EMBEDDING_PROVIDER = 'huggingface';
  process.env.HUGGINGFACE_MODEL_NAME = MODEL_NAME;
  process.env.KB_ACTIVE_MODEL = MODEL_ID;
  jest.resetModules();
  return import('./cli-backup.js');
}

async function seedModel(faissDir: string, version = 'index.v3'): Promise<{
  modelDir: string;
  versionDir: string;
}> {
  const modelDir = path.join(faissDir, 'models', MODEL_ID);
  const versionDir = path.join(modelDir, version);
  const faissBytes = `faiss-${version}`;
  const docstoreBytes = JSON.stringify([
    [
      ['doc-1', {
        pageContent: 'Backup fixture content.',
        metadata: {
          knowledgeBase: 'alpha',
          relativePath: 'alpha/note.md',
          source: '/kbs/alpha/note.md',
          extension: '.md',
        },
      }],
    ],
    { '0': 'doc-1' },
  ]);

  await fsp.mkdir(versionDir, { recursive: true });
  await fsp.writeFile(path.join(faissDir, 'active.txt'), MODEL_ID, 'utf-8');
  await fsp.writeFile(path.join(modelDir, 'model_name.txt'), MODEL_NAME, 'utf-8');
  await fsp.writeFile(path.join(modelDir, 'index-type.txt'), 'flat\n', 'utf-8');
  await fsp.writeFile(path.join(modelDir, 'last-index-update.json'), '{"ok":true}\n', 'utf-8');
  await fsp.writeFile(path.join(modelDir, 'freshness.json'), '{"schema_version":"kb.freshness-manifest.v1"}\n', 'utf-8');
  await fsp.writeFile(path.join(modelDir, 'metadata-sidecar.jsonl'), '{"schema_version":"kb.metadata-sidecar.v1"}\n', 'utf-8');
  await fsp.writeFile(path.join(versionDir, 'faiss.index'), faissBytes, 'utf-8');
  await fsp.writeFile(path.join(versionDir, 'docstore.json'), docstoreBytes, 'utf-8');
  await fsp.writeFile(
    path.join(versionDir, 'integrity.json'),
    `${JSON.stringify({
      schema_version: 'kb.index-integrity.v1',
      written_at: '2026-06-12T00:00:00.000Z',
      model_id: MODEL_ID,
      index_type: 'flat',
      files: {
        'faiss.index': { sha256: sha256(faissBytes) },
        'docstore.json': { sha256: sha256(docstoreBytes) },
      },
    }, null, 2)}\n`,
    'utf-8',
  );
  await fsp.symlink(version, path.join(modelDir, 'index'), 'dir');
  return { modelDir, versionDir };
}

describe('kb backup', () => {
  it('writes a checksum manifest for the active model snapshot and releases the write lock', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-backup-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      const outputDir = path.join(tmp, 'snapshot');
      const { modelDir } = await seedModel(faissDir);
      const backup = await freshBackupModule(faissDir);

      const result = await backup.createBackup({ outputDir, modelId: MODEL_ID });

      expect(result.manifest).toMatchObject({
        schema_version: 'kb.backup.v1',
        model_id: MODEL_ID,
        active_version: 'index.v3',
      });
      const manifest = JSON.parse(
        await fsp.readFile(path.join(outputDir, 'backup-manifest.json'), 'utf-8'),
      ) as { files: Array<{ path: string; sha256: string }> };
      const paths = manifest.files.map((file) => file.path);
      expect(paths).toEqual(expect.arrayContaining([
        `models/${MODEL_ID}/model_name.txt`,
        `models/${MODEL_ID}/index-type.txt`,
        `models/${MODEL_ID}/last-index-update.json`,
        `models/${MODEL_ID}/freshness.json`,
        `models/${MODEL_ID}/metadata-sidecar.jsonl`,
        `models/${MODEL_ID}/index.v3/faiss.index`,
        `models/${MODEL_ID}/index.v3/docstore.json`,
        `models/${MODEL_ID}/index.v3/integrity.json`,
      ]));
      expect(await fsp.readFile(path.join(outputDir, 'models', MODEL_ID, 'index.v3', 'faiss.index'), 'utf-8'))
        .toBe('faiss-index.v3');
      await expect(fsp.stat(path.join(modelDir, '.kb-write.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses an incomplete active version before publishing the output directory', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-backup-partial-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      const outputDir = path.join(tmp, 'snapshot');
      const { versionDir } = await seedModel(faissDir);
      await fsp.rm(path.join(versionDir, 'integrity.json'));
      const backup = await freshBackupModule(faissDir);

      await expect(backup.createBackup({ outputDir, modelId: MODEL_ID }))
        .rejects.toThrow(/active index is incomplete/);
      await expect(fsp.stat(outputDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses checksum mismatches when validating a backup directory', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-backup-validate-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      const outputDir = path.join(tmp, 'snapshot');
      await seedModel(faissDir);
      const backup = await freshBackupModule(faissDir);
      await backup.createBackup({ outputDir, modelId: MODEL_ID });
      await fsp.writeFile(
        path.join(outputDir, 'models', MODEL_ID, 'index.v3', 'docstore.json'),
        'tampered',
        'utf-8',
      );

      await expect(backup.validateBackupDirectory(outputDir))
        .rejects.toThrow(/checksum validation failed/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses unsafe destinations under the live FAISS root', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-backup-unsafe-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      await seedModel(faissDir);
      const backup = await freshBackupModule(faissDir);

      await expect(backup.createBackup({
        outputDir: path.join(faissDir, 'snapshots', 'bad'),
        modelId: MODEL_ID,
      })).rejects.toThrow(/unsafe backup destination/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // Issue #908 — disk-space preflight before any snapshot copy.
  it('refuses with INSUFFICIENT_DISK_SPACE before writing the snapshot when free space is short', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-backup-disk-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      const outputDir = path.join(tmp, 'snapshot');
      await seedModel(faissDir);
      // Impossible margin forces the preflight to refuse regardless of real free space.
      process.env.KB_MIN_FREE_DISK_BYTES = String(Number.MAX_SAFE_INTEGER);
      const backup = await freshBackupModule(faissDir);

      let thrown: unknown;
      try {
        await backup.createBackup({ outputDir, modelId: MODEL_ID });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      const { KBError } = await import('./errors.js');
      expect(thrown).toBeInstanceOf(KBError);
      expect((thrown as InstanceType<typeof KBError>).code).toBe('INSUFFICIENT_DISK_SPACE');
      expect((thrown as Error).message).toMatch(/Insufficient disk space for backup/);
      expect((thrown as Error).message).toMatch(/need ~/);
      expect((thrown as Error).message).toMatch(/have .* free/);
      // No published output and no leftover tmp dir.
      await expect(fsp.stat(outputDir)).rejects.toMatchObject({ code: 'ENOENT' });
      const leftovers = (await fsp.readdir(tmp)).filter((name) => name.includes('.tmp.'));
      expect(leftovers).toEqual([]);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('proceeds with a normal backup when free space is sufficient', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-backup-disk-ok-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      const outputDir = path.join(tmp, 'snapshot');
      await seedModel(faissDir);
      // Explicit small margin so ambient free space always clears the guard.
      process.env.KB_MIN_FREE_DISK_BYTES = '0';
      const backup = await freshBackupModule(faissDir);

      const result = await backup.createBackup({ outputDir, modelId: MODEL_ID });
      expect(result.manifest.model_id).toBe(MODEL_ID);
      expect(await fsp.readFile(path.join(outputDir, 'backup-manifest.json'), 'utf-8')).toMatch(
        /kb\.backup\.v1/,
      );
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
