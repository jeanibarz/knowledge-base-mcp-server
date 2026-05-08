// `kb doctor` — aggregate read-only health report for local KB operations
// (issue #180). The command intentionally composes existing filesystem and
// model-resolution surfaces instead of loading the FAISS store or embedding
// documents.

import * as fsp from 'fs/promises';
import { realpathSync } from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ActiveModelResolutionError,
  listRegisteredModels,
  parseModelId,
  resolveActiveModel,
  resolveFaissIndexBinaryPath,
} from './active-model.js';
import {
  FAISS_INDEX_PATH,
  HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN,
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
  KNOWLEDGE_BASES_ROOT_DIR,
  OLLAMA_BASE_URL,
} from './config.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';
import { FaissIndexManager } from './FaissIndexManager.js';

const execFileAsync = promisify(execFile);

export interface DoctorArgs {
  format: 'md' | 'json';
}

export type HealthStatus = 'ok' | 'warn' | 'error';

export interface DoctorReport {
  status: HealthStatus;
  checks: Array<{ name: string; status: HealthStatus; detail: string }>;
  active_model: {
    model_id: string | null;
    provider: string | null;
    model_name: string | null;
  };
  index: {
    path: string;
    binary_path: string | null;
    version: string | null;
    mtime: string | null;
  };
  stale_counts_by_kb: Record<string, { modified_files: number; new_files: number }>;
  backend: {
    provider: string | null;
    healthy: boolean;
    detail: string;
  };
  cli: {
    version: string;
    package_root: string;
    invoked_path: string | null;
    symlinked_checkout_path: string | null;
  };
  git: {
    branch: string | null;
    head: string | null;
    origin_main: string | null;
    relation: 'ahead' | 'behind' | 'diverged' | 'up-to-date' | 'unknown';
  } | null;
}

export interface BuildDoctorReportOptions {
  backendHealthCheck?: BackendHealthCheck;
  packageRoot?: string;
  invokedPath?: string | null;
  packageVersion?: string;
}

export type BackendHealthCheck = (
  provider: string,
  modelName: string,
) => Promise<{ healthy: boolean; detail: string }>;

export async function runDoctor(rest: string[]): Promise<number> {
  let parsed: DoctorArgs;
  try {
    parsed = parseDoctorArgs(rest);
  } catch (err) {
    process.stderr.write(`kb doctor: ${(err as Error).message}\n`);
    return 2;
  }

  const report = await buildDoctorReport();
  if (parsed.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctorMarkdown(report));
  }
  return report.status === 'error' ? 1 : 0;
}

