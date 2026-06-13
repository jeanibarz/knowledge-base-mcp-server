// `kb capture` — run a command and append its stdout to a KB note as a
// fenced, provenance-tagged code block. See issue #143.
//
// Composes with `kb remember --append=<path>` for the write path. The
// `--append-section` heading-aware variant is tracked separately under
// issue #139; without it the captured block lands at EOF of the target
// note.

import { spawn } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { ActiveModelResolutionError, resolveActiveModel } from './active-model.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { assertNoTraversal, resolveKbPath, resolveKnowledgeBaseDir } from './kb-fs.js';
import { withWriteLock } from './write-lock.js';
import { loadManagerForModel } from './cli-shared.js';
import { appendFileAtomically } from './file-mutation.js';
import { assertKbWritePolicyAllowsMutation } from './kb-write-policy.js';
import {
  auditEnabled,
  recordMutation,
  sha256OfFileOrNull,
  type RefreshStatus,
} from './audit-log.js';
import {
  REDACTION_PLACEHOLDER,
  combineRedactionSummaries,
  maybeRedact,
  type RedactionSummary,
} from './redaction.js';

interface CaptureArgs {
  kb?: string;
  append?: string;
  note?: string;
  language?: string;
  maxBytes: number;
  allowFail: boolean;
  redact: boolean;
  refresh: boolean;
  command: string[];
}

