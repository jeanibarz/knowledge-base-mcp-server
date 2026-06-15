// Issue #46 — extension-routed file loaders.
//
// `FaissIndexManager.updateIndex` historically called `fs.readFile(filePath, 'utf-8')`
// on every ingestable file. That works for `.md` / `.txt` but turned `.pdf` and
// `.html` into either U+FFFD noise (PDF bytes decoded as UTF-8) or raw markup
// embedded with the visible text (HTML tags). This module routes a file by its
// lowercased extension to a loader that returns plain text suitable for the
// existing splitter + embedder pipeline.
//
// Library choices:
//   - `pdf-parse@^1.1.1` for `.pdf`. Pure-JS, no native bindings, exposes a
//     `pdfParse(buffer): Promise<{text, numpages, ...}>` API. Pinned to v1
//     because `@langchain/community@^0.3.59` declares
//     `peerOptional pdf-parse@1.1.1`; v2 satisfies our usage but trips
//     `npm ci` (CI uses strict peer resolution, which legacy-peer-deps
//     can't bypass without a project-wide `.npmrc` flag).
//   - `html-to-text` for `.html` / `.htm`. Pure-JS, no DOM emulation, focuses
//     on producing readable plain text (preserves paragraph/list breaks,
//     skips `<script>` / `<style>`). Lighter than cheerio + manual extraction.
//
// Both modules are imported lazily inside the loader so the cold-start cost is
// only paid by KBs that actually contain PDFs or HTML.

import { createReadStream } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { resolveLargeFileLimits, type KBLargeFilePolicy } from './config/ingest.js';
import { resolveChunkSize } from './config/indexing.js';
import { loadWithExtractionCache } from './extraction-cache.js';
import { formatNotebook } from './loaders-ipynb.js';

/** Loader contract: filePath in, plain text out. Throws on parse failure. */
export type Loader = (filePath: string) => Promise<string>;

// Issue #279 — bump these constants whenever the extraction behavior of the
// corresponding loader changes in a way that would affect chunk content
// (different html-to-text selectors, a pdf-parse upgrade that alters text
// flow, etc.). The version is folded into the extraction-cache key so a bump
// transparently invalidates every cached entry produced by the previous
// behavior; operators do not need to manually purge `extracted-text/`.
const PDF_LOADER_NAME = 'pdf-parse';
const PDF_LOADER_VERSION = 1;
const HTML_LOADER_NAME = 'html-to-text';
const HTML_LOADER_VERSION = 1;
const DELIMITED_TABLE_LOADER_NAME = 'delimited-table';
const DELIMITED_TABLE_LOADER_VERSION = 1;
const IPYNB_LOADER_NAME = 'ipynb';
const IPYNB_LOADER_VERSION = 1;

export type LargeFileLimitKind = 'file_bytes' | 'extracted_text_bytes';

export class LargeFileIngestError extends Error {
  readonly code: 'KB_LARGE_FILE_SKIPPED' | 'KB_LARGE_FILE_TOO_LARGE';
  readonly filePath: string;
  readonly limitKind: LargeFileLimitKind;
  readonly observedBytes: number;
  readonly limitBytes: number;
  readonly policy: KBLargeFilePolicy;

  constructor(args: {
    filePath: string;
    limitKind: LargeFileLimitKind;
    observedBytes: number;
    limitBytes: number;
    policy: KBLargeFilePolicy;
  }) {
    const action = args.policy === 'skip' ? 'skipped' : 'rejected';
    super(
      `Large file ${action}: ${args.filePath} ${args.limitKind}=${args.observedBytes} ` +
      `exceeds limit ${args.limitBytes} (KB_LARGE_FILE_POLICY=${args.policy})`,
    );
    this.name = 'LargeFileIngestError';
    this.code = args.policy === 'skip' ? 'KB_LARGE_FILE_SKIPPED' : 'KB_LARGE_FILE_TOO_LARGE';
    this.filePath = args.filePath;
    this.limitKind = args.limitKind;
    this.observedBytes = args.observedBytes;
    this.limitBytes = args.limitBytes;
    this.policy = args.policy;
  }
}

type LargeFileLimits = ReturnType<typeof resolveLargeFileLimits>;

function throwLargeFileLimit(args: {
  filePath: string;
  limitKind: LargeFileLimitKind;
  observedBytes: number;
  limitBytes: number;
  policy: KBLargeFilePolicy;
}): never {
  throw new LargeFileIngestError(args);
}

async function statSize(filePath: string): Promise<number> {
  return (await fsp.stat(filePath)).size;
}

