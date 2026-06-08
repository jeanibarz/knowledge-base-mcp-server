// RFC 020 §7 — the cross-run leaderboard view.
//
// "The existing benchmarks/compare/ HTML report becomes the human-facing
// leaderboard view across runs." Where compare/render.ts compares two embedding
// models on one fixture, this renders the BEIR matrix headline ACROSS RUNS: each
// row is a recorded matrix run (a commit + env), each column a retrieval mode,
// each cell the multi-domain mean nDCG@10 (the headline metric). It surfaces the
// best run per mode, the Δ_g generality gap, and the full commit+env provenance
// — the reproducibility contract a public ranking claim rests on.
//
// The renderer is a pure function over already-loaded matrix reports (string in,
// string out, no I/O) so it is deterministic and unit-testable from stubs; a
// thin loader maps a matrix-report JSON onto the leaderboard run shape.

import * as fsp from 'fs/promises';
import * as path from 'path';

export interface LeaderboardRunEnv {
  embedding_provider: string | null;
  embedding_model: string | null;
  rrf_c: string;
  rerank_model: string;
  rerank_top_n: string;
  chunk_size: string;
  chunk_overlap: string;
  contextual: string;
}

export interface LeaderboardModeStat {
  mode: string;
  multiDomainMeanNdcgAt10: number | null;
  datasetsEvaluated: number;
  datasetsRequested: number;
  deltaG: number | null;
}

export interface LeaderboardRun {
  label: string;
  gitSha: string;
  generatedAt: string;
  env: LeaderboardRunEnv;
  modes: LeaderboardModeStat[];
}

export interface LeaderboardInput {
  runs: LeaderboardRun[];
  generatedAt: string;
}

/**
 * Map a parsed BEIR matrix report (matrix.ts MatrixReport JSON) onto a
 * leaderboard run. Tolerant of the structural subset it needs so a future
 * schema bump that adds fields does not break the leaderboard.
 */
export function matrixReportToRun(report: unknown, label: string): LeaderboardRun {
  if (!isRecord(report)) throw new Error('leaderboard: matrix report is not an object');
  const env = isRecord(report.env) ? report.env : {};
  const perMode = Array.isArray(report.perMode) ? report.perMode : [];
  const deltaGByMode = new Map<string, number | null>();
  const generalization = isRecord(report.generalization) ? report.generalization : {};
  if (Array.isArray(generalization.modes)) {
    for (const modeGen of generalization.modes) {
      if (!isRecord(modeGen) || typeof modeGen.mode !== 'string') continue;
      const dg = isRecord(modeGen.deltaG) ? modeGen.deltaG : {};
      deltaGByMode.set(modeGen.mode, typeof dg.deltaG === 'number' ? dg.deltaG : null);
    }
  }
  const modes: LeaderboardModeStat[] = perMode
    .filter(isRecord)
    .map((summary) => {
      const mode = typeof summary.mode === 'string' ? summary.mode : 'unknown';
      return {
        mode,
        multiDomainMeanNdcgAt10:
          typeof summary.multiDomainMeanNdcgAt10 === 'number' ? summary.multiDomainMeanNdcgAt10 : null,
        datasetsEvaluated: typeof summary.datasetsEvaluated === 'number' ? summary.datasetsEvaluated : 0,
        datasetsRequested: typeof summary.datasetsRequested === 'number' ? summary.datasetsRequested : 0,
        deltaG: deltaGByMode.get(mode) ?? null,
      };
    });
  return {
    label,
    gitSha: typeof report.git_sha === 'string' ? report.git_sha : 'unknown',
    generatedAt: typeof report.generated_at === 'string' ? report.generated_at : 'unknown',
    env: {
      embedding_provider: strOrNull(env.embedding_provider),
      embedding_model: strOrNull(env.embedding_model),
      rrf_c: str(env.rrf_c, 'default'),
      rerank_model: str(env.rerank_model, 'default'),
      rerank_top_n: str(env.rerank_top_n, 'default'),
      chunk_size: str(env.chunk_size, 'default'),
      chunk_overlap: str(env.chunk_overlap, 'default'),
      contextual: str(env.contextual, 'off'),
    },
    modes,
  };
}

