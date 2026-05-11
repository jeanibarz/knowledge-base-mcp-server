#!/usr/bin/env node
// Validate source file-line and symbol anchors embedded in repo documentation.

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DOC_ROOTS = [
  'docs/architecture',
  'docs/rfcs',
  'README.md',
  'CONTRIBUTING.md',
  'CLAUDE.md',
];

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const ANCHOR_RE = /(?<![\w/.-])((?:(?:src|scripts|docs|benchmarks)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|mjs|cjs|json|md|markdown|yml|yaml|sh)|(?:package\.json|tsconfig(?:\.[A-Za-z0-9_-]+)?\.json|jest\.config\.js|README\.md|CONTRIBUTING\.md|CLAUDE\.md))(?:(::[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)|:(\d+)(?:-(\d+))?))/g;
const CONTINUATION_RE = /(?<![\w/.:])(?::(\d+)(?:-(\d+))?)(?![\w/.-])/g;
const FENCE_RE = /^\s*(```|~~~)/;
const IGNORE_LINE_RE = /anchor-check:\s*ignore/i;
const IGNORE_OFF_RE = /anchor-check:\s*off/i;
const IGNORE_ON_RE = /anchor-check:\s*on/i;

function usage() {
  return [
    'usage: node scripts/check-doc-anchors.mjs [--root <repo>] [--strict] [--verbose] [--json] [--self-test]',
    '',
    'Scans docs/architecture/**/*.md, docs/rfcs/**/*.md, README.md,',
    'CONTRIBUTING.md, and CLAUDE.md for anchors like src/file.ts:12-20',
    'and src/file.ts::SymbolName.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    verbose: false,
    json: false,
    strict: false,
    selfTest: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === '--verbose' || arg === '-v') {
      opts.verbose = true;
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '--strict') {
      opts.strict = true;
      continue;
    }
    if (arg === '--self-test') {
      opts.selfTest = true;
      continue;
    }
    if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--root requires a path');
      opts.root = path.resolve(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (!value) throw new Error('--root requires a path');
      opts.root = path.resolve(value);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`docs:check-anchors: ${err.message}\n${usage()}\n`);
    process.exit(2);
  }

  if (opts.selfTest) {
    await runSelfTest();
    process.stdout.write('docs:check-anchors self-test passed\n');
    return;
  }

  try {
    const report = await checkDocAnchors(opts);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(formatReport(report, opts));
    }
    process.exitCode = opts.strict && report.totals.failures > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write(`docs:check-anchors: ${err.message}\n`);
    process.exitCode = 1;
  }
}

export async function checkDocAnchors(opts = {}) {
  const root = path.resolve(opts.root ?? process.cwd());
  const docFiles = await collectDocFiles(root, opts.docRoots ?? DEFAULT_DOC_ROOTS);
  const fileCache = new Map();
  const failures = [];
  const checked = [];

  for (const docPath of docFiles) {
    const content = await fs.readFile(docPath, 'utf8');
    const anchors = extractAnchors(content, path.relative(root, docPath).split(path.sep).join('/'));
    for (const anchor of anchors) {
      const result = await validateAnchor(root, anchor, fileCache);
      checked.push(result);
      if (result.status !== 'OK') failures.push(result);
    }
  }

  return {
    root,
    totals: {
      docsScanned: docFiles.length,
      anchorsChecked: checked.length,
      failures: failures.length,
    },
    failures,
    checked: opts.verbose ? checked : undefined,
  };
}

async function collectDocFiles(root, docRoots) {
  const files = [];
  for (const rel of docRoots) {
    const full = path.join(root, rel);
    let st;
    try {
      st = await fs.stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walkMarkdown(full, files);
    } else if (st.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(full).toLowerCase())) {
      files.push(full);
    }
  }
  return files.sort();
}

async function walkMarkdown(dir, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(full, out);
    } else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

export function extractAnchors(content, docRelPath = '<memory>') {
  const anchors = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let disabled = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const docLine = i + 1;

    if (IGNORE_ON_RE.test(line)) disabled = false;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (IGNORE_OFF_RE.test(line)) {
      disabled = true;
      continue;
    }
    if (inFence || disabled || IGNORE_LINE_RE.test(line)) continue;

    const fullAnchors = [];
    ANCHOR_RE.lastIndex = 0;
    for (const match of line.matchAll(ANCHOR_RE)) {
      const anchor = buildAnchor({
        docRelPath,
        docLine,
        docColumn: match.index + 1,
        raw: match[1],
        filePath: stripAnchorSuffix(match[1]),
        symbol: match[2] ? match[2].slice(2) : null,
        startLine: match[3] ? Number(match[3]) : null,
        endLine: match[4] ? Number(match[4]) : null,
      });
      anchors.push(anchor);
      fullAnchors.push(anchor);
    }

    if (fullAnchors.length === 0) continue;
    const occupied = fullAnchors.map((anchor) => ({
      start: anchor.docColumn - 1,
      end: anchor.docColumn - 1 + anchor.raw.length,
    }));
    let lastPath = null;
    CONTINUATION_RE.lastIndex = 0;
    for (const match of line.matchAll(CONTINUATION_RE)) {
      const idx = match.index;
      for (const anchor of fullAnchors) {
        if (anchor.docColumn - 1 <= idx) lastPath = anchor.filePath;
      }
      if (!lastPath) continue;
      if (occupied.some((range) => idx >= range.start && idx < range.end)) continue;

      anchors.push(buildAnchor({
        docRelPath,
        docLine,
        docColumn: idx + 1,
        raw: match[0],
        filePath: lastPath,
        symbol: null,
        startLine: Number(match[1]),
        endLine: match[2] ? Number(match[2]) : null,
        continuation: true,
      }));
    }
  }

  return anchors;
}

function stripAnchorSuffix(raw) {
  const symbolIdx = raw.indexOf('::');
  if (symbolIdx !== -1) return raw.slice(0, symbolIdx);
  return raw.replace(/:\d+(?:-\d+)?$/, '');
}

function buildAnchor(anchor) {
  return {
    ...anchor,
    endLine: anchor.endLine ?? anchor.startLine,
  };
}

async function validateAnchor(root, anchor, fileCache) {
  const targetPath = path.normalize(path.join(root, anchor.filePath));
  if (!isInside(root, targetPath)) {
    return fail(anchor, 'PATH_ESCAPE', 'target path escapes repository root');
  }

  let target;
  try {
    target = await readTarget(targetPath, fileCache);
  } catch {
    return fail(anchor, 'MISSING_FILE', 'target file does not exist');
  }

  if (anchor.symbol) {
    return validateSymbol(anchor, target);
  }
  return validateLineRange(anchor, target);
}

function isInside(root, targetPath) {
  const rel = path.relative(root, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function readTarget(targetPath, fileCache) {
  const cached = fileCache.get(targetPath);
  if (cached) return cached;
  const content = await fs.readFile(targetPath, 'utf8');
  const target = {
    path: targetPath,
    content,
    lines: content.split(/\r?\n/),
  };
  fileCache.set(targetPath, target);
  return target;
}

function validateLineRange(anchor, target) {
  if (!Number.isInteger(anchor.startLine) || anchor.startLine < 1) {
    return fail(anchor, 'INVALID_LINE', 'line number must be >= 1');
  }
  if (!Number.isInteger(anchor.endLine) || anchor.endLine < anchor.startLine) {
    return fail(anchor, 'INVALID_RANGE', 'range end must be >= range start');
  }
  if (anchor.endLine > target.lines.length) {
    return fail(anchor, 'RANGE_EXCEEDS_FILE', `range exceeds file length ${target.lines.length}`);
  }
  return ok(anchor);
}

function validateSymbol(anchor, target) {
  const symbol = anchor.symbol;
  const matches = symbol.includes('.')
    ? findMemberDeclarations(target.lines, symbol)
    : findSymbolDeclarations(target.lines, symbol);

  if (matches.length === 0) {
    return fail(anchor, 'MISSING_SYMBOL', `symbol ${symbol} was not found`);
  }
  if (matches.length > 1) {
    return fail(anchor, 'AMBIGUOUS_SYMBOL', `symbol ${symbol} matched ${matches.length} declarations`);
  }
  return ok({ ...anchor, resolvedLine: matches[0] });
}

function findSymbolDeclarations(lines, symbol) {
  const name = escapeRegExp(symbol);
  const patterns = [
    new RegExp(`\\b(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:class|function|interface|type|enum)\\s+${name}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`),
    new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`),
  ];
  return matchingLineNumbers(lines, patterns);
}

