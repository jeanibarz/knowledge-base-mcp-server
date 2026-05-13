// RFC 016 — docstore canonicalization + CAS dedup tests.
//
// Acceptance lifted directly from issue #286 / RFC 016 §"Validation plan":
//   * canonicalization is deterministic and key-order-stable;
//   * collision salting fires on duplicate `(pageContent, metadata)`;
//   * a "miss" save writes the CAS payload and a hardlink;
//   * a "hit" save reuses the existing CAS inode without re-writing it;
//   * a second model with the same content shares the inode (the whole
//     point of the issue);
//   * GC removes orphan CAS payloads (nlink==1) and keeps live ones (nlink>=2);
//   * `link()` EXDEV / EOPNOTSUPP poisons the runtime flag and degrades to
//     "skipped" without failing the save.

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  canonicalizeDocstore,
  casRootForIndexPath,
  dedupeDocstoreOnSave,
  gcDocstoreCas,
  resetDedupDisabledForTests,
} from './docstore-cas.js';

beforeEach(() => {
  resetDedupDisabledForTests();
});

function makeDocstoreJson(
  entries: Array<{ uuid: string; pageContent: string; metadata: Record<string, unknown> }>,
): string {
  const docstoreEntries = entries.map((e) => [e.uuid, { pageContent: e.pageContent, metadata: e.metadata }]);
  const mapping: Record<string, string> = {};
  entries.forEach((e, i) => {
    mapping[String(i)] = e.uuid;
  });
  return JSON.stringify([docstoreEntries, mapping]);
}

async function makeTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeDocstoreToStaging(
  stagingDir: string,
  raw: string,
): Promise<void> {
  await fsp.mkdir(stagingDir, { recursive: true });
  await fsp.writeFile(path.join(stagingDir, 'docstore.json'), raw, 'utf-8');
}

