#!/usr/bin/env node
// Code→schema config drift guard.
//
// `kb config validate` warns at *runtime* when an operator sets an unknown
// controlled env var. This guard covers the opposite, contributor-facing
// direction: a `process.env.KB_*` (or other controlled-prefix) read added in
// source that was never registered in `CONFIG_SCHEMA`. Such a var silently
// escapes schema validation, `kb config show`, and the generated config
// reference. Wired into `npm run check`; fails when production code reads a
// controlled env var that is neither registered nor explicitly allowlisted.
//
// Only *literal* env names are inspected (`process.env.NAME` and
// `process.env['NAME']`). Dynamic `process.env[variable]` access is ignored,
// so intentionally-dynamic reads never produce false positives.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CONTROLLED_PREFIXES,
  isControlledEnvName,
  isRegisteredConfigName,
} from '../build/config/schema.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

// Controlled-prefix env vars read in production source that are intentionally
// NOT registered in CONFIG_SCHEMA. Every entry needs a reason. Keep this list
// empty or shrinking: prefer registering a var in src/config/schema.ts over
// adding it here.
export const ALLOWLIST = new Map([
]);

const DOTTED_READ = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const BRACKET_READ = /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;

// Directory / file names excluded from the production scan. Tests, fixtures,
// and the opt-in e2e suite legitimately read env knobs that are not part of
// the operator-facing config surface.
const EXCLUDED_DIR_NAMES = new Set(['__mocks__', '__property-tests__', '__fixtures__', 'e2e']);

function isProductionSourceFile(name) {
  return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts');
}

/** Recursively collect production TypeScript source files under `dir`. */
export function collectSourceFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      out.push(...collectSourceFiles(full));
    } else if (entry.isFile() && isProductionSourceFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Extract literal controlled-prefix env names read in `content`. */
function controlledReadsIn(content) {
  const names = new Set();
  for (const re of [DOTTED_READ, BRACKET_READ]) {
    for (const match of content.matchAll(re)) {
      const name = match[1];
      if (isControlledEnvName(name)) names.add(name);
    }
  }
  return names;
}

/**
 * Scan the given roots for controlled-prefix env reads and classify them.
 * Returns unregistered reads (drift) and stale allowlist entries that have
 * since been registered in the schema.
 */
export function scanConfigEnvUsage(roots = [SRC_DIR]) {
  const usedControlled = new Map(); // name -> Set<relative file>
  for (const root of roots) {
    for (const file of collectSourceFiles(root)) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(REPO_ROOT, file);
      for (const name of controlledReadsIn(content)) {
        if (!usedControlled.has(name)) usedControlled.set(name, new Set());
        usedControlled.get(name).add(rel);
      }
    }
  }

  const drift = [];
  for (const [name, files] of usedControlled) {
    if (isRegisteredConfigName(name)) continue;
    if (ALLOWLIST.has(name)) continue;
    drift.push({ name, files: [...files].sort() });
  }
  drift.sort((a, b) => a.name.localeCompare(b.name));

  // Allowlist hygiene: an entry that is now registered in the schema is
  // redundant and should be removed so the allowlist keeps shrinking.
  const redundantAllowlist = [...ALLOWLIST.keys()]
    .filter((name) => isRegisteredConfigName(name))
    .sort();

  return { drift, redundantAllowlist };
}

function main(argv) {
  const extraRoots = argv.slice(2).map((p) => path.resolve(p));
  const { drift, redundantAllowlist } = scanConfigEnvUsage([SRC_DIR, ...extraRoots]);

  if (drift.length === 0 && redundantAllowlist.length === 0) {
    process.stderr.write(
      `config:check-env-usage: ${ALLOWLIST.size} allowlisted; no unregistered controlled env reads.\n`,
    );
    return;
  }

  const lines = [];
  if (drift.length > 0) {
    lines.push(
      'config:check-env-usage: controlled env vars read in code but not registered in CONFIG_SCHEMA:',
      '',
    );
    for (const { name, files } of drift) {
      lines.push(`  ${name}`);
      for (const file of files) lines.push(`    ${file}`);
    }
    lines.push(
      '',
      `Controlled prefixes: ${CONTROLLED_PREFIXES.join(', ')}`,
      'Fix: register the var in src/config/schema.ts (CONFIG_SCHEMA), or, if it is',
      'intentionally not part of the config surface, add it to the ALLOWLIST in',
      'scripts/check-config-env-usage.mjs with a reason.',
    );
  }
  if (redundantAllowlist.length > 0) {
    lines.push(
      '',
      'config:check-env-usage: allowlist entries are now registered in CONFIG_SCHEMA',
      'and should be removed from scripts/check-config-env-usage.mjs:',
      ...redundantAllowlist.map((name) => `  ${name}`),
    );
  }
  lines.push('');
  process.stderr.write(lines.join('\n'));
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`config:check-env-usage: ${err.message}\n`);
    process.exitCode = 1;
  }
}