function enforceFileSizeLimit(
  filePath: string,
  size: number,
  limits: LargeFileLimits,
): void {
  if (size > limits.maxFileBytes) {
    throwLargeFileLimit({
      filePath,
      limitKind: 'file_bytes',
      observedBytes: size,
      limitBytes: limits.maxFileBytes,
      policy: limits.policy,
    });
  }
}

function trimIncompleteUtf8(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  let leadIndex = buffer.length - 1;
  while (leadIndex >= 0 && (buffer[leadIndex] & 0xc0) === 0x80) {
    leadIndex -= 1;
  }
  if (leadIndex < 0) return Buffer.alloc(0);
  const lead = buffer[leadIndex];
  const expectedLength = lead < 0x80
    ? 1
    : (lead & 0xe0) === 0xc0
      ? 2
      : (lead & 0xf0) === 0xe0
        ? 3
        : (lead & 0xf8) === 0xf0
          ? 4
          : 1;
  const actualLength = buffer.length - leadIndex;
  return actualLength < expectedLength ? buffer.subarray(0, leadIndex) : buffer;
}

function utf8Prefix(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= maxBytes) return text;
  return trimIncompleteUtf8(buffer.subarray(0, maxBytes)).toString('utf-8');
}

async function readUtf8Prefix(filePath: string, maxBytes: number): Promise<string> {
  if (maxBytes <= 0) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxBytes - total;
    if (remaining <= 0) break;
    if (buffer.length > remaining) {
      chunks.push(buffer.subarray(0, remaining));
      total += remaining;
      break;
    }
    chunks.push(buffer);
    total += buffer.length;
  }
  return trimIncompleteUtf8(Buffer.concat(chunks, total)).toString('utf-8');
}

export function applyExtractedTextLimit(filePath: string, text: string): string {
  const limits = resolveLargeFileLimits();
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes <= limits.maxExtractedTextBytes) return text;
  if (limits.policy === 'truncate') {
    return utf8Prefix(text, limits.maxExtractedTextBytes);
  }
  return throwLargeFileLimit({
    filePath,
    limitKind: 'extracted_text_bytes',
    observedBytes: bytes,
    limitBytes: limits.maxExtractedTextBytes,
    policy: limits.policy,
  });
}

async function loadText(filePath: string): Promise<string> {
  const limits = resolveLargeFileLimits();
  const size = await statSize(filePath);
  if (limits.policy !== 'truncate') {
    enforceFileSizeLimit(filePath, size, limits);
    if (size > limits.maxExtractedTextBytes) {
      throwLargeFileLimit({
        filePath,
        limitKind: 'extracted_text_bytes',
        observedBytes: size,
        limitBytes: limits.maxExtractedTextBytes,
        policy: limits.policy,
      });
    }
    return fsp.readFile(filePath, 'utf-8');
  }
  const maxReadBytes = Math.min(size, limits.maxFileBytes, limits.maxExtractedTextBytes);
  return readUtf8Prefix(filePath, maxReadBytes);
}

type Delimiter = ',' | '\t';

interface DelimitedRecord {
  fields: string[];
}

interface FormattedRow {
  rowNumber: number;
  text: string;
}

function isBlankRecord(fields: readonly string[]): boolean {
  return fields.every((field) => field.trim() === '');
}

function pushDelimitedRecord(
  records: DelimitedRecord[],
  fields: string[],
  field: string,
): void {
  const recordFields = [...fields, field];
  if (!isBlankRecord(recordFields)) {
    records.push({ fields: recordFields });
  }
}

function parseDelimitedRecords(text: string, delimiter: Delimiter): DelimitedRecord[] {
  const records: DelimitedRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawRecordContent = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      if (char === '\r') {
        if (text[i + 1] === '\n') i += 1;
        field += '\n';
        sawRecordContent = true;
        continue;
      }
      field += char;
      sawRecordContent = true;
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
      sawRecordContent = true;
      continue;
    }
    if (char === delimiter) {
      fields.push(field);
      field = '';
      sawRecordContent = true;
      continue;
    }
    if (char === '\n' || char === '\r') {
      pushDelimitedRecord(records, fields, field);
      fields = [];
      field = '';
      sawRecordContent = false;
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      continue;
    }
    field += char;
    sawRecordContent = true;
  }

  if (sawRecordContent || fields.length > 0 || field.length > 0) {
    pushDelimitedRecord(records, fields, field);
  }
  return records;
}

function normalizeTableCell(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, ' / ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeColumnNames(records: readonly DelimitedRecord[]): string[] {
  const header = records[0]?.fields ?? [];
  const width = records.reduce(
    (max, record) => Math.max(max, record.fields.length),
    header.length,
  );
  const columns: string[] = [];
  for (let i = 0; i < width; i += 1) {
    columns.push(normalizeTableCell(header[i] ?? '') || `column_${i + 1}`);
  }
  return columns;
}

