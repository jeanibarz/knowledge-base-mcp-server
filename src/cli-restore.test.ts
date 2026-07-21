import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

jest.setTimeout(15_000);

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

async function freshModules(faissDir: string) {
  process.env.FAISS_INDEX_PATH = faissDir;
  process.env.EMBEDDING_PROVIDER = 'huggingface';
  process.env.HUGGINGFACE_MODEL_NAME = MODEL_NAME;
  process.env.KB_ACTIVE_MODEL = MODEL_ID;
  jest.resetModules();
  const backup = await import('./cli-backup.js');
  const restore = await import('./cli-restore.js');
  return { backup, restore };
}

async function seedModelVersion(args: {
  faissDir: string;
  version: string;
  faissBytes: string;
  docstoreBytes: string;
  makeActive?: boolean;
}): Promise<string> {
  const modelDir = path.join(args.faissDir, 'models', MODEL_ID);
  const versionDir = path.join(modelDir, args.version);
  await fsp.mkdir(versionDir, { recursive: true });
  await fsp.writeFile(path.join(args.faissDir, 'active.txt'), MODEL_ID, 'utf-8');
  await fsp.writeFile(path.join(modelDir, 'model_name.txt'), MODEL_NAME, 'utf-8');
  await fsp.writeFile(path.join(modelDir, 'index-type.txt'), 'flat\n', 'utf-8');
  await fsp.writeFile(path.join(modelDir, 'last-index-update.json'), `{"version":"${args.version}"}\n`, 'utf-8');
  await fsp.writeFile(path.join(modelDir, 'metadata-sidecar.jsonl'), `{"version":"${args.version}"}\n`, 'utf-8');
  await fsp.writeFile(path.join(versionDir, 'faiss.index'), args.faissBytes, 'utf-8');
  await fsp.writeFile(path.join(versionDir, 'docstore.json'), args.docstoreBytes, 'utf-8');
  await fsp.writeFile(
    path.join(versionDir, 'integrity.json'),
    `${JSON.stringify({
      schema_version: 'kb.index-integrity.v1',
      written_at: '2026-06-12T00:00:00.000Z',
      model_id: MODEL_ID,
      index_type: 'flat',
      files: {
        'faiss.index': { sha256: sha256(args.faissBytes) },
        'docstore.json': { sha256: sha256(args.docstoreBytes) },
      },
    }, null, 2)}\n`,
    'utf-8',
  );
  if (args.makeActive) {
    await fsp.rm(path.join(modelDir, 'index'), { force: true });
    await fsp.symlink(args.version, path.join(modelDir, 'index'), 'dir');
  }
  return versionDir;
}

