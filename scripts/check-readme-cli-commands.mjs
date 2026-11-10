#!/usr/bin/env node
// Fail when README.md tells the reader to run a `kb <command>` that the built
// CLI does not have (issue #1177, proposal item 4: keep docs honest).
//
// Source of truth is `kb help --format=json` from the built CLI, the same
// registry scripts/gen-cli-reference.mjs reads. Only code spans (`kb x`) and
// fenced code blocks are scanned, so prose such as "the kb command" is ignored.
//
//   node scripts/check-readme-cli-commands.mjs   # exit 1 on unknown commands

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Words that follow `kb` in README code but are options, shell syntax or
// placeholders rather than subcommands.
const NOT_COMMANDS = new Set(['<command>', '<topic>']);

export function extractReadmeCommands(markdown) {
  const code = [];
  const fence = /^```[^\n]*\n([\s\S]*?)^```/gm;
  let stripped = markdown.replace(fence, (_m, body) => {
    code.push(body);
    return '\n';
  });
  for (const m of stripped.matchAll(/`([^`\n]+)`/g)) code.push(m[1]);
  const found = new Set();
  for (const chunk of code) {
    for (const m of chunk.matchAll(/(?:^|[\s|;(&$>])kb\s+([a-z][a-z0-9-]*)/gm)) {
      found.add(m[1]);
    }
  }
  return [...found].filter((c) => !NOT_COMMANDS.has(c)).sort();
}

export function findUnknownCommands(markdown, knownCommands) {
  const known = new Set(knownCommands);
  return extractReadmeCommands(markdown).filter((c) => !known.has(c));
}

function loadKnownCommands() {
  const cli = path.join(REPO_ROOT, 'build/cli.js');
  if (!fs.existsSync(cli)) throw new Error('build/cli.js not found; run `npm run build` first.');
  const r = spawnSync(process.execPath, [cli, 'help', '--format=json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`kb help --format=json exited ${r.status}: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  const list = Array.isArray(parsed) ? parsed : (parsed.commands ?? []);
  // `help` is handled before the SUBCOMMANDS registry lookup.
  return [...list.map((c) => c.name), 'help'];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const unknown = findUnknownCommands(readme, loadKnownCommands());
  if (unknown.length > 0) {
    console.error(`README.md references kb commands the CLI does not have: ${unknown.join(', ')}`);
    process.exit(1);
  }
  console.log('README kb command references: OK');
}