function formatDelimitedRow(
  rowNumber: number,
  fields: readonly string[],
  columns: readonly string[],
): FormattedRow {
  const cells = columns.map((column, index) => (
    `${column}=${normalizeTableCell(fields[index] ?? '')}`
  ));
  return {
    rowNumber,
    text: `row ${rowNumber}: ${cells.join(' | ')}`,
  };
}

function formatDelimitedGroup(
  filePath: string,
  columns: readonly string[],
  rows: readonly FormattedRow[],
): string {
  const rowRange = rows.length === 0
    ? 'none'
    : `${rows[0].rowNumber}-${rows[rows.length - 1].rowNumber}`;
  return [
    `source_path: ${path.basename(filePath)}`,
    `rows: ${rowRange}`,
    `columns: ${columns.join(' | ')}`,
    '',
    ...rows.map((row) => row.text),
  ].join('\n').trimEnd();
}

function formatDelimitedTable(
  raw: string,
  delimiter: Delimiter,
  filePath: string,
  targetChars: number,
): string {
  const records = parseDelimitedRecords(raw, delimiter);
  if (records.length === 0) return '';

  const columns = normalizeColumnNames(records);
  const rows = records
    .slice(1)
    .map((record, index) => formatDelimitedRow(index + 1, record.fields, columns));
  if (rows.length === 0) {
    return formatDelimitedGroup(filePath, columns, []);
  }

  const groups: string[] = [];
  let currentRows: FormattedRow[] = [];
  const groupHeaderLength = formatDelimitedGroup(filePath, columns, []).length;
  let currentLength = groupHeaderLength;

  for (const row of rows) {
    const separatorLength = currentRows.length === 0 ? 0 : 1;
    const projectedLength = currentLength + separatorLength + row.text.length;
    if (currentRows.length > 0 && projectedLength > targetChars) {
      groups.push(formatDelimitedGroup(filePath, columns, currentRows));
      currentRows = [];
      currentLength = groupHeaderLength;
    }
    currentRows.push(row);
    currentLength += (currentRows.length === 1 ? 0 : 1) + row.text.length;
  }

  if (currentRows.length > 0) {
    groups.push(formatDelimitedGroup(filePath, columns, currentRows));
  }
  return groups.join('\n\n');
}

async function loadDelimitedTable(filePath: string, delimiter: Delimiter): Promise<string> {
  const limits = resolveLargeFileLimits();
  const size = await statSize(filePath);
  const { chunkSize } = resolveChunkSize();

  if (limits.policy === 'truncate') {
    const raw = await readUtf8Prefix(
      filePath,
      Math.min(size, limits.maxFileBytes, limits.maxExtractedTextBytes),
    );
    return applyExtractedTextLimit(
      filePath,
      formatDelimitedTable(raw, delimiter, filePath, chunkSize),
    );
  }

  enforceFileSizeLimit(filePath, size, limits);
  const text = await loadWithExtractionCache({
    filePath,
    loaderName: `${DELIMITED_TABLE_LOADER_NAME}:${chunkSize}`,
    loaderVersion: DELIMITED_TABLE_LOADER_VERSION,
    parse: async (buffer) => formatDelimitedTable(
      buffer.toString('utf-8'),
      delimiter,
      filePath,
      chunkSize,
    ),
  });
  return applyExtractedTextLimit(filePath, text);
}

function loadCsv(filePath: string): Promise<string> {
  return loadDelimitedTable(filePath, ',');
}

function loadTsv(filePath: string): Promise<string> {
  return loadDelimitedTable(filePath, '\t');
}

// Issue #652 — structure-aware Jupyter notebook loader. Parses the notebook
// JSON and re-emits one labelled block per cell (see `loaders-ipynb.ts`)
// rather than letting the file ride the default text loader as one opaque JSON
// blob. Mirrors the delimited-table loader's large-file handling and gates the
// parse behind the content-addressed extraction cache (#279).
async function loadIpynb(filePath: string): Promise<string> {
  const limits = resolveLargeFileLimits();
  const size = await statSize(filePath);

  if (limits.policy === 'truncate') {
    // A truncated notebook is no longer valid JSON, so parsing the prefix
    // would throw. Read the whole file (still bounded by the byte limits) and
    // bound the formatted text afterwards, matching the delimited-table path.
    const raw = await readUtf8Prefix(
      filePath,
      Math.min(size, limits.maxFileBytes, limits.maxExtractedTextBytes),
    );
    return applyExtractedTextLimit(filePath, safeFormatNotebook(raw, filePath));
  }

  enforceFileSizeLimit(filePath, size, limits);
  const text = await loadWithExtractionCache({
    filePath,
    loaderName: IPYNB_LOADER_NAME,
    loaderVersion: IPYNB_LOADER_VERSION,
    parse: async (buffer) => safeFormatNotebook(buffer.toString('utf-8'), filePath),
  });
  return applyExtractedTextLimit(filePath, text);
}

