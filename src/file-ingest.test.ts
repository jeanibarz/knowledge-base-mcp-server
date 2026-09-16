import fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { jest } from '@jest/globals';
import { Document } from '@langchain/core/documents';
import {
  buildChunkDocuments,
  buildChunkManifest,
  countStableChunkPrefix,
  normalizeChunkTextForEmbedding,
  writeChunkManifests,
  writeSidecarHashes,
  CHUNK_MANIFEST_SCHEMA_VERSION,
  type ChunkManifest,
} from './file-ingest.js';
import { buildSidecarRowFromDocument } from './metadata-sidecar.js';

// The durable-write tests below drive `writeSidecarHashes` / `writeChunkManifests`
// directly. Their real `withSidecarLock` wrapper (a) does `fsp.mkdir` + a
// proper-lockfile lock on the process-wide FAISS_INDEX_PATH, which is resolved
// once at import time and would otherwise touch the operator's *real* KB
// `.index/` dir, and (b) serializes concurrent callers, which would hide the
// fixed-`${target}.tmp` collision race the fix closes. Replace it with a
// passthrough so the two-writer test exercises a genuine, unserialized race to
// the same target — exactly the sidecar-lock fail-open window issue #902
// targets. Every other write-lock export stays real.
jest.mock('./write-lock.js', () => {
  const actual = jest.requireActual<typeof import('./write-lock.js')>('./write-lock.js');
  return {
    ...actual,
    withSidecarLock: <T,>(action: () => Promise<T>): Promise<T> => action(),
  };
});

describe('normalizeChunkTextForEmbedding', () => {
  it('collapses insignificant text differences before indexing dedupe', () => {
    expect(normalizeChunkTextForEmbedding('  Cafe\u0301\t\nrunbook   section  ')).toBe('Caf\u00e9 runbook section');
  });
});