function findMemberDeclarations(lines, symbol) {
  const [className, memberName] = symbol.split('.', 2);
  const classMatches = findSymbolDeclarations(lines, className).filter((lineNo) => {
    return /\bclass\b/.test(lines[lineNo - 1]);
  });
  if (classMatches.length !== 1) return [];

  const name = escapeRegExp(memberName);
  const memberPatterns = [
    new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|readonly\\s+|override\\s+|abstract\\s+)*${name}\\s*[(:=]`),
    new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+)*get\\s+${name}\\s*\\(`),
    new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+)*set\\s+${name}\\s*\\(`),
  ];
  return matchingLineNumbers(lines.slice(classMatches[0]), memberPatterns).map((lineNo) => lineNo + classMatches[0]);
}

function matchingLineNumbers(lines, patterns) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (patterns.some((pattern) => pattern.test(line))) {
      out.push(i + 1);
    }
  }
  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ok(anchor) {
  return { ...anchor, status: 'OK' };
}

function fail(anchor, code, detail) {
  return { ...anchor, status: code, detail };
}

function formatReport(report, opts) {
  const lines = [];
  for (const failure of report.failures) {
    lines.push(`${failure.docRelPath}:${failure.docLine}`);
    lines.push(`  target: ${failure.continuation ? `${failure.filePath}${failure.raw}` : failure.raw}`);
    lines.push(`  error: ${failure.detail}`);
    lines.push(`  next: update the anchor, fix the target, or add <!-- anchor-check: ignore --> if intentionally historical`);
  }
  if (report.failures.length > 0) lines.push('');
  if (opts.verbose && report.checked.length > 0) {
    lines.push('Checked anchors:');
    for (const item of report.checked) {
      lines.push(`  ${item.status.padEnd(18)} ${item.docRelPath}:${item.docLine} -> ${item.continuation ? `${item.filePath}${item.raw}` : item.raw}`);
    }
    lines.push('');
  }
  lines.push(`Summary: ${report.totals.failures} stale anchor(s) across ${report.totals.anchorsChecked} checked anchor(s) in ${report.totals.docsScanned} doc file(s).`);
  if (report.totals.failures > 0) {
    lines.push(opts.strict ? 'Strict mode: exiting 1 because stale anchors were found.' : 'Warning mode: exiting 0. Re-run with --strict to fail on stale anchors.');
  }
  return `${lines.join('\n')}\n`;
}

async function runSelfTest() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-anchor-check-'));
  try {
    await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'docs', 'architecture'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'src', 'sample.ts'),
      [
        'export class Sample {',
        '  run(): void {}',
        '}',
        'export const VALUE = 1;',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(tmp, 'docs', 'architecture', 'note.md'),
      [
        '# Note',
        '',
        'Valid line: `src/sample.ts:1-2`, same target shorthand `:3`.',
        'Valid symbol: `src/sample.ts::VALUE`.',
        'Invalid line: `src/sample.ts:99`.',
        'Invalid symbol: `src/sample.ts::MISSING`.',
        'Ignored: `src/sample.ts:100` <!-- anchor-check: ignore -->',
        '```',
        'src/sample.ts:101',
        '```',
      ].join('\n'),
    );

    const report = await checkDocAnchors({ root: tmp });
    assert.equal(report.totals.anchorsChecked, 5);
    assert.equal(report.totals.failures, 2);
    assert.deepEqual(report.failures.map((failure) => failure.status).sort(), ['MISSING_SYMBOL', 'RANGE_EXCEEDS_FILE']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