interface CommandResult {
  stdout: string;
  truncated: boolean;
  bytesElided: number;
  exitCode: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

const LANGUAGE_BY_EXT: Record<string, string> = {
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
};

export const CAPTURE_HELP = `kb capture — run a command and append its stdout to a KB note as a fenced block

Usage:
  kb capture --kb=<name> --append=<path> [options] -- <cmd> [args...]

Spawns the command (\`shell: false\`), captures up to \`--max-bytes\` of stdout,
and appends a fenced, provenance-tagged code block to the target KB note.
The \`--\` separator is required: everything after it is the command + args
passed verbatim to spawn. Composes with \`kb remember --append=<path>\` for the
atomic EOF append write path.

Targeting:
  --kb=<name>           Target knowledge base. Required.
  --append=<path>       Existing KB-relative note path. Required. Rejects
                        path traversal and absolute paths before spawning.

Capture options:
  --note=<text>         Optional "### <text>" header above the captured block.
  --language=<hint>     Code-fence language hint. Auto-detected from the
                        command's first .json / .yml / .yaml argument if
                        absent (e.g. \`-- gh pr view --json title\` → \`json\`).
  --max-bytes=<N>       Truncate captured stdout at N bytes
                        (default: ${DEFAULT_MAX_BYTES}).
  --allow-fail          Capture even when the command exits non-zero.
                        Without this flag, a non-zero exit aborts the write.
  --no-redact           Persist raw stdout and displayed command line. By
                        default, common credentials in captured content are
                        replaced with ${REDACTION_PLACEHOLDER}.
  --refresh             Re-index the affected KB after a successful write.
  --                    End of options; remaining argv is the command + args.
  --help, -h            Show this help.

Examples:
  kb capture --kb=work --append=oncall.md --note="incident snapshot" -- \\
    gh pr view 123 --json title,body
  kb capture --kb=ops --append=deploys.md --language=yaml -- \\
    kubectl get deployment api -o yaml
  kb capture --kb=work --append=models.md --allow-fail -- ollama list
`;

export async function runCapture(rest: string[]): Promise<number> {
  let parsed: CaptureArgs;
  try {
    parsed = parseCaptureArgs(rest);
    validateCaptureArgs(parsed);
  } catch (err) {
    process.stderr.write(`kb capture: ${(err as Error).message}\n`);
    return 2;
  }

  // Reject traversal/absolute --append paths before spawning the command —
  // an obviously bogus target shouldn't have side effects.
  try {
    assertNoTraversal(parsed.append!);
  } catch (err) {
    process.stderr.write(`kb capture: ${(err as Error).message}\n`);
    return 1;
  }

  let result: CommandResult;
  try {
    result = await runCommand(parsed.command, parsed.maxBytes);
  } catch (err) {
    process.stderr.write(`kb capture: failed to spawn command: ${(err as Error).message}\n`);
    return 1;
  }

  if (result.exitCode !== 0 && !parsed.allowFail) {
    process.stderr.write(
      `kb capture: command exited ${result.exitCode}; pass --allow-fail to capture anyway.\n`,
    );
    return 1;
  }
  if (result.stdout.length === 0) {
    process.stderr.write('kb capture: command produced no stdout; refusing to write empty fence.\n');
    return 1;
  }

  const language = parsed.language ?? detectLanguageFromCommand(parsed.command);
  const redactedStdout = maybeRedact(result.stdout, parsed.redact);
  const redactedCommand = maybeRedact(quoteCommand(parsed.command), parsed.redact);
  const redactionSummary = combineRedactionSummaries(
    parsed.redact,
    redactedStdout.summary,
    redactedCommand.summary,
  );
  const block = buildMarkdownBlock({
    note: parsed.note,
    commandLine: redactedCommand.text,
    stdout: redactedStdout.text,
    truncated: result.truncated,
    bytesElided: result.bytesElided,
    language,
  });

  const auditing = auditEnabled();
  const expectedDocPath = auditing
    ? await safeResolveKbPath(parsed.kb!, parsed.append!)
    : null;
  const beforeHash = expectedDocPath !== null
    ? await sha256OfFileOrNull(expectedDocPath)
    : null;

  let relativePath = '';
  let writePerformed = false;
  let writeError: Error | undefined;
  try {
    relativePath = await appendToNote(parsed.kb!, parsed.append!, block);
    writePerformed = true;
  } catch (err) {
    writeError = err as Error;
  }

  let refreshStatus: RefreshStatus = parsed.refresh ? 'skipped' : null;
  let refreshError: Error | undefined;
  if (writePerformed && parsed.refresh) {
    try {
      await refreshKnowledgeBase(parsed.kb!);
      refreshStatus = 'ok';
    } catch (err) {
      refreshStatus = 'failed';
      refreshError = err as Error;
    }
  }

  if (auditing) {
    const afterHash = expectedDocPath !== null
      ? await sha256OfFileOrNull(expectedDocPath)
      : null;
    await recordMutation({
      surface: 'cli.kb-capture',
      operation: 'capture',
      kb: parsed.kb!,
      relative_path: writePerformed ? relativePath : parsed.append!,
      before_sha256: beforeHash,
      after_sha256: afterHash,
      write_performed: writePerformed,
      refresh_requested: parsed.refresh,
      refresh_status: refreshStatus,
      decision_flags: {
        truncated: result.truncated,
        bytes_elided: result.bytesElided,
        exit_code: result.exitCode,
        allow_fail: parsed.allowFail,
        redaction_enabled: redactionSummary.enabled,
        redactions_total: redactionSummary.total,
        redactions_by_type: redactionSummary.by_type,
      },
      error: (writeError ?? refreshError)?.message,
    });
  }

  if (writeError !== undefined) {
    process.stderr.write(`kb capture: ${writeError.message}\n`);
    return 1;
  }
  if (refreshError !== undefined) {
    if (refreshError instanceof ActiveModelResolutionError) {
      process.stderr.write(`kb capture: ${refreshError.message}\n`);
      return 2;
    }
    process.stderr.write(`kb capture: refresh failed after write: ${refreshError.message}\n`);
    return 1;
  }

  process.stdout.write(`${JSON.stringify({
    knowledge_base_name: parsed.kb,
    path: relativePath,
    action: 'capture',
    truncated: result.truncated,
    bytes_elided: result.bytesElided,
    exit_code: result.exitCode,
    refreshed: parsed.refresh,
    redaction_summary: redactionSummary,
  }, null, 2)}\n`);
  return 0;
}

async function safeResolveKbPath(kbName: string, relativePath: string): Promise<string | null> {
  try {
    return await resolveKbPath(
      KNOWLEDGE_BASES_ROOT_DIR,
      kbName,
      relativePath,
      { mustExist: false },
    );
  } catch {
    return null;
  }
}

function parseCaptureArgs(rest: string[]): CaptureArgs {
  const out: CaptureArgs = {
    maxBytes: DEFAULT_MAX_BYTES,
    allowFail: false,
    redact: true,
    refresh: false,
    command: [],
  };
  let sawSeparator = false;
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    if (sawSeparator) {
      out.command.push(raw);
      continue;
    }
    if (raw === '--') { sawSeparator = true; continue; }
    if (raw === '--allow-fail') { out.allowFail = true; continue; }
    if (raw === '--no-redact') { out.redact = false; continue; }
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--append=')) { out.append = raw.slice('--append='.length); continue; }
    if (raw.startsWith('--note=')) { out.note = raw.slice('--note='.length); continue; }
    if (raw === '--note') {
      const next = rest[i + 1];
      if (next === undefined) throw new Error('--note requires a value');
      out.note = next;
      i++;
      continue;
    }
    if (raw.startsWith('--language=')) { out.language = raw.slice('--language='.length); continue; }
    if (raw.startsWith('--max-bytes=')) {
      const valueStr = raw.slice('--max-bytes='.length);
      const n = Number(valueStr);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`invalid --max-bytes: ${JSON.stringify(valueStr)}`);
      }
      out.maxBytes = n;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument before "--": ${JSON.stringify(raw)}`);
  }
  return out;
}

function validateCaptureArgs(args: CaptureArgs): void {
  if (args.kb === undefined || args.kb.trim() === '') {
    throw new Error('missing --kb=<name>');
  }
  if (args.append === undefined || args.append.trim() === '') {
    throw new Error('missing --append=<path>');
  }
  if (args.command.length === 0) {
    throw new Error('missing command after "--"');
  }
}

async function runCommand(command: string[], maxBytes: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command;
    const child = spawn(cmd, args, { shell: false, stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks: Buffer[] = [];
    let captured = 0;
    let totalBytes = 0;
    let truncated = false;
    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (truncated) return;
      const remaining = maxBytes - captured;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        captured += chunk.length;
      } else {
        if (remaining > 0) {
          const slice = chunk.subarray(0, remaining);
          chunks.push(slice);
          captured += slice.length;
        }
        truncated = true;
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf-8');
      resolve({
        stdout,
        truncated,
        bytesElided: truncated ? Math.max(0, totalBytes - captured) : 0,
        exitCode: code ?? 1,
      });
    });
  });
}

interface BlockOptions {
  note?: string;
  commandLine: string;
  stdout: string;
  truncated: boolean;
  bytesElided: number;
  language: string | null;
}

function buildMarkdownBlock(opts: BlockOptions): string {
  const fence = '`'.repeat(longestBacktickRun(opts.stdout) + 1);
  const lines: string[] = [];
  lines.push('');
  if (opts.note !== undefined && opts.note.length > 0) {
    lines.push(`### ${opts.note}`);
    lines.push('');
  }
  lines.push(`$ ${opts.commandLine}`);
  lines.push(opts.language !== null ? `${fence}${opts.language}` : fence);
  lines.push(stripTrailingNewline(opts.stdout));
  if (opts.truncated) {
    lines.push(`... (truncated, ${opts.bytesElided} bytes elided)`);
  }
  lines.push(fence);
  lines.push('');
  return lines.join('\n');
}

