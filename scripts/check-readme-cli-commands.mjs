#!/usr/bin/env node
// Fail when README.md tells the reader to run a `kb <command>` that the built
// CLI does not have (issue #1177, proposal item 4: keep docs honest).
//
// Source of truth is `kb help --format=json` from the built CLI, the same
// registry scripts/gen-cli-reference.mjs reads. Only code spans (`kb x`) and
// fenced code blocks are scanned, so prose such as "the kb command" is ignored.
//
// It also checks each `--flag` written after a known `kb <command>` (up to the
// next `kb <command>`, pipe, `;` or `&`, so a `# ...` shell comment is checked
// too) against that command's documented options and usage lines (issue #1284).
//
//   node scripts/check-readme-cli-commands.mjs   # exit 1 on unknown commands or flags

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Words that follow `kb` in README code but are options, shell syntax or
// placeholders rather than subcommands.
const NOT_COMMANDS = new Set(['<command>', '<topic>']);

// Code spans and fenced-block bodies; prose is never scanned.
function readmeCodeChunks(markdown) {
  const code = [];
  const stripped = markdown.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, (_m, body) => {
    code.push(body);
    return '\n';
  });
  for (const m of stripped.matchAll(/`([^`\n]+)`/g)) code.push(m[1]);
  return code;
}

export function extractReadmeCommands(markdown) {
  const found = new Set();
  for (const chunk of readmeCodeChunks(markdown)) {
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

function knownFlagsOf(command) {
  const flags = new Set();
  for (const opt of command.options ?? []) for (const f of opt.flags ?? []) flags.add(f);
  for (const u of command.usage ?? []) for (const m of u.matchAll(/--[a-z][a-z0-9-]*/g)) flags.add(m[0]);
  return flags;
}

// Returns `kb <cmd> --flag` strings for flags the registry does not document
// for that command. `registry` is the parsed `kb help --format=json` list.
// Commands absent from the registry are skipped (findUnknownCommands reports them).
export function findUnknownFlags(markdown, registry) {
  const byName = new Map(registry.map((c) => [c.name, c]));
  const bad = new Set();
  for (const chunk of readmeCodeChunks(markdown)) {
    // Join `\`-continued lines so a multi-line command is checked as one.
    for (const line of chunk.replace(/\\\n/g, ' ').split('\n')) {
      const starts = [...line.matchAll(/(?:^|[\s|;(&$>])kb\s+([a-z][a-z0-9-]*)/g)];
      starts.forEach((m, i) => {
        const command = byName.get(m[1]);
        if (!command) return;
        const end = i + 1 < starts.length ? starts[i + 1].index : undefined;
        const segment = line.slice(m.index + m[0].length, end).split(/[|;&]/)[0];
        const known = knownFlagsOf(command);
        for (const f of segment.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/g)) {
          if (!known.has(f[1])) bad.add(`kb ${m[1]} ${f[1]}`);
        }
      });
    }
  }
  return [...bad].sort();
}

function loadRegistry() {
  const cli = path.join(REPO_ROOT, 'build/cli.js');
  if (!fs.existsSync(cli)) throw new Error('build/cli.js not found; run `npm run build` first.');
  const r = spawnSync(process.execPath, [cli, 'help', '--format=json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`kb help --format=json exited ${r.status}: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  return Array.isArray(parsed) ? parsed : (parsed.commands ?? []);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const registry = loadRegistry();
  // `help` is handled before the SUBCOMMANDS registry lookup.
  const unknown = findUnknownCommands(readme, [...registry.map((c) => c.name), 'help']);
  const unknownFlags = findUnknownFlags(readme, registry);
  if (unknown.length > 0) {
    console.error(`README.md references kb commands the CLI does not have: ${unknown.join(', ')}`);
  }
  if (unknownFlags.length > 0) {
    console.error(`README.md references kb flags the CLI does not have: ${unknownFlags.join(', ')}`);
  }
  if (unknown.length > 0 || unknownFlags.length > 0) process.exit(1);
  console.log('README kb command and flag references: OK');
}