export async function loadMatrixRun(jsonPath: string, label?: string): Promise<LeaderboardRun> {
  const raw = await fsp.readFile(jsonPath, 'utf-8');
  const fallbackLabel = path.basename(path.dirname(jsonPath)) || path.basename(jsonPath);
  return matrixReportToRun(JSON.parse(raw), label ?? fallbackLabel);
}

/** Stable union of all modes seen across runs, in first-seen order. */
function allModes(runs: readonly LeaderboardRun[]): string[] {
  const seen: string[] = [];
  for (const run of runs) {
    for (const modeStat of run.modes) {
      if (!seen.includes(modeStat.mode)) seen.push(modeStat.mode);
    }
  }
  return seen;
}

function statFor(run: LeaderboardRun, mode: string): LeaderboardModeStat | undefined {
  return run.modes.find((m) => m.mode === mode);
}

export async function renderLeaderboard(input: LeaderboardInput): Promise<string> {
  const template = await loadTemplate();
  const modes = allModes(input.runs);

  // Best (highest) mean nDCG@10 per mode, and best (lowest) Δ_g per mode.
  const bestNdcgByMode = new Map<string, number>();
  const bestDeltaGByMode = new Map<string, number>();
  for (const mode of modes) {
    for (const run of input.runs) {
      const stat = statFor(run, mode);
      if (stat?.multiDomainMeanNdcgAt10 != null) {
        const prev = bestNdcgByMode.get(mode);
        if (prev === undefined || stat.multiDomainMeanNdcgAt10 > prev) {
          bestNdcgByMode.set(mode, stat.multiDomainMeanNdcgAt10);
        }
      }
      if (stat?.deltaG != null) {
        const prev = bestDeltaGByMode.get(mode);
        if (prev === undefined || stat.deltaG < prev) bestDeltaGByMode.set(mode, stat.deltaG);
      }
    }
  }

  const headHtml = `<tr><th>Run</th>${modes.map((m) => `<th>${escHtml(m)}</th>`).join('')}</tr>`;
  const headlineRows = input.runs.map((run) => {
    const cells = modes.map((mode) => {
      const stat = statFor(run, mode);
      if (stat?.multiDomainMeanNdcgAt10 == null) return '<td>—</td>';
      const isBest = bestNdcgByMode.get(mode) === stat.multiDomainMeanNdcgAt10;
      const label = `${stat.multiDomainMeanNdcgAt10.toFixed(4)} <span class="note">(${stat.datasetsEvaluated}/${stat.datasetsRequested})</span>`;
      return `<td class="${isBest ? 'best' : ''}">${label}</td>`;
    });
    return `<tr><td>${escHtml(run.label)}</td>${cells.join('')}</tr>`;
  }).join('');

  const deltaGRows = input.runs.map((run) => {
    const cells = modes.map((mode) => {
      const stat = statFor(run, mode);
      if (stat?.deltaG == null) return '<td>—</td>';
      const isBest = bestDeltaGByMode.get(mode) === stat.deltaG;
      return `<td class="${isBest ? 'best' : ''}">${formatPct(stat.deltaG)}</td>`;
    });
    return `<tr><td>${escHtml(run.label)}</td>${cells.join('')}</tr>`;
  }).join('');

  const provenanceRows = input.runs.map((run) => {
    const e = run.env;
    const embedding = e.embedding_provider
      ? `${escHtml(e.embedding_provider)}/${escHtml(e.embedding_model ?? 'default')}`
      : 'lexical/none';
    return `<tr>` +
      `<td>${escHtml(run.label)}</td>` +
      `<td><code>${escHtml(run.gitSha)}</code></td>` +
      `<td>${escHtml(run.generatedAt)}</td>` +
      `<td>${embedding}</td>` +
      `<td>${escHtml(e.rrf_c)}</td>` +
      `<td>${escHtml(e.rerank_model)} topN=${escHtml(e.rerank_top_n)}</td>` +
      `<td>${escHtml(e.chunk_size)}/${escHtml(e.chunk_overlap)}</td>` +
      `<td>${escHtml(e.contextual)}</td>` +
      `</tr>`;
  }).join('');

  return template
    .replace(/\{\{TITLE\}\}/g, escHtml('BEIR retrieval leaderboard (local reproductions)'))
    .replace('{{META}}', `Generated ${escHtml(input.generatedAt)} • ${input.runs.length} run(s) • ${modes.length} mode(s)`)
    .replace('{{HEADLINE_HEAD}}', headHtml)
    .replace('{{HEADLINE_ROWS}}', headlineRows || '<tr><td colspan="99" class="note">no runs</td></tr>')
    .replace('{{DELTAG_HEAD}}', headHtml)
    .replace('{{DELTAG_ROWS}}', deltaGRows || '<tr><td colspan="99" class="note">no runs</td></tr>')
    .replace('{{PROVENANCE_ROWS}}', provenanceRows || '<tr><td colspan="8" class="note">no runs</td></tr>');
}