function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function longestBacktickRun(text: string): number {
  const matches = text.match(/`+/g);
  if (matches === null) return 2;
  let longest = 2;
  for (const run of matches) {
    if (run.length > longest) longest = run.length;
  }
  return longest;
}

function quoteCommand(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}

function shellQuote(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function detectLanguageFromCommand(argv: string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const match = argv[i].match(/\.([A-Za-z0-9]+)$/);
    if (match === null) continue;
    const ext = match[1].toLowerCase();
    if (ext in LANGUAGE_BY_EXT) return LANGUAGE_BY_EXT[ext];
  }
  return null;
}

async function appendToNote(kbName: string, relativePath: string, content: string): Promise<string> {
  assertNoTraversal(relativePath);
  const documentPath = await resolveKbPath(KNOWLEDGE_BASES_ROOT_DIR, kbName, relativePath, { mustExist: false });
  const kbDir = await resolveKnowledgeBaseDir(KNOWLEDGE_BASES_ROOT_DIR, kbName);
  await assertKbWritePolicyAllowsMutation(kbDir, documentPath);
  const stat = await fsp.stat(documentPath);
  if (!stat.isFile()) {
    throw new Error(`append target is not a file: ${JSON.stringify(relativePath)}`);
  }
  await appendFileAtomically(documentPath, content, { kbDir });
  return path.relative(kbDir, documentPath).split(path.sep).join('/');
}


async function refreshKnowledgeBase(kbName: string): Promise<void> {
  await FaissIndexManager.bootstrapLayout();
  const activeModelId = await resolveActiveModel();
  const manager = await loadManagerForModel(activeModelId);
  await withWriteLock(manager.modelDir, async () => {
    await manager.initialize();
    await manager.updateIndex(kbName);
  });
}
