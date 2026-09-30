// Issue #941 — drift guard for the dense/small-model reproduction runbook.
//
// benchmarks/REPRODUCE.md quotes canonical commands and expected headline
// numbers for the committed dense/nomic public-benchmark runs. If a committed
// result JSON changes (a re-run lands new numbers), a canonical command flag
// drifts, or an npm script is renamed, this test fails so the runbook is updated
// in lockstep rather than silently going stale. It is a pure filesystem read —
// hermetic, no provider, no FAISS — so it runs in the fast parallel Jest project.

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const runbookRel = path.join('benchmarks', 'REPRODUCE.md');
const runbookPath = path.join(repoRoot, runbookRel);
const readmePath = path.join(repoRoot, 'README.md');

function read(relFromRepo: string): string {
  return fs.readFileSync(path.join(repoRoot, relFromRepo), 'utf8');
}

function readJson(relFromRepo: string): any {
  return JSON.parse(read(relFromRepo));
}

/** Format an nDCG-style score the way the runbook tables render it. */
function ref4(value: number): string {
  return value.toFixed(4);
}

/** Collapse `\`-continued, multi-space command text onto one normalized line. */
function normalizeCmd(text: string): string {
  return text.replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Assert a Markdown table row whose first content cell is exactly `label`
 * contains every value in `values`. Anchoring to the row (not a global substring
 * search) is what catches a value that drifted into the wrong dataset/mode row.
 */
function rowContains(text: string, label: string, values: string[]): boolean {
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .replace(/[*`]/g, '')
      .split('|')
      .map((c) => c.trim());
    // cells[0] is empty (leading pipe); cells[1] is the first content column.
    if (cells[1] !== label) continue;
    const rest = cells.slice(2).join(' ');
    return values.every((v) => rest.includes(v));
  }
  return false;
}

describe('benchmarks/REPRODUCE.md — dense/small-model reproduction runbook', () => {
  const runbook = fs.readFileSync(runbookPath, 'utf8');

  it('exists and is linked from the README', () => {
    expect(fs.existsSync(runbookPath)).toBe(true);
    expect(read('README.md')).toContain(runbookRel);
  });

  it('names npm scripts that actually exist in package.json', () => {
    const scripts = readJson('package.json').scripts as Record<string, string>;
    for (const name of ['bench:reproduce', 'bench:beir:matrix', 'bench:mteb', 'bench:bright']) {
      expect(scripts[name]).toBeDefined();
      expect(runbook).toContain(`npm run ${name}`);
    }
    // The dataset fetchers that turn a clean machine into a runnable one.
    expect(runbook).toContain('fetch_beir_from_hf.py');
    expect(runbook).toContain('fetch_bright_from_hf.py');
    expect(runbook).toContain('mteb_submit.py');
  });

  it('reproduces the committed BEIR dense command verbatim (recorded `command` field)', () => {
    // The committed SciFact dense cell records the canonical config; the runbook
    // quotes that exact command, so a whitespace-normalized substring match is a
    // real "commands match the recorded command fields" guard, not a loose
    // per-flag check.
    const scifactDense = readJson(
      'benchmarks/results/beir/matrix/nomic/kb-scifact-dense-chunk-results.json',
    );
    expect(normalizeCmd(runbook)).toContain(normalizeCmd(scifactDense.command));
  });

  it('quotes the committed BEIR matrix (nomic) per-mode means, row-anchored', () => {
    const matrix = readJson('benchmarks/results/beir/matrix/nomic/beir-matrix.json');
    for (const perMode of matrix.perMode) {
      expect(rowContains(runbook, perMode.mode, [ref4(perMode.multiDomainMeanNdcgAt10)])).toBe(
        true,
      );
    }
    // The "What you will reproduce" headline cell quotes the dense mean too.
    const denseMean = matrix.perMode.find((m: any) => m.mode === 'dense')
      .multiDomainMeanNdcgAt10;
    expect(rowContains(runbook, 'BEIR matrix', [ref4(denseMean)])).toBe(true);
  });

  it('quotes each committed BEIR per-dataset dense cell, row-anchored', () => {
    for (const dataset of ['scifact', 'nfcorpus', 'fiqa', 'arguana', 'scidocs']) {
      const cell = readJson(
        `benchmarks/results/beir/matrix/nomic/kb-${dataset}-dense-chunk-results.json`,
      );
      expect(rowContains(runbook, dataset, [ref4(cell.metrics.ndcgAt10)])).toBe(true);
    }
  });

  it('quotes the committed MTEB (nomic) numbers, row-anchored', () => {
    const mteb = readJson('benchmarks/results/mteb/nomic.json');
    for (const task of mteb.tasks) {
      expect(rowContains(runbook, task.task, [String(task.main_score)])).toBe(true);
    }
    // Full-precision mean in the Step 4 table + rounded mean in the headline.
    expect(rowContains(runbook, 'mean main score', [String(mteb.mean_main_score)])).toBe(true);
    expect(rowContains(runbook, 'MTEB rank', [ref4(mteb.mean_main_score)])).toBe(true);
  });

  it('quotes the committed BRIGHT (nomic) numbers, row-anchored', () => {
    const report = readJson('benchmarks/results/bright/nomic/bright-report.json');
    const cell = (task: string, mode: string): number =>
      report.points.find((p: any) => p.task === task && p.mode === mode).ndcgAt10;
    const meanFor = (mode: string): number => {
      const pts = report.points.filter((p: any) => p.mode === mode);
      return pts.reduce((sum: number, p: any) => sum + p.ndcgAt10, 0) / pts.length;
    };
    for (const task of ['biology', 'economics']) {
      expect(
        rowContains(runbook, task, [ref4(cell(task, 'dense')), ref4(cell(task, 'hybrid+rerank'))]),
      ).toBe(true);
    }
    expect(
      rowContains(runbook, 'mean', [ref4(meanFor('dense')), ref4(meanFor('hybrid+rerank'))]),
    ).toBe(true);
    // Headline cell quotes the dense mean.
    expect(rowContains(runbook, 'BRIGHT', [ref4(meanFor('dense'))])).toBe(true);
  });

  it('every relative link in the runbook resolves to an existing file', () => {
    const linkRe = /\]\(([^)]+)\)/g;
    const runbookDir = path.dirname(runbookPath);
    const targets = [...runbook.matchAll(linkRe)]
      .map((m) => m[1])
      .filter((t) => !/^https?:/.test(t)) // skip external URLs
      .filter((t) => !t.startsWith('#')); // skip same-page anchors
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const filePart = target.split('#')[0];
      expect(fs.existsSync(path.resolve(runbookDir, filePart))).toBe(true);
    }
  });

  it('frames the numbers as hardware-sensitive reference values, not pass/fail', () => {
    expect(runbook).toMatch(/reference value/i);
    expect(runbook).toMatch(/not.*pass\/fail/i);
    expect(runbook).toMatch(/hardware/i);
    expect(runbook).toContain('not official leaderboard submissions');
  });
});
