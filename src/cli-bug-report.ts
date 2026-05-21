import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runLogs } from './cli-logs.js';
import { runStats } from './cli-stats.js';
import { captureProcessOutput } from './cli-shared.js';
import {
  REDACTION_PLACEHOLDER,
  combineRedactionSummaries,
  emptyRedactionSummary,
  redactSecrets,
  type RedactionSummary,
} from './redaction.js';
import type { DoctorReport } from './cli-doctor.js';

const BUG_REPORT_SCHEMA_VERSION = 'kb.doctor.bug_report.v1';
const DEFAULT_LOG_LIMIT = 50;
const COMMAND_STDERR_TAIL_BYTES = 16 * 1024;

export interface DoctorBugReportOptions {
  outputParentDir?: string;
  now?: Date;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  command?: string[];
  buildDoctorReport?: () => Promise<DoctorReport>;
  runStats?: (args: string[]) => Promise<number>;
  runLogs?: (args: string[]) => Promise<number>;
}

export interface DoctorBugReportResult {
  schema_version: typeof BUG_REPORT_SCHEMA_VERSION;
  bundle_dir: string;
  created_at: string;
  files: string[];
  redaction_summary: RedactionSummary;
}

interface WrittenFile {
  name: string;
  redaction: RedactionSummary;
}

interface CommandBundleResult {
  command: string[];
  exit_code: number;
  signal: NodeJS.Signals | null;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  stderr_tail: string;
  stderr_truncated: boolean;
}

export async function createDoctorBugReportBundle(
  options: DoctorBugReportOptions = {},
): Promise<DoctorBugReportResult> {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const parentDir = path.resolve(options.cwd ?? process.cwd(), options.outputParentDir ?? '.');
  const bundleDir = path.join(parentDir, `kb-bug-report-${formatBundleTimestamp(now)}`);
  await fsp.mkdir(bundleDir, { recursive: false });

  const written: WrittenFile[] = [];
  const writeJson = async (name: string, value: unknown): Promise<void> => {
    const redacted = redactJsonValue(value);
    await fsp.writeFile(
      path.join(bundleDir, name),
      `${JSON.stringify(redacted.value, null, 2)}\n`,
      'utf-8',
    );
    written.push({ name, redaction: redacted.redaction });
  };
  const writeText = async (name: string, text: string): Promise<void> => {
    const redacted = redactSecrets(text);
    await fsp.writeFile(path.join(bundleDir, name), redacted.text, 'utf-8');
    written.push({ name, redaction: redacted.summary });
  };

  await writeJson('doctor.json', await (options.buildDoctorReport ?? defaultBuildDoctorReport)());
  await writeCapturedJson(
    'stats.json',
    async () => captureProcessOutput(() => (options.runStats ?? runStats)(['--format=json'])),
    writeJson,
  );
  await writeCapturedJson(
    'logs-recent.json',
    async () => captureProcessOutput(() => (options.runLogs ?? runLogs)([
      'recent',
      `--limit=${DEFAULT_LOG_LIMIT}`,
      '--format=json',
    ])),
    writeJson,
  );
  await writeJson('runtime.json', buildRuntimeSummary(options.env ?? process.env));

  if (options.command !== undefined) {
    await writeJson('command.json', await runSupportCommand(options.command));
  }

  const manifestRedaction = combineRedactionSummaries(
    true,
    ...written.map((file) => file.redaction),
  );
  const manifest: DoctorBugReportResult = {
    schema_version: BUG_REPORT_SCHEMA_VERSION,
    bundle_dir: bundleDir,
    created_at: createdAt,
    files: [],
    redaction_summary: manifestRedaction,
  };
  await writeText('README.md', buildReadme(createdAt, options.command !== undefined));
  manifest.files = [...written.map((file) => file.name), 'manifest.json'].sort();
  await fsp.writeFile(
    path.join(bundleDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );

  return manifest;
}

async function defaultBuildDoctorReport(): Promise<DoctorReport> {
  const { buildDoctorReport } = await import('./cli-doctor.js');
  return buildDoctorReport();
}

function redactJsonValue(value: unknown): { value: unknown; redaction: RedactionSummary } {
  if (typeof value === 'string') {
    const redacted = redactSecrets(value);
    return { value: redacted.text, redaction: redacted.summary };
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => redactJsonValue(item));
    return {
      value: items.map((item) => item.value),
      redaction: combineRedactionSummaries(true, ...items.map((item) => item.redaction)),
    };
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const summaries: RedactionSummary[] = [];
    for (const [key, child] of Object.entries(value)) {
      const redacted = redactJsonValue(child);
      out[key] = redacted.value;
      summaries.push(redacted.redaction);
    }
    return {
      value: out,
      redaction: combineRedactionSummaries(true, ...summaries),
    };
  }
  return { value, redaction: emptyRedactionSummary(true) };
}

async function writeCapturedJson(
  fileName: string,
  run: () => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  writeJson: (name: string, value: unknown) => Promise<void>,
): Promise<void> {
  const captured = await run();
  const parsed = parseJsonOrNull(captured.stdout);
  await writeJson(fileName, {
    command_exit_code: captured.exitCode,
    payload: parsed,
    parse_error: parsed === null && captured.stdout.trim() !== ''
      ? 'command did not emit valid JSON'
      : null,
    stderr_tail: tailString(captured.stderr, COMMAND_STDERR_TAIL_BYTES),
  });
}

