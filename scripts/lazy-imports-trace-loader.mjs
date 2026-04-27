// Issue #59 — ESM loader hook used only by `verify-lazy-imports.mjs`.
//
// Records every module URL the loader resolves into the file pointed at by
// $LAZY_IMPORTS_TRACE_FILE. Per-process, single shot — the file is opened
// in append mode and closed by the OS on process exit.
//
// Loader hooks run in their own scope, so we can't share state with the
// probe; the file path crosses the boundary via env. We use writeFileSync
// per resolve (cheap; the probe only loads ~1k modules total) instead of
// buffering, so a probe that crashes mid-init still produces a useful trace.
import { appendFileSync } from 'node:fs';

const TRACE_FILE = process.env.LAZY_IMPORTS_TRACE_FILE;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (TRACE_FILE) {
    appendFileSync(TRACE_FILE, `${result.url}\n`);
  }
  return result;
}
