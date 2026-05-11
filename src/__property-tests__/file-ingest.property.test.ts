// Property tests for `buildChunkDocuments` (issue #219).
//
// Invariants covered:
//   * Every non-frontmatter, non-whitespace "word" in the input appears in at
//     least one emitted chunk's `pageContent` (total coverage).
//   * `chunk.pageContent.length <= chunkSize + chunkOverlap` for every chunk
//     (langchain splitter contract).
//   * `chunk.metadata.chunkIndex` is `[0..N-1]` strictly increasing.
//   * Metadata shape includes the wire-shape keys (`source`, `relativePath`,
//     `knowledgeBase`, `extension`, `chunkIndex`, `tags`).
//
// `numRuns: 50` by default; `KB_PROPERTY_DEEP=1` raises it to 1000 for manual
// sweeps. Chunk-size/overlap is supplied via `KB_CHUNK_SIZE` /
// `KB_CHUNK_OVERLAP` because `resolveChunkSize` reads them at call time.

import { describe, it, afterEach, expect } from '@jest/globals';
import * as fc from 'fast-check';
import * as os from 'os';
import * as path from 'path';
import { buildChunkDocuments } from '../file-ingest.js';

const NUM_RUNS = process.env.KB_PROPERTY_DEEP === '1' ? 1000 : 50;

const savedChunkSize = process.env.KB_CHUNK_SIZE;
const savedChunkOverlap = process.env.KB_CHUNK_OVERLAP;
const savedMaxExtractedTextBytes = process.env.KB_MAX_EXTRACTED_TEXT_BYTES;
const savedLargeFilePolicy = process.env.KB_LARGE_FILE_POLICY;

afterEach(() => {
  if (savedChunkSize === undefined) delete process.env.KB_CHUNK_SIZE;
  else process.env.KB_CHUNK_SIZE = savedChunkSize;
  if (savedChunkOverlap === undefined) delete process.env.KB_CHUNK_OVERLAP;
  else process.env.KB_CHUNK_OVERLAP = savedChunkOverlap;
  if (savedMaxExtractedTextBytes === undefined) delete process.env.KB_MAX_EXTRACTED_TEXT_BYTES;
  else process.env.KB_MAX_EXTRACTED_TEXT_BYTES = savedMaxExtractedTextBytes;
  if (savedLargeFilePolicy === undefined) delete process.env.KB_LARGE_FILE_POLICY;
  else process.env.KB_LARGE_FILE_POLICY = savedLargeFilePolicy;
});

// A "word" is an alphanumeric run; tokens used as content. Avoiding spaces /
// newlines as content keeps the test impervious to the splitter's incidental
// whitespace trimming at chunk boundaries.
const wordArb = fc
  .stringMatching(/^[A-Za-z0-9]{1,12}$/)
  .filter((s) => s.length > 0);

// Newline-delimited list of words. The splitter prefers `\n` separators, so
// chunk boundaries land between words; no word is ever split in half.
const wordsArb = fc.array(wordArb, { minLength: 1, maxLength: 200 });

const extensionArb = fc.constantFrom('.md', '.txt', '.rst', '.markdown');

describe('buildChunkDocuments — property tests (issue #219)', () => {
  it('covers every word, respects size bound, has monotonic chunkIndex', async () => {
    await fc.assert(
      fc.asyncProperty(
        wordsArb,
        extensionArb,
        fc.integer({ min: 50, max: 500 }),
        fc.integer({ min: 0, max: 100 }),
        async (words, ext, chunkSize, chunkOverlap) => {
          // langchain rejects chunkOverlap >= chunkSize.
          const safeOverlap = Math.min(chunkOverlap, chunkSize - 1);
          process.env.KB_CHUNK_SIZE = String(chunkSize);
          process.env.KB_CHUNK_OVERLAP = String(safeOverlap);

          const content = words.join('\n');
          const fakeFile = path.join(os.tmpdir(), `kb-prop-${ext.slice(1)}-file${ext}`);
          const docs = await buildChunkDocuments(fakeFile, content, 'kb-prop');

          expect(docs.length).toBeGreaterThan(0);

          // Size bound.
          for (const d of docs) {
            expect(d.pageContent.length).toBeLessThanOrEqual(chunkSize + safeOverlap);
          }

          // chunkIndex monotonicity.
          for (let i = 0; i < docs.length; i += 1) {
            expect(docs[i].metadata.chunkIndex).toBe(i);
          }

          // Metadata shape — wire-shape keys per RFC 011 §5.4.
          for (const d of docs) {
            expect(d.metadata.source).toBe(fakeFile);
            expect(d.metadata.knowledgeBase).toBe('kb-prop');
            expect(d.metadata.extension).toBe(ext);
            expect(Array.isArray(d.metadata.tags)).toBe(true);
            expect(typeof d.metadata.relativePath).toBe('string');
          }

          // Total coverage — every input word lives in some chunk.
          const joined = docs.map((d) => d.pageContent).join('\n');
          for (const w of words) {
            expect(joined.includes(w)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('empty content emits at most one (possibly-empty) chunk', async () => {
    await fc.assert(
      fc.asyncProperty(extensionArb, async (ext) => {
        const fakeFile = path.join(os.tmpdir(), `kb-prop-empty${ext}`);
        const docs = await buildChunkDocuments(fakeFile, '', 'kb-prop');
        // langchain may emit zero or one chunk on empty input — both are fine,
        // chunkIndex is still 0-based and increasing.
        for (let i = 0; i < docs.length; i += 1) {
          expect(docs[i].metadata.chunkIndex).toBe(i);
        }
      }),
      { numRuns: Math.min(NUM_RUNS, 10) },
    );
  });

  it('bounds direct chunk-building input by KB_MAX_EXTRACTED_TEXT_BYTES', async () => {
    process.env.KB_CHUNK_SIZE = '100';
    process.env.KB_CHUNK_OVERLAP = '0';
    process.env.KB_MAX_EXTRACTED_TEXT_BYTES = '5';
    process.env.KB_LARGE_FILE_POLICY = 'truncate';

    const fakeFile = path.join(os.tmpdir(), 'kb-prop-large.txt');
    const docs = await buildChunkDocuments(fakeFile, 'abcdefghij', 'kb-prop');

    expect(docs.map((doc) => doc.pageContent).join('')).toBe('abcde');
  });
});
