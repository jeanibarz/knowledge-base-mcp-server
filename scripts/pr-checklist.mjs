#!/usr/bin/env node
// Local preflight for the required "Anti-drift checklist" CI check.
//
// Runs the SAME verifier the `PR checklist` workflow runs
// (`.github/workflows/pr-checklist.yml` -> `kookr pr-checklist verify`) against
// a drafted PR-body file and the merge-base diff, BEFORE you run
// `gh pr create --body-file <file>`. This catches the most common first-attempt
// failure — a PR body that was not built from `.github/PULL_REQUEST_TEMPLATE.md`
// (so the `kookr:check:*` rows are absent) — without spending a full CI cycle.
//
// Usage:
//   npm run pr-checklist -- <body-file> [--base <ref>] [--json]
//
// Exit codes mirror the verifier: 0 pass, 2 verification failure, non-zero on
// usage/tooling problems. CI remains authoritative — this is a convenience
// gate, and the pinned engine in CI is the source of truth if the two disagree.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const KOOKR_BIN = process.env.KOOKR_BIN ?? 'kookr';
const DEFAULT_BASE = 'origin/main';

function usage() {
  return [
    'usage: npm run pr-checklist -- <body-file> [--base <ref>] [--json]',
    '',
    'Verifies a drafted PR-body file against the merge-base diff using the same',
    'verifier the "Anti-drift checklist" CI check runs, so you can self-check',
    'before `gh pr create --body-file <file>`.',
    '',
    'Draft the body from .github/PULL_REQUEST_TEMPLATE.md, work each',
    '`kookr:check:*` row, then run this preflight.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { body: undefined, base: DEFAULT_BASE, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') {
      opts.base = argv[i + 1];
      i += 1;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (opts.body === undefined) {
      opts.body = arg;
    } else {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${usage()}\n`);
    process.exit(64); // usage
  }

  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  if (!opts.body) {
    process.stderr.write(`error: a PR-body file is required.\n\n${usage()}\n`);
    process.exit(64);
  }

  const bodyPath = path.resolve(opts.body);
  if (!fs.existsSync(bodyPath)) {
    process.stderr.write(`error: body file not found: ${opts.body}\n`);
    process.exit(64);
  }

  if (!opts.base) {
    process.stderr.write('error: --base requires a ref argument.\n');
    process.exit(64);
  }

  // Best-effort refresh of the base so the merge-base diff matches what CI sees.
  // Mirrors the workflow's `git fetch origin <base_ref>` step. Non-fatal: an
  // offline run still verifies against whatever base commit is already local.
  const baseBranch = opts.base.startsWith('origin/') ? opts.base.slice('origin/'.length) : opts.base;
  try {
    execFileSync('git', ['fetch', '--no-tags', '--quiet', 'origin', baseBranch], { stdio: 'ignore' });
  } catch {
    process.stderr.write(`[pr-checklist] warning: could not fetch origin/${baseBranch}; verifying against the local base.\n`);
  }

  const verifyArgs = ['pr-checklist', 'verify', '--pr-body', bodyPath, '--base', opts.base];
  if (opts.json) verifyArgs.push('--json');

  try {
    execFileSync(KOOKR_BIN, verifyArgs, { stdio: 'inherit' });
    process.exit(0);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      process.stderr.write(
        [
          `error: \`${KOOKR_BIN}\` was not found on PATH.`,
          '',
          'This preflight shells out to the Kookr CLI, which also powers the',
          '"Anti-drift checklist" CI check. Install/link it, or set KOOKR_BIN to',
          'its path. CI still enforces the check regardless, so you can also just',
          'push and let CI verify.',
        ].join('\n') + '\n',
      );
      process.exit(69); // unavailable
    }
    // Propagate the verifier's own exit code (2 = verification failure).
    const code = typeof err?.status === 'number' ? err.status : 1;
    process.exit(code);
  }
}

main();
