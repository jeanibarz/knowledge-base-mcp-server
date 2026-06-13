#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_REFERENCE_PATH,
  generateConfigReferenceMarkdown,
} from './generate-config-reference.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const expected = generateConfigReferenceMarkdown();
  const target = path.join(REPO_ROOT, CONFIG_REFERENCE_PATH);
  let actual;
  try {
    actual = await fs.readFile(target, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    actual = null;
  }

  if (actual !== expected) {
    process.stderr.write([
      `${CONFIG_REFERENCE_PATH} is out of date.`,
      'Run `npm run build && npm run docs:generate-config-reference` and commit the result.',
      '',
    ].join('\n'));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`docs:check-config-reference: ${err.message}\n`);
  process.exitCode = 1;
});
