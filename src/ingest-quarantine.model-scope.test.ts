import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const originalEnv = {
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
};

type Quarantine = typeof import('./ingest-quarantine.js');

interface Fixture {
  q: Quarantine;
  kbPath: string;
  providerError: () => Error;
  nonProviderError: () => Error;
}

const NOW = new Date('2026-05-12T10:00:00.000Z');
// Backoff after the first failure is 120s; 10 minutes is well past it, 30s is well inside it.
const DURING_BACKOFF = new Date(NOW.getTime() + 30_000);
const AFTER_BACKOFF = new Date(NOW.getTime() + 10 * 60_000);

let tempDirs: string[] = [];

afterEach(async () => {
  if (originalEnv.FAISS_INDEX_PATH === undefined) delete process.env.FAISS_INDEX_PATH;
  else process.env.FAISS_INDEX_PATH = originalEnv.FAISS_INDEX_PATH;
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function setup(): Promise<Fixture> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-quarantine-model-scope-'));
  tempDirs.push(tempDir);
  const kbPath = path.join(tempDir, 'kb');
  await fsp.mkdir(kbPath, { recursive: true });
  process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');
  jest.resetModules();
  const q = await import('./ingest-quarantine.js');
  // Import after resetModules so instanceof checks in the classifier see the same class.
  const { KBError } = await import('./errors.js');
  return {
    q,
    kbPath,
    providerError: () => new KBError('PROVIDER_TIMEOUT', 'embedding provider timed out'),
    nonProviderError: () => Object.assign(new Error('bad input'), { code: 'EINVAL' }),
  };
}

describe('ingest quarantine model scoping', () => {
  it('stores a provider failure with modelId as a record carrying that model_id', async () => {
    const { q, kbPath, providerError } = await setup();
    const record = await q.recordIngestFailure({
      kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW,
    });
    expect(record.error_category).toBe('provider');
    expect(record.model_id).toBe('model-b');
    expect(record.schema_version).toBe('ingest-quarantine.v1');
  });

  it('does not block another model on a model-scoped provider record', async () => {
    const { q, kbPath, providerError } = await setup();
    await q.recordIngestFailure({
      kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW,
    });
    const decision = await q.shouldRetryIngest(kbPath, 'a.md', {
      modelId: 'model-a', now: DURING_BACKOFF,
    });
    expect(decision).toMatchObject({ retry: true, reason: 'no_record' });
  });

  it('blocks the same model while its scoped record is in backoff, and releases it after', async () => {
    const { q, kbPath, providerError } = await setup();
    await q.recordIngestFailure({
      kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW,
    });
    expect(await q.shouldRetryIngest(kbPath, 'a.md', { modelId: 'model-b', now: DURING_BACKOFF }))
      .toMatchObject({ retry: false, reason: 'backoff_active' });
    expect(await q.shouldRetryIngest(kbPath, 'a.md', { modelId: 'model-b', now: AFTER_BACKOFF }))
      .toMatchObject({ retry: true, reason: 'backoff_elapsed' });
  });

  it('keeps a non-provider failure KB-wide (no model_id) even when modelId is given', async () => {
    const { q, kbPath, nonProviderError } = await setup();
    const record = await q.recordIngestFailure({
      kbPath, relativePath: 'a.md', error: nonProviderError(), modelId: 'model-b', now: NOW,
    });
    expect(record.error_category).not.toBe('provider');
    expect(record.model_id).toBeUndefined();
  });

  it('blocks every model on a KB-wide non-provider record', async () => {
    const { q, kbPath, nonProviderError } = await setup();
    await q.recordIngestFailure({
      kbPath, relativePath: 'a.md', error: nonProviderError(), modelId: 'model-b', now: NOW,
    });
    for (const modelId of ['model-a', 'model-b', 'model-c']) {
      expect(await q.shouldRetryIngest(kbPath, 'a.md', { modelId, now: DURING_BACKOFF }))
        .toMatchObject({ retry: false, reason: 'backoff_active' });
    }
  });

  it('keeps a provider failure recorded without modelId KB-wide (legacy behaviour)', async () => {
    const { q, kbPath, providerError } = await setup();
    const record = await q.recordIngestFailure({
      kbPath, relativePath: 'a.md', error: providerError(), now: NOW,
    });
    expect(record.error_category).toBe('provider');
    expect(record.model_id).toBeUndefined();
  });

  it('ignores a legacy KB-wide provider record when modelId is given', async () => {
    const { q, kbPath, providerError } = await setup();
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), now: NOW });
    expect(await q.shouldRetryIngest(kbPath, 'a.md', { modelId: 'model-a', now: DURING_BACKOFF }))
      .toMatchObject({ retry: true, reason: 'no_record' });
  });

  it('still blocks on a legacy KB-wide provider record when modelId is omitted', async () => {
    const { q, kbPath, providerError } = await setup();
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), now: NOW });
    expect(await q.shouldRetryIngest(kbPath, 'a.md', { now: DURING_BACKOFF }))
      .toMatchObject({ retry: false, reason: 'backoff_active' });
  });

  it('without modelId, ignores model-scoped records and looks at the KB-wide record only', async () => {
    const { q, kbPath, providerError } = await setup();
    await q.recordIngestFailure({
      kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW,
    });
    expect(await q.shouldRetryIngest(kbPath, 'a.md', { now: DURING_BACKOFF }))
      .toMatchObject({ retry: true, reason: 'no_record' });
  });

  it('recordIngestSuccess with modelId removes its own record and the KB-wide record, not other models', async () => {
    const { q, kbPath, providerError, nonProviderError } = await setup();
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: nonProviderError(), now: NOW });
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-a', now: NOW });
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });

    await expect(q.recordIngestSuccess(kbPath, 'a.md', { modelId: 'model-a' })).resolves.toBe(true);

    const remaining = await q.listIngestQuarantine(kbPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ relative_path: 'a.md', model_id: 'model-b' });
  });

  it('recordIngestSuccess with modelId returns false when nothing applies', async () => {
    const { q, kbPath, providerError } = await setup();
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });
    await expect(q.recordIngestSuccess(kbPath, 'a.md', { modelId: 'model-a' })).resolves.toBe(false);
    expect(await q.listIngestQuarantine(kbPath)).toHaveLength(1);
  });

  it('recordIngestSuccess without modelId removes only the KB-wide record', async () => {
    const { q, kbPath, providerError, nonProviderError } = await setup();
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: nonProviderError(), now: NOW });
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });

    await expect(q.recordIngestSuccess(kbPath, 'a.md')).resolves.toBe(true);

    const remaining = await q.listIngestQuarantine(kbPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ model_id: 'model-b' });
  });

  it('a content hash change removes every record for the path (all models and KB-wide)', async () => {
    const { q, kbPath, providerError, nonProviderError } = await setup();
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: nonProviderError(), sourceHash: 'h1', now: NOW });
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), sourceHash: 'h1', modelId: 'model-a', now: NOW });
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), sourceHash: 'h1', modelId: 'model-b', now: NOW });
    await q.recordIngestFailure({ kbPath, relativePath: 'other.md', error: providerError(), sourceHash: 'x', modelId: 'model-b', now: NOW });

    const decision = await q.shouldRetryIngest(kbPath, 'a.md', {
      modelId: 'model-a', sourceHash: 'h2', now: DURING_BACKOFF,
    });
    expect(decision).toMatchObject({ retry: true, reason: 'content_changed' });

    const remaining = await q.listIngestQuarantine(kbPath);
    expect(remaining.map((r) => r.relative_path)).toEqual(['other.md']);
  });

  it('removeIngestQuarantineForModel removes that model\'s records, returns the count, and keeps the rest', async () => {
    const { q, kbPath, providerError, nonProviderError } = await setup();
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });
    await q.recordIngestFailure({ kbPath, relativePath: 'b.md', error: providerError(), modelId: 'model-b', now: NOW });
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-a', now: NOW });
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: nonProviderError(), now: NOW });

    await expect(q.removeIngestQuarantineForModel(kbPath, 'model-b')).resolves.toBe(2);

    const remaining = await q.listIngestQuarantine(kbPath);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.model_id ?? '(kb-wide)').sort()).toEqual(['(kb-wide)', 'model-a']);
  });

  it('removeIngestQuarantineForModel returns 0 when the model has no records', async () => {
    const { q, kbPath, providerError } = await setup();
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-a', now: NOW });
    await expect(q.removeIngestQuarantineForModel(kbPath, 'model-z')).resolves.toBe(0);
    expect(await q.listIngestQuarantine(kbPath)).toHaveLength(1);
  });

  it('round-trips model_id through the manifest file and listIngestQuarantine', async () => {
    const { q, kbPath, providerError } = await setup();
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'ollama__nomic', now: NOW });
    const listed = await q.listIngestQuarantine(kbPath);
    expect(listed).toHaveLength(1);
    expect(listed[0].model_id).toBe('ollama__nomic');
    const raw = await fsp.readFile(path.join(kbPath, '.index', 'quarantine.jsonl'), 'utf-8');
    expect(JSON.parse(raw.trim()).model_id).toBe('ollama__nomic');
  });

  it('drops a manifest line whose model_id is an empty string', async () => {
    const { q, kbPath } = await setup();
    const line = {
      schema_version: 'ingest-quarantine.v1',
      relative_path: 'empty.md',
      model_id: '',
      source_sha256: null,
      error_category: 'provider',
      error_code: 'PROVIDER_TIMEOUT',
      error_fingerprint: 'sha256:abc',
      first_seen_at: NOW.toISOString(),
      last_attempted_at: NOW.toISOString(),
      retry_count: 1,
      next_retry_at: NOW.toISOString(),
      ack: false,
      dead_lettered_at: null,
      message: 'x',
    };
    await fsp.mkdir(path.join(kbPath, '.index'), { recursive: true });
    await fsp.writeFile(path.join(kbPath, '.index', 'quarantine.jsonl'), `${JSON.stringify(line)}\n`);
    expect(await q.listIngestQuarantine(kbPath)).toEqual([]);
  });

  it('still loads existing manifest lines that have no model_id', async () => {
    const { q, kbPath } = await setup();
    const line = {
      schema_version: 'ingest-quarantine.v1',
      relative_path: 'old.md',
      source_sha256: null,
      error_category: 'provider',
      error_code: 'PROVIDER_TIMEOUT',
      error_fingerprint: 'sha256:abc',
      first_seen_at: NOW.toISOString(),
      last_attempted_at: NOW.toISOString(),
      retry_count: 1,
      next_retry_at: new Date(NOW.getTime() + 120_000).toISOString(),
      ack: false,
      dead_lettered_at: null,
      message: 'old',
    };
    await fsp.mkdir(path.join(kbPath, '.index'), { recursive: true });
    await fsp.writeFile(path.join(kbPath, '.index', 'quarantine.jsonl'), JSON.stringify(line) + '\n', 'utf-8');
    const listed = await q.listIngestQuarantine(kbPath);
    expect(listed).toHaveLength(1);
    expect(listed[0].relative_path).toBe('old.md');
    expect(listed[0].model_id).toBeUndefined();
  });

  it('lets two models hold records for one path and counts both', async () => {
    const { q, kbPath, providerError } = await setup();
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-a', now: NOW });
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });
    const listed = await q.listIngestQuarantine(kbPath);
    expect(listed.map((r) => r.model_id).sort()).toEqual(['model-a', 'model-b']);
    await expect(q.countIngestQuarantine(kbPath)).resolves.toBe(2);
  });

  it('a repeat provider failure increments only that model\'s retry_count', async () => {
    const { q, kbPath, providerError } = await setup();
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-a', now: NOW });
    await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const second = await q.recordIngestFailure({
      kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: later,
    });
    expect(second.retry_count).toBe(2);
    expect(Date.parse(second.next_retry_at)).toBeGreaterThan(Date.parse(
      (await q.listIngestQuarantine(kbPath)).find((r) => r.model_id === 'model-b')!.last_attempted_at,
    ));

    const listed = await q.listIngestQuarantine(kbPath);
    const a = listed.find((r) => r.model_id === 'model-a')!;
    const b = listed.find((r) => r.model_id === 'model-b')!;
    expect(a.retry_count).toBe(1);
    expect(a.last_attempted_at).toBe(NOW.toISOString());
    expect(b.retry_count).toBe(2);
    expect(listed).toHaveLength(2);
  });

  it('bounds the total record count by maxEntries, model-scoped records included', async () => {
    const { q, kbPath, providerError } = await setup();
    for (const [i, modelId] of ['model-a', 'model-b', 'model-c'].entries()) {
      await q.recordIngestFailure({
        kbPath, relativePath: 'a.md', error: providerError(), modelId, maxEntries: 2,
        now: new Date(NOW.getTime() + i * 1000),
      });
    }
    expect(await q.listIngestQuarantine(kbPath)).toHaveLength(2);
  });

  describe('IngestQuarantineSnapshot', () => {
    it('keys records by model: get with modelId finds it, other model and KB-wide get do not', async () => {
      const { q, kbPath, providerError } = await setup();
      const record = await q.recordIngestFailure({
        kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW,
      });
      const snapshot = new q.IngestQuarantineSnapshot();
      await snapshot.set(kbPath, record);
      expect(await snapshot.get(kbPath, 'a.md', 'model-b')).toMatchObject({ model_id: 'model-b' });
      expect(await snapshot.get(kbPath, 'a.md', 'model-a')).toBeNull();
      expect(await snapshot.get(kbPath, 'a.md')).toBeNull();
    });

    it('get without modelId returns the KB-wide record while a model record coexists', async () => {
      const { q, kbPath, providerError, nonProviderError } = await setup();
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: nonProviderError(), now: NOW });
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });
      const snapshot = new q.IngestQuarantineSnapshot();
      const wide = await snapshot.get(kbPath, 'a.md');
      expect(wide).not.toBeNull();
      expect(wide!.model_id).toBeUndefined();
    });

    it('delete with modelId removes only that model\'s entry', async () => {
      const { q, kbPath, providerError } = await setup();
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-a', now: NOW });
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });
      const snapshot = new q.IngestQuarantineSnapshot();
      await snapshot.delete(kbPath, 'a.md', 'model-a');
      expect(await snapshot.get(kbPath, 'a.md', 'model-a')).toBeNull();
      expect(await snapshot.get(kbPath, 'a.md', 'model-b')).not.toBeNull();
    });

    it('shouldRetryIngest through a snapshot honours model scoping', async () => {
      const { q, kbPath, providerError } = await setup();
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });
      const snapshot = new q.IngestQuarantineSnapshot();
      expect(await q.shouldRetryIngest(kbPath, 'a.md', { snapshot, modelId: 'model-a', now: DURING_BACKOFF }))
        .toMatchObject({ retry: true, reason: 'no_record' });
      expect(await q.shouldRetryIngest(kbPath, 'a.md', { snapshot, modelId: 'model-b', now: DURING_BACKOFF }))
        .toMatchObject({ retry: false, reason: 'backoff_active' });
    });
  });

  describe('operator helpers with optional modelId', () => {
    it('removeIngestQuarantineEntry with modelId acts on that model only; without it acts on every record for the path', async () => {
      const { q, kbPath, providerError, nonProviderError } = await setup();
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: nonProviderError(), now: NOW });
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-a', now: NOW });
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });

      await expect(q.removeIngestQuarantineEntry(kbPath, 'a.md', 'model-a')).resolves.toBe(true);
      expect(await q.listIngestQuarantine(kbPath)).toHaveLength(2);

      await expect(q.removeIngestQuarantineEntry(kbPath, 'a.md')).resolves.toBe(true);
      expect(await q.listIngestQuarantine(kbPath)).toHaveLength(0);
    });

    it('ackIngestQuarantineEntry with modelId acks only that model\'s record', async () => {
      const { q, kbPath, providerError } = await setup();
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-a', now: NOW });
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });
      await q.ackIngestQuarantineEntry(kbPath, 'a.md', 'model-a');
      const listed = await q.listIngestQuarantine(kbPath);
      expect(listed.find((r) => r.model_id === 'model-a')!.ack).toBe(true);
      expect(listed.find((r) => r.model_id === 'model-b')!.ack).toBe(false);
    });

    it('ackIngestQuarantineEntry without modelId acks every record for the path', async () => {
      const { q, kbPath, providerError } = await setup();
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-a', now: NOW });
      await q.recordIngestFailure({ kbPath, relativePath: 'a.md', error: providerError(), modelId: 'model-b', now: NOW });
      await q.ackIngestQuarantineEntry(kbPath, 'a.md');
      const listed = await q.listIngestQuarantine(kbPath);
      expect(listed.every((r) => r.ack)).toBe(true);
    });
  });
});
