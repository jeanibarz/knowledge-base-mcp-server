// Issue #46 — extension-routed loader tests.
//
// Covers:
//   - Text loader for `.md` / `.txt` (the default-fallback path).
//   - PDF loader round-trips text through pdf-parse (fixture generated at
//     test-time via pdfkit so no binary blob lands in the repo).
//   - HTML loader extracts text and drops tags via html-to-text.
//   - `getLoader` dispatch — registered extensions get the format loader,
//     unregistered extensions (e.g. `.json` opted in via INGEST_EXTRA_EXTENSIONS)
//     get the UTF-8 text fallback.
//   - LOADERS registry is frozen so callers can't mutate it from outside.
//
// Issue #279 — every `describe` block that drives the PDF or HTML loader sets
// `EXTRACTION_TEXT_CACHE_DIR` to a per-test temp path BEFORE calling loadFile.
// The PDF and HTML loaders now consult an extraction cache by content hash;
// without per-test redirection, the first test's parse output would land in
// the global cache and every subsequent test on the same bytes would hit the
// cache instead of the pdf-parse / html-to-text mock — destroying the call
// count assertions and the noise-suppression coverage.

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  getLoader,
  LargeFileIngestError,
  LOADERS,
  loadFile,
  SUPPORTED_LOADER_EXTENSIONS,
} from './loaders.js';

// `__fixtures__/sample.pdf` is a 1.4 KB pdfkit-generated PDF committed to
// the repo; regenerate via `node scripts/generate-pdf-fixture.cjs` after
// upgrading pdfkit or pdf-parse. The fixture is used by the routing test
// (verifies the PDF loader is invoked when a `.pdf` extension dispatches)
// and by the regen script (which exercises a real round-trip through
// pdf-parse outside Jest's CJS context).
//
// Jest runs in a CJS context where `import.meta.url` is unavailable; we
// resolve from `process.cwd()` (which Jest sets to the project root via
// `testMatch`) instead of `__dirname`.
const SAMPLE_PDF_FIXTURE = path.join(
  process.cwd(),
  'src',
  '__fixtures__',
  'sample.pdf',
);

// Mock pdf-parse so the suite never actually drives pdfjs-dist. Real PDF
// round-trip is exercised by `scripts/generate-pdf-fixture.cjs` and by the
// runtime path when `.pdf` is enabled with INGEST_EXTRA_EXTENSIONS. The mock
// here verifies that the PDF loader (a) reads the file from disk into a buffer,
// (b) hands it to pdf-parse, and (c) returns the extracted text — which is
// the only logic in `loadPdf` worth unit-testing in isolation.
const pdfParseFnMock = jest.fn();

jest.mock('pdf-parse/lib/pdf-parse.js', () => ({
  __esModule: true,
  default: (buf: Buffer) => pdfParseFnMock(buf),
}));

describe('LOADERS registry', () => {
  it('registers structured loader extensions (text formats fall through to default)', () => {
    expect(SUPPORTED_LOADER_EXTENSIONS).toEqual(
      expect.arrayContaining(['.pdf', '.html', '.htm', '.csv', '.tsv']),
    );
    // Plain-text formats deliberately ride the default text loader so any
    // INGEST_EXTRA_EXTENSIONS opt-in (e.g. `.json`) just works.
    expect(SUPPORTED_LOADER_EXTENSIONS).not.toContain('.md');
    expect(SUPPORTED_LOADER_EXTENSIONS).not.toContain('.txt');
  });

  it('LOADERS object is frozen so callers cannot replace a registered loader at runtime', () => {
    expect(Object.isFrozen(LOADERS)).toBe(true);
  });
});