describe('kb restore', () => {
  it('validates the backup and atomically swaps the live model to a new index version', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-restore-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      const outputDir = path.join(tmp, 'snapshot');
      const modelDir = path.join(faissDir, 'models', MODEL_ID);
      const { backup, restore } = await freshModules(faissDir);
      await seedModelVersion({
        faissDir,
        version: 'index.v1',
        faissBytes: 'good-faiss',
        docstoreBytes: 'good-docstore',
        makeActive: true,
      });
      await backup.createBackup({ outputDir, modelId: MODEL_ID });
      await seedModelVersion({
        faissDir,
        version: 'index.v4',
        faissBytes: 'bad-faiss',
        docstoreBytes: 'bad-docstore',
        makeActive: true,
      });
      await fsp.writeFile(path.join(modelDir, 'metadata-sidecar.jsonl'), 'live-sidecar\n', 'utf-8');
      await fsp.writeFile(path.join(modelDir, 'pending-manifest.json'), '{"phase":"save-started"}\n', 'utf-8');

      const result = await restore.restoreBackup({ fromDir: outputDir });

      expect(result).toEqual({
        modelId: MODEL_ID,
        backupVersion: 'index.v1',
        restoredVersion: 'index.v5',
      });
      expect(await fsp.readlink(path.join(modelDir, 'index'))).toBe('index.v5');
      expect(await fsp.readFile(path.join(modelDir, 'index.v5', 'faiss.index'), 'utf-8')).toBe('good-faiss');
      expect(await fsp.readFile(path.join(modelDir, 'index.v5', 'docstore.json'), 'utf-8')).toBe('good-docstore');
      expect(await fsp.readFile(path.join(modelDir, 'metadata-sidecar.jsonl'), 'utf-8')).toContain('index.v1');
      await expect(fsp.stat(path.join(modelDir, 'pending-manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fsp.readFile(path.join(modelDir, 'index.v4', 'faiss.index'), 'utf-8')).toBe('bad-faiss');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses checksum mismatches before changing live state', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-restore-checksum-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      const outputDir = path.join(tmp, 'snapshot');
      const modelDir = path.join(faissDir, 'models', MODEL_ID);
      const { backup, restore } = await freshModules(faissDir);
      await seedModelVersion({
        faissDir,
        version: 'index.v1',
        faissBytes: 'backup-faiss',
        docstoreBytes: 'backup-docstore',
        makeActive: true,
      });
      await backup.createBackup({ outputDir, modelId: MODEL_ID });
      await seedModelVersion({
        faissDir,
        version: 'index.v2',
        faissBytes: 'live-faiss',
        docstoreBytes: 'live-docstore',
        makeActive: true,
      });
      await fsp.writeFile(path.join(outputDir, 'models', MODEL_ID, 'index.v1', 'faiss.index'), 'tampered', 'utf-8');

      await expect(restore.restoreBackup({ fromDir: outputDir }))
        .rejects.toThrow(/checksum validation failed/);
      expect(await fsp.readlink(path.join(modelDir, 'index'))).toBe('index.v2');
      await expect(fsp.stat(path.join(modelDir, 'index.v3'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fsp.readFile(path.join(modelDir, 'index.v2', 'faiss.index'), 'utf-8')).toBe('live-faiss');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses partial backups before changing live state', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-restore-partial-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      const outputDir = path.join(tmp, 'snapshot');
      const modelDir = path.join(faissDir, 'models', MODEL_ID);
      const { backup, restore } = await freshModules(faissDir);
      await seedModelVersion({
        faissDir,
        version: 'index.v1',
        faissBytes: 'backup-faiss',
        docstoreBytes: 'backup-docstore',
        makeActive: true,
      });
      await backup.createBackup({ outputDir, modelId: MODEL_ID });
      await seedModelVersion({
        faissDir,
        version: 'index.v2',
        faissBytes: 'live-faiss',
        docstoreBytes: 'live-docstore',
        makeActive: true,
      });
      await fsp.rm(path.join(outputDir, 'models', MODEL_ID, 'index.v1', 'docstore.json'));

      await expect(restore.restoreBackup({ fromDir: outputDir }))
        .rejects.toThrow(/partial backup/);
      expect(await fsp.readlink(path.join(modelDir, 'index'))).toBe('index.v2');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses restore sources under the live FAISS root', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-restore-unsafe-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      const { restore } = await freshModules(faissDir);

      await expect(restore.restoreBackup({ fromDir: path.join(faissDir, 'snapshots', 'bad') }))
        .rejects.toThrow(/unsafe restore source/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // Issue #908 — disk-space preflight before any staging write.
  it('refuses with INSUFFICIENT_DISK_SPACE before staging when free space is short', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-restore-disk-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      const outputDir = path.join(tmp, 'snapshot');
      const modelDir = path.join(faissDir, 'models', MODEL_ID);
      // Zero margin so ambient free space always clears the backup preflight.
      process.env.KB_MIN_FREE_DISK_BYTES = '0';
      const { backup } = await freshModules(faissDir);
      await seedModelVersion({
        faissDir,
        version: 'index.v1',
        faissBytes: 'backup-faiss',
        docstoreBytes: 'backup-docstore',
        makeActive: true,
      });
      await backup.createBackup({ outputDir, modelId: MODEL_ID });
      await seedModelVersion({
        faissDir,
        version: 'index.v2',
        faissBytes: 'live-faiss',
        docstoreBytes: 'live-docstore',
        makeActive: true,
      });

      // Impossible margin forces restore preflight to refuse.
      process.env.KB_MIN_FREE_DISK_BYTES = String(Number.MAX_SAFE_INTEGER);
      const { restore } = await freshModules(faissDir);

      let thrown: unknown;
      try {
        await restore.restoreBackup({ fromDir: outputDir });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      const { KBError } = await import('./errors.js');
      expect(thrown).toBeInstanceOf(KBError);
      expect((thrown as InstanceType<typeof KBError>).code).toBe('INSUFFICIENT_DISK_SPACE');
      expect((thrown as Error).message).toMatch(/Insufficient disk space for restore/);
      expect((thrown as Error).message).toMatch(/need ~/);
      expect((thrown as Error).message).toMatch(/have .* free/);
      // Live state untouched: still index.v2, no new version, no staging leftovers.
      expect(await fsp.readlink(path.join(modelDir, 'index'))).toBe('index.v2');
      await expect(fsp.stat(path.join(modelDir, 'index.v3'))).rejects.toMatchObject({ code: 'ENOENT' });
      const leftovers = (await fsp.readdir(modelDir)).filter((name) => name.includes('.restore.tmp.'));
      expect(leftovers).toEqual([]);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('proceeds with a normal restore when free space is sufficient', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-restore-disk-ok-'));
    try {
      const faissDir = path.join(tmp, '.faiss');
      const outputDir = path.join(tmp, 'snapshot');
      const modelDir = path.join(faissDir, 'models', MODEL_ID);
      process.env.KB_MIN_FREE_DISK_BYTES = '0';
      const { backup, restore } = await freshModules(faissDir);
      await seedModelVersion({
        faissDir,
        version: 'index.v1',
        faissBytes: 'good-faiss',
        docstoreBytes: 'good-docstore',
        makeActive: true,
      });
      await backup.createBackup({ outputDir, modelId: MODEL_ID });
      await seedModelVersion({
        faissDir,
        version: 'index.v2',
        faissBytes: 'live-faiss',
        docstoreBytes: 'live-docstore',
        makeActive: true,
      });

      const result = await restore.restoreBackup({ fromDir: outputDir });
      expect(result.restoredVersion).toBe('index.v3');
      expect(await fsp.readlink(path.join(modelDir, 'index'))).toBe('index.v3');
      expect(await fsp.readFile(path.join(modelDir, 'index.v3', 'faiss.index'), 'utf-8')).toBe(
        'good-faiss',
      );
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
