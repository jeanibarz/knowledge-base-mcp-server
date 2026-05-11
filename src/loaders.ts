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

import * as fsp from 'fs/promises';
import * as path from 'path';
import { loadWithExtractionCache } from './extraction-cache.js';

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

async function loadText(filePath: string): Promise<string> {
  // `.md` / `.txt` / `INGEST_EXTRA_EXTENSIONS` opt-ins ride this loader. They
  // are already a single fsp.readFile away from "normalized text", so caching
  // would only add overhead (sha256 + a second copy on disk) without saving
  // any parse work. Skip the cache here on purpose; only the expensive PDF
  // and HTML parsers cache.
  return fsp.readFile(filePath, 'utf-8');
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
  return loadWithExtractionCache({
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
}

async function loadHtml(filePath: string): Promise<string> {
  // Issue #279 — same caching gate as `loadPdf`. html-to-text is cheap per
  // call but quadratic in document size on large structured documents, so
  // skipping it on rebuilds is still a meaningful win.
  return loadWithExtractionCache({
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
}

/**
 * Extension → loader override. Keys are lowercased and dot-prefixed to match
 * `path.extname(...).toLowerCase()` directly. Extensions absent from this map
 * fall back to {@link loadText} (read-as-UTF-8); the loader registry only
 * needs an entry when the file format is binary or structured enough that
 * a naive UTF-8 read would be wrong (PDF bytes → U+FFFD noise; HTML →
 * embedded markup tags). Plain-text formats (`.md`, `.txt`, `.json`, `.yaml`,
 * any extension the operator opts into via `INGEST_EXTRA_EXTENSIONS`) ride
 * the default text loader without needing to be enumerated here.
 */
export const LOADERS: Readonly<Record<string, Loader>> = Object.freeze({
  '.pdf': loadPdf,
  '.html': loadHtml,
  '.htm': loadHtml,
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
