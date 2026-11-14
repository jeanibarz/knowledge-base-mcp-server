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
  describe('per-refresh snapshot and no-op writes', () => {
    async function withQuarantine(
      run: (ctx: {
        q: typeof import('./ingest-quarantine.js');
        kbPath: string;
        lockCalls: () => number;
      }) => Promise<void>,
    ): Promise<void> {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-quarantine-snap-'));
      try {
        const kbPath = path.join(tempDir, 'kb');
        await fsp.mkdir(kbPath, { recursive: true });
        process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
        jest.resetModules();
        let calls = 0;
        jest.doMock('./write-lock.js', () => {
          const actual = jest.requireActual('./write-lock.js') as typeof import('./write-lock.js');
          return {
            ...actual,
            withSidecarLock: <T>(action: () => Promise<T>) => {
              calls += 1;
              return actual.withSidecarLock(action);
            },
          };
        });
        const q = await import('./ingest-quarantine.js');
        await run({ q, kbPath, lockCalls: () => calls });
      } finally {
        jest.dontMock('./write-lock.js');
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    }

    it('takes O(1) locks and never touches the manifest for 100 unchanged files with no quarantine', async () => {
      await withQuarantine(async ({ q, kbPath, lockCalls }) => {
        const snapshot = new q.IngestQuarantineSnapshot();
        for (let i = 0; i < 100; i += 1) {
          await expect(
            q.shouldRetryIngest(kbPath, `f${i}.md`, { sourceHash: `h${i}`, snapshot }),
          ).resolves.toMatchObject({ retry: true, reason: 'no_record' });
          await expect(q.recordIngestSuccess(kbPath, `f${i}.md`, { snapshot })).resolves.toBe(false);
        }
        expect(lockCalls()).toBe(1);
        await expect(fsp.stat(q.quarantineManifestPath(kbPath))).rejects.toMatchObject({ code: 'ENOENT' });
      });
    });

    it('does not rewrite the manifest for files without a record, and still honours the one that has one', async () => {
      await withQuarantine(async ({ q, kbPath, lockCalls }) => {
        const now = new Date('2026-05-12T10:00:00.000Z');
        await q.recordIngestFailure({
          kbPath,
          relativePath: 'bad.md',
          sourceHash: 'bad-hash',
          error: Object.assign(new Error('boom'), { code: 'EINVAL' }),
          now,
        });
        const manifest = q.quarantineManifestPath(kbPath);
        const before = await fsp.stat(manifest);
        const locksBefore = lockCalls();
        const snapshot = new q.IngestQuarantineSnapshot();

        await expect(
          q.shouldRetryIngest(kbPath, 'bad.md', { sourceHash: 'bad-hash', snapshot, now: new Date(now.getTime() + 1000) }),
        ).resolves.toMatchObject({ retry: false, reason: 'backoff_active' });
        for (let i = 0; i < 99; i += 1) {
          await q.recordIngestSuccess(kbPath, `ok${i}.md`, { snapshot });
        }

        expect(lockCalls() - locksBefore).toBe(1);
        const after = await fsp.stat(manifest);
        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).toBe(before.mtimeMs);

        // A successful retry still clears the record, on disk and in the snapshot.
        await expect(q.recordIngestSuccess(kbPath, 'bad.md', { snapshot })).resolves.toBe(true);
        await expect(q.listIngestQuarantine(kbPath)).resolves.toEqual([]);
        await expect(snapshot.get(kbPath, 'bad.md')).resolves.toBeNull();
      });
    });

    it('resets a record on content change and sees failures recorded later in the same run', async () => {
      await withQuarantine(async ({ q, kbPath }) => {
        const now = new Date('2026-05-12T10:00:00.000Z');
        await q.recordIngestFailure({
          kbPath, relativePath: 'bad.md', sourceHash: 'old', error: new Error('boom'), now,
        });
        const snapshot = new q.IngestQuarantineSnapshot();
        await expect(
          q.shouldRetryIngest(kbPath, 'bad.md', { sourceHash: 'new', snapshot, now }),
        ).resolves.toMatchObject({ retry: true, reason: 'content_changed' });
        await expect(q.listIngestQuarantine(kbPath)).resolves.toEqual([]);

        const record = await q.recordIngestFailure({
          kbPath, relativePath: 'later.md', sourceHash: 'h', error: new Error('boom'), now,
        });
        await snapshot.set(kbPath, record);
        await expect(
          q.shouldRetryIngest(kbPath, 'later.md', { sourceHash: 'h', snapshot, now: new Date(now.getTime() + 1000) }),
        ).resolves.toMatchObject({ retry: false, reason: 'backoff_active' });
      });
    });

    it('mutateManifest-backed operations leave the file alone when nothing changes', async () => {
      await withQuarantine(async ({ q, kbPath }) => {
        await q.recordIngestFailure({ kbPath, relativePath: 'bad.md', error: new Error('boom') });
        const manifest = q.quarantineManifestPath(kbPath);
        const before = await fsp.stat(manifest);
        await expect(q.removeIngestQuarantineEntry(kbPath, 'absent.md')).resolves.toBe(false);
        await expect(q.ackIngestQuarantineEntry(kbPath, 'absent.md')).resolves.toBeNull();
        const after = await fsp.stat(manifest);
        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).toBe(before.mtimeMs);
      });
    });
  });

  describe('model-scoped provider failures (#1258)', () => {
    const now = new Date('2026-05-12T10:00:00.000Z');
    const soon = new Date(now.getTime() + 1000);

    async function withQ(
      fn: (ctx: { q: typeof import('./ingest-quarantine.js'); kbPath: string; providerError: Error }) => Promise<void>,
    ): Promise<void> {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-quarantine-model-'));
      try {
        const kbPath = path.join(tempDir, 'kb');
        await fsp.mkdir(kbPath, { recursive: true });
        const q = await freshQuarantine(tempDir);
        // Import after the module reset so the error class matches the one q's classifier checks.
        const { KBError } = await import('./errors.js');
        await fn({ q, kbPath, providerError: new KBError('PROVIDER_TIMEOUT', 'timed out') });
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    }

    it('scopes only provider failures that carry a modelId; everything else stays KB-wide', async () => {
      await withQ(async ({ q, kbPath, providerError }) => {
        const scoped = await q.recordIngestFailure({
          kbPath, relativePath: 'a.md', error: providerError, modelId: 'm1', now,
        });
        expect(scoped).toMatchObject({ error_category: 'provider', model_id: 'm1' });
        const wide = await q.recordIngestFailure({
          kbPath, relativePath: 'b.md', error: Object.assign(new Error('bad'), { code: 'EINVAL' }), modelId: 'm1', now,
        });
        expect(wide.model_id).toBeUndefined();
        const noModel = await q.recordIngestFailure({
          kbPath, relativePath: 'c.md', error: providerError, now,
        });
        expect(noModel.model_id).toBeUndefined();
        const raw = await fsp.readFile(q.quarantineManifestPath(kbPath), 'utf-8');
        expect(raw).toContain('"model_id":"m1"');
        expect((await q.listIngestQuarantine(kbPath)).find((r) => r.relative_path === 'a.md')?.model_id).toBe('m1');
        expect(await q.countIngestQuarantine(kbPath)).toBe(3);
      });
    });

    it('keys by (model, path): repeat failures update only that model, other models never block', async () => {
      await withQ(async ({ q, kbPath, providerError }) => {
        await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError, modelId: 'B', sourceHash: 'h', now });
        const again = await q.recordIngestFailure({
          kbPath, relativePath: 'a.md', error: providerError, modelId: 'B', sourceHash: 'h', now,
        });
        expect(again.retry_count).toBe(2);
        await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError, modelId: 'C', sourceHash: 'h', now });
        const all = await q.listIngestQuarantine(kbPath);
        expect(all.map((r) => [r.model_id, r.retry_count])).toEqual([['B', 2], ['C', 1]]);

        await expect(q.shouldRetryIngest(kbPath, 'a.md', { sourceHash: 'h', now: soon, modelId: 'A' }))
          .resolves.toMatchObject({ retry: true, reason: 'no_record' });
        await expect(q.shouldRetryIngest(kbPath, 'a.md', { sourceHash: 'h', now: soon, modelId: 'B' }))
          .resolves.toMatchObject({ retry: false, reason: 'backoff_active' });
        // Same answers through a snapshot.
        const snapshot = new q.IngestQuarantineSnapshot();
        await expect(q.shouldRetryIngest(kbPath, 'a.md', { sourceHash: 'h', now: soon, modelId: 'A', snapshot }))
          .resolves.toMatchObject({ retry: true, reason: 'no_record' });
        await expect(q.shouldRetryIngest(kbPath, 'a.md', { sourceHash: 'h', now: soon, modelId: 'C', snapshot }))
          .resolves.toMatchObject({ retry: false, reason: 'backoff_active' });
      });
    });

    it('a KB-wide record still blocks every model, but legacy KB-wide provider records are ignored given a modelId', async () => {
      await withQ(async ({ q, kbPath, providerError }) => {
        await q.recordIngestFailure({
          kbPath, relativePath: 'bad.md', error: Object.assign(new Error('bad'), { code: 'EINVAL' }), sourceHash: 'h', now,
        });
        await q.recordIngestFailure({ kbPath, relativePath: 'legacy.md', error: providerError, sourceHash: 'h', now });
        await expect(q.shouldRetryIngest(kbPath, 'bad.md', { sourceHash: 'h', now: soon, modelId: 'A' }))
          .resolves.toMatchObject({ retry: false, reason: 'backoff_active' });
        await expect(q.shouldRetryIngest(kbPath, 'legacy.md', { sourceHash: 'h', now: soon, modelId: 'A' }))
          .resolves.toMatchObject({ retry: true, reason: 'no_record' });
        // Without a modelId behaviour is unchanged.
        await expect(q.shouldRetryIngest(kbPath, 'legacy.md', { sourceHash: 'h', now: soon }))
          .resolves.toMatchObject({ retry: false, reason: 'backoff_active' });
      });
    });

    it('a content change removes every record for the path; success removes own + KB-wide only', async () => {
      await withQ(async ({ q, kbPath, providerError }) => {
        const wideErr = Object.assign(new Error('bad'), { code: 'EINVAL' });
        for (const modelId of ['A', 'B']) {
          await q.recordIngestFailure({ kbPath, relativePath: 'p.md', error: providerError, modelId, sourceHash: 'h', now });
        }
        await q.recordIngestFailure({ kbPath, relativePath: 'p.md', error: wideErr, sourceHash: 'h', now });
        const snapshot = new q.IngestQuarantineSnapshot();
        await expect(q.recordIngestSuccess(kbPath, 'p.md', { modelId: 'A', snapshot })).resolves.toBe(true);
        expect((await q.listIngestQuarantine(kbPath)).map((r) => r.model_id)).toEqual(['B']);
        await expect(q.shouldRetryIngest(kbPath, 'p.md', { sourceHash: 'new', modelId: 'B', snapshot, now: soon }))
          .resolves.toMatchObject({ retry: true, reason: 'content_changed' });
        await expect(q.listIngestQuarantine(kbPath)).resolves.toEqual([]);

        await q.recordIngestFailure({ kbPath, relativePath: 'p.md', error: providerError, modelId: 'A', sourceHash: 'h', now });
        await q.recordIngestFailure({ kbPath, relativePath: 'p.md', error: providerError, modelId: 'B', sourceHash: 'h', now });
        await expect(q.shouldRetryIngest(kbPath, 'p.md', { sourceHash: 'new', modelId: 'A', now: soon }))
          .resolves.toMatchObject({ reason: 'content_changed' });
        await expect(q.listIngestQuarantine(kbPath)).resolves.toEqual([]);
      });
    });

    it('remove/retry/ack honour the optional modelId, and removeIngestQuarantineForModel clears a model', async () => {
      await withQ(async ({ q, kbPath, providerError }) => {
        for (const modelId of ['A', 'B']) {
          await q.recordIngestFailure({ kbPath, relativePath: 'p.md', error: providerError, modelId, now });
          await q.recordIngestFailure({ kbPath, relativePath: 'q.md', error: providerError, modelId, now });
        }
        await expect(q.ackIngestQuarantineEntry(kbPath, 'p.md', 'A')).resolves.toMatchObject({ model_id: 'A', ack: true });
        const acked = (await q.listIngestQuarantine(kbPath)).filter((r) => r.ack);
        expect(acked.map((r) => [r.model_id, r.relative_path])).toEqual([['A', 'p.md']]);
        await expect(q.forceRetryIngestQuarantineEntry(kbPath, 'q.md', soon, 'B')).resolves.toMatchObject({ model_id: 'B' });
        await expect(q.removeIngestQuarantineEntry(kbPath, 'q.md', 'A')).resolves.toBe(true);
        expect(await q.countIngestQuarantine(kbPath)).toBe(3);
        await expect(q.removeIngestQuarantineForModel(kbPath, 'B')).resolves.toBe(2);
        await expect(q.removeIngestQuarantineForModel(kbPath, 'B')).resolves.toBe(0);
        // Without a modelId the operator verbs act on every record for the path.
        await expect(q.removeIngestQuarantineEntry(kbPath, 'p.md')).resolves.toBe(true);
        await expect(q.listIngestQuarantine(kbPath)).resolves.toEqual([]);
      });
    });

    it('the maxEntries cap bounds the total including model-scoped records', async () => {
      await withQ(async ({ q, kbPath, providerError }) => {
        for (const modelId of ['A', 'B', 'C']) {
          await q.recordIngestFailure({ kbPath, relativePath: 'p.md', error: providerError, modelId, now, maxEntries: 2 });
        }
        expect(await q.countIngestQuarantine(kbPath)).toBe(2);
      });
    });
  });
});
