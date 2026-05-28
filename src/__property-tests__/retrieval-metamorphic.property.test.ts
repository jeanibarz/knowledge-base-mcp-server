// Metamorphic retrieval tests (issue #495).
//
// These tests assert relations that should hold across generated small
// retrieval corpora instead of pinning one golden query. They intentionally
// stay on pure retrieval policy functions: no FAISS process, local LLM, or KB
// filesystem is needed to catch mode, filter, and ranking regressions.

import { afterEach, describe, it, expect, jest } from '@jest/globals';
import type { Document } from '@langchain/core/documents';
import * as fc from 'fast-check';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  createSimilaritySearchPostFilter,
  type ScoredDocument,
} from '../search-filters.js';
import {
  fuseHybridResults,
  type HybridChunk,
} from '../hybrid-retrieval.js';
import { chunkIdFromMetadata } from '../rrf.js';
import { resolveAutoSearchMode } from '../search-core.js';

const NUM_RUNS = process.env.KB_PROPERTY_DEEP === '1' ? 1000 : 50;
const KB_ROOT = path.join(path.sep, 'kb-root');

const originalEnv = {
  KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
  INGEST_EXTRA_EXTENSIONS: process.env.INGEST_EXTRA_EXTENSIONS,
  INGEST_EXCLUDE_PATHS: process.env.INGEST_EXCLUDE_PATHS,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const kbNameArb = fc.constantFrom('alpha', 'beta');
const dirArb = fc.constantFrom('runbooks', 'notes', 'reference');
const extensionArb = fc.constantFrom('.md', '.txt', '.pdf');
const tagArb = fc.constantFrom('ops', 'oncall', 'research', 'security');
const leafArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,10}$/);
const chunkIndexArb = fc.integer({ min: 0, max: 3 });
const scoreArb = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

interface CorpusDoc {
  id: string;
  kbName: string;
  dir: string;
  leaf: string;
  extension: string;
  tags: string[];
  chunkIndex: number;
  score: number;
}

const corpusDocArb = fc.record({
  kbName: kbNameArb,
  dir: dirArb,
  leaf: leafArb,
  extension: extensionArb,
  tags: fc.uniqueArray(tagArb, { minLength: 0, maxLength: 3 }),
  chunkIndex: chunkIndexArb,
  score: scoreArb,
}).map((doc) => ({
  ...doc,
  id: `${doc.kbName}/${doc.dir}/${doc.leaf}${doc.extension}#${doc.chunkIndex}`,
}));

function toScoredDocument(doc: CorpusDoc): ScoredDocument {
  const relativePath = `${doc.kbName}/${doc.dir}/${doc.leaf}${doc.extension}`;
  return [
    {
      pageContent: `content for ${doc.id}`,
      metadata: {
        source: path.join(KB_ROOT, ...relativePath.split('/')),
        relativePath,
        extension: doc.extension,
        tags: doc.tags,
        chunkIndex: doc.chunkIndex,
      },
    } as Document,
    doc.score,
  ];
}

function ids(results: readonly ScoredDocument[]): string[] {
  return results.map(([doc]) => {
    const metadata = doc.metadata as Record<string, unknown>;
    return `${String(metadata.relativePath)}#${String(metadata.chunkIndex)}`;
  });
}

function hybridChunk(source: string, chunkIndex: number, prefix: string): HybridChunk {
  return {
    pageContent: `${prefix} body for ${source}`,
    metadata: { source, chunkIndex },
    score: 0.1 + chunkIndex / 100,
  };
}

const hybridIdArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,10}$/);

async function freshLexical(rootDir: string, faissDir: string): Promise<typeof import('../lexical-index.js')> {
  process.env.KNOWLEDGE_BASES_ROOT_DIR = rootDir;
  process.env.FAISS_INDEX_PATH = faissDir;
  delete process.env.INGEST_EXTRA_EXTENSIONS;
  delete process.env.INGEST_EXCLUDE_PATHS;
  jest.resetModules();
  return import('../lexical-index.js');
}