describe('canonicalizeDocstore', () => {
  it('rewrites random UUIDs into content-hash UUIDs and preserves mapping order', () => {
    const raw = makeDocstoreJson([
      { uuid: 'random-a', pageContent: 'hello', metadata: { source: 'a.md', chunkIndex: 0 } },
      { uuid: 'random-b', pageContent: 'world', metadata: { source: 'a.md', chunkIndex: 1 } },
    ]);
    const result = canonicalizeDocstore(raw);

    expect(result.entryCount).toBe(2);
    expect(result.collisions).toBe(0);

    const parsed = JSON.parse(result.bytes.toString('utf-8'));
    const [entries, mapping] = parsed;
    expect(entries[0][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(entries[0][0]).not.toBe('random-a');
    expect(entries[1][0]).not.toBe('random-b');
    expect(mapping['0']).toBe(entries[0][0]);
    expect(mapping['1']).toBe(entries[1][0]);
  });

  it('produces byte-identical output for two random-UUID inputs with identical content', () => {
    const docs = [
      { pageContent: 'a chunk', metadata: { source: 'a.md', chunkIndex: 0 } },
      { pageContent: 'another chunk', metadata: { source: 'a.md', chunkIndex: 1 } },
    ];
    const rawA = makeDocstoreJson(docs.map((d, i) => ({ uuid: `model-a-uuid-${i}`, ...d })));
    const rawB = makeDocstoreJson(docs.map((d, i) => ({ uuid: `model-b-uuid-${i}`, ...d })));

    const canonicalA = canonicalizeDocstore(rawA);
    const canonicalB = canonicalizeDocstore(rawB);

    expect(canonicalA.hash).toBe(canonicalB.hash);
    expect(canonicalA.bytes.equals(canonicalB.bytes)).toBe(true);
  });

  it('is stable across metadata key-order permutations', () => {
    const rawA = makeDocstoreJson([
      { uuid: 'u1', pageContent: 'x', metadata: { source: 'a.md', chunkIndex: 0, extension: '.md' } },
    ]);
    const rawB = makeDocstoreJson([
      // Same metadata, different key order.
      { uuid: 'u1', pageContent: 'x', metadata: { extension: '.md', chunkIndex: 0, source: 'a.md' } },
    ]);
    expect(canonicalizeDocstore(rawA).hash).toBe(canonicalizeDocstore(rawB).hash);
  });

  it('detects and salts collisions on duplicate (pageContent, metadata)', () => {
    const raw = makeDocstoreJson([
      { uuid: 'u1', pageContent: 'same', metadata: { source: 'a.md', chunkIndex: 0 } },
      // Two entries with identical pageContent + metadata — only possible if
      // the chunker mis-emits, but the canonicalization layer must defend.
      { uuid: 'u2', pageContent: 'same', metadata: { source: 'a.md', chunkIndex: 0 } },
    ]);
    const result = canonicalizeDocstore(raw);
    expect(result.collisions).toBe(1);
    const [entries] = JSON.parse(result.bytes.toString('utf-8'));
    expect(entries[0][0]).not.toBe(entries[1][0]);
  });

  it('rejects malformed input (not a tuple)', () => {
    expect(() => canonicalizeDocstore('{}')).toThrow(/expected \[entries, mapping\] tuple/);
  });

  it('rejects mapping that references unknown uuid', () => {
    const raw = JSON.stringify([
      [['u1', { pageContent: 'x', metadata: {} }]],
      { '0': 'u-orphan' },
    ]);
    expect(() => canonicalizeDocstore(raw)).toThrow(/mapping references uuid/);
  });
});

describe('dedupeDocstoreOnSave', () => {
  it('returns "skipped" with no side effects when casRoot is null', async () => {
    const stagingDir = await makeTmpDir('kb-docstore-null-');
    const raw = makeDocstoreJson([
      { uuid: 'u1', pageContent: 'x', metadata: { source: 'a.md', chunkIndex: 0 } },
    ]);
    await writeDocstoreToStaging(stagingDir, raw);
    const before = await fsp.readFile(path.join(stagingDir, 'docstore.json'), 'utf-8');

    const result = await dedupeDocstoreOnSave({ stagingDir, casRoot: null, swapCounter: 1 });

    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('disabled');
    // The original file is untouched.
    const after = await fsp.readFile(path.join(stagingDir, 'docstore.json'), 'utf-8');
    expect(after).toBe(before);
  });

  it('on miss: writes the CAS payload and hardlinks staging/docstore.json to it', async () => {
    const root = await makeTmpDir('kb-docstore-miss-');
    const casRoot = casRootForIndexPath(root);
    const stagingDir = path.join(root, 'models', 'm1', 'index.v0');
    const raw = makeDocstoreJson([
      { uuid: 'u1', pageContent: 'hello', metadata: { source: 'a.md', chunkIndex: 0 } },
    ]);
    await writeDocstoreToStaging(stagingDir, raw);

    const result = await dedupeDocstoreOnSave({ stagingDir, casRoot, swapCounter: 1 });

    expect(result.status).toBe('miss');
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    const casPath = path.join(casRoot, `${result.hash}.json`);
    const casStat = await fsp.stat(casPath);
    const stagingStat = await fsp.stat(path.join(stagingDir, 'docstore.json'));
    expect(stagingStat.ino).toBe(casStat.ino);
    expect(casStat.nlink).toBe(2);
  });

  it('on hit: reuses the existing CAS inode; nlink grows; no rewrite', async () => {
    const root = await makeTmpDir('kb-docstore-hit-');
    const casRoot = casRootForIndexPath(root);
    const stagingA = path.join(root, 'models', 'm1', 'index.v0');
    const stagingB = path.join(root, 'models', 'm2', 'index.v0');

    // Same semantic content under two different random UUIDs (= two models).
    const docs = [{ pageContent: 'shared', metadata: { source: 'a.md', chunkIndex: 0 } }];
    const rawA = makeDocstoreJson(docs.map((d, i) => ({ uuid: `a-${i}`, ...d })));
    const rawB = makeDocstoreJson(docs.map((d, i) => ({ uuid: `b-${i}`, ...d })));
    await writeDocstoreToStaging(stagingA, rawA);
    await writeDocstoreToStaging(stagingB, rawB);

    const resultA = await dedupeDocstoreOnSave({ stagingDir: stagingA, casRoot, swapCounter: 1 });
    const casPath = path.join(casRoot, `${resultA.hash}.json`);
    const casMtimeBefore = (await fsp.stat(casPath)).mtimeMs;

    const resultB = await dedupeDocstoreOnSave({ stagingDir: stagingB, casRoot, swapCounter: 1 });

    expect(resultA.status).toBe('miss');
    expect(resultB.status).toBe('hit');
    expect(resultB.hash).toBe(resultA.hash);

    const inoA = (await fsp.stat(path.join(stagingA, 'docstore.json'))).ino;
    const inoB = (await fsp.stat(path.join(stagingB, 'docstore.json'))).ino;
    expect(inoA).toBe(inoB);

    const casStat = await fsp.stat(casPath);
    expect(casStat.nlink).toBe(3); // cas + stagingA + stagingB
    // "Hit" branch must not have rewritten the CAS payload.
    expect(casStat.mtimeMs).toBe(casMtimeBefore);
  });

  it('produces same hash for two models with identical chunks (issue #286 acceptance)', async () => {
    const root = await makeTmpDir('kb-docstore-cross-model-');
    const casRoot = casRootForIndexPath(root);
    const stagingA = path.join(root, 'models', 'huggingface__bge-small', 'index.v0');
    const stagingB = path.join(root, 'models', 'openai__text-3-small', 'index.v0');

    const sharedDocs = [
      { pageContent: 'chunk-0', metadata: { source: 'a.md', chunkIndex: 0, knowledgeBase: 'kb' } },
      { pageContent: 'chunk-1', metadata: { source: 'a.md', chunkIndex: 1, knowledgeBase: 'kb' } },
      { pageContent: 'chunk-2', metadata: { source: 'b.md', chunkIndex: 0, knowledgeBase: 'kb' } },
    ];
    await writeDocstoreToStaging(
      stagingA,
      makeDocstoreJson(sharedDocs.map((d, i) => ({ uuid: `random-a-${i}`, ...d }))),
    );
    await writeDocstoreToStaging(
      stagingB,
      makeDocstoreJson(sharedDocs.map((d, i) => ({ uuid: `random-b-${i}`, ...d }))),
    );

    const ra = await dedupeDocstoreOnSave({ stagingDir: stagingA, casRoot, swapCounter: 1 });
    const rb = await dedupeDocstoreOnSave({ stagingDir: stagingB, casRoot, swapCounter: 1 });

    expect(ra.hash).toBe(rb.hash);
    const inoA = (await fsp.stat(path.join(stagingA, 'docstore.json'))).ino;
    const inoB = (await fsp.stat(path.join(stagingB, 'docstore.json'))).ino;
    expect(inoA).toBe(inoB);
  });

  it('different content → different CAS entries (no spurious dedup)', async () => {
    const root = await makeTmpDir('kb-docstore-distinct-');
    const casRoot = casRootForIndexPath(root);
    const stagingA = path.join(root, 'models', 'm1', 'index.v0');
    const stagingB = path.join(root, 'models', 'm1', 'index.v1');

    await writeDocstoreToStaging(
      stagingA,
      makeDocstoreJson([{ uuid: 'u1', pageContent: 'first', metadata: { source: 'a.md', chunkIndex: 0 } }]),
    );
    await writeDocstoreToStaging(
      stagingB,
      makeDocstoreJson([{ uuid: 'u1', pageContent: 'second', metadata: { source: 'a.md', chunkIndex: 0 } }]),
    );

    const ra = await dedupeDocstoreOnSave({ stagingDir: stagingA, casRoot, swapCounter: 1 });
    const rb = await dedupeDocstoreOnSave({ stagingDir: stagingB, casRoot, swapCounter: 2 });

    expect(ra.hash).not.toBe(rb.hash);
    const inoA = (await fsp.stat(path.join(stagingA, 'docstore.json'))).ino;
    const inoB = (await fsp.stat(path.join(stagingB, 'docstore.json'))).ino;
    expect(inoA).not.toBe(inoB);
  });

  it('clears a stale orphan tmpLink from a prior crash before linking', async () => {
    const root = await makeTmpDir('kb-docstore-orphan-tmp-');
    const casRoot = casRootForIndexPath(root);
    const stagingDir = path.join(root, 'models', 'm1', 'index.v0');
    const raw = makeDocstoreJson([
      { uuid: 'u1', pageContent: 'x', metadata: { source: 'a.md', chunkIndex: 0 } },
    ]);
    await writeDocstoreToStaging(stagingDir, raw);

    // Plant an orphan tmpLink that would otherwise collide with our save.
    const orphanTmp = path.join(stagingDir, `.docstore.json.tmp.${process.pid}.1`);
    await fsp.writeFile(orphanTmp, 'stale', 'utf-8');

    const result = await dedupeDocstoreOnSave({ stagingDir, casRoot, swapCounter: 1 });
    expect(result.status).toBe('miss');
    // tmpLink must not survive past the save.
    await expect(fsp.stat(orphanTmp)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('gcDocstoreCas', () => {
  it('removes orphan CAS payloads (nlink==1) and keeps live ones (nlink>=2)', async () => {
    const root = await makeTmpDir('kb-docstore-gc-');
    const casRoot = casRootForIndexPath(root);
    const staging = path.join(root, 'models', 'm1', 'index.v0');
    await fsp.mkdir(staging, { recursive: true });

    // Live entry: writing + linking via dedup.
    await writeDocstoreToStaging(
      staging,
      makeDocstoreJson([{ uuid: 'u1', pageContent: 'live', metadata: { source: 'a.md', chunkIndex: 0 } }]),
    );
    const live = await dedupeDocstoreOnSave({ stagingDir: staging, casRoot, swapCounter: 1 });
    expect(live.status).toBe('miss');

    // Orphan entry: just drop a stand-alone JSON file into the CAS root.
    const orphanPath = path.join(casRoot, 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.json');
    await fsp.writeFile(orphanPath, '[[],{}]', 'utf-8');

    const result = await gcDocstoreCas(casRoot);

    expect(result.removed).toContain(path.basename(orphanPath));
    expect(result.kept).toBe(1);
    // Live payload survives.
    await expect(fsp.stat(path.join(casRoot, `${live.hash}.json`))).resolves.toBeDefined();
    // Orphan is gone.
    await expect(fsp.stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('no-ops cleanly when casRoot does not exist', async () => {
    const root = await makeTmpDir('kb-docstore-gc-missing-');
    const casRoot = path.join(root, '.docstore-cas');
    const result = await gcDocstoreCas(casRoot);
    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(0);
  });

  it('ignores non-.json entries (e.g., lockfile, tmp files)', async () => {
    const root = await makeTmpDir('kb-docstore-gc-noise-');
    const casRoot = casRootForIndexPath(root);
    await fsp.mkdir(casRoot, { recursive: true });
    await fsp.writeFile(path.join(casRoot, '.lock'), '', 'utf-8');
    await fsp.writeFile(path.join(casRoot, 'README'), 'unrelated', 'utf-8');

    const result = await gcDocstoreCas(casRoot);
    expect(result.removed).toEqual([]);
    // .lock + README are not counted; only .json files contribute to `kept`.
    expect(result.kept).toBe(0);
    // Non-.json files are untouched.
    await expect(fsp.stat(path.join(casRoot, 'README'))).resolves.toBeDefined();
  });
});

describe('dedupeDocstoreOnSave — filesystem failure modes', () => {
  it('disables dedup process-wide when link() reports EXDEV / EPERM / EOPNOTSUPP', async () => {
    const root = await makeTmpDir('kb-docstore-exdev-');
    const casRoot = casRootForIndexPath(root);
    const stagingDir = path.join(root, 'models', 'm1', 'index.v0');
    await writeDocstoreToStaging(
      stagingDir,
      makeDocstoreJson([{ uuid: 'u1', pageContent: 'x', metadata: { source: 'a.md', chunkIndex: 0 } }]),
    );

    const exdevLink = async (): Promise<void> => {
      const err = new Error('mock EXDEV') as NodeJS.ErrnoException;
      err.code = 'EXDEV';
      throw err;
    };
    const first = await dedupeDocstoreOnSave({
      stagingDir,
      casRoot,
      swapCounter: 1,
      hooks: { link: exdevLink },
    });
    expect(first.status).toBe('skipped');
    expect(first.skipReason).toBe('EXDEV');

    // Second save short-circuits via the disabled flag without even
    // consulting the link hook — the original docstore.json stays in place.
    const stagingDir2 = path.join(root, 'models', 'm1', 'index.v1');
    await writeDocstoreToStaging(
      stagingDir2,
      makeDocstoreJson([{ uuid: 'u2', pageContent: 'y', metadata: { source: 'a.md', chunkIndex: 0 } }]),
    );
    let secondaryHookCalled = false;
    const second = await dedupeDocstoreOnSave({
      stagingDir: stagingDir2,
      casRoot,
      swapCounter: 2,
      hooks: {
        link: async () => {
          secondaryHookCalled = true;
        },
      },
    });
    expect(second.status).toBe('skipped');
    expect(second.skipReason).toBe('disabled');
    expect(secondaryHookCalled).toBe(false);
  });
});