describe('getLoader / loadFile dispatch', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-loaders-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('routes a `.md` file through the text loader (read as UTF-8 verbatim)', async () => {
    const filePath = path.join(tempDir, 'note.md');
    await fsp.writeFile(filePath, '# Heading\n\nBody paragraph.\n');
    const text = await loadFile(filePath);
    expect(text).toBe('# Heading\n\nBody paragraph.\n');
  });

  it('routes a `.txt` file through the text loader', async () => {
    const filePath = path.join(tempDir, 'note.txt');
    await fsp.writeFile(filePath, 'plain text content');
    expect(await loadFile(filePath)).toBe('plain text content');
  });

  it('falls back to the text loader for an unregistered extension (e.g. `.json` opt-in)', async () => {
    // INGEST_EXTRA_EXTENSIONS=".json" can land a JSON file at this layer.
    // Without a fallback, the loader would return undefined and crash the
    // ingest loop; with the fallback, JSON reads as UTF-8 — same as before
    // issue #46.
    const filePath = path.join(tempDir, 'config.json');
    await fsp.writeFile(filePath, '{"k": "v"}');
    const loader = getLoader(filePath);
    expect(loader).toBeDefined();
    expect(await loadFile(filePath)).toBe('{"k": "v"}');
  });

  it('extension matching is case-insensitive (e.g. `.PDF` resolves to the PDF loader)', () => {
    const upper = getLoader('/tmp/UPPER.PDF');
    const lower = getLoader('/tmp/lower.pdf');
    expect(upper).toBe(lower);
    expect(upper).toBe(LOADERS['.pdf']);
  });
});

describe('CSV/TSV loader — header-context row groups', () => {
  let tempDir = '';
  let priorCacheDir: string | undefined;
  let priorChunkSize: string | undefined;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-loaders-tabular-'));
    priorCacheDir = process.env.EXTRACTION_TEXT_CACHE_DIR;
    priorChunkSize = process.env.KB_CHUNK_SIZE;
    process.env.EXTRACTION_TEXT_CACHE_DIR = path.join(tempDir, 'extraction-cache');
    process.env.KB_CHUNK_SIZE = '180';
  });

  afterEach(async () => {
    if (priorCacheDir === undefined) delete process.env.EXTRACTION_TEXT_CACHE_DIR;
    else process.env.EXTRACTION_TEXT_CACHE_DIR = priorCacheDir;
    if (priorChunkSize === undefined) delete process.env.KB_CHUNK_SIZE;
    else process.env.KB_CHUNK_SIZE = priorChunkSize;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('routes `.csv` through a loader that repeats column headers for each row group', async () => {
    const filePath = path.join(tempDir, 'incidents.csv');
    await fsp.writeFile(
      filePath,
      [
        'id,title,owner,notes',
        '1,Parser,Ada,"quoted, comma"',
        '2,Ops,Ben,plain',
        '3,Docs,Cy,last',
      ].join('\n'),
    );

    const text = await loadFile(filePath);

    expect(getLoader(filePath)).toBe(LOADERS['.csv']);
    expect(text).toContain('source_path: incidents.csv');
    expect(text).toContain('columns: id | title | owner | notes');
    expect(text).toContain('row 1: id=1 | title=Parser | owner=Ada | notes=quoted, comma');
    expect(text).toContain('row 3: id=3 | title=Docs | owner=Cy | notes=last');
    expect(text.match(/^columns: id \| title \| owner \| notes$/gm)?.length).toBeGreaterThan(1);
  });

  it('parses escaped quotes and multiline quoted CSV fields into searchable row text', async () => {
    const filePath = path.join(tempDir, 'quotes.csv');
    await fsp.writeFile(
      filePath,
      'id,note\n1,"hello, ""Ada"""\n2,"first line\nsecond line"\n',
    );

    const text = await loadFile(filePath);

    expect(text).toContain('row 1: id=1 | note=hello, "Ada"');
    expect(text).toContain('row 2: id=2 | note=first line / second line');
  });

  it('routes `.tsv` through the same header-context formatter with tab delimiters', async () => {
    const filePath = path.join(tempDir, 'owners.tsv');
    await fsp.writeFile(filePath, 'id\tname\tnote\n1\tAda\talpha,beta\n');

    const text = await loadFile(filePath);

    expect(getLoader(filePath)).toBe(LOADERS['.tsv']);
    expect(text).toContain('columns: id | name | note');
    expect(text).toContain('row 1: id=1 | name=Ada | note=alpha,beta');
  });

  it('keeps ragged rows retrievable by assigning fallback column names', async () => {
    const filePath = path.join(tempDir, 'ragged.csv');
    await fsp.writeFile(filePath, 'a,b\n1\n2,three,extra\n');

    const text = await loadFile(filePath);

    expect(text).toContain('columns: a | b | column_3');
    expect(text).toContain('row 1: a=1 | b= | column_3=');
    expect(text).toContain('row 2: a=2 | b=three | column_3=extra');
  });
});