export function parseDoctorArgs(rest: string[]): DoctorArgs {
  const out: DoctorArgs = { format: 'md' };
  for (const raw of rest) {
    if (raw === '--help' || raw === '-h') {
      throw new Error('usage: kb doctor [--format=md|json]');
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format: ${raw}`);
      }
      out.format = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  return out;
}

export async function buildDoctorReport(
  options: BuildDoctorReportOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorReport['checks'] = [];
  let activeModelId: string | null = null;
  let activeProvider: string | null = null;
  let activeModelName: string | null = null;

  try {
    await FaissIndexManager.bootstrapLayout();
    checks.push({ name: 'layout', status: 'ok', detail: 'index layout bootstrap succeeded' });
  } catch (err) {
    checks.push({ name: 'layout', status: 'error', detail: (err as Error).message });
  }

  try {
    activeModelId = await resolveActiveModel();
    const model = (await listRegisteredModels()).find((m) => m.model_id === activeModelId);
    const parsed = parseModelId(activeModelId);
    activeProvider = parsed.provider;
    activeModelName = model?.model_name ?? parsed.slugBody;
    checks.push({ name: 'active_model', status: 'ok', detail: activeModelId });
  } catch (err) {
    const status = err instanceof ActiveModelResolutionError ? 'error' : 'error';
    checks.push({ name: 'active_model', status, detail: (err as Error).message });
  }

  const index = await readIndexHealth(activeModelId);
  checks.push({
    name: 'index',
    status: index.binary_path === null ? 'error' : 'ok',
    detail: index.binary_path === null
      ? 'active model index is not built'
      : `${index.version ?? 'unknown'} at ${index.mtime ?? 'unknown mtime'}`,
  });

  const staleCounts = await computeStaleCountsByKb(
    activeModelId,
    index.mtime === null ? null : Date.parse(index.mtime),
  );
  const staleTotal = Object.values(staleCounts)
    .reduce((sum, row) => sum + row.modified_files + row.new_files, 0);
  checks.push({
    name: 'staleness',
    status: staleTotal === 0 ? 'ok' : 'warn',
    detail: staleTotal === 0
      ? 'no modified or new ingestable files detected'
      : `${staleTotal} modified/new ingestable file(s) detected`,
  });

  const backend = await readBackendHealth(
    activeProvider,
    activeModelName,
    options.backendHealthCheck ?? defaultBackendHealthCheck,
  );
  checks.push({
    name: 'backend',
    status: backend.healthy ? 'ok' : 'error',
    detail: backend.detail,
  });

  const packageRoot = options.packageRoot ?? resolvePackageRoot();
  const invokedPath = options.invokedPath ?? process.argv[1] ?? null;
  const cli = {
    version: options.packageVersion ?? await readPackageVersion(packageRoot),
    package_root: packageRoot,
    invoked_path: invokedPath,
    symlinked_checkout_path: detectSymlinkedCheckoutPath(packageRoot, invokedPath),
  };
  const git = await readGitState(packageRoot);

  const status = summarizeStatus(checks);
  return {
    status,
    checks,
    active_model: {
      model_id: activeModelId,
      provider: activeProvider,
      model_name: activeModelName,
    },
    index,
    stale_counts_by_kb: staleCounts,
    backend,
    cli,
    git,
  };
}

async function readIndexHealth(activeModelId: string | null): Promise<DoctorReport['index']> {
  if (activeModelId === null) {
    return { path: FAISS_INDEX_PATH, binary_path: null, version: null, mtime: null };
  }
  const binaryPath = await resolveFaissIndexBinaryPath(activeModelId);
  if (binaryPath === null) {
    return { path: FAISS_INDEX_PATH, binary_path: null, version: null, mtime: null };
  }
  try {
    const st = await fsp.stat(binaryPath);
    return {
      path: FAISS_INDEX_PATH,
      binary_path: binaryPath,
      version: indexVersionFromPath(binaryPath),
      mtime: new Date(st.mtimeMs).toISOString(),
    };
  } catch {
    return { path: FAISS_INDEX_PATH, binary_path: null, version: null, mtime: null };
  }
}

async function computeStaleCountsByKb(
  activeModelId: string | null,
  indexMtimeMs: number | null,
): Promise<DoctorReport['stale_counts_by_kb']> {
  let kbs: string[];
  try {
    kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  } catch {
    return {};
  }

  const enumerations = await enumerateIngestableKbFiles(
    KNOWLEDGE_BASES_ROOT_DIR,
    kbs,
    {
      extraExtensions: INGEST_EXTRA_EXTENSIONS,
      excludePaths: INGEST_EXCLUDE_PATHS,
    },
  );

  const out: DoctorReport['stale_counts_by_kb'] = {};
  for (const { kbName, kbPath, filePaths } of enumerations) {
    let modified = 0;
    for (const filePath of filePaths) {
      if (indexMtimeMs === null) continue;
      try {
        const st = await fsp.stat(filePath);
        if (st.mtimeMs > indexMtimeMs) modified += 1;
      } catch {
        // Vanished between walk and stat; ignore in a read-only health check.
      }
    }
    const sidecarCount = await countFiles(path.join(kbPath, '.index'));
    const added = activeModelId === null || indexMtimeMs === null
      ? filePaths.length
      : Math.max(0, filePaths.length - sidecarCount);
    out[kbName] = { modified_files: modified, new_files: added };
  }
  return out;
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  async function walk(target: string): Promise<void> {
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fsp.readdir(target, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw err;
    }
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
  await walk(dir);
  return count;
}

async function readBackendHealth(
  provider: string | null,
  modelName: string | null,
  check: BackendHealthCheck,
): Promise<DoctorReport['backend']> {
  if (provider === null || modelName === null) {
    return { provider, healthy: false, detail: 'no active model resolved' };
  }
  const result = await check(provider, modelName).catch((err): { healthy: boolean; detail: string } => ({
    healthy: false,
    detail: (err as Error).message,
  }));
  return { provider, ...result };
}

async function defaultBackendHealthCheck(
  provider: string,
  modelName: string,
): Promise<{ healthy: boolean; detail: string }> {
  if (provider === 'ollama') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(new URL('/api/tags', OLLAMA_BASE_URL), {
        signal: controller.signal,
      });
      if (!res.ok) return { healthy: false, detail: `Ollama ${OLLAMA_BASE_URL} returned HTTP ${res.status}` };
      return { healthy: true, detail: `Ollama ${OLLAMA_BASE_URL} is reachable for ${modelName}` };
    } catch (err) {
      const message = (err as Error).name === 'AbortError'
        ? 'timed out'
        : (err as Error).message;
      return { healthy: false, detail: `Ollama ${OLLAMA_BASE_URL} is not reachable: ${message}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY
      ? { healthy: true, detail: `OPENAI_API_KEY is set for ${modelName}` }
      : { healthy: false, detail: 'OPENAI_API_KEY is not set' };
  }

  if (provider === 'huggingface') {
    if (!process.env.HUGGINGFACE_API_KEY) {
      return { healthy: false, detail: 'HUGGINGFACE_API_KEY is not set' };
    }
    const endpointNote = HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN
      ? 'custom endpoint configured'
      : 'router endpoint configured';
    return { healthy: true, detail: `HUGGINGFACE_API_KEY is set for ${modelName}; ${endpointNote}` };
  }

  return { healthy: false, detail: `unsupported provider: ${provider}` };
}

function summarizeStatus(checks: DoctorReport['checks']): HealthStatus {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

function indexVersionFromPath(binaryPath: string): string {
  const parent = path.basename(path.dirname(binaryPath));
  if (/^index\.v\d+$/.test(parent)) return parent;
  if (parent === 'faiss.index') return 'legacy';
  return parent;
}

function resolvePackageRoot(): string {
  if (process.argv[1]) {
    try {
      return path.resolve(path.dirname(realpathSync(process.argv[1])), '..');
    } catch {
      // Fall through to cwd below.
    }
  }
  return process.cwd();
}

async function readPackageVersion(packageRoot: string): Promise<string> {
  try {
    const raw = await fsp.readFile(path.join(packageRoot, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function detectSymlinkedCheckoutPath(packageRoot: string, invokedPath: string | null): string | null {
  if (invokedPath === null) return null;
  try {
    const invokedLexical = path.resolve(invokedPath);
    const invokedReal = realpathSync(invokedPath);
    const cliReal = path.join(packageRoot, 'build', 'cli.js');
    if (invokedLexical !== invokedReal && invokedReal === cliReal) return packageRoot;
  } catch {
    return null;
  }
  return null;
}

async function readGitState(packageRoot: string): Promise<DoctorReport['git']> {
  try {
    const [branch, head, originMain] = await Promise.all([
      git(packageRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(packageRoot, ['rev-parse', '--short', 'HEAD']),
      git(packageRoot, ['rev-parse', '--short', 'origin/main']),
    ]);
    let relation: 'ahead' | 'behind' | 'diverged' | 'up-to-date' | 'unknown' = 'unknown';
    try {
      const counts = await git(packageRoot, ['rev-list', '--left-right', '--count', 'HEAD...origin/main']);
      const [aheadRaw, behindRaw] = counts.split(/\s+/);
      const ahead = Number(aheadRaw);
      const behind = Number(behindRaw);
      if (ahead === 0 && behind === 0) relation = 'up-to-date';
      else if (ahead > 0 && behind === 0) relation = 'ahead';
      else if (ahead === 0 && behind > 0) relation = 'behind';
      else if (ahead > 0 && behind > 0) relation = 'diverged';
    } catch {
      relation = 'unknown';
    }
    return { branch, head, origin_main: originMain, relation };
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

export function formatDoctorMarkdown(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`Status: ${report.status.toUpperCase()}`);
  lines.push('');
  lines.push(`Active model: ${report.active_model.model_id ?? '<unresolved>'}`);
  if (report.active_model.provider !== null && report.active_model.model_name !== null) {
    lines.push(`Provider/model: ${report.active_model.provider} / ${report.active_model.model_name}`);
  }
  lines.push(`Index: ${report.index.binary_path ?? '<not built>'}`);
  lines.push(`Index version: ${report.index.version ?? '<unknown>'}`);
  lines.push(`Index mtime: ${report.index.mtime ?? '<none>'}`);
  lines.push(`Backend: ${report.backend.healthy ? 'ok' : 'error'} — ${report.backend.detail}`);
  lines.push(`kb version: ${report.cli.version}`);
  if (report.cli.symlinked_checkout_path !== null) {
    lines.push(`Linked checkout: ${report.cli.symlinked_checkout_path}`);
  }
  if (report.git !== null) {
    lines.push(
      `Git: ${report.git.branch ?? '<unknown>'} ${report.git.head ?? '<unknown>'} ` +
      `vs origin/main ${report.git.origin_main ?? '<unknown>'} (${report.git.relation})`,
    );
  }
  lines.push('');
  lines.push('Stale counts by KB:');
  const names = Object.keys(report.stale_counts_by_kb).sort();
  if (names.length === 0) {
    lines.push('  (no knowledge bases found)');
  } else {
    for (const name of names) {
      const row = report.stale_counts_by_kb[name];
      lines.push(`  ${name}: ${row.modified_files} modified, ${row.new_files} new`);
    }
  }
  lines.push('');
  lines.push('Checks:');
  for (const check of report.checks) {
    lines.push(`  ${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}`);
  }
  return lines.join('\n') + '\n';
}
