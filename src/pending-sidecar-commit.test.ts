import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CHUNK_MANIFEST_SCHEMA_VERSION, type ChunkManifest } from './file-ingest.js';
import {
  PENDING_SIDECAR_COMMIT_FILENAME,
  PENDING_SIDECAR_COMMIT_SCHEMA_VERSION,
  pendingSidecarCommitManifestPath,
  readPendingSidecarCommitManifest,
  writePendingSidecarCommitManifest,
} from './pending-sidecar-commit.js';

// Issue #902: the crash-recovery journal that gates sidecar/manifest commit
// must itself be durable and collision-safe. `writePendingSidecarCommitManifest`
// now routes through `writeFileAtomicDurable` (unique tmp name, fsync +
// parent-dir sync, atomic rename) so a power loss cannot drop the journal and
// two racing writers cannot interleave bytes into one shared `.tmp` path.
describe('writePendingSidecarCommitManifest durability (#902)', () => {
  // Deterministic, valid 64-char hex string seeded by `seed`.
  const hex = (seed: string): string => {
    let out = '';
    for (let i = 0; out.length < 64; i += 1) {
      out += (seed.charCodeAt(i % seed.length) & 0xf).toString(16);
    }
    return out.slice(0, 64);
  };

  const manifest = (source: string): ChunkManifest => ({
    schema_version: CHUNK_MANIFEST_SCHEMA_VERSION,
    source_sha256: hex(source),
    chunks: [
      {
        chunkIndex: 0,
        textHash: hex(`${source}t`),
        metadataHash: hex(`${source}m`),
        vectorDocstoreId: hex(`${source}v`),
      },
    ],
  });

  let modelDir: string;

  beforeEach(async () => {
    modelDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-pending-commit-'));
  });

  afterEach(async () => {
    await fsp.rm(modelDir, { recursive: true, force: true });
  });

  const onlyJournalRemains = async (): Promise<string[]> =>
    (await fsp.readdir(modelDir)).filter((name) => name !== PENDING_SIDECAR_COMMIT_FILENAME);

  it('round-trips a journal written through the durable helper', async () => {
    await writePendingSidecarCommitManifest({
      modelDir,
      phase: 'save-started',
      pendingHashWrites: [{ path: path.join(modelDir, 'a.hash'), hash: hex('a') }],
      pendingChunkManifestWrites: [{ path: path.join(modelDir, 'a.chunks.json'), manifest: manifest('a') }],
    });

    const read = await readPendingSidecarCommitManifest(modelDir);
    expect(read).not.toBeNull();
    expect(read?.schema_version).toBe(PENDING_SIDECAR_COMMIT_SCHEMA_VERSION);
    expect(read?.phase).toBe('save-started');
    expect(read?.pending_hash_writes).toHaveLength(1);
    expect(read?.pending_chunk_manifest_writes).toHaveLength(1);
    // No leftover `.tmp` — the unique tmp was renamed away cleanly.
    expect(await onlyJournalRemains()).toEqual([]);
  });

  it('never tears the journal when two writers race the same model dir', async () => {
    await Promise.all([
      writePendingSidecarCommitManifest({
        modelDir,
        phase: 'save-started',
        pendingHashWrites: [{ path: path.join(modelDir, 'a.hash'), hash: hex('a') }],
        pendingChunkManifestWrites: [],
      }),
      writePendingSidecarCommitManifest({
        modelDir,
        phase: 'save-complete',
        pendingHashWrites: [{ path: path.join(modelDir, 'b.hash'), hash: hex('b') }],
        pendingChunkManifestWrites: [{ path: path.join(modelDir, 'b.chunks.json'), manifest: manifest('b') }],
      }),
    ]);

    // Whichever writer landed last, the journal parses as one intact manifest
    // (never a byte-interleave that `readPendingSidecarCommitManifest` rejects).
    const read = await readPendingSidecarCommitManifest(modelDir);
    expect(read).not.toBeNull();
    expect(['save-started', 'save-complete']).toContain(read?.phase);
    expect(await onlyJournalRemains()).toEqual([]);
  });

  it('preserves the prior journal when a write crashes before the rename', async () => {
    await writePendingSidecarCommitManifest({
      modelDir,
      phase: 'save-started',
      pendingHashWrites: [{ path: path.join(modelDir, 'a.hash'), hash: hex('a') }],
      pendingChunkManifestWrites: [],
    });

    const renameSpy = jest.spyOn(fsp, 'rename').mockRejectedValue(
      Object.assign(new Error('simulated crash before rename'), { code: 'EIO' }),
    );
    try {
      await expect(
        writePendingSidecarCommitManifest({
          modelDir,
          phase: 'save-complete',
          pendingHashWrites: [{ path: path.join(modelDir, 'b.hash'), hash: hex('b') }],
          pendingChunkManifestWrites: [],
        }),
      ).rejects.toThrow('simulated crash before rename');
    } finally {
      renameSpy.mockRestore();
    }

    // The previously committed journal is still readable and unchanged.
    const read = await readPendingSidecarCommitManifest(modelDir);
    expect(read?.phase).toBe('save-started');
    expect(read?.pending_hash_writes[0]?.hash).toBe(hex('a'));
    expect(await onlyJournalRemains()).toEqual([]);
    // Sanity: the journal path is what we expect.
    expect(pendingSidecarCommitManifestPath(modelDir)).toBe(
      path.join(modelDir, PENDING_SIDECAR_COMMIT_FILENAME),
    );
  });
});
