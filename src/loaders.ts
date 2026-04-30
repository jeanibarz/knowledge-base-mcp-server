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

/** Loader contract: filePath in, plain text out. Throws on parse failure. */
export type Loader = (filePath: string) => Promise<string>;

async function loadText(filePath: string): Promise<string> {
  return fsp.readFile(filePath, 'utf-8');
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
  // @ts-expect-error: subpath import resolved at runtime, not by tsc
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  const pdfParse = (mod.default ?? mod) as (
    buf: Buffer,
  ) => Promise<{ text: string }>;
  const buffer = await fsp.readFile(filePath);
  const result = await pdfParse(buffer);
  return result.text;
}

async function loadHtml(filePath: string): Promise<string> {
  const { htmlToText } = await import('html-to-text');
  const raw = await fsp.readFile(filePath, 'utf-8');
  return htmlToText(raw, {
    wordwrap: false,
    selectors: [
      // Hrefs are noise inside an embedding; the link text is what matters.
      { selector: 'a', options: { ignoreHref: true } },
      // Images carry no embeddable text; skip the alt-text-only line they'd produce.
      { selector: 'img', format: 'skip' },
    ],
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
