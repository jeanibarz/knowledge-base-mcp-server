// Issue #405 — repo-wide non-CLI import boundary guard.
//
// This repo has repeatedly extracted command-independent logic out of
// `cli-*` command modules into shared, command-independent modules
// (issues #338-#342, PR #360 "move reusable CLI internals into core
// modules"). `src/search-core.boundaries.test.ts` pins two specific
// consumers (`retrieval-eval`, `ingest-quarantine`); this test is the
// repo-wide net: NO production module other than the CLI itself may
// import a `cli-*` command adapter.
//
// Definitions used by the scan:
//   * "production module" — any `.ts` file under `src/` that is not a
//     test (`*.test.ts`) and not under a test/fixture directory.
//   * "CLI module" — `cli.ts` (the dispatcher) or any `cli-*.ts`
//     command adapter. A CLI module importing another `cli-*` module is
//     expected: that is how `cli.ts` wires its subcommands.
//   * a "cli-* import" — a relative import/export/`require`/`import()`
//     whose target file basename starts with `cli-`.
//
// If this test fails, the fix is almost never "add an exception" — it is
// to move the shared helper the importer actually needs into a
// command-independent module (the `*-core` pattern), exactly as #341
// did. An exception here re-opens the drift the guard exists to stop.

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname);

// Directories under `src/` that hold tests or fixtures, never shipped logic.
const NON_PRODUCTION_DIRS = new Set(['e2e', '__fixtures__', '__property-tests__']);

function isTestFile(basename: string): boolean {
  return basename.endsWith('.test.ts');
}

/** `cli.ts` and `cli-*.ts` are the only modules allowed to import `cli-*`. */
function isCliModule(basename: string): boolean {
  return basename === 'cli.ts' || basename.startsWith('cli-');
}

/** Recursively collect production (non-test) `.ts` files under `dir`. */
function collectProductionFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NON_PRODUCTION_DIRS.has(entry.name)) collectProductionFiles(full, acc);
    } else if (entry.name.endsWith('.ts') && !isTestFile(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

// Module specifiers referenced by `import` / `export ... from` / `require` /
// dynamic `import()`. The `from` form also covers `import type`, re-exports,
// and multi-line import blocks (`} from './x.js'`).
const SPECIFIER_PATTERNS: RegExp[] = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
];

/** Every module specifier the source references in an import-like position. */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

/** True when `specifier` is a relative import of a `cli-*` command module. */
function isCliSpecifier(specifier: string): boolean {
  if (!specifier.startsWith('.')) return false; // package import, not local
  const base = path.basename(specifier).replace(/\.(js|ts)$/, '');
  return base.startsWith('cli-');
}

describe('non-CLI import boundary: detector', () => {
  it('extracts specifiers from every import-like form', () => {
    const source = [
      "import { runSearch } from './cli-search.js';",
      "import type { TimingPayload } from './timing-core.js';",
      "export * from './cli-stats.js';",
      "import './cli-doctor.js';",
      "const ev = await import('./cli-eval.js');",
      "const m = require('./formatter.js');",
      "import axios from 'axios';",
    ].join('\n');
    expect(importSpecifiers(source).sort()).toEqual(
      [
        './cli-doctor.js',
        './cli-eval.js',
        './cli-search.js',
        './cli-stats.js',
        './formatter.js',
        './timing-core.js',
        'axios',
      ].sort(),
    );
  });

  it('flags cli-* command modules and nothing else', () => {
    expect(isCliSpecifier('./cli-search.js')).toBe(true);
    expect(isCliSpecifier('../cli-stats.js')).toBe(true);
    expect(isCliSpecifier('./cli-doctor')).toBe(true);
    // `cli.ts` itself is the dispatcher, not a `cli-*` adapter.
    expect(isCliSpecifier('./cli.js')).toBe(false);
    // `*-core` modules are command-independent on purpose.
    expect(isCliSpecifier('./timing-core.js')).toBe(false);
    expect(isCliSpecifier('./search-core.js')).toBe(false);
    // Package imports are out of scope.
    expect(isCliSpecifier('@modelcontextprotocol/sdk')).toBe(false);
  });
});

describe('issue #405 module boundary: production non-CLI modules do not import cli-* adapters', () => {
  const productionFiles = collectProductionFiles(SRC_DIR);

  it('discovers the production source set to scan', () => {
    // Sanity floor: if the walk silently finds nothing the guard is moot.
    expect(productionFiles.length).toBeGreaterThan(50);
  });

  it('no shared, server, or transport module imports a cli-* command adapter', () => {
    const violations: string[] = [];
    for (const file of productionFiles) {
      if (isCliModule(path.basename(file))) continue; // CLI may import CLI
      const source = fs.readFileSync(file, 'utf-8');
      for (const specifier of importSpecifiers(source)) {
        if (isCliSpecifier(specifier)) {
          violations.push(`${path.relative(SRC_DIR, file)} imports ${specifier}`);
        }
      }
    }
    // A non-empty list means a non-CLI module reached back into a CLI
    // command adapter. Move the shared helper into a `*-core` module
    // instead of importing the adapter.
    expect(violations).toEqual([]);
  });
});
