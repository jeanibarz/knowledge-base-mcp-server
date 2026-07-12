import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { jest } from '@jest/globals';
import { Document } from '@langchain/core/documents';
import {
  buildChunkDocuments,
  buildChunkManifest,
  countStableChunkPrefix,
  normalizeChunkTextForEmbedding,
} from './file-ingest.js';
import { buildSidecarRowFromDocument } from './metadata-sidecar.js';

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
      const content = [
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