// A `.ipynb` whose JSON is malformed (truncated export, hand-edited) should
// not abort the whole ingest run. Fall back to the raw text so the file is
// still ingested verbatim — the same outcome the default text loader would
// have produced before this loader existed.
function safeFormatNotebook(raw: string, filePath: string): string {
  try {
    return formatNotebook(raw, filePath);
  } catch {
    return raw;
  }
}

// Reentrancy depth for `silencePdfjsConsole` — pdf-parse calls can interleave
// (the hybrid-search dense and lexical legs both load PDFs in parallel under
// `--refresh`). Depth-counting ensures the first concurrent caller installs
// the filter, the last one restores the real `console.log`, and intermediate
// callers neither double-install nor restore early.
let pdfjsSilenceDepth = 0;
let pdfjsOriginalConsoleLog: typeof console.log | null = null;

/**
 * Filter `console.log` for the duration of `fn` so the pdfjs-dist v1.10.100
 * bundle inside `pdf-parse@1.1.1` does not pollute stdout with TrueType
 * sanitizer chatter.
 *
 * Why the noise exists. pdf-parse bundles pdfjs-dist v1.10.100. Inside that
 * bundle, `warn(msg)` resolves to `console.log('Warning: ' + msg)` and is
 * called by the TrueType-program sanitizer for every glyph hint it doesn't
 * understand ("TT: undefined function: 32") and by the font loader on
 * malformed font tables ("FormatError: Required 'loca' table is not found").
 * Text extraction succeeds anyway — these are advisory, not failures.
 *
 * Why we cannot just lower verbosity. The bundled pdfjs has two copies of
 * the verbosity flag: one in `pdf.js` (reachable via `PDFJS.verbosity`) and
 * one in `pdf.worker.js` (module-private, only exposed to outside callers
 * through `WorkerMessageHandler`). pdf.js synchronizes the two by sending a
 * `configure` message — but ONLY on the real-Worker path. In Node we always
 * take the fake-worker `LoopbackPort` path, where no `configure` message is
 * sent and the worker keeps `verbosity = warnings` regardless of what we set
 * on the main module. Setting `PDFJS.verbosity = 0` therefore has no effect
 * on the warnings emitted from inside the worker bundle.
 *
 * Filtering the single Node process's `console.log` is the smallest fix that
 * actually silences the noise. We match the three prefixes pdfjs uses
 * (`Warning: `, `Info: `, `Deprecated API usage: `) and pass everything else
 * through unchanged so user `console.log` calls are unaffected. Reentrant
 * via depth-counting so concurrent PDF loads don't restore each other early.
 */
async function silencePdfjsConsole<T>(fn: () => Promise<T>): Promise<T> {
  if (pdfjsSilenceDepth === 0) {
    pdfjsOriginalConsoleLog = console.log;
    const realLog = pdfjsOriginalConsoleLog;
    console.log = (...args: unknown[]): void => {
      const first = args[0];
      if (
        typeof first === 'string' &&
        (first.startsWith('Warning: ') ||
          first.startsWith('Info: ') ||
          first.startsWith('Deprecated API usage: '))
      ) {
        return;
      }
      realLog(...args);
    };
  }
  pdfjsSilenceDepth += 1;
  try {
    return await fn();
  } finally {
    pdfjsSilenceDepth -= 1;
    if (pdfjsSilenceDepth === 0 && pdfjsOriginalConsoleLog !== null) {
      console.log = pdfjsOriginalConsoleLog;
      pdfjsOriginalConsoleLog = null;
    }
  }
}