describe('PDF loader (pdf-parse) — routing + dispatch (pdf-parse is mocked)', () => {
  let tempDir = '';
  let priorCacheDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-loaders-pdf-'));
    priorCacheDir = process.env.EXTRACTION_TEXT_CACHE_DIR;
    process.env.EXTRACTION_TEXT_CACHE_DIR = path.join(tempDir, 'extraction-cache');
    pdfParseFnMock.mockReset();
  });

  afterEach(async () => {
    if (priorCacheDir === undefined) delete process.env.EXTRACTION_TEXT_CACHE_DIR;
    else process.env.EXTRACTION_TEXT_CACHE_DIR = priorCacheDir;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('reads the file as bytes, hands them to pdf-parse, and returns the extracted text', async () => {
    // Copy the committed fixture into the temp dir so the loader reads
    // the actual PDF bytes — the mock then asserts that pdf-parse was
    // called with those exact bytes (proving the file→buffer hop runs)
    // and returns canned text.
    const filePath = path.join(tempDir, 'sample.pdf');
    await fsp.copyFile(SAMPLE_PDF_FIXTURE, filePath);
    const expectedBytes = await fsp.readFile(SAMPLE_PDF_FIXTURE);

    pdfParseFnMock.mockResolvedValue({ text: 'Mocked PDF text body' });

    const text = await loadFile(filePath);
    expect(text).toBe('Mocked PDF text body');
    expect(pdfParseFnMock).toHaveBeenCalledTimes(1);
    const buf = pdfParseFnMock.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(expectedBytes)).toBe(true);
  });

  it('routes the `.pdf` extension to the PDF loader (not the text loader)', async () => {
    // Smoke-check the dispatch from the loader registry. If `.pdf` ever
    // accidentally fell through to `loadText`, the file's `%PDF-` header
    // would surface as the loader's return value (raw bytes UTF-8-decoded)
    // and the pdf-parse mock would never fire.
    const filePath = path.join(tempDir, 'sample.pdf');
    await fsp.copyFile(SAMPLE_PDF_FIXTURE, filePath);
    pdfParseFnMock.mockResolvedValue({ text: 'OK' });
    await loadFile(filePath);
    expect(pdfParseFnMock).toHaveBeenCalledTimes(1);
  });

  it('propagates parse errors so the ingest loop can log + skip', async () => {
    const filePath = path.join(tempDir, 'corrupt.pdf');
    await fsp.writeFile(filePath, Buffer.from('not a pdf'));
    pdfParseFnMock.mockRejectedValue(new Error('Invalid PDF structure.'));

    await expect(loadFile(filePath)).rejects.toThrow('Invalid PDF structure.');
  });
});

