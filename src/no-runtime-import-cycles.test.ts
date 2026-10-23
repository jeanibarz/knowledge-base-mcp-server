// Issue #1006 — repo-wide runtime (value-level) import-cycle guard.
//
// `src/non-cli-import-boundary.test.ts` enforces a *layering* rule (no
// non-CLI module imports a `cli-*` adapter); this test enforces a
// different, complementary rule: no production module may participate in
// a *runtime* import cycle, i.e. a cycle made entirely of edges that
// actually execute code at module-load time.
//
// `import type` (and the type-only half of a mixed import, e.g.
// `import { foo, type Bar } from './x.js'`, which still contributes a
// value edge for `foo`) is erased by the TypeScript compiler and never
// participates in a runtime load, so a cycle built only from type-only
// edges is harmless and is deliberately NOT flagged here (it can still
// show up in a `madge --circular` scan, which does not distinguish
// `import type`; that's expected and tracked separately from this guard).
// Likewise, a dynamic `await import(...)` call deliberately defers the
// load past module-init time (see `cli-bug-report.ts`'s lazy load of
// `cli-doctor.ts`, which exists specifically to avoid a static cycle) and
// is intentionally excluded from the static edge graph below — flagging
// it would re-introduce the exact coupling the lazy load was written to
// avoid.
//
// Definitions used by the scan mirror `non-cli-import-boundary.test.ts`:
//   * "production module" — any `.ts` file under `src/` that is not a
//     test (`*.test.ts`) and not under a test/fixture directory.
//   * a "runtime edge" — a static `import ... from '...'` / `export ...
//     from '...'` / bare `import '...'` / `require('...')` whose
//     resolved target contributes at least one non-type binding. A
//     dynamic `import(...)` call is never a runtime edge here.
//
// If this test fails, the fix is almost never "add an exception" — it is
// to extract the shared type/class the two modules both need into a leaf
// module (the `*-types.ts` pattern introduced by issue #1006: see
// `search-types.ts`, `metrics-types.ts`, `rerank-types.ts`,
// `cli-doctor-types.ts`), exactly as that issue did for the cycles that
// existed before it landed.

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname);

// Directories under `src/` that hold tests or fixtures, never shipped logic.
const NON_PRODUCTION_DIRS = new Set(['e2e', '__fixtures__', '__property-tests__']);

function isTestFile(basename: string): boolean {
  return basename.endsWith('.test.ts');
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

/**
 * Strip comments before scanning. Not string-literal-aware, but good
 * enough for this repo's own `.ts` source: without it, a comment that
 * happens to contain `from './foo.js'` prose (e.g. a doc comment showing
 * example code) reads as a real edge and can manufacture a false
 * self-loop or cycle.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Statements of the form `import ... from '...'` / `export ... from '...'`.
// Captures the clause between the keyword and `from` so the caller can
// decide whether it is entirely type-only. Deliberately does NOT match
// dynamic `import(...)` calls — those are excluded from the runtime-edge
// graph on purpose (see module doc comment above).
const FROM_STATEMENT = /(?:import|export)\s+([^;]*?)\bfrom\s*['"]([^'"]+)['"]/gs;
// Bare side-effect import: `import './foo.js';`.
const BARE_IMPORT = /\bimport\s*['"]([^'"]+)['"]/g;
const REQUIRE_CALL = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * True when an import/export clause (the text between `import`/`export`
 * and `from`) contributes no value binding at all — i.e. `import type
 * {...}` / `export type {...}`, or a named clause where every entry is
 * individually `type`-prefixed (`{ type Foo, type Bar }`). A default
 * import, a namespace import (`* as X`), or a named clause with at least
 * one non-`type` entry all count as a value edge.
 */
function isClauseTypeOnly(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed === 'type' || trimmed.startsWith('type ')) return true;
  const braceMatch = trimmed.match(/^\{([^}]*)\}$/s);
  if (braceMatch) {
    const inner = braceMatch[1].trim();
    if (inner === '') return true;
    const entries = inner.split(',').map((e) => e.trim()).filter((e) => e !== '');
    return entries.length > 0 && entries.every((e) => e.startsWith('type '));
  }
  return false;
}

/** Every module specifier reached by a runtime (non-type-only) edge. */
function runtimeImportSpecifiers(source: string): string[] {
  const found: string[] = [];
  const clean = stripComments(source);
  for (const match of clean.matchAll(FROM_STATEMENT)) {
    const [, clause, specifier] = match;
    if (isClauseTypeOnly(clause)) continue;
    found.push(specifier);
  }
  for (const match of clean.matchAll(BARE_IMPORT)) found.push(match[1]);
  for (const match of clean.matchAll(REQUIRE_CALL)) found.push(match[1]);
  return found;
}

/** Resolve a relative specifier to an on-disk production `.ts` file, if any. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // package import, out of scope
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidate = `${base.replace(/\.(js|ts)$/, '')}.ts`;
  return fs.existsSync(candidate) ? candidate : null;
}

/** Build the directed runtime-edge graph and run DFS cycle detection. */
function findRuntimeImportCycles(files: readonly string[]): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8');
    const edges = new Set<string>();
    for (const specifier of runtimeImportSpecifiers(source)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved && resolved !== file) edges.add(resolved);
    }
    graph.set(file, edges);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const f of files) color.set(f, WHITE);
  const cycles: string[][] = [];

  function dfs(node: string, stack: string[]): void {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue; // outside the production set (e.g. unresolved)
      const c = color.get(next);
      if (c === GRAY) {
        const idx = stack.indexOf(next);
        cycles.push(stack.slice(idx).concat(next));
      } else if (c === WHITE) {
        dfs(next, stack);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const f of files) {
    if (color.get(f) === WHITE) dfs(f, []);
  }
  return cycles;
}

describe('issue #1006 runtime import-cycle guard: detector', () => {
  it('treats import type and fully-typed named clauses as contributing no edge', () => {
    expect(isClauseTypeOnly('type { Foo, Bar }')).toBe(true);
    expect(isClauseTypeOnly('{ type Foo, type Bar }')).toBe(true);
    expect(isClauseTypeOnly('{ Foo, type Bar }')).toBe(false);
    expect(isClauseTypeOnly('Default')).toBe(false);
    expect(isClauseTypeOnly('* as ns')).toBe(false);
  });

  it('extracts only the value half of mixed/static import forms, never dynamic import()', () => {
    const source = [
      "import { KBError, type KBErrorCode } from './errors.js';",
      "import type { Foo } from './foo-types.js';",
      "export type { Bar } from './bar-types.js';",
      "export { Baz } from './baz.js';",
      "import './side-effect.js';",
      "const mod = await import('./lazy.js');",
    ].join('\n');
    expect(runtimeImportSpecifiers(source).sort()).toEqual(
      ["./errors.js", './baz.js', './side-effect.js'].sort(),
    );
  });
});

describe('issue #1006: production modules do not form a runtime import cycle', () => {
  const productionFiles = collectProductionFiles(SRC_DIR);

  it('discovers the production source set to scan', () => {
    expect(productionFiles.length).toBeGreaterThan(50);
  });

  it('has zero cycles in the value-level (runtime) import graph', () => {
    const cycles = findRuntimeImportCycles(productionFiles);
    const described = cycles.map((cycle) =>
      cycle.map((f) => path.relative(SRC_DIR, f)).join(' -> '),
    );
    // A non-empty list means a real, runtime module-load cycle exists.
    // Extract the shared type/class into a `*-types.ts` leaf module
    // instead of adding an exception — see the module doc comment above.
    expect(described).toEqual([]);
  });
});
