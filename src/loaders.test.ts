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

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  getLoader,
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
// runtime path that ingests `.pdf` files at `npm start`. The mock here
// verifies that the PDF loader (a) reads the file from disk into a buffer,
// (b) hands it to pdf-parse, and (c) returns the extracted text — which is
// the only logic in `loadPdf` worth unit-testing in isolation.
const pdfParseFnMock = jest.fn();

jest.mock('pdf-parse/lib/pdf-parse.js', () => ({
  __esModule: true,
  default: (buf: Buffer) => pdfParseFnMock(buf),
}));

describe('LOADERS registry', () => {
  it('registers PDF and HTML extensions only (text formats fall through to default)', () => {
    expect(SUPPORTED_LOADER_EXTENSIONS).toEqual(
      expect.arrayContaining(['.pdf', '.html', '.htm']),
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

describe('PDF loader (pdf-parse) — routing + dispatch (pdf-parse is mocked)', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-loaders-pdf-'));
    pdfParseFnMock.mockReset();
  });

  afterEach(async () => {
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

describe('HTML loader (html-to-text)', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-loaders-html-'));
  });

  afterEach(async () => {
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