describe('PDF loader — pdfjs-dist stdout noise suppression', () => {
  // Regression for the hybrid-search complaint: pdf-parse@1.1.1 bundles
  // pdfjs-dist v1.10.100, whose worker emits TrueType-sanitizer chatter
  // ("Warning: TT: undefined function: 32",
  // "Warning: FormatError: Required 'loca' table is not found",
  // "Warning: Empty 'FlateDecode' stream.") via console.log when it
  // re-indexes a PDF whose fonts use glyph hints the sanitizer doesn't
  // understand. Those lines used to land on stdout and pollute the
  // retrieval markdown / JSON output. We filter them at the loader's
  // boundary; this suite locks the filter in place.
  let tempDir = '';
  let originalConsoleLog: typeof console.log;
  let stdoutSpy: jest.Mock;
  let priorCacheDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-loaders-pdf-noise-'));
    priorCacheDir = process.env.EXTRACTION_TEXT_CACHE_DIR;
    // Issue #279 — redirect the extraction cache into the per-test tempdir so
    // every test in this suite drives a real parse (the cache lives only for
    // the duration of one test, which is what the noise-suppression assertions
    // assume).
    process.env.EXTRACTION_TEXT_CACHE_DIR = path.join(tempDir, 'extraction-cache');
    pdfParseFnMock.mockReset();
    originalConsoleLog = console.log;
    stdoutSpy = jest.fn();
    console.log = stdoutSpy as unknown as typeof console.log;
  });

  afterEach(async () => {
    console.log = originalConsoleLog;
    if (priorCacheDir === undefined) delete process.env.EXTRACTION_TEXT_CACHE_DIR;
    else process.env.EXTRACTION_TEXT_CACHE_DIR = priorCacheDir;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('drops "Warning: ", "Info: ", and "Deprecated API usage: " lines emitted during pdf-parse', async () => {
    const filePath = path.join(tempDir, 'noisy.pdf');
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4\n'));
    pdfParseFnMock.mockImplementation(async () => {
      // These three prefixes are exactly what pdfjs-dist v1.10.100's
      // util.warn / util.info / util.deprecated emit. The test asserts
      // every such line is dropped so the user's stdout (search results)
      // stays clean.
      console.log('Warning: TT: undefined function: 32');
      console.log('Warning: FormatError: Required "loca" table is not found');
      console.log('Info: Loading font fallback...');
      console.log('Deprecated API usage: PDFJS.something');
      return { text: 'extracted text' };
    });

    const text = await loadFile(filePath);
    expect(text).toBe('extracted text');
    // Filter swallowed all four pdfjs-style lines. Spy never saw them.
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('passes non-pdfjs console.log calls through unchanged', async () => {
    // Defensive: the filter must only match the three pdfjs prefixes.
    // Anything else a downstream library logs during a PDF parse should
    // still reach the real console.log. Otherwise we'd silently swallow
    // legitimate user output if pdf-parse ever delegated to another lib.
    const filePath = path.join(tempDir, 'mixed.pdf');
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4\n'));
    pdfParseFnMock.mockImplementation(async () => {
      console.log('Warning: TT: undefined function: 32'); // dropped
      console.log('user log line that must survive');     // passed through
      console.log('warning: lower-case prefix is unrelated'); // passed through
      return { text: 'ok' };
    });

    await loadFile(filePath);
    expect(stdoutSpy).toHaveBeenCalledTimes(2);
    expect(stdoutSpy.mock.calls[0][0]).toBe('user log line that must survive');
    expect(stdoutSpy.mock.calls[1][0]).toBe('warning: lower-case prefix is unrelated');
  });

  it('restores console.log after the parse resolves', async () => {
    const filePath = path.join(tempDir, 'restore.pdf');
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4\n'));
    pdfParseFnMock.mockResolvedValue({ text: 'ok' });
    const before = console.log;

    await loadFile(filePath);

    // Reference equality — the filter wrapper is gone, our test spy is back.
    expect(console.log).toBe(before);
    // And the spy works as expected after restoration.
    console.log('post-parse line');
    expect(stdoutSpy).toHaveBeenCalledWith('post-parse line');
  });

  it('restores console.log even if pdf-parse rejects', async () => {
    // The filter is installed via try/finally so a corrupt PDF that throws
    // mid-parse cannot leave the wrapper permanently swallowing
    // application-level "Warning: ..." logs.
    const filePath = path.join(tempDir, 'bad.pdf');
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4\n'));
    pdfParseFnMock.mockRejectedValue(new Error('parse boom'));
    const before = console.log;

    await expect(loadFile(filePath)).rejects.toThrow('parse boom');
    expect(console.log).toBe(before);
  });

  it('handles concurrent PDF loads via depth-counting (no early restore)', async () => {
    // The hybrid-search dense + lexical legs both call into loadPdf in
    // parallel under --refresh. If the inner load restored console.log
    // when its own try/finally fired, the outer load's filter would be
    // gone for the rest of its parse and Warning: lines would leak.
    // Depth-count the install/restore so concurrent calls compose.
    const slowPath = path.join(tempDir, 'slow.pdf');
    const fastPath = path.join(tempDir, 'fast.pdf');
    await fsp.writeFile(slowPath, Buffer.from('%PDF-1.4\nslow fixture'));
    await fsp.writeFile(fastPath, Buffer.from('%PDF-1.4\nfast fixture'));

    let releaseSlow!: (v: { text: string }) => void;
    const slowDone = new Promise<{ text: string }>((resolve) => {
      releaseSlow = resolve;
    });

    pdfParseFnMock.mockImplementation((buf: Buffer) => {
      const raw = buf.toString('utf-8');
      if (raw.includes('slow fixture')) {
        // Slow fixture: emit a Warning: line then await the gate that the
        // fast fixture's completion will open.
        console.log('Warning: slow pre-await');
        return slowDone.then((res) => {
          console.log('Warning: slow post-await');
          return res;
        });
      }
      if (raw.includes('fast fixture')) {
        // Fast fixture: emits + resolves immediately, then opens the gate
        // so the slow call can finish. Do not rely on mock call count here;
        // Jest versions differ on whether the current call is visible before
        // the implementation body runs.
        console.log('Warning: fast');
        const result = { text: 'fast-text' };
        releaseSlow({ text: 'slow-text' });
        return Promise.resolve(result);
      }
      return Promise.resolve({ text: '' });
    });

    const slowPromise = loadFile(slowPath);
    const fastPromise = loadFile(fastPath);
    const [slowText, fastText] = await Promise.all([slowPromise, fastPromise]);

    expect(slowText).toBe('slow-text');
    expect(fastText).toBe('fast-text');
    // All three Warning: lines (slow pre-await, fast, slow post-await)
    // must be dropped — including the slow one that emits AFTER the fast
    // load's try/finally has already run. Spy never sees them.
    expect(stdoutSpy).not.toHaveBeenCalled();
    // After both loads settle, console.log is back to the test spy.
    expect(console.log).toBe(stdoutSpy);
  });
});

describe('large-file bounds (#285)', () => {
  const savedMaxFileBytes = process.env.KB_MAX_FILE_BYTES;
  const savedMaxExtractedTextBytes = process.env.KB_MAX_EXTRACTED_TEXT_BYTES;
  const savedLargeFilePolicy = process.env.KB_LARGE_FILE_POLICY;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-loaders-large-'));
    pdfParseFnMock.mockReset();
  });

  afterEach(async () => {
    if (savedMaxFileBytes === undefined) delete process.env.KB_MAX_FILE_BYTES;
    else process.env.KB_MAX_FILE_BYTES = savedMaxFileBytes;
    if (savedMaxExtractedTextBytes === undefined) delete process.env.KB_MAX_EXTRACTED_TEXT_BYTES;
    else process.env.KB_MAX_EXTRACTED_TEXT_BYTES = savedMaxExtractedTextBytes;
    if (savedLargeFilePolicy === undefined) delete process.env.KB_LARGE_FILE_POLICY;
    else process.env.KB_LARGE_FILE_POLICY = savedLargeFilePolicy;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('skips files that exceed KB_MAX_FILE_BYTES before invoking the PDF parser', async () => {
    process.env.KB_MAX_FILE_BYTES = '4';
    process.env.KB_LARGE_FILE_POLICY = 'skip';
    const filePath = path.join(tempDir, 'large.pdf');
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4\nbody'));
    pdfParseFnMock.mockResolvedValue({ text: 'should not parse' });

    await expect(loadFile(filePath)).rejects.toMatchObject({
      code: 'KB_LARGE_FILE_SKIPPED',
      limitKind: 'file_bytes',
      policy: 'skip',
    });
    expect(pdfParseFnMock).not.toHaveBeenCalled();
  });

  it('rejects extracted text over the cap when KB_LARGE_FILE_POLICY=error', async () => {
    process.env.KB_MAX_FILE_BYTES = '100';
    process.env.KB_MAX_EXTRACTED_TEXT_BYTES = '5';
    process.env.KB_LARGE_FILE_POLICY = 'error';
    const filePath = path.join(tempDir, 'large.txt');
    await fsp.writeFile(filePath, 'abcdef');

    let thrown: unknown;
    try {
      await loadFile(filePath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LargeFileIngestError);
    expect(thrown).toMatchObject({
      code: 'KB_LARGE_FILE_TOO_LARGE',
      limitKind: 'extracted_text_bytes',
      observedBytes: 6,
      limitBytes: 5,
      policy: 'error',
    });
  });

  it('streams and truncates text under KB_LARGE_FILE_POLICY=truncate', async () => {
    process.env.KB_MAX_FILE_BYTES = '100';
    process.env.KB_MAX_EXTRACTED_TEXT_BYTES = '5';
    process.env.KB_LARGE_FILE_POLICY = 'truncate';
    const filePath = path.join(tempDir, 'large.txt');
    await fsp.writeFile(filePath, 'abcdef');

    await expect(loadFile(filePath)).resolves.toBe('abcde');
  });

  it('does not split a multibyte UTF-8 character while truncating', async () => {
    process.env.KB_MAX_FILE_BYTES = '100';
    process.env.KB_MAX_EXTRACTED_TEXT_BYTES = '5';
    process.env.KB_LARGE_FILE_POLICY = 'truncate';
    const filePath = path.join(tempDir, 'emoji.txt');
    await fsp.writeFile(filePath, 'abcdé');

    await expect(loadFile(filePath)).resolves.toBe('abcd');
  });

  it('truncates extracted HTML text after markup conversion', async () => {
    process.env.KB_MAX_FILE_BYTES = '100';
    process.env.KB_MAX_EXTRACTED_TEXT_BYTES = '5';
    process.env.KB_LARGE_FILE_POLICY = 'truncate';
    const filePath = path.join(tempDir, 'large.html');
    await fsp.writeFile(filePath, '<html><body><p>abcdef</p></body></html>');

    await expect(loadFile(filePath)).resolves.toBe('abcde');
  });
});

describe('HTML loader (html-to-text)', () => {
  let tempDir = '';
  let priorCacheDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-loaders-html-'));
    priorCacheDir = process.env.EXTRACTION_TEXT_CACHE_DIR;
    process.env.EXTRACTION_TEXT_CACHE_DIR = path.join(tempDir, 'extraction-cache');
  });

  afterEach(async () => {
    if (priorCacheDir === undefined) delete process.env.EXTRACTION_TEXT_CACHE_DIR;
    else process.env.EXTRACTION_TEXT_CACHE_DIR = priorCacheDir;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('extracts text content from an HTML file (tags stripped, paragraphs preserved)', async () => {
    const filePath = path.join(tempDir, 'sample.html');
    await fsp.writeFile(
      filePath,
      `<html>
        <head><title>Ignored</title><script>var x = 1;</script></head>
        <body>
          <h1>Greeting</h1>
          <p>Hello <strong>HTML</strong> World.</p>
          <p>Second paragraph.</p>
        </body>
      </html>`,
    );

    const text = await loadFile(filePath);
    // html-to-text renders <h1> in uppercase by default — the original
    // capitalisation is irrelevant to embeddings, just check the word is
    // present case-insensitively.
    expect(text.toLowerCase()).toContain('greeting');
    expect(text).toContain('Hello HTML World.');
    expect(text).toContain('Second paragraph.');
    // Tags are stripped.
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('<h1>');
    // Script content does not leak into the embedding text.
    expect(text).not.toContain('var x = 1');
  });

  it('handles `.htm` (legacy extension) the same way as `.html`', async () => {
    const htm = path.join(tempDir, 'legacy.htm');
    const html = path.join(tempDir, 'modern.html');
    const markup = '<html><body><p>Same content</p></body></html>';
    await fsp.writeFile(htm, markup);
    await fsp.writeFile(html, markup);
    expect(await loadFile(htm)).toBe(await loadFile(html));
  });

  it('drops `<a href>` URLs but keeps the link text (URLs are noise inside an embedding)', async () => {
    const filePath = path.join(tempDir, 'links.html');
    await fsp.writeFile(
      filePath,
      '<p>See <a href="https://example.com/long/url">the docs</a> for details.</p>',
    );
    const text = await loadFile(filePath);
    expect(text).toContain('the docs');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('https://');
  });
});

describe('Issue #279 — PDF loader honors the extraction cache', () => {
  // End-to-end coverage that the cache wire actually short-circuits the
  // expensive parser path. We mock pdf-parse and assert the mock fires
  // exactly once across two loadFile() calls on the same bytes; a third
  // call after rewriting the file produces a cache miss and re-fires.
  let tempDir = '';
  let priorCacheDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-loaders-pdf-cache-'));
    priorCacheDir = process.env.EXTRACTION_TEXT_CACHE_DIR;
    process.env.EXTRACTION_TEXT_CACHE_DIR = path.join(tempDir, 'extraction-cache');
    pdfParseFnMock.mockReset();
  });

  afterEach(async () => {
    if (priorCacheDir === undefined) delete process.env.EXTRACTION_TEXT_CACHE_DIR;
    else process.env.EXTRACTION_TEXT_CACHE_DIR = priorCacheDir;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('skips pdf-parse on the second load of identical bytes (cache hit)', async () => {
    const filePath = path.join(tempDir, 'doc.pdf');
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4 fixed bytes'));
    pdfParseFnMock.mockResolvedValue({ text: 'parsed body' });

    const first = await loadFile(filePath);
    const second = await loadFile(filePath);

    expect(first).toBe('parsed body');
    expect(second).toBe('parsed body');
    // The whole point of #279: forced rebuilds and multi-model registration
    // must not re-drive pdf-parse on bytes whose extraction is already cached.
    expect(pdfParseFnMock).toHaveBeenCalledTimes(1);
  });

  it('re-runs pdf-parse when the file bytes change (sha256 differs → cache miss)', async () => {
    const filePath = path.join(tempDir, 'doc.pdf');
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4 first'));
    pdfParseFnMock
      .mockResolvedValueOnce({ text: 'first body' })
      .mockResolvedValueOnce({ text: 'second body' });

    expect(await loadFile(filePath)).toBe('first body');

    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4 second'));
    expect(await loadFile(filePath)).toBe('second body');

    // First call landed a cache entry, second call's bytes hash to a
    // different key so the parser must be invoked again — embeddings must
    // reflect the latest content, not a stale cached extraction.
    expect(pdfParseFnMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed parse (next call re-runs the parser)', async () => {
    // A poisoned-cache regression would let one bad PDF permanently break
    // ingest of that file even after the source was fixed. The loader must
    // only store successful extractions.
    const filePath = path.join(tempDir, 'flaky.pdf');
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4 flaky'));
    pdfParseFnMock
      .mockRejectedValueOnce(new Error('parse boom'))
      .mockResolvedValueOnce({ text: 'recovered' });

    await expect(loadFile(filePath)).rejects.toThrow('parse boom');
    expect(await loadFile(filePath)).toBe('recovered');
    expect(pdfParseFnMock).toHaveBeenCalledTimes(2);
  });
});

describe('Issue #279 — HTML loader honors the extraction cache', () => {
  // The real html-to-text runs end-to-end here (mocking it is brittle because
  // the loader's `await import('html-to-text')` is lazy and other suites in
  // this file already pulled in the real module). Instead of counting parser
  // invocations we inspect the cache directory directly — that is sufficient
  // to verify the wire because:
  //   - a successful load with a fresh cacheDir MUST create exactly one entry
  //     (proves the writeCachedExtraction path runs and points at the right dir);
  //   - a second load with identical bytes MUST NOT create a second entry
  //     (proves the readCachedExtraction path is consulted before re-parsing);
  //   - rewriting the file MUST produce a second, differently-named entry
  //     (proves the cache key tracks the content hash).
  let tempDir = '';
  let cacheDir = '';
  let priorCacheDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-loaders-html-cache-'));
    cacheDir = path.join(tempDir, 'extraction-cache');
    priorCacheDir = process.env.EXTRACTION_TEXT_CACHE_DIR;
    process.env.EXTRACTION_TEXT_CACHE_DIR = cacheDir;
  });

  afterEach(async () => {
    if (priorCacheDir === undefined) delete process.env.EXTRACTION_TEXT_CACHE_DIR;
    else process.env.EXTRACTION_TEXT_CACHE_DIR = priorCacheDir;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('writes a cache entry on first load and reuses it (no new entry) on a second load of identical bytes', async () => {
    const filePath = path.join(tempDir, 'doc.html');
    await fsp.writeFile(filePath, '<p>Stable HTML body.</p>');

    const first = await loadFile(filePath);
    const firstEntries = await fsp.readdir(cacheDir);

    const second = await loadFile(filePath);
    const secondEntries = await fsp.readdir(cacheDir);

    expect(second).toBe(first);
    expect(firstEntries).toHaveLength(1);
    // Cache-hit path: second load found the entry and did not write a new one.
    expect(secondEntries).toEqual(firstEntries);
  });

  it('writes a second, differently-keyed entry when the file bytes change', async () => {
    const filePath = path.join(tempDir, 'doc.html');
    await fsp.writeFile(filePath, '<p>version one</p>');
    const firstText = await loadFile(filePath);
    const afterFirst = await fsp.readdir(cacheDir);
    expect(afterFirst).toHaveLength(1);

    await fsp.writeFile(filePath, '<p>version two</p>');
    const secondText = await loadFile(filePath);
    const afterSecond = await fsp.readdir(cacheDir);

    expect(secondText).not.toBe(firstText);
    // Two distinct cache entries: one per content hash. The first remains on
    // disk because the key is content-addressed, not path-addressed — a
    // rollback to v1 of the file would hit the original entry without re-parsing.
    expect(afterSecond).toHaveLength(2);
    expect(new Set(afterSecond).size).toBe(2);
    expect(afterSecond).toEqual(expect.arrayContaining(afterFirst));
  });
});