describe('buildChunkManifest', () => {
  it('hashes normalized chunk text and stable metadata for prefix comparison', () => {
    const first = buildChunkManifest(
      [
        new Document({
          pageContent: '  Cafe\u0301\t\nrunbook   section  ',
          metadata: { source: '/kb/doc.md', chunkIndex: 0, tags: ['ops'] },
        }),
        new Document({
          pageContent: 'next section',
          metadata: { tags: ['ops'], chunkIndex: 1, source: '/kb/doc.md' },
        }),
      ],
      'a'.repeat(64),
    );
    const second = buildChunkManifest(
      [
        new Document({
          pageContent: 'Caf\u00e9 runbook section',
          metadata: { tags: ['ops'], chunkIndex: 0, source: '/kb/doc.md' },
        }),
        new Document({
          pageContent: 'changed section',
          metadata: { source: '/kb/doc.md', chunkIndex: 1, tags: ['ops'] },
        }),
      ],
      'b'.repeat(64),
    );

    expect(first.schema_version).toBe('kb.chunk-manifest.v1');
    expect(first.chunks).toHaveLength(2);
    expect(first.chunks[0]).toEqual(expect.objectContaining({
      chunkIndex: 0,
      textHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      metadataHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      vectorDocstoreId: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(first.chunks[0].textHash).toBe(second.chunks[0].textHash);
    expect(first.chunks[0].metadataHash).toBe(second.chunks[0].metadataHash);
    expect(countStableChunkPrefix(first, second)).toBe(1);
  });
});

describe('durable + collision-safe sidecar writes (#902)', () => {
  // These helpers back the re-embed decision on the next reindex, so a torn
  // or lost sidecar/manifest silently skips or re-embeds a source file.
  // Issue #902 routed them through `writeFileAtomicDurable` (unique tmp name,
  // fsync + parent-dir sync) to close both the durability gap and the
  // fixed-`${target}.tmp` collision race. Lock those properties here.
  // Deterministic, valid 64-char hex string seeded by `seed`.
  const hex = (seed: string): string => {
    let out = '';
    for (let i = 0; out.length < 64; i += 1) {
      out += (seed.charCodeAt(i % seed.length) & 0xf).toString(16);
    }
    return out.slice(0, 64);
  };

  const largeManifest = (source: string, chunkCount: number): ChunkManifest => ({
    schema_version: CHUNK_MANIFEST_SCHEMA_VERSION,
    source_sha256: hex(source),
    chunks: Array.from({ length: chunkCount }, (_unused, i) => ({
      chunkIndex: i,
      textHash: hex(`${source}t${i}`),
      metadataHash: hex(`${source}m${i}`),
      vectorDocstoreId: hex(`${source}v${i}`),
    })),
  });

  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-durable-sidecar-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('writeSidecarHashes writes through a unique tmp and leaves no fixed .tmp behind', async () => {
    const target = path.join(dir, 'doc.md.hash');
    await writeSidecarHashes([{ path: target, hash: hex('a') }]);

    await expect(fsp.readFile(target, 'utf-8')).resolves.toBe(hex('a'));
    // No `${target}.tmp` and no `.kb-tmp.` leftover — the write is clean.
    const leftovers = (await fsp.readdir(dir)).filter((name) => name !== 'doc.md.hash');
    expect(leftovers).toEqual([]);
  });

  it('two interleaved chunk-manifest writers to the same target never tear the output', async () => {
    // With `withSidecarLock` stubbed to a passthrough (see the mock at the top
    // of this file), these two calls genuinely race. Distinct, sizeable
    // payloads: a byte-interleave into one shared tmp (the old fixed-
    // `${target}.tmp` bug) would yield invalid JSON or a hybrid of the two.
    // With per-write unique tmp names the loser is fully overwritten by the
    // winner and the survivor is always one intact value.
    const target = path.join(dir, 'doc.md.chunks.json');
    const first = largeManifest('1', 400);
    const second = largeManifest('2', 400);

    await Promise.all([
      writeChunkManifests([{ path: target, manifest: first }]),
      writeChunkManifests([{ path: target, manifest: second }]),
    ]);

    const raw = await fsp.readFile(target, 'utf-8');
    const parsed = JSON.parse(raw) as ChunkManifest;
    // Exactly one complete manifest survives — never a torn hybrid.
    expect([JSON.stringify(first), JSON.stringify(second)]).toContain(raw);
    expect(parsed.chunks).toHaveLength(400);
    const leftovers = (await fsp.readdir(dir)).filter((name) => name !== 'doc.md.chunks.json');
    expect(leftovers).toEqual([]);
  });

  it('writeSidecarHashes preserves the prior sidecar when a write crashes before the rename', async () => {
    const target = path.join(dir, 'doc.md.hash');
    await writeSidecarHashes([{ path: target, hash: hex('a') }]);

    // Simulate a crash between the fsynced tmp write and the durability
    // point (rename): the recovery contract is that the previously committed
    // sidecar stays byte-intact so the next reindex still makes a correct
    // re-embed decision, and no partial tmp is left behind.
    const renameSpy = jest.spyOn(fsp, 'rename').mockRejectedValue(
      Object.assign(new Error('simulated crash before rename'), { code: 'EIO' }),
    );
    try {
      await expect(
        writeSidecarHashes([{ path: target, hash: hex('b') }]),
      ).rejects.toThrow('simulated crash before rename');
    } finally {
      renameSpy.mockRestore();
    }

    await expect(fsp.readFile(target, 'utf-8')).resolves.toBe(hex('a'));
    const leftovers = (await fsp.readdir(dir)).filter((name) => name !== 'doc.md.hash');
    expect(leftovers).toEqual([]);
  });
});

describe('buildChunkDocuments → metadata-sidecar contract (#283)', () => {
  // Issue #283: the ingest path must emit every metadata field the
  // predicate-pushdown sidecar relies on. If buildChunkDocuments ever
  // stops attaching `knowledgeBase`, `relativePath`, `extension`, or the
  // tags array, the sidecar row will be null and the fast-path silently
  // disappears. Lock that contract here.
  //
  // KNOWLEDGE_BASES_ROOT_DIR is read by `config.ts` at module load, so
  // tests build their fixture under a directory that is itself under the
  // active KB root and assert the relativePath is the path RELATIVE to
  // that root (rather than guessing it).
  let kbRoot: string | undefined;
  let workspaceUnderRoot: string | undefined;

  beforeAll(async () => {
    const { KNOWLEDGE_BASES_ROOT_DIR } = await import('./config.js');
    kbRoot = KNOWLEDGE_BASES_ROOT_DIR;
    workspaceUnderRoot = await fsp.mkdtemp(path.join(kbRoot, 'kb-ingest-sidecar-'));
  });

  afterAll(async () => {
    if (workspaceUnderRoot !== undefined) {
      await fsp.rm(workspaceUnderRoot, { recursive: true, force: true });
    }
  });

  it('produces documents whose metadata maps cleanly to a sidecar row', async () => {
    const kbName = 'docs';
    const kbDir = path.join(workspaceUnderRoot as string, kbName, 'runbooks');
    await fsp.mkdir(kbDir, { recursive: true });
    const filePath = path.join(kbDir, 'oncall.md');
    const content = [
      '---',
      'tags:',
      '  - ops',
      '  - oncall',
      'title: On-call runbook',
      'status: active',
      'kb_policy:',
      '  no_llm_context: true',
      '  resource_read: local_only',
      '  sensitivity: internal',
      '---',
      '',
      '# On-call runbook',
      '',
      'Restart the queue worker if the lag exceeds five minutes.',
    ].join('\n');
    await fsp.writeFile(filePath, content, 'utf-8');

    const documents = await buildChunkDocuments(filePath, content, kbName);
    expect(documents.length).toBeGreaterThan(0);

    const first = documents[0];
    const expectedRelativePath = path
      .relative(kbRoot as string, filePath)
      .split(path.sep)
      .join('/');

    expect(first.metadata).toEqual(expect.objectContaining({
      knowledgeBase: kbName,
      source: filePath,
      relativePath: expectedRelativePath,
      extension: '.md',
      tags: expect.arrayContaining(['ops', 'oncall']),
      frontmatter: expect.objectContaining({
        title: 'On-call runbook',
        status: 'active',
        kb_policy: {
          no_llm_context: true,
          resource_read: 'local_only',
          sensitivity: 'internal',
        },
      }),
    }));

    const row = buildSidecarRowFromDocument('vec-0', first);
    expect(row).not.toBeNull();
    expect(row).toEqual(expect.objectContaining({
      docstoreId: 'vec-0',
      knowledgeBase: kbName,
      source: filePath,
      relativePath: expectedRelativePath,
      extension: '.md',
      tags: expect.arrayContaining(['ops', 'oncall']),
      frontmatter: expect.objectContaining({ title: 'On-call runbook', status: 'active' }),
    }));
  });

  it('does not call the contextual-preface LLM for no_llm_context documents', async () => {
    const previousRetrieval = process.env.KB_CONTEXTUAL_RETRIEVAL;
    const previousEndpoint = process.env.KB_LLM_ENDPOINT;
    const previousFake = process.env.KB_LLM_FAKE;
    process.env.KB_CONTEXTUAL_RETRIEVAL = 'on';
    process.env.KB_LLM_ENDPOINT = 'http://preface.invalid/v1/chat/completions';
    delete process.env.KB_LLM_FAKE;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected contextual-preface LLM call');
    });

    try {
      const kbName = 'docs';
      const kbDir = path.join(workspaceUnderRoot as string, kbName, 'sensitive');
      await fsp.mkdir(kbDir, { recursive: true });
      const filePath = path.join(kbDir, 'private.md');
      const content = '\uFEFF' + [
        '---',
        'kb_policy:',
        '  no_llm_context: true',
        '---',
        '',
        'Sensitive body must never be sent to the preface model.',
      ].join('\n');
      await fsp.writeFile(filePath, content, 'utf-8');

      const documents = await buildChunkDocuments(filePath, content, kbName);

      expect(documents.length).toBeGreaterThan(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(documents.every((document) => document.metadata.contextual_preface === undefined)).toBe(true);
    } finally {
      fetchMock.mockRestore();
      if (previousRetrieval === undefined) delete process.env.KB_CONTEXTUAL_RETRIEVAL;
      else process.env.KB_CONTEXTUAL_RETRIEVAL = previousRetrieval;
      if (previousEndpoint === undefined) delete process.env.KB_LLM_ENDPOINT;
      else process.env.KB_LLM_ENDPOINT = previousEndpoint;
      if (previousFake === undefined) delete process.env.KB_LLM_FAKE;
      else process.env.KB_LLM_FAKE = previousFake;
    }
  });

  it('fails closed when malformed frontmatter could hide an LLM egress policy', async () => {
    const previousRetrieval = process.env.KB_CONTEXTUAL_RETRIEVAL;
    const previousEndpoint = process.env.KB_LLM_ENDPOINT;
    const previousFake = process.env.KB_LLM_FAKE;
    process.env.KB_CONTEXTUAL_RETRIEVAL = 'on';
    process.env.KB_LLM_ENDPOINT = 'http://preface.invalid/v1/chat/completions';
    delete process.env.KB_LLM_FAKE;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected contextual-preface LLM call');
    });

    try {
      const kbName = 'docs';
      const kbDir = path.join(workspaceUnderRoot as string, kbName, 'malformed');
      await fsp.mkdir(kbDir, { recursive: true });
      const filePath = path.join(kbDir, 'private.md');
      const content = [
        '---',
        'kb_policy:',
        '  no_llm_context: [true',
        '---',
        '',
        'Malformed policy body must never be sent to the preface model.',
      ].join('\n');
      await fsp.writeFile(filePath, content, 'utf-8');

      const documents = await buildChunkDocuments(filePath, content, kbName);

      expect(documents.length).toBeGreaterThan(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(documents.every((document) =>
        (document.metadata.frontmatter as { kb_policy?: { no_llm_context?: boolean } })
          ?.kb_policy?.no_llm_context === true,
      )).toBe(true);
    } finally {
      fetchMock.mockRestore();
      if (previousRetrieval === undefined) delete process.env.KB_CONTEXTUAL_RETRIEVAL;
      else process.env.KB_CONTEXTUAL_RETRIEVAL = previousRetrieval;
      if (previousEndpoint === undefined) delete process.env.KB_LLM_ENDPOINT;
      else process.env.KB_LLM_ENDPOINT = previousEndpoint;
      if (previousFake === undefined) delete process.env.KB_LLM_FAKE;
      else process.env.KB_LLM_FAKE = previousFake;
    }
  });

  it('fails closed when kb_policy is not a YAML mapping', async () => {
    const previousRetrieval = process.env.KB_CONTEXTUAL_RETRIEVAL;
    const previousEndpoint = process.env.KB_LLM_ENDPOINT;
    const previousFake = process.env.KB_LLM_FAKE;
    process.env.KB_CONTEXTUAL_RETRIEVAL = 'on';
    process.env.KB_LLM_ENDPOINT = 'http://preface.invalid/v1/chat/completions';
    delete process.env.KB_LLM_FAKE;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected contextual-preface LLM call');
    });

    try {
      const kbName = 'docs';
      const kbDir = path.join(workspaceUnderRoot as string, kbName, 'scalar-policy');
      await fsp.mkdir(kbDir, { recursive: true });
      const filePath = path.join(kbDir, 'private.md');
      const content = [
        '---',
        'kb_policy: true',
        '---',
        '',
        'Scalar policy body must never be sent to the preface model.',
      ].join('\n');
      await fsp.writeFile(filePath, content, 'utf-8');

      const documents = await buildChunkDocuments(filePath, content, kbName);

      expect(documents.length).toBeGreaterThan(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(documents.every((document) =>
        (document.metadata.frontmatter as { kb_policy?: { no_llm_context?: boolean } })
          ?.kb_policy?.no_llm_context === true,
      )).toBe(true);
    } finally {
      fetchMock.mockRestore();
      if (previousRetrieval === undefined) delete process.env.KB_CONTEXTUAL_RETRIEVAL;
      else process.env.KB_CONTEXTUAL_RETRIEVAL = previousRetrieval;
      if (previousEndpoint === undefined) delete process.env.KB_LLM_ENDPOINT;
      else process.env.KB_LLM_ENDPOINT = previousEndpoint;
      if (previousFake === undefined) delete process.env.KB_LLM_FAKE;
      else process.env.KB_LLM_FAKE = previousFake;
    }
  });

  it('still generates contextual prefatory metadata for non-sensitive documents', async () => {
    const previousRetrieval = process.env.KB_CONTEXTUAL_RETRIEVAL;
    const previousEndpoint = process.env.KB_LLM_ENDPOINT;
    const previousFake = process.env.KB_LLM_FAKE;
    process.env.KB_CONTEXTUAL_RETRIEVAL = 'on';
    delete process.env.KB_LLM_ENDPOINT;
    process.env.KB_LLM_FAKE = 'on';

    try {
      const kbName = 'docs';
      const kbDir = path.join(workspaceUnderRoot as string, kbName, 'public');
      await fsp.mkdir(kbDir, { recursive: true });
      const filePath = path.join(kbDir, 'runbook.md');
      const content = [
        '# Public deployment runbook',
        '',
        'Rollback approval requires the release lead.',
      ].join('\n');
      await fsp.writeFile(filePath, content, 'utf-8');

      const documents = await buildChunkDocuments(filePath, content, kbName);

      expect(documents.some((document) => typeof document.metadata.contextual_preface === 'string')).toBe(true);
    } finally {
      if (previousRetrieval === undefined) delete process.env.KB_CONTEXTUAL_RETRIEVAL;
      else process.env.KB_CONTEXTUAL_RETRIEVAL = previousRetrieval;
      if (previousEndpoint === undefined) delete process.env.KB_LLM_ENDPOINT;
      else process.env.KB_LLM_ENDPOINT = previousEndpoint;
      if (previousFake === undefined) delete process.env.KB_LLM_FAKE;
      else process.env.KB_LLM_FAKE = previousFake;
    }
  });

  it('refresh re-ingest of the same file regenerates documents that map to fresh rows', async () => {
    const kbName = 'docs';
    const kbDir = path.join(workspaceUnderRoot as string, 'refresh', kbName);
    await fsp.mkdir(kbDir, { recursive: true });
    const filePath = path.join(kbDir, 'changing.md');
    const expectedRelativePath = path
      .relative(kbRoot as string, filePath)
      .split(path.sep)
      .join('/');

    await fsp.writeFile(filePath, '# Initial title\n\nFirst body.\n', 'utf-8');
    const initial = await buildChunkDocuments(filePath, await fsp.readFile(filePath, 'utf-8'), kbName);
    const initialRow = buildSidecarRowFromDocument('vec-0', initial[0]);
    expect(initialRow?.relativePath).toBe(expectedRelativePath);

    await fsp.writeFile(filePath, '# Updated title\n\nNew body.\n', 'utf-8');
    const updated = await buildChunkDocuments(filePath, await fsp.readFile(filePath, 'utf-8'), kbName);
    const updatedRow = buildSidecarRowFromDocument('vec-0', updated[0]);
    expect(updatedRow?.relativePath).toBe(expectedRelativePath);
    // Same docstore id, same metadata fields → sidecar refresh stays
    // structurally identical even when the underlying chunk text changed.
    expect(updatedRow).toEqual(expect.objectContaining({
      knowledgeBase: kbName,
      extension: '.md',
    }));
  });
});
