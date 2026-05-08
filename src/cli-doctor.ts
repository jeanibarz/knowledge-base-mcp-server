// `kb doctor` — aggregate health surface (RFC 004 / issue #180).
//
// Single-shot diagnostic that bundles the facts an agent or a human
// debugging a stuck `kb` run actually needs:
//
//   - CLI version (matches `kb --version`).
//   - Active embedding model (provider + model_name + model_id).
//   - Active index file path + mtime (RFC 014 versioned layout aware;
//     falls back to legacy `faiss.index/` when versioned is absent).
//   - Per-KB stale counts: total ingestable files, files modified since
//     the active index's mtime, files with no sidecar yet (new since
//     last `kb search --refresh`).
//   - Linked-checkout status: is `kb` running from an `npm link`'d
//     git working tree? When so, local HEAD vs `origin/main` is
//     reported so an operator on the ingestion host can tell whether
//     the binary needs a `git pull && npm i && npm run build`.
//
// Strictly read-only — never touches the FAISS index or network. All
// data sources are filesystem reads + `git` subprocess calls. Output
// formats: `--format=md` (default, human-readable), `--format=json`
// (machine-readable, the agent path).
//
// Exit codes:
//   0 — index resolves and active index file exists ("healthy")
//   1 — runtime error during data collection
//   2 — argv parse error
//
// The "healthy" bar is intentionally narrow: the absence of an active
// model or a missing index is the main wedge `kb doctor` should expose.
// Stale counts > 0 are NOT unhealthy — they're the natural signal that
// `kb search --refresh` is due. Backend reachability is not probed here
// (would mean a network call); a future PR can add `--probe` if the
// trade-off is worth it.

import { execFileSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { readFileSync, realpathSync } from 'fs';
import {
  ActiveModelResolutionError,
  modelDir as resolveModelDir,
  readStoredModelName,
  resolveActiveModel,
} from './active-model.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { resolveActiveIndexFilePath } from './faiss-store-layout.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';
import { parseModelId } from './model-id.js';

interface DoctorArgs {
  format: 'md' | 'json';
}

export interface DoctorActiveModel {
  model_id: string;
  provider: string;
  model_name: string;
}

export interface DoctorIndex {
  path: string | null;
  mtime: string | null;
}

export interface DoctorKbHealth {
  name: string;
  total_files: number;
  modified_files: number;
  new_files: number;
}

export interface DoctorGit {
  head: string | null;
  origin_main: string | null;
  /** Number of commits HEAD is behind origin/main; null when either ref is unresolvable. */
  behind_origin_main: number | null;
}

export interface DoctorCheckout {
  /** True when argv[1] resolves through a symlink AND the resolved path lives under a git working tree. */
  linked: boolean;
  /** realpath of argv[1] (the actually-running binary), or null when undetectable. */
  realpath: string | null;
  /** Working-tree root containing the binary, or null when not under a git checkout. */
  worktree: string | null;
  git?: DoctorGit;
}

export interface DoctorReport {
  version: string;
  active_model: DoctorActiveModel | null;
  active_index: DoctorIndex;
  knowledge_bases: DoctorKbHealth[];
  checkout: DoctorCheckout;
  healthy: boolean;
}

const HELP =
  'usage: kb doctor [--format=md|json]\n' +
  '\n' +
  'Aggregate health report: active model, active index path + mtime,\n' +
  'per-KB stale counts, CLI version, and linked-checkout git status\n' +
  '(when running from an npm-linked working tree).\n' +
  '\n' +
  'Strictly read-only. Exits 0 when the active model resolves and the\n' +
  'active index file exists; non-zero on data-collection errors.\n';

export function parseDoctorArgs(rest: string[]): DoctorArgs {
  let format: 'md' | 'json' = 'md';
  for (const raw of rest) {
    if (raw === '--help' || raw === '-h') {
      throw new Error(HELP.trimEnd());
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format value '${value}' (expected md or json)`);
      }
      format = value;
      continue;
    }
    if (raw.startsWith('--')) {
      throw new Error(`unknown flag: ${raw}`);
    }
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  return { format };
}

export async function runDoctor(rest: string[]): Promise<number> {
  let parsed: DoctorArgs;
  try {
    parsed = parseDoctorArgs(rest);
  } catch (err) {
    process.stderr.write(`kb doctor: ${(err as Error).message}\n`);
    return 2;
  }

  let report: DoctorReport;
  try {
    report = await collectDoctorReport();
  } catch (err) {
    process.stderr.write(`kb doctor: ${(err as Error).message}\n`);
    return 1;
  }

  if (parsed.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatReportMarkdown(report));
  }
  return report.healthy ? 0 : 1;
}

export async function collectDoctorReport(): Promise<DoctorReport> {
  const version = readPackageVersion();
  const activeModel = await collectActiveModel();
  const activeIndex = activeModel !== null
    ? await collectActiveIndex(activeModel.model_id)
    : { path: null, mtime: null };
  const indexMtimeMs = activeIndex.mtime !== null ? Date.parse(activeIndex.mtime) : null;
  const knowledgeBases = await collectKnowledgeBaseHealth(indexMtimeMs);
  const checkout = collectCheckoutInfo();

  const healthy =
    activeModel !== null && activeIndex.path !== null;

  return {
    version,
    active_model: activeModel,
    active_index: activeIndex,
    knowledge_bases: knowledgeBases,
    checkout,
    healthy,
  };
}

function readPackageVersion(): string {
  // Anchor on process.argv[1] (the running script) rather than
  // `import.meta.url` so this module is straightforwardly compilable by
  // ts-jest's CJS-mode test runner. The two anchors point at the same
  // file at runtime in production (`build/cli.js`); in tests, argv[1]
  // resolves to jest's worker binary and the package.json lookup
  // gracefully falls back to 'unknown'.
  try {
    if (!process.argv[1]) return 'unknown';
    const here = realpathSync(process.argv[1]);
    const pkgPath = path.join(path.dirname(here), '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function collectActiveModel(): Promise<DoctorActiveModel | null> {
  let modelId: string;
  try {
    modelId = await resolveActiveModel();
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      return null;
    }
    throw err;
  }
  // `model_id` is a filesystem slug; the human-readable model name (e.g.
  // `BAAI/bge-small-en-v1.5`) lives in the per-model `model_name.txt`.
  // Treat a missing sidecar as "unknown" rather than failing the report.
  let provider = 'unknown';
  try {
    provider = parseModelId(modelId).provider;
  } catch {
    // Malformed model_id — surface as unknown but keep going.
  }
  let modelName = 'unknown';
  try {
    const stored = await readStoredModelName(modelId);
    if (stored !== null && stored.length > 0) modelName = stored;
  } catch {
    // best-effort; missing file just leaves modelName='unknown'
  }
  return { model_id: modelId, provider, model_name: modelName };
}

async function collectActiveIndex(modelId: string): Promise<DoctorIndex> {
  const dir = resolveModelDir(modelId);
  let indexPath: string | null = null;
  try {
    indexPath = await resolveActiveIndexFilePath(dir);
  } catch {
    indexPath = null;
  }
  if (indexPath === null) {
    return { path: null, mtime: null };
  }
  let mtime: string | null = null;
  try {
    const st = await fsp.stat(indexPath);
    mtime = new Date(st.mtimeMs).toISOString();
  } catch {
    // The path resolver returned a candidate, but stat failed (race with
    // a concurrent rebuild that swapped the symlink). Treat as "no
    // mtime" rather than failing the whole report.
    mtime = null;
  }
  return { path: indexPath, mtime };
}

async function collectKnowledgeBaseHealth(indexMtimeMs: number | null): Promise<DoctorKbHealth[]> {
  let kbs: string[];
  try {
    kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  } catch {
    return [];
  }
  if (kbs.length === 0) return [];
  const enumerations = await enumerateIngestableKbFiles(KNOWLEDGE_BASES_ROOT_DIR, kbs);
  const out: DoctorKbHealth[] = [];
  for (const { kbName, kbPath, filePaths } of enumerations) {
    let modified = 0;
    if (indexMtimeMs !== null) {
      for (const f of filePaths) {
        try {
          const st = await fsp.stat(f);
          if (st.mtimeMs > indexMtimeMs) modified += 1;
        } catch {
          // file vanished between the walker and stat; ignore.
        }
      }
    }
    let sidecarCount = 0;
    try {
      const sidecars = await fsp.readdir(path.join(kbPath, '.index'));
      sidecarCount = sidecars.length;
    } catch {
      // .index missing → every ingestable file is "new" since the
      // sidecar count is zero, and the difference below catches it.
    }
    const newFiles = Math.max(0, filePaths.length - sidecarCount);
    out.push({
      name: kbName,
      total_files: filePaths.length,
      modified_files: modified,
      new_files: newFiles,
    });
  }
  return out;
}

function collectCheckoutInfo(): DoctorCheckout {
  // argv[1] is the script being run (e.g. `~/.nvm/.../bin/kb` when
  // installed via npm link). realpathSync collapses the symlink chain,
  // so a linked checkout shows a path under the dev working tree.
  const argv1 = process.argv[1];
  if (!argv1) {
    return { linked: false, realpath: null, worktree: null };
  }
  let resolved: string;
  try {
    resolved = realpathSync(argv1);
  } catch {
    return { linked: false, realpath: null, worktree: null };
  }
  const linked = path.resolve(argv1) !== resolved;
  const worktree = findGitWorktreeRoot(resolved);
  if (worktree === null) {
    return { linked, realpath: resolved, worktree: null };
  }
  return {
    linked,
    realpath: resolved,
    worktree,
    git: collectGitState(worktree),
  };
}

function findGitWorktreeRoot(start: string): string | null {
  // `git rev-parse --show-toplevel` is the canonical "where is this
  // worktree rooted?" check. Run from the binary's parent dir so a
  // build/cli.js path resolves to the project root.
  const cwd = path.dirname(start);
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function collectGitState(worktree: string): DoctorGit {
  const head = readGitRef(worktree, ['rev-parse', 'HEAD']);
  const originMain = readGitRef(worktree, ['rev-parse', 'origin/main']);
  let behind: number | null = null;
  if (head !== null && originMain !== null) {
    const raw = readGitRef(worktree, ['rev-list', '--count', 'HEAD..origin/main']);
    if (raw !== null) {
      const n = Number(raw);
      behind = Number.isInteger(n) && n >= 0 ? n : null;
    }
  }
  return { head, origin_main: originMain, behind_origin_main: behind };
}

function readGitRef(worktree: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync('git', args.slice(), {
      cwd: worktree,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function formatReportMarkdown(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`kb doctor: ${report.healthy ? 'healthy' : 'UNHEALTHY'}`);
  lines.push('');
  lines.push(`version: ${report.version}`);
  if (report.active_model !== null) {
    lines.push(
      `active_model: ${report.active_model.provider}/${report.active_model.model_name} ` +
        `(${report.active_model.model_id})`,
    );
  } else {
    lines.push('active_model: <unresolved> — run `kb models add <provider> <model>` or set KB_ACTIVE_MODEL');
  }
  if (report.active_index.path !== null) {
    const mtime = report.active_index.mtime ?? '<no-mtime>';
    lines.push(`active_index: ${report.active_index.path} (mtime ${mtime})`);
  } else {
    lines.push('active_index: <missing> — run `kb search --refresh` to build it');
  }
  if (report.knowledge_bases.length === 0) {
    lines.push('knowledge_bases: (none registered under KNOWLEDGE_BASES_ROOT_DIR)');
  } else {
    lines.push('knowledge_bases:');
    const longest = report.knowledge_bases.reduce((m, kb) => Math.max(m, kb.name.length), 0);
    for (const kb of report.knowledge_bases) {
      lines.push(
        `  ${kb.name.padEnd(longest)}  total=${kb.total_files}` +
          `  modified=${kb.modified_files}  new=${kb.new_files}`,
      );
    }
  }
  lines.push('');
  if (report.checkout.worktree !== null) {
    const label = report.checkout.linked ? 'linked dev install' : 'dev checkout';
    lines.push(`checkout: ${label} (worktree=${report.checkout.worktree})`);
    if (report.checkout.realpath !== null && report.checkout.linked) {
      lines.push(`  realpath:    ${report.checkout.realpath}`);
    }
    if (report.checkout.git) {
      const head = report.checkout.git.head ?? '<unknown>';
      const originMain = report.checkout.git.origin_main ?? '<unfetched>';
      const behind = report.checkout.git.behind_origin_main;
      lines.push(`  HEAD:        ${head}`);
      lines.push(`  origin/main: ${originMain}`);
      if (behind !== null) {
        lines.push(`  behind:      ${behind} commit${behind === 1 ? '' : 's'}`);
      }
    }
  } else {
    lines.push('checkout: installed binary (no git worktree detected)');
  }
  return `${lines.join('\n')}\n`;
}
