import { describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const originalEnv = {
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
};

async function freshQuarantine(tempDir: string): Promise<typeof import('./ingest-quarantine.js')> {
  process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
  jest.resetModules();
  return import('./ingest-quarantine.js');
}

afterEach(() => {
  if (originalEnv.FAISS_INDEX_PATH === undefined) delete process.env.FAISS_INDEX_PATH;
  else process.env.FAISS_INDEX_PATH = originalEnv.FAISS_INDEX_PATH;
});

describe('ingest quarantine manifest', () => {
  it('records schema-versioned failures and backs off retries by relative path', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-quarantine-'));
    try {
      const kbPath = path.join(tempDir, 'kb');
      await fsp.mkdir(kbPath, { recursive: true });
      const q = await freshQuarantine(tempDir);
      const now = new Date('2026-05-12T10:00:00.000Z');
      const error = Object.assign(new Error('bad frontmatter\nsecond line'), { code: 'EINVAL' });

      const record = await q.recordIngestFailure({
        kbPath,
        relativePath: 'drafts/bad.md',
        sourceHash: 'abc123',
        error,
        now,
      });

      expect(record).toMatchObject({
        schema_version: 'ingest-quarantine.v1',
        relative_path: 'drafts/bad.md',
        source_sha256: 'abc123',
        error_code: 'EINVAL',
        retry_count: 1,
        ack: false,
        dead_lettered_at: null,
        last_attempted_at: now.toISOString(),
      });
      expect(record.error_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Date.parse(record.next_retry_at)).toBe(now.getTime() + 120_000);

      const listed = await q.listIngestQuarantine(kbPath);
      expect(listed).toEqual([record]);
      await expect(fsp.readFile(path.join(kbPath, '.index', 'quarantine.jsonl'), 'utf-8'))
        .resolves.toContain('"schema_version":"ingest-quarantine.v1"');

      expect(await q.shouldRetryIngest(kbPath, 'drafts/bad.md', {
        sourceHash: 'abc123',
        now: new Date('2026-05-12T10:01:00.000Z'),
      })).toMatchObject({
        retry: false,
        reason: 'backoff_active',
      });
      expect(await q.shouldRetryIngest(kbPath, 'drafts/bad.md', {
        sourceHash: 'abc123',
        now: new Date('2026-05-12T10:03:00.000Z'),
      })).toMatchObject({
        retry: true,
        reason: 'backoff_elapsed',
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('dead-letters after max retries, ack allows one forced retry, and success removes the entry', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-quarantine-dlq-'));
    try {
      const kbPath = path.join(tempDir, 'kb');
      await fsp.mkdir(kbPath, { recursive: true });
      const q = await freshQuarantine(tempDir);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await q.recordIngestFailure({
          kbPath,
          relativePath: 'bad.md',
          sourceHash: 'hash-a',
          error: new Error('poison input'),
          now: new Date(1_700_000_000_000 + attempt * 1000),
        });
      }

      expect(await q.shouldRetryIngest(kbPath, 'bad.md', {
        sourceHash: 'hash-a',
        now: new Date('2026-05-12T10:00:00.000Z'),
      })).toMatchObject({
        retry: false,
        reason: 'dead_lettered',
      });

      const acked = await q.ackIngestQuarantineEntry(kbPath, 'bad.md');
      expect(acked).toMatchObject({ ack: true });
      expect(await q.shouldRetryIngest(kbPath, 'bad.md', {
        sourceHash: 'hash-a',
        now: new Date('2026-05-12T10:00:00.000Z'),
      })).toMatchObject({
        retry: true,
        reason: 'forced_ack',
      });

      await expect(q.recordIngestSuccess(kbPath, 'bad.md')).resolves.toBe(true);
      await expect(q.listIngestQuarantine(kbPath)).resolves.toEqual([]);
      await expect(fsp.stat(path.join(kbPath, '.index', 'quarantine.jsonl')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('treats content hash changes as a fix and truncates oldest entries at the cap', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-quarantine-cap-'));
    try {
      const kbPath = path.join(tempDir, 'kb');
      await fsp.mkdir(kbPath, { recursive: true });
      const q = await freshQuarantine(tempDir);

      await q.recordIngestFailure({
        kbPath,
        relativePath: 'changed.md',
        sourceHash: 'old',
        error: new Error('old failure'),
        now: new Date('2026-05-12T10:00:00.000Z'),
      });
      expect(await q.shouldRetryIngest(kbPath, 'changed.md', {
        sourceHash: 'new',
        now: new Date('2026-05-12T10:01:00.000Z'),
      })).toMatchObject({
        retry: true,
        reason: 'content_changed',
      });
      await expect(q.listIngestQuarantine(kbPath)).resolves.toEqual([]);

      for (let i = 0; i < 4; i += 1) {
        await q.recordIngestFailure({
          kbPath,
          relativePath: `doc-${i}.md`,
          sourceHash: `hash-${i}`,
          error: new Error(`failure ${i}`),
          now: new Date(1_700_000_000_000 + i * 1000),
          maxEntries: 3,
        });
      }
      expect((await q.listIngestQuarantine(kbPath)).map((record) => record.relative_path))
        .toEqual(['doc-1.md', 'doc-2.md', 'doc-3.md']);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