async function loadTemplate(): Promise<string> {
  // The template is a static asset under benchmarks/compare/ that tsc does not
  // copy into build/. It is resolved relative to process.cwd() (the repo root,
  // for both the `bench:beir:leaderboard` npm script and the jest suite) rather
  // than import.meta.url, so this module stays importable under ts-jest's CJS
  // transform — the seam compare/render.ts cannot use because it is never
  // imported by a test.
  const candidates = [
    path.resolve(process.cwd(), 'benchmarks', 'compare', 'leaderboard-template.html'),
    path.resolve(process.cwd(), '..', 'benchmarks', 'compare', 'leaderboard-template.html'),
  ];
  for (const candidate of candidates) {
    try {
      return await fsp.readFile(candidate, 'utf-8');
    } catch {
      // try next
    }
  }
  throw new Error(`leaderboard: could not locate leaderboard-template.html in any of: ${candidates.join(', ')}`);
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface LeaderboardCliOptions {
  inputs: string[];
  outputPath: string;
  now: string;
}

export function parseLeaderboardArgs(argv: string[], now: string): LeaderboardCliOptions {
  const options: LeaderboardCliOptions = {
    inputs: [],
    outputPath: path.join(process.cwd(), 'benchmarks', 'results', 'beir', 'leaderboard.html'),
    now,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const [flag, inlineValue] = token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined];
    const readValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      const value = argv[i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (flag === '--inputs') {
      options.inputs = readValue().split(',').map((v) => v.trim()).filter(Boolean).map((p) => path.resolve(p));
    } else if (flag === '--output') {
      options.outputPath = path.resolve(readValue());
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(leaderboardHelpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  if (options.inputs.length === 0) {
    throw new Error('leaderboard: --inputs=<matrix.json[,matrix2.json]> is required');
  }
  return options;
}

function leaderboardHelpText(): string {
  return `kb BEIR cross-run leaderboard (RFC 020 §7)

Usage:
  npm run bench:beir:leaderboard -- --inputs=run1/beir-matrix.json,run2/beir-matrix.json \\
      --output=benchmarks/results/beir/leaderboard.html

Each input is a beir-matrix.json produced by bench:beir:matrix. The leaderboard
ranks runs by the per-mode multi-domain mean nDCG@10, shows Δ_g, and records the
commit + env for each run.

Options:
  --inputs=<a.json[,b.json]>  Matrix report JSON files (one per run). Required.
  --output=<path>             Output HTML. Default: benchmarks/results/beir/leaderboard.html.
`;
}

async function main(): Promise<void> {
  const options = parseLeaderboardArgs(process.argv.slice(2), new Date().toISOString());
  const runs = await Promise.all(options.inputs.map((input) => loadMatrixRun(input)));
  const html = await renderLeaderboard({ runs, generatedAt: options.now });
  await fsp.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fsp.writeFile(options.outputPath, html, 'utf-8');
  process.stdout.write(`${options.outputPath}\n`);
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'compare', 'leaderboard.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'compare', 'leaderboard.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