async function seedKb(rootDir: string, kbName: string, files: Record<string, string>): Promise<string> {
  const kbPath = path.join(rootDir, kbName);
  await fsp.mkdir(kbPath, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(kbPath, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf-8');
  }
  return kbPath;
}

interface ControlledLexicalIndex {
  entries: Map<string, {
    sha256: string;
    chunks: Array<{
      pageContent: string;
      metadata: Record<string, unknown>;
      searchText?: string;
    }>;
  }>;
  chunkRankerCache: unknown | null;
  sourceRankerCache: unknown | null;
}

describe('retrieval metamorphic invariants — property tests (issue #495)', () => {
  it('filter narrowing never introduces out-of-filter results', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(corpusDocArb, {
          minLength: 0,
          maxLength: 30,
          selector: (doc) => doc.id,
        }),
        extensionArb,
        dirArb,
        tagArb,
        (docs, extension, dir, tag) => {
          const candidates = docs.map(toScoredDocument);
          const unfiltered = createSimilaritySearchPostFilter({
            threshold: 1,
            knowledgeBasesRootDir: KB_ROOT,
          }).apply(candidates);
          const narrowed = createSimilaritySearchPostFilter({
            threshold: 1,
            knowledgeBasesRootDir: KB_ROOT,
            filters: {
              extensions: [extension],
              pathGlob: `${dir}/**`,
              tags: [tag],
            },
          }).apply(candidates);

          const unfilteredIds = new Set(ids(unfiltered));
          for (const [doc] of narrowed) {
            const metadata = doc.metadata as Record<string, unknown>;
            expect(unfilteredIds.has(`${String(metadata.relativePath)}#${String(metadata.chunkIndex)}`)).toBe(true);
            expect(metadata.extension).toBe(extension);
            expect(String(metadata.relativePath)).toMatch(new RegExp(`^[^/]+/${dir}/`));
            expect(metadata.tags).toEqual(expect.arrayContaining([tag]));
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('scoped path globs are equivalent with and without an explicit KB prefix', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(corpusDocArb, {
          minLength: 0,
          maxLength: 30,
          selector: (doc) => doc.id,
        }),
        dirArb,
        (docs, dir) => {
          const candidates = docs.map(toScoredDocument);
          const inKbGlob = createSimilaritySearchPostFilter({
            threshold: 1,
            knowledgeBasesRootDir: KB_ROOT,
            knowledgeBaseName: 'alpha',
            filters: { pathGlob: `${dir}/**` },
          }).apply(candidates);
          const prefixedGlob = createSimilaritySearchPostFilter({
            threshold: 1,
            knowledgeBasesRootDir: KB_ROOT,
            knowledgeBaseName: 'alpha',
            filters: { pathGlob: `alpha/${dir}/**` },
          }).apply(candidates);

          expect(ids(prefixedGlob)).toEqual(ids(inKbGlob));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('auto mode remains hybrid when a code-shaped token is surrounded by prose', () => {
    const lowercaseProseArb = fc
      .array(fc.stringMatching(/^[a-z]{2,8}$/), { minLength: 1, maxLength: 8 })
      .map((words) => words.join(' '));
    const codeTokenArb = fc.constantFrom(
      'INDEX_NOT_INITIALIZED',
      'src/cli-search.ts',
      '--refresh',
      'PR #253',
      'FaissIndexManager',
    );

    fc.assert(
      fc.property(lowercaseProseArb, codeTokenArb, (prose, token) => {
        expect(resolveAutoSearchMode(prose).mode).toBe('dense');
        expect(resolveAutoSearchMode(`${prose} ${token} ${prose}`).mode).toBe('hybrid');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('hybrid top result is stable when k increases over the same fused corpus', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(hybridIdArb, { minLength: 1, maxLength: 16 }),
        fc.integer({ min: 1, max: 16 }),
        (rawIds, requestedK) => {
          const denseCount = Math.ceil(rawIds.length / 2);
          const dense = rawIds
            .slice(0, denseCount)
            .map((id, index) => hybridChunk(`${id}.md`, index, 'dense'));
          const lexical = rawIds
            .slice(denseCount)
            .map((id, index) => hybridChunk(`${id}.md`, index, 'lexical'));
          const largeK = Math.min(requestedK, rawIds.length);

          const top1 = fuseHybridResults({ denseResults: dense, lexicalResults: lexical, k: 1 });
          const larger = fuseHybridResults({ denseResults: dense, lexicalResults: lexical, k: largeK });

          expect(larger[0]).toBeDefined();
          expect(chunkIdFromMetadata(larger[0].metadata)).toBe(
            chunkIdFromMetadata(top1[0].metadata),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('hybrid fusion includes lexical-only candidates when k covers the controlled corpus', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(hybridIdArb, { minLength: 2, maxLength: 12 }),
        (rawIds) => {
          const denseCount = Math.floor(rawIds.length / 2);
          const dense = rawIds
            .slice(0, denseCount)
            .map((id, index) => hybridChunk(`${id}.md`, index, 'dense unrelated'));
          const lexical = rawIds
            .slice(denseCount)
            .map((id, index) => hybridChunk(`${id}.md`, index, 'INDEX_NOT_INITIALIZED'));

          const out = fuseHybridResults({
            denseResults: dense,
            lexicalResults: lexical,
            k: rawIds.length,
          });
          const outIds = new Set(out.map((chunk) => chunkIdFromMetadata(chunk.metadata)));

          for (const hit of lexical) {
            expect(outIds.has(chunkIdFromMetadata(hit.metadata))).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('lexical exact-token hits survive hybrid fusion when dense misses them', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'retrieval-metamorphic-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const kbPath = await seedKb(rootDir, 'docs', {
        'errors.md': 'This note covers INDEX_NOT_INITIALIZED recovery and remediation.',
        'pasta.md': 'This note covers pasta sauce and dinner planning.',
      });

      const { LexicalIndex } = await freshLexical(rootDir, faissDir);
      const idx = await LexicalIndex.load('docs', kbPath);
      await idx.refresh();

      const lexical = await idx.query('INDEX_NOT_INITIALIZED', 2);
      expect(lexical[0]?.metadata.relativePath).toBe('docs/errors.md');

      const dense = [hybridChunk('pasta.md', 0, 'dense unrelated')];
      const fused = fuseHybridResults({
        denseResults: dense,
        lexicalResults: lexical,
        k: dense.length + lexical.length,
      });

      expect(
        fused.some((chunk) => chunk.metadata.relativePath === 'docs/errors.md'),
      ).toBe(true);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('lexical source ranking returns one representative chunk per source', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'retrieval-source-unit-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      await fsp.mkdir(rootDir, { recursive: true });
      const kbPath = await seedKb(rootDir, 'docs', {
        'alpha.md': [
          '---',
          'title: Alpha incident response',
          '---',
          '',
          '# Alpha',
          '',
          'alpha duplicate marker',
          '',
          'alpha duplicate marker',
        ].join('\n'),
        'beta.md': [
          '---',
          'title: Beta runbook',
          '---',
          '',
          '# Beta',
          '',
          'alpha duplicate marker appears once',
        ].join('\n'),
      });

      const { LexicalIndex } = await freshLexical(rootDir, faissDir);
      const idx = await LexicalIndex.load('docs', kbPath);
      await idx.refresh();

      const lexical = await idx.query('alpha incident response', 2, { unit: 'source' });

      expect(lexical).toHaveLength(2);
      expect(lexical.map((hit) => hit.metadata.relativePath)).toEqual([
        'docs/alpha.md',
        'docs/beta.md',
      ]);
      expect(lexical[0]?.metadata.lexicalRankingUnit).toBe('source');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('lexical source ranking returns the best matching chunk from a winning source', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'retrieval-source-representative-'));
    try {
      const rootDir = path.join(tmp, 'kbs');
      const faissDir = path.join(tmp, 'faiss');
      const kbPath = await seedKb(rootDir, 'docs', {});

      const { LexicalIndex } = await freshLexical(rootDir, faissDir);
      const idx = await LexicalIndex.load('docs', kbPath);
      const controlled = idx as unknown as ControlledLexicalIndex;
      controlled.entries.set('source.md', {
        sha256: 'sha',
        chunks: [
          {
            pageContent: 'unrelated opening chunk',
            metadata: { source: path.join(kbPath, 'source.md'), relativePath: 'docs/source.md', chunkIndex: 0 },
          },
          {
            pageContent: 'target marker lives here',
            metadata: { source: path.join(kbPath, 'source.md'), relativePath: 'docs/source.md', chunkIndex: 1 },
          },
        ],
      });
      controlled.chunkRankerCache = null;
      controlled.sourceRankerCache = null;

      const lexical = await idx.query('target marker', 1, { unit: 'source', candidateK: 1 });

      expect(lexical[0]?.pageContent).toBe('target marker lives here');
      expect(lexical[0]?.metadata.chunkIndex).toBe(1);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