function parseJsonOrNull(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function buildRuntimeSummary(env: NodeJS.ProcessEnv): unknown {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cwd: process.cwd(),
    package: readPackageMetadata(),
    env: summarizeEnv(env),
  };
}

function readPackageMetadata(): { name: string | null; version: string | null } {
  const candidates = [
    ...(process.argv[1] === undefined
      ? []
      : [
          path.join(path.dirname(process.argv[1]), '..', 'package.json'),
          path.join(path.dirname(process.argv[1]), 'package.json'),
        ]),
    path.join(process.cwd(), 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(requireText(candidate)) as { name?: string; version?: string };
      return { name: parsed.name ?? null, version: parsed.version ?? null };
    } catch {
      // Try the next likely package location.
    }
  }
  return { name: null, version: null };
}

function requireText(filePath: string): string {
  return readFileSync(filePath, 'utf-8');
}

function summarizeEnv(env: NodeJS.ProcessEnv): Array<{ name: string; value: string }> {
  const prefixes = [
    'KB_',
    'KNOWLEDGE_',
    'FAISS_',
    'EMBEDDING_',
    'OLLAMA_',
    'OPENAI_',
    'HUGGINGFACE_',
    'MCP_',
    'LOG_',
    'REINDEX_',
  ];
  return Object.keys(env)
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    .sort()
    .map((name) => ({
      name,
      value: redactEnvValue(name, env[name] ?? ''),
    }));
}

function redactEnvValue(name: string, value: string): string {
  if (isSensitiveEnvName(name)) return REDACTION_PLACEHOLDER;
  return redactSecrets(value).text;
}

function isSensitiveEnvName(name: string): boolean {
  return /(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|REFRESH_?TOKEN|SESSION_?TOKEN|PRIVATE_?KEY|CLIENT_?SECRET|SECRET|PASSWORD|PASSWD|COOKIE|AUTHORIZATION)/i
    .test(name);
}

async function runSupportCommand(command: string[]): Promise<CommandBundleResult> {
  if (command.length === 0) {
    throw new Error('bug-report support command is empty');
  }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command;
    const child = spawn(cmd, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
      trimTailBuffers(stderrChunks, COMMAND_STDERR_TAIL_BYTES);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const rawStderrTail = Buffer.concat(stderrChunks).toString('utf-8');
      resolve({
        command: redactCommandArguments(command),
        exit_code: code ?? 1,
        signal,
        duration_ms: Math.max(0, Date.now() - started),
        stdout_bytes: 0,
        stderr_bytes: stderrBytes,
        stderr_tail: redactSecrets(rawStderrTail).text,
        stderr_truncated: stderrBytes > COMMAND_STDERR_TAIL_BYTES,
      });
    });
  });
}

function redactCommandArguments(command: string[]): string[] {
  let redactNext = false;
  return command.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTION_PLACEHOLDER;
    }

    const equalsIndex = arg.indexOf('=');
    if (equalsIndex > 0) {
      const flag = arg.slice(0, equalsIndex);
      if (isSensitiveCommandValueFlag(flag)) {
        return `${flag}=${REDACTION_PLACEHOLDER}`;
      }
    }

    if (isSensitiveCommandValueFlag(arg)) {
      redactNext = true;
    }
    return redactSecrets(arg).text;
  });
}

function isSensitiveCommandValueFlag(arg: string): boolean {
  const flag = arg.replace(/^-+/, '').toLowerCase();
  return /(?:^|[-_])(?:token|api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|session[-_]?token|private[-_]?key|client[-_]?secret|secret|password|passwd|cookie|authorization)$/
    .test(flag);
}

function trimTailBuffers(chunks: Buffer[], maxBytes: number): void {
  let total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  while (total > maxBytes && chunks.length > 0) {
    const first = chunks[0];
    const excess = total - maxBytes;
    if (first.length <= excess) {
      chunks.shift();
      total -= first.length;
    } else {
      chunks[0] = first.subarray(excess);
      total -= excess;
    }
  }
}

function tailString(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(buffer.length - maxBytes).toString('utf-8');
}

function buildReadme(createdAt: string, includedCommand: boolean): string {
  return [
    '# kb doctor bug report',
    '',
    `Created: ${createdAt}`,
    '',
    'This support bundle contains redacted diagnostics for a local `kb` installation.',
    'It intentionally excludes knowledge-base note contents and raw API keys.',
    'KB names, filesystem paths, model names, and log metadata can still be sensitive.',
    '',
    'Included files:',
    '- `manifest.json` - bundle schema, file list, and redaction counts.',
    '- `doctor.json` - aggregate `kb doctor` health report.',
    '- `stats.json` - captured `kb stats --format=json` result or error metadata.',
    '- `logs-recent.json` - recent canonical log summaries when a log file is configured.',
    '- `runtime.json` - Node/package/platform and redacted relevant environment settings.',
    ...(includedCommand
      ? ['- `command.json` - optional support command exit metadata and redacted stderr tail.']
      : []),
    '',
  ].join('\n');
}

function formatBundleTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
