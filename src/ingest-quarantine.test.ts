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

  it('can read a manifest without creating the global sidecar lock directory', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-quarantine-readonly-'));
    try {
      const kbPath = path.join(tempDir, 'kb');
      await fsp.mkdir(kbPath, { recursive: true });
      const q = await freshQuarantine(tempDir);

      await expect(q.listIngestQuarantine(kbPath, { useLock: false })).resolves.toEqual([]);
      await expect(fsp.stat(path.join(tempDir, '.faiss')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves POSIX backslashes in relative paths', async () => {
    if (path.sep !== '/') return;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-quarantine-posix-'));
    try {
      const kbPath = path.join(tempDir, 'kb');
      await fsp.mkdir(kbPath, { recursive: true });
      const q = await freshQuarantine(tempDir);
      const relativePath = 'secret\\file.md';

      const record = await q.recordIngestFailure({
        kbPath,
        relativePath,
        error: new Error('poison input'),
      });

      expect(record.relative_path).toBe(relativePath);
      await expect(q.getIngestQuarantineRecord(kbPath, relativePath)).resolves.toMatchObject({
        relative_path: relativePath,
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

  it('skips torn/malformed JSONL lines and still returns valid quarantine records', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-quarantine-torn-'));
    try {
      const kbPath = path.join(tempDir, 'kb');
      await fsp.mkdir(kbPath, { recursive: true });
      const q = await freshQuarantine(tempDir);

      const good = await q.recordIngestFailure({
        kbPath,
        relativePath: 'good.md',
        sourceHash: 'hash-good',
        error: Object.assign(new Error('poison'), { code: 'EINVAL' }),
        now: new Date('2026-05-12T10:00:00.000Z'),
      });
      const second = await q.recordIngestFailure({
        kbPath,
        relativePath: 'also-good.md',
        sourceHash: 'hash-also',
        error: Object.assign(new Error('still poison'), { code: 'EACCES' }),
        now: new Date('2026-05-12T10:01:00.000Z'),
      });

      const manifestPath = path.join(kbPath, '.index', 'quarantine.jsonl');
      // Compose a dirty manifest: valid rows + interior garbage + torn tail +
      // schema-invalid-but-parseable JSON. Mimics crash/corruption without
      // changing the writer.
      const expected = [good, second].sort((a, b) => a.relative_path.localeCompare(b.relative_path));
      await fsp.writeFile(
        manifestPath,
        [
          JSON.stringify(good),
          'this is not json at all',
          JSON.stringify(second),
          '{"schema_version":"ingest-quarant', // torn / truncated line
          '{"schema_version":"wrong.v0","relative_path":"ignored.md"}',
          '',
        ].join('\n'),
        'utf-8',
      );

      await expect(q.listIngestQuarantine(kbPath)).resolves.toEqual(expected);
      await expect(q.listIngestQuarantine(kbPath, { useLock: false })).resolves.toEqual(expected);

      // Hot-path consumer must not throw either.
      await expect(q.shouldRetryIngest(kbPath, 'good.md', {
        sourceHash: 'hash-good',
        now: new Date('2026-05-12T10:00:30.000Z'),
      })).resolves.toMatchObject({
        retry: false,
        reason: 'backoff_active',
      });
      await expect(q.shouldRetryIngest(kbPath, 'unrelated.md', {
        sourceHash: 'x',
        now: new Date('2026-05-12T10:00:00.000Z'),
      })).resolves.toMatchObject({
        retry: true,
        reason: 'no_record',
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
