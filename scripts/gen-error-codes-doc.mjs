#!/usr/bin/env node
// Generate docs/reference/error-codes.md from the KBError taxonomy.
//
// The single source of truth is the `KBErrorCode` union in src/errors.ts plus
// the per-code documentation registry KB_ERROR_CODE_DOCS in
// src/error-codes-doc.ts. The pure rendering lives in that module so it can be
// unit-tested without a build; this script imports the built module and
// writes/checks the doc. Reading the registry instead of a hand-maintained
// table is what lets the drift gate catch a newly added error code or a changed
// remedy. Output is deterministic (registry order) so the gate is not noisy.
//
// Modes:
//   node scripts/gen-error-codes-doc.mjs           # write docs/reference/error-codes.md
//   node scripts/gen-error-codes-doc.mjs --check    # exit 1 if the committed doc drifts
//
// Mirrors scripts/gen-mcp-tools-doc.mjs / scripts/gen-cli-reference.mjs.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ERROR_CODES_REFERENCE_PATH, renderErrorCodesMarkdown } from '../build/error-codes-doc.js';

export { ERROR_CODES_REFERENCE_PATH };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function generateErrorCodesMarkdown() {
  return renderErrorCodesMarkdown();
}

export async function writeErrorCodesReference({ root = REPO_ROOT } = {}) {
  const target = path.join(root, ERROR_CODES_REFERENCE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, generateErrorCodesMarkdown(), 'utf8');
}

export async function checkErrorCodesReference({ root = REPO_ROOT } = {}) {
  const expected = generateErrorCodesMarkdown();
  const target = path.join(root, ERROR_CODES_REFERENCE_PATH);
  let actual = null;
  try {
    actual = await fs.readFile(target, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { ok: actual === expected, exists: actual !== null };
}

async function main(argv) {
  if (argv.includes('--check')) {
    const { ok, exists } = await checkErrorCodesReference();
    if (!ok) {
      process.stderr.write(
        [
          `${ERROR_CODES_REFERENCE_PATH} is ${exists ? 'out of date' : 'missing'}.`,
          'Run `npm run docs:gen-error-codes` and commit the result.',
          '',
        ].join('\n'),
      );
      process.exitCode = 1;
    }
    return;
  }
  await writeErrorCodesReference();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`gen-error-codes-doc: ${err.message}\n`);
    process.exitCode = 1;
  });
}
