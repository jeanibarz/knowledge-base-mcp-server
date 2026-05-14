import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Document } from '@langchain/core/documents';
import {
  METADATA_SIDECAR_FILENAME,
  METADATA_SIDECAR_SCHEMA_VERSION,
  buildSidecarRowFromDocument,
  deleteMetadataSidecar,
  isSidecarStale,
  readMetadataSidecar,
  recommendFastPathFetchK,
  toSidecarFilter,
  writeMetadataSidecar,
  type MetadataSidecarRow,
} from './metadata-sidecar.js';

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'kb-sidecar-test-'));
}

function row(overrides: Partial<MetadataSidecarRow>): MetadataSidecarRow {
  return {
    docstoreId: overrides.docstoreId ?? '0',
    knowledgeBase: overrides.knowledgeBase ?? 'kb-default',
    source: overrides.source ?? '/kbs/kb-default/notes/file.md',
    relativePath: overrides.relativePath ?? 'kb-default/notes/file.md',
    extension: overrides.extension ?? '.md',
    tags: overrides.tags ?? [],
    frontmatter: overrides.frontmatter,
  };
}

describe('metadata-sidecar', () => {
  describe('buildSidecarRowFromDocument', () => {
    it('extracts the search-relevant metadata fields and lower-cases the extension', () => {
      const document = new Document({
        pageContent: 'irrelevant',
        metadata: {
          knowledgeBase: 'docs',
          source: '/kbs/docs/runbooks/payments.MD',
          relativePath: 'docs/runbooks/payments.MD',
          extension: '.MD',
          tags: ['ops', 'oncall', ''],
          frontmatter: {
            title: 'Payments runbook',
            status: 'active',
            extras: { ignored: 'because non-whitelisted' },
            non_string: 42,
          },
        },
      });
      const result = buildSidecarRowFromDocument('vec-7', document);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        docstoreId: 'vec-7',
        knowledgeBase: 'docs',
        source: '/kbs/docs/runbooks/payments.MD',
        relativePath: 'docs/runbooks/payments.MD',
        extension: '.md',
        tags: ['ops', 'oncall'],
        frontmatter: { title: 'Payments runbook', status: 'active' },
      });
    });

    it('returns null when required fields are missing rather than indexing a broken row', () => {
      const document = new Document({
        pageContent: 'irrelevant',
        metadata: { source: '/kbs/docs/file.md' },
      });
      expect(buildSidecarRowFromDocument('1', document)).toBeNull();
    });

    it('omits frontmatter when no whitelisted scalars survive', () => {
      const document = new Document({
        pageContent: 'irrelevant',
        metadata: {
          knowledgeBase: 'docs',
          source: '/kbs/docs/file.md',
          relativePath: 'docs/file.md',
          extension: '.md',
          frontmatter: { extras: { x: 'y' }, non_string: 42 },
        },
      });
      const result = buildSidecarRowFromDocument('id', document);
      expect(result).not.toBeNull();
      expect(result?.frontmatter).toBeUndefined();
    });
  });

  describe('round-trip persistence', () => {
    it('writes a JSONL header + one line per row and reads them back with stable buckets', async () => {
      const dir = await makeTempDir();
      try {
        const sidecarPath = path.join(dir, METADATA_SIDECAR_FILENAME);
        const rows: MetadataSidecarRow[] = [
          row({ docstoreId: '0', knowledgeBase: 'docs', extension: '.md', tags: ['ops'] }),
          row({ docstoreId: '1', knowledgeBase: 'docs', extension: '.txt' }),
          row({ docstoreId: '2', knowledgeBase: 'design', extension: '.md', tags: ['oncall'] }),
        ];
        await writeMetadataSidecar({ sidecarPath, modelId: 'model-x', rows });

        const raw = await fsp.readFile(sidecarPath, 'utf-8');
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(rows.length + 1);
        expect(JSON.parse(lines[0])).toEqual({
          schema_version: METADATA_SIDECAR_SCHEMA_VERSION,
          model_id: 'model-x',
          total_chunks: rows.length,
        });

        const sidecar = await readMetadataSidecar({ sidecarPath, modelId: 'model-x' });
        expect(sidecar).not.toBeNull();
        if (!sidecar) throw new Error('sidecar read returned null');
        expect(sidecar.totalChunks).toBe(rows.length);
        const docsCandidates = sidecar.candidateIds({ knowledgeBaseName: 'docs' });
        expect(docsCandidates.sort()).toEqual(['0', '1']);
        const opsCandidates = sidecar.candidateIds({ tags: ['ops'] });
        expect(opsCandidates).toEqual(['0']);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('refresh re-ingest replaces rows so the candidate set reflects the new file', async () => {
      const dir = await makeTempDir();
      try {
        const sidecarPath = path.join(dir, METADATA_SIDECAR_FILENAME);
        await writeMetadataSidecar({
          sidecarPath,
          modelId: 'model-x',
          rows: [row({ docstoreId: '0', extension: '.md' })],
        });
        // Same model, fresh ingest with a different file shape — sidecar
        // is rewritten in place; the old row must not survive.
        await writeMetadataSidecar({
          sidecarPath,
          modelId: 'model-x',
          rows: [
            row({ docstoreId: '0', extension: '.md' }),
            row({ docstoreId: '1', extension: '.txt' }),
          ],
        });

        const sidecar = await readMetadataSidecar({ sidecarPath, modelId: 'model-x' });
        if (!sidecar) throw new Error('sidecar read returned null');
        expect(sidecar.totalChunks).toBe(2);
        expect(sidecar.candidateIds({ extensions: ['.txt'] })).toEqual(['1']);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('candidate id selection', () => {
    function buildSidecarFromRows(rows: MetadataSidecarRow[]): Promise<NonNullable<Awaited<ReturnType<typeof readMetadataSidecar>>>> {
      return (async () => {
        const dir = await makeTempDir();
        const sidecarPath = path.join(dir, METADATA_SIDECAR_FILENAME);
        await writeMetadataSidecar({ sidecarPath, modelId: 'mid', rows });
        const sidecar = await readMetadataSidecar({ sidecarPath, modelId: 'mid' });
        if (!sidecar) throw new Error('failed to build sidecar fixture');
        return sidecar;
      })();
    }

    it('intersects KB + extension + tag predicates so the candidate set is the AND of all', async () => {
      const sidecar = await buildSidecarFromRows([
        row({ docstoreId: '0', knowledgeBase: 'docs', extension: '.md', tags: ['ops'] }),
        row({ docstoreId: '1', knowledgeBase: 'docs', extension: '.txt', tags: ['ops'] }),
        row({ docstoreId: '2', knowledgeBase: 'design', extension: '.md', tags: ['ops'] }),
        row({ docstoreId: '3', knowledgeBase: 'docs', extension: '.md', tags: [] }),
      ]);

      expect(
        sidecar
          .candidateIds({ knowledgeBaseName: 'docs', extensions: ['.md'], tags: ['ops'] })
          .sort(),
      ).toEqual(['0']);
    });

    it('returns the empty array when no row satisfies the filter (so the caller can short-circuit FAISS)', async () => {
      const sidecar = await buildSidecarFromRows([
        row({ docstoreId: '0', knowledgeBase: 'docs', extension: '.md' }),
      ]);
      expect(sidecar.candidateIds({ knowledgeBaseName: 'design' })).toEqual([]);
    });

    it('applies the path glob against either the KB-prefixed path or the in-KB suffix', async () => {
      const sidecar = await buildSidecarFromRows([
        row({ docstoreId: 'a', knowledgeBase: 'docs', relativePath: 'docs/runbooks/foo.md' }),
        row({ docstoreId: 'b', knowledgeBase: 'docs', relativePath: 'docs/notes/bar.md' }),
      ]);
      expect(sidecar.candidateIds({ pathGlob: 'runbooks/**' })).toEqual(['a']);
      expect(sidecar.candidateIds({ pathGlob: 'docs/notes/**' })).toEqual(['b']);
    });

    it('matches whitelisted frontmatter keys by exact equality', async () => {
      const sidecar = await buildSidecarFromRows([
        row({ docstoreId: 'p', frontmatter: { status: 'active', tier: 'platinum' } }),
        row({ docstoreId: 'g', frontmatter: { status: 'active', tier: 'gold' } }),
        row({ docstoreId: 's', frontmatter: { status: 'archived', tier: 'platinum' } }),
      ]);
      expect(
        sidecar.candidateIds({ frontmatter: { status: 'active', tier: 'platinum' } }),
      ).toEqual(['p']);
    });
  });

  describe('staleness and corruption fallback', () => {
    it('returns null and logs a single warning when the sidecar file is missing', async () => {
      const dir = await makeTempDir();
      try {
        const sidecar = await readMetadataSidecar({
          sidecarPath: path.join(dir, METADATA_SIDECAR_FILENAME),
          modelId: 'mid',
        });
        expect(sidecar).toBeNull();
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('returns null when the header schema version is wrong', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const dir = await makeTempDir();
      try {
        const sidecarPath = path.join(dir, METADATA_SIDECAR_FILENAME);
        await fsp.writeFile(
          sidecarPath,
          `${JSON.stringify({ schema_version: 'kb.metadata-sidecar.v999', model_id: 'mid', total_chunks: 0 })}\n`,
          'utf-8',
        );
        const sidecar = await readMetadataSidecar({ sidecarPath, modelId: 'mid' });
        expect(sidecar).toBeNull();
      } finally {
        warnSpy.mockRestore();
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('returns null when the model id stored in the header does not match the active model', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const dir = await makeTempDir();
      try {
        const sidecarPath = path.join(dir, METADATA_SIDECAR_FILENAME);
        await writeMetadataSidecar({
          sidecarPath,
          modelId: 'other-model',
          rows: [row({ docstoreId: '0' })],
        });
        const sidecar = await readMetadataSidecar({ sidecarPath, modelId: 'mid' });
        expect(sidecar).toBeNull();
      } finally {
        warnSpy.mockRestore();
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('returns null when a body row is malformed JSON', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const dir = await makeTempDir();
      try {
        const sidecarPath = path.join(dir, METADATA_SIDECAR_FILENAME);
        const header = JSON.stringify({
          schema_version: METADATA_SIDECAR_SCHEMA_VERSION,
          model_id: 'mid',
          total_chunks: 1,
        });
        await fsp.writeFile(sidecarPath, `${header}\n{not-json\n`, 'utf-8');
        const sidecar = await readMetadataSidecar({ sidecarPath, modelId: 'mid' });
        expect(sidecar).toBeNull();
      } finally {
        warnSpy.mockRestore();
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('returns null when row count disagrees with the header total', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const dir = await makeTempDir();
      try {
        const sidecarPath = path.join(dir, METADATA_SIDECAR_FILENAME);
        const header = JSON.stringify({
          schema_version: METADATA_SIDECAR_SCHEMA_VERSION,
          model_id: 'mid',
          total_chunks: 5,
        });
        await fsp.writeFile(
          sidecarPath,
          `${header}\n${JSON.stringify(row({ docstoreId: '0' }))}\n`,
          'utf-8',
        );
        const sidecar = await readMetadataSidecar({ sidecarPath, modelId: 'mid' });
        expect(sidecar).toBeNull();
      } finally {
        warnSpy.mockRestore();
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('detects ntotal mismatch via isSidecarStale so the caller can fall through', async () => {
      const dir = await makeTempDir();
      try {
        const sidecarPath = path.join(dir, METADATA_SIDECAR_FILENAME);
        await writeMetadataSidecar({
          sidecarPath,
          modelId: 'mid',
          rows: [row({ docstoreId: '0' }), row({ docstoreId: '1' })],
        });
        const sidecar = await readMetadataSidecar({ sidecarPath, modelId: 'mid' });
        if (!sidecar) throw new Error('sidecar read returned null');
        expect(isSidecarStale(sidecar, 2)).toBe(false);
        expect(isSidecarStale(sidecar, 3)).toBe(true);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('deleteMetadataSidecar succeeds when the file is absent', async () => {
      const dir = await makeTempDir();
      try {
        await deleteMetadataSidecar(path.join(dir, 'never-existed.jsonl'));
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('toSidecarFilter', () => {
    it('passes through the post-filter inputs unchanged', () => {
      const result = toSidecarFilter({
        knowledgeBaseName: 'docs',
        knowledgeBasesRootDir: '/kbs',
        filters: { extensions: ['.md'], pathGlob: 'runbooks/**', tags: ['ops'] },
        frontmatter: { status: 'active' },
      });
      expect(result).toEqual({
        knowledgeBaseName: 'docs',
        knowledgeBasesRootDir: '/kbs',
        extensions: ['.md'],
        pathGlob: 'runbooks/**',
        tags: ['ops'],
        frontmatter: { status: 'active' },
      });
    });
  });

  describe('recommendFastPathFetchK', () => {
    it('returns null when the filter is too broad to benefit', () => {
      expect(recommendFastPathFetchK({ k: 10, candidates: 80, ntotal: 100 })).toBeNull();
    });

    it('returns the targeted window when the filter is selective', () => {
      // selectivity = 100/10000 = 1%. Naive ceil(k / sel) * 2 = ceil(10 / 0.01) * 2 = 2000.
      const fetchK = recommendFastPathFetchK({ k: 10, candidates: 100, ntotal: 10_000 });
      expect(fetchK).not.toBeNull();
      expect(fetchK).toBeGreaterThanOrEqual(40); // at least k * 4
      expect(fetchK).toBeLessThanOrEqual(10_000); // capped at ntotal
    });

    it('caps the fetchK at ntotal even when the targeted window is larger', () => {
      const fetchK = recommendFastPathFetchK({ k: 1000, candidates: 10, ntotal: 200 });
      expect(fetchK).toBe(200);
    });

    it('returns null when ntotal is zero', () => {
      expect(recommendFastPathFetchK({ k: 10, candidates: 0, ntotal: 0 })).toBeNull();
    });
  });
});