async function loadPdf(filePath: string): Promise<string> {
  const limits = resolveLargeFileLimits();
  const size = await statSize(filePath);
  enforceFileSizeLimit(filePath, size, limits);
  // pdf-parse@1 ships its main as a CJS function with `module.exports = PDF`
  // and a `parent`-less debug branch that fires on import (it tries to read
  // a bundled test fixture from `./test/data/...`). Importing under that
  // condition crashes with ENOENT before we ever feed it our buffer. Both
  // `require('pdf-parse/lib/pdf-parse.js')` and `await import(...)` of the
  // direct lib file dodge the debug branch by setting `module.parent` to a
  // truthy value at load time. The `@ts-expect-error` is for the
  // un-typed subpath; pdf-parse/lib/pdf-parse.js is the same function as
  // the package main, just without the debug branch wrapper.
  //
  // Issue #279 — gate the heavy parse behind the content-addressed extraction
  // cache. On a cache hit we never touch pdfjs-dist at all; on a miss we run
  // the original parse and store its output for the next caller.
  const text = await loadWithExtractionCache({
    filePath,
    loaderName: PDF_LOADER_NAME,
    loaderVersion: PDF_LOADER_VERSION,
    parse: async (buffer) => {
      // @ts-expect-error: subpath import resolved at runtime, not by tsc
      const mod = await import('pdf-parse/lib/pdf-parse.js');
      const pdfParse = (mod.default ?? mod) as (
        buf: Buffer,
      ) => Promise<{ text: string }>;
      const result = await silencePdfjsConsole(() => pdfParse(buffer));
      return result.text;
    },
  });
  return applyExtractedTextLimit(filePath, text);
}

async function loadHtml(filePath: string): Promise<string> {
  const limits = resolveLargeFileLimits();
  const size = await statSize(filePath);
  if (limits.policy === 'truncate') {
    const { htmlToText } = await import('html-to-text');
    const raw = await readUtf8Prefix(filePath, Math.min(size, limits.maxFileBytes));
    return applyExtractedTextLimit(filePath, htmlToText(raw, {
      wordwrap: false,
      selectors: [
        // Hrefs are noise inside an embedding; the link text is what matters.
        { selector: 'a', options: { ignoreHref: true } },
        // Images carry no embeddable text; skip the alt-text-only line they'd produce.
        { selector: 'img', format: 'skip' },
      ],
    }));
  }
  enforceFileSizeLimit(filePath, size, limits);
  // Issue #279 — same caching gate as `loadPdf`. html-to-text is cheap per
  // call but quadratic in document size on large structured documents, so
  // skipping it on rebuilds is still a meaningful win.
  const text = await loadWithExtractionCache({
    filePath,
    loaderName: HTML_LOADER_NAME,
    loaderVersion: HTML_LOADER_VERSION,
    parse: async (buffer) => {
      const { htmlToText } = await import('html-to-text');
      const raw = buffer.toString('utf-8');
      return htmlToText(raw, {
        wordwrap: false,
        selectors: [
          // Hrefs are noise inside an embedding; the link text is what matters.
          { selector: 'a', options: { ignoreHref: true } },
          // Images carry no embeddable text; skip the alt-text-only line they'd produce.
          { selector: 'img', format: 'skip' },
        ],
      });
    },
  });
  return applyExtractedTextLimit(filePath, text);
}

/**
 * Extension → loader override. Keys are lowercased and dot-prefixed to match
 * `path.extname(...).toLowerCase()` directly. Extensions absent from this map
 * fall back to {@link loadText} (read-as-UTF-8); the loader registry only
 * needs an entry when the file format is binary or structured enough that
 * a naive UTF-8 read would be wrong (PDF bytes → U+FFFD noise; HTML →
 * embedded markup tags; CSV/TSV rows → chunks without column context;
 * `.ipynb` → one opaque JSON blob instead of per-cell context).
 * Plain-text formats (`.md`, `.txt`, `.json`, `.yaml`, any extension the
 * operator opts into via `INGEST_EXTRA_EXTENSIONS`) ride the default text
 * loader without needing to be enumerated here.
 */
export const LOADERS: Readonly<Record<string, Loader>> = Object.freeze({
  '.pdf': loadPdf,
  '.html': loadHtml,
  '.htm': loadHtml,
  '.csv': loadCsv,
  '.tsv': loadTsv,
  '.ipynb': loadIpynb,
});

/** Lowercased dot-prefixed extensions with a non-text loader registered. */
export const SUPPORTED_LOADER_EXTENSIONS: readonly string[] = Object.freeze(
  Object.keys(LOADERS),
);

/**
 * Returns the registered loader for `filePath`'s extension. Falls back to
 * {@link loadText} for any unmapped extension — the upstream ingest filter
 * is the canonical guard against unwanted extensions, this layer assumes
 * the caller has already decided the file should be ingested.
 */
export function getLoader(filePath: string): Loader {
  const ext = path.extname(filePath).toLowerCase();
  return LOADERS[ext] ?? loadText;
}

/** Convenience wrapper: route by extension and load to a string. */
export function loadFile(filePath: string): Promise<string> {
  return getLoader(filePath)(filePath);
}
