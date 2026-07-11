import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { FaissIndexManager } from './FaissIndexManager.js';
import { resolveActiveModel } from './active-model.js';
import {
  auditEnabled,
  recordMutation,
  sha256OfFileOrNull,
  type RefreshStatus,
} from './audit-log.js';
import {
  classifyKbAskError,
  exitCodeForFailure,
  formatKbAskFailureJson,
  formatKbAskFailureStderr,
} from './search-errors-core.js';
import { extractVerbosity, loadManagerForModel, loadWithJsonRetry, type Verbosity } from './cli-shared.js';
import {
  formatTimingFooter,
  nowMs,
  type TimingPayload,
} from './timing-core.js';
import { callChatCompletion } from './llm-client.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { resolveKbPath, resolveKnowledgeBaseDir } from './kb-fs.js';
import { slugifyTitle } from './slug.js';
import { withWriteLock } from './write-lock.js';
import {
  type RelevanceGateOverride,
} from './relevance-gate.js';
import {
  AskExecutionError,
  DEFAULT_ASK_CONTEXT_BUDGET_TOKENS,
  MIN_ASK_CONTEXT_BUDGET_TOKENS,
  askKnowledge,
  executeAsk,
  packAskContext,
  type AskCitation,
  type AskExecutionArgs,
  type AskKnowledgeResult,
  type AskLlmPayload,
  type AskRetrievalPayload,
  type RunAskCoreDeps,
  type RerankOverride,
  type SearchMode,
} from './ask-core.js';
import {
  runAskRepl,
  type SaveTranscriptInput,
  type SaveTranscriptResult,
} from './ask-repl.js';
import { createTtyProgress } from './tty-progress.js';

export {
  DEFAULT_ASK_CONTEXT_BUDGET_TOKENS,
  askKnowledge,
  packAskContext,
};

export const ASK_HELP = `kb ask — answer a question from retrieved KB context using a local LLM

Usage:
  kb ask <question> [options]
  kb ask --stdin [options]

Retrieves top-K chunks with the existing embedding index, then calls a local
OpenAI-compatible chat-completions endpoint. The endpoint is resolved from
\`--endpoint\`, \`KB_LLM_ENDPOINT\`, \`--llm-profile\`, the active \`kb llm\`
profile, or the local-research-agent default at 127.0.0.1:8080.

Options:
  --kb=<name>           Scope retrieval to one knowledge base.
  --model=<id>          Override the active embedding model for retrieval.
  --mode=dense|hybrid|lexical|auto
                        Retrieval mode for the snippets fed to the LLM
                        (default: auto). auto keeps dense for prose and
                        upgrades code/error-token queries to hybrid; hybrid
                        fuses dense + BM25 via RRF; lexical is BM25-only.
  --rerank              Run the RFC 019 cross-encoder reranker for this call
                        (hybrid retrieval only). Off by default.
  --no-rerank           Bypass the reranker for this call.
  --gate                Run the relevance gate for this call even when
                        KB_RELEVANCE_GATE is off.
  --no-gate             Bypass the relevance gate for this call.
  --k=<int>             Retrieval top-K (default 8).
  --context-budget-tokens=<int>
                        Approximate token budget for snippets sent to the LLM
                        (default 6000).
  --refresh             Re-scan KB files before retrieval.
  --endpoint=<url>      OpenAI-compatible chat endpoint for this call only.
  --llm-profile=<name>  Use a saved \`kb llm\` profile.
  --format=md|json      Output format (default: md).
  --interactive, -i     Start a multi-turn REPL: the first question retrieves
                        evidence and follow-ups reuse it (/refresh to re-retrieve).
                        Requires a TTY; otherwise falls back to one-shot. In-session
                        commands: /sources, /kb <name>, /save, /refresh, /reset, /exit.
  --no-stream           Wait for the full answer before printing markdown output.
  --timing              Include elapsed milliseconds for retrieval and LLM stages.
  --quiet, -q           Suppress the thinking spinner and the LLM/context
                        footers, leaving only the answer and sources.
  --verbose, -v         Surface extra diagnostics (equivalent to --timing).
  --stdin               Read question from stdin.
  --save-transcript     Save the question, answer, citations, and provenance
                        as a new markdown note. Requires --kb and --yes.
  --title=<title>       Transcript note title (default: derived from question).
  --yes                 Confirm transcript write when --save-transcript is set.
  --help, -h            Show this help.
`;

export interface AskArgs {
  question: string | null;
  kb?: string;
  model?: string;
  llmProfile?: string;
  endpoint?: string;
  k: number;
  contextBudgetTokens: number;
  refresh: boolean;
  stdin: boolean;
  format: 'md' | 'json';
  interactive: boolean;
  noStream: boolean;
  timing: boolean;
  verbosity: Verbosity;
  saveTranscript: boolean;
  title?: string;
  yes: boolean;
  taskContext?: string;
  gate?: RelevanceGateOverride;
  mode?: SearchMode;
  rerank?: RerankOverride;
}

interface AskTranscriptRecord {
  title: string;
  createdAt: string;
  question: string;
  answer: string;
  citations: AskCitation[];
  llm: AskLlmPayload;
  retrieval: AskRetrievalPayload;
  timing?: Record<string, unknown>;
}

interface SavedTranscriptInfo {
  saved: true;
  knowledge_base: string;
  path: string;
  title: string;
}

export interface RunAskDeps extends Omit<RunAskCoreDeps, 'loadReadOnlyIndex'> {
  loadWithJsonRetry: typeof loadWithJsonRetry;
  createTranscriptNote: typeof createAskTranscriptNote;
  knowledgeBasesRootDir: string;
  /** Interactive REPL runner (injectable for tests; defaults to {@link runAskRepl}). */
  runRepl?: typeof runAskRepl;
  /** Whether stdin is a TTY — gates the REPL vs. the one-shot fall-back. */
  stdinIsTty?: () => boolean;
}

const defaultRunAskDeps: RunAskDeps = {
  bootstrapLayout: FaissIndexManager.bootstrapLayout.bind(FaissIndexManager),
  resolveActiveModel,
  loadManagerForModel,
  loadWithJsonRetry,
  withWriteLock,
  callChatCompletion,
  createTranscriptNote: createAskTranscriptNote,
  knowledgeBasesRootDir: KNOWLEDGE_BASES_ROOT_DIR,
  runRepl: runAskRepl,
  stdinIsTty: () => Boolean(process.stdin.isTTY),
};

export async function runAsk(rest: string[], deps: RunAskDeps = defaultRunAskDeps): Promise<number> {
  const totalStartedAt = nowMs();
  let args: AskArgs;
  try {
    args = parseAskArgs(rest);
  } catch (err) {
    const failure = classifyKbAskError(err, 'argument');
    return reportAskFailure(requestedAskFormat(rest), failure);
  }
  if (args.stdin && args.question === null) {
    args.question = await readAllStdin();
  }
  // Issue #739 — --verbose surfaces the same per-stage timing as --timing.
  if (args.verbosity === 'verbose') args.timing = true;

  if (args.interactive) {
    const stdinIsTty = deps.stdinIsTty ?? (() => Boolean(process.stdin.isTTY));
    if (stdinIsTty()) {
      const runRepl = deps.runRepl ?? runAskRepl;
      const seedQuestion = args.question !== null && args.question.trim() !== ''
        ? args.question.trim()
        : undefined;
      return runRepl({
        baseArgs: toAskBaseArgs(args),
        coreDeps: toRunAskCoreDeps(deps),
        env: process.env,
        ...(seedQuestion !== undefined ? { seedQuestion } : {}),
        saveTranscript: (input) => persistAskTranscript(deps, input),
      });
    }
    // Non-TTY (piped/redirected) input cannot drive a REPL — fall back to a
    // single one-shot answer over the supplied question (#649).
    process.stderr.write('kb ask: interactive mode requires a TTY; falling back to one-shot.\n');
  }

  if (args.question === null || args.question.trim() === '') {
    const failure = classifyKbAskError(new Error('missing <question> (or use --stdin)'), 'argument');
    return reportAskFailure(args.format, failure);
  }

  let result: AskKnowledgeResult;
  let streamedAnswer = false;
  // #759 — retrieval + LLM latency can leave the terminal silent for many
  // seconds. Show a stderr spinner while we wait; it self-suppresses for
  // JSON / piped / NO_COLOR output and is cleared before any answer prints.
  const progress = createTtyProgress({ label: 'kb ask: thinking', format: args.format });
  // --quiet suppresses the spinner along with the other non-essential chatter.
  if (args.verbosity !== 'quiet') progress.start();
  try {
    const streamMarkdown = args.format === 'md' && !args.noStream;
    result = await executeAsk({
      ...args,
      question: args.question,
      ...(args.mode !== undefined ? { searchMode: args.mode } : {}),
      ...(streamMarkdown
        ? {
            onAnswerToken: (token: string) => {
              // Clear the spinner before the first streamed token so stdout
              // never interleaves with the stderr spinner line.
              progress.stop();
              streamedAnswer = true;
              process.stdout.write(token);
            },
          }
        : {}),
    }, toRunAskCoreDeps(deps), totalStartedAt);
    progress.stop();
  } catch (err) {
    progress.stop();
    if (err instanceof AskExecutionError) {
      if (err.failure !== undefined) {
        return reportAskFailure(args.format, err.failure, err.exitCode);
      }
      const failure = classifyKbAskError(err, 'runtime');
      return reportAskFailure(args.format, failure, err.exitCode);
    }
    const failure = classifyKbAskError(err, 'runtime');
    return reportAskFailure(args.format, failure);
  }

  let savedTranscript: SavedTranscriptInfo | null = null;
  if (args.saveTranscript) {
    const title = args.title ?? defaultAskTranscriptTitle(args.question);
    const content = buildAskTranscriptMarkdown({
      title,
      createdAt: new Date().toISOString(),
      question: args.question,
      answer: result.answer,
      citations: result.citations,
      llm: result.llm,
      retrieval: result.retrieval,
      ...(result.timing ? { timing: result.timing } : {}),
    });
    const auditing = auditEnabled();
    let relativePath = '';
    let writePerformed = false;
    let writeError: Error | undefined;
    try {
      relativePath = await deps.createTranscriptNote(
        deps.knowledgeBasesRootDir,
        args.kb!,
        title,
        content,
      );
      writePerformed = true;
    } catch (err) {
      writeError = err as Error;
    }
    const refreshStatus: RefreshStatus = null;
    if (auditing) {
      const afterDocPath = writePerformed
        ? await safeResolveKbPath(deps.knowledgeBasesRootDir, args.kb!, relativePath)
        : null;
      const afterHash = afterDocPath !== null
        ? await sha256OfFileOrNull(afterDocPath)
        : null;
      await recordMutation({
        surface: 'cli.kb-ask',
        operation: 'ask-transcript',
        kb: args.kb!,
        relative_path: writePerformed ? relativePath : null,
        before_sha256: null,
        after_sha256: afterHash,
        write_performed: writePerformed,
        refresh_requested: false,
        refresh_status: refreshStatus,
        decision_flags: {
          citation_count: result.citations.length,
          llm_profile: result.llm.profile,
          llm_mode: result.llm.mode,
          llm_source: result.llm.source,
          retrieval_model: result.retrieval.embedding_model,
          k: args.k,
        },
        error: writeError?.message,
      });
    }
    if (writeError !== undefined) {
      const failure = classifyKbAskError(writeError, 'transcript');
      return reportAskFailure(args.format, failure);
    }
    savedTranscript = {
      saved: true,
      knowledge_base: args.kb!,
      path: relativePath,
      title,
    };
  }

  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify({
      ...result,
      ...(savedTranscript ? { transcript: savedTranscript } : {}),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(streamedAnswer ? '\n\n' : `${result.answer}\n\n`);
    if (result.citations.length > 0) {
      process.stdout.write('## Sources\n\n');
      for (const c of result.citations) {
        const kb = c.knowledge_base ? `${c.knowledge_base}:` : '';
        const score = typeof c.score === 'number' ? ` (score ${c.score.toFixed(2)})` : '';
        const chunk = c.chunk_id ? ` - chunk ${c.chunk_id}` : '';
        process.stdout.write(`- ${kb}${c.path}${score}${chunk}\n`);
      }
    }
    // Issue #739 — the LLM/context provenance footers are non-essential
    // metadata; --quiet drops them so the answer + sources are all that print.
    if (args.verbosity !== 'quiet') {
      process.stdout.write(`\n> _LLM: ${result.llm.profile} (${result.llm.mode}) at ${result.llm.endpoint}; retrieval model: ${result.retrieval.embedding_model}._\n`);
      const totalChunks = result.context_packing.included_chunks + result.context_packing.excluded_chunks;
      process.stdout.write(`> _Context: ${result.context_packing.included_chunks}/${totalChunks} chunks, approx ${result.context_packing.estimated_tokens}/${result.context_packing.budget_tokens} tokens`);
      if (result.context_packing.truncated_chunks > 0) {
        process.stdout.write(`, ${result.context_packing.truncated_chunks} truncated`);
      }
      process.stdout.write('._\n');
    }
    if (savedTranscript) {
      process.stdout.write(`> _Transcript saved: ${savedTranscript.knowledge_base}:${savedTranscript.path}._\n`);
    }
    if (result.timing) {
      process.stdout.write(formatTimingFooter('Timing', result.timing as TimingPayload));
      process.stdout.write('\n');
    }
  }
  return 0;
}

function toRunAskCoreDeps(deps: RunAskDeps): RunAskCoreDeps {
  return {
    bootstrapLayout: deps.bootstrapLayout,
    resolveActiveModel: deps.resolveActiveModel,
    loadManagerForModel: deps.loadManagerForModel,
    loadReadOnlyIndex: deps.loadWithJsonRetry,
    withWriteLock: deps.withWriteLock,
    callChatCompletion: deps.callChatCompletion,
  };
}

/** Project parsed CLI args onto the per-turn retrieval/answer shape the REPL drives. */
function toAskBaseArgs(args: AskArgs): AskExecutionArgs {
  return {
    question: '',
    ...(args.kb !== undefined ? { kb: args.kb } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.llmProfile !== undefined ? { llmProfile: args.llmProfile } : {}),
    ...(args.endpoint !== undefined ? { endpoint: args.endpoint } : {}),
    k: args.k,
    contextBudgetTokens: args.contextBudgetTokens,
    refresh: args.refresh,
    timing: false,
    ...(args.taskContext !== undefined ? { taskContext: args.taskContext } : {}),
    ...(args.gate !== undefined ? { gate: args.gate } : {}),
    ...(args.mode !== undefined ? { searchMode: args.mode } : {}),
    ...(args.rerank !== undefined ? { rerank: args.rerank } : {}),
  };
}

/**
 * Persist a REPL exchange as a transcript note, reusing the one-shot transcript
 * markdown + atomic-write plumbing so interactive and one-shot saves never
 * diverge. (#649)
 */
async function persistAskTranscript(
  deps: RunAskDeps,
  input: SaveTranscriptInput,
): Promise<SaveTranscriptResult> {
  const title = input.title ?? defaultAskTranscriptTitle(input.question);
  const content = buildAskTranscriptMarkdown({
    title,
    createdAt: new Date().toISOString(),
    question: input.question,
    answer: input.result.answer,
    citations: input.result.citations,
    llm: input.result.llm,
    retrieval: input.result.retrieval,
    ...(input.result.timing ? { timing: input.result.timing } : {}),
  });
  const path = await deps.createTranscriptNote(
    deps.knowledgeBasesRootDir,
    input.kb,
    title,
    content,
  );
  return { kb: input.kb, path };
}

export function parseAskArgs(rest: string[]): AskArgs {
  // Issue #739 — resolve the shared --quiet/--verbose flags before parsing the
  // command-specific flags from what remains.
  const { verbosity, rest: args } = extractVerbosity(rest);
  const out: AskArgs = {
    question: null,
    k: 8,
    contextBudgetTokens: DEFAULT_ASK_CONTEXT_BUDGET_TOKENS,
    refresh: false,
    stdin: false,
    format: 'md',
    interactive: false,
    noStream: false,
    timing: false,
    verbosity,
    saveTranscript: false,
    yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw === '--stdin') { out.stdin = true; continue; }
    if (raw === '--interactive' || raw === '-i') { out.interactive = true; continue; }
    if (raw === '--no-stream') { out.noStream = true; continue; }
    if (raw === '--timing') { out.timing = true; continue; }
    if (raw === '--save-transcript') { out.saveTranscript = true; continue; }
    if (raw === '--yes') { out.yes = true; continue; }
    if (raw === '--rerank') { out.rerank = 'on'; continue; }
    if (raw === '--no-rerank') { out.rerank = 'off'; continue; }
    if (raw === '--gate') { out.gate = 'on'; continue; }
    if (raw === '--no-gate') { out.gate = 'off'; continue; }
    if (raw.startsWith('--mode=')) {
      const v = raw.slice('--mode='.length);
      if (v !== 'dense' && v !== 'hybrid' && v !== 'lexical' && v !== 'auto') {
        throw new Error(`invalid --mode: ${raw} (expected 'dense', 'hybrid', 'lexical', or 'auto')`);
      }
      out.mode = v; continue;
    }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--model=')) { out.model = raw.slice('--model='.length); continue; }
    if (raw.startsWith('--llm-profile=')) { out.llmProfile = raw.slice('--llm-profile='.length); continue; }
    if (raw.startsWith('--endpoint=')) { out.endpoint = raw.slice('--endpoint='.length); continue; }
    if (raw.startsWith('--title=')) { out.title = raw.slice('--title='.length); continue; }
    if (raw === '--title') {
      const next = args[i + 1];
      if (next === undefined) throw new Error('--title requires a value');
      out.title = next;
      i++;
      continue;
    }
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = n; continue;
    }
    if (raw.startsWith('--context-budget-tokens=')) {
      const n = Number(raw.slice('--context-budget-tokens='.length));
      if (!Number.isInteger(n) || n < MIN_ASK_CONTEXT_BUDGET_TOKENS) {
        throw new Error(`invalid --context-budget-tokens: ${raw}`);
      }
      out.contextBudgetTokens = n;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v !== 'md' && v !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = v; continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    if (out.question === null) { out.question = raw; continue; }
    throw new Error(`unexpected argument: ${raw}`);
  }
  if (out.saveTranscript) {
    if (!out.yes) throw new Error('--save-transcript requires --yes');
    if (out.kb === undefined || out.kb.trim() === '') {
      throw new Error('--save-transcript requires --kb=<name>');
    }
    if (out.title !== undefined && out.title.trim() === '') {
      throw new Error('--title must not be empty');
    }
  } else if (out.title !== undefined) {
    throw new Error('--title requires --save-transcript');
  }
  return out;
}

export function buildAskTranscriptMarkdown(record: AskTranscriptRecord): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('type: kb_ask_transcript');
  lines.push(`created_at: ${yamlString(record.createdAt)}`);
  lines.push(`question_sha256: ${yamlString(sha256(record.question))}`);
  if (record.retrieval.knowledge_base !== null) {
    lines.push(`knowledge_base: ${yamlString(record.retrieval.knowledge_base)}`);
  }
  lines.push(`retrieval_model: ${yamlString(record.retrieval.embedding_model)}`);
  lines.push(`llm_profile: ${yamlString(record.llm.profile)}`);
  lines.push(`llm_mode: ${yamlString(record.llm.mode)}`);
  if (record.llm.model !== null) {
    lines.push(`llm_model: ${yamlString(record.llm.model)}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(`# ${record.title}`);
  lines.push('');
  lines.push('## Question');
  lines.push('');
  lines.push(record.question.trim());
  lines.push('');
  lines.push('## Answer');
  lines.push('');
  lines.push(record.answer.trim());
  lines.push('');
  lines.push('## Citations');
  lines.push('');
  if (record.citations.length === 0) {
    lines.push('_No citations returned._');
  } else {
    record.citations.forEach((citation, index) => {
      const kbPrefix = citation.knowledge_base ? `${citation.knowledge_base}:` : '';
      const score = typeof citation.score === 'number' ? `, score ${citation.score.toFixed(4)}` : '';
      const chunkIds = citation.chunk_ids ?? (citation.chunk_id ? [citation.chunk_id] : []);
      const chunks = chunkIds.length > 0 ? `, chunks ${chunkIds.map((id) => `\`${id}\``).join(', ')}` : '';
      lines.push(`${index + 1}. \`${kbPrefix}${citation.path}\`${score}${chunks}`);
    });
  }
  lines.push('');
  lines.push('## Provenance');
  lines.push('');
  lines.push(`- asked at: \`${record.createdAt}\``);
  lines.push(`- LLM profile: \`${record.llm.profile}\``);
  lines.push(`- LLM mode: \`${record.llm.mode}\``);
  lines.push(`- LLM source: \`${record.llm.source}\``);
  lines.push(`- LLM endpoint: \`${record.llm.endpoint}\``);
  lines.push(`- LLM model: \`${record.llm.model ?? 'unknown'}\``);
  lines.push(`- retrieval model: \`${record.retrieval.embedding_model}\``);
  lines.push(`- retrieval knowledge base: \`${record.retrieval.knowledge_base ?? 'all'}\``);
  lines.push(`- retrieval k: \`${record.retrieval.k}\``);
  lines.push(`- context budget tokens: \`${record.retrieval.context_budget_tokens}\``);
  lines.push(`- refreshed before retrieval: \`${record.retrieval.refreshed}\``);
  if (record.timing !== undefined) {
    lines.push('');
    lines.push('## Timing');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(record.timing, null, 2));
    lines.push('```');
  }
  lines.push('');
  return `${lines.join('\n')}`;
}

export async function createAskTranscriptNote(
  rootDir: string,
  kbName: string,
  title: string,
  content: string,
): Promise<string> {
  const relativePath = `${slugifyTitle(title, { fallback: 'ask-transcript' })}.md`;
  const documentPath = await resolveKbPath(rootDir, kbName, relativePath, { mustExist: false });
  await fsp.mkdir(path.dirname(documentPath), { recursive: true });
  const tmpPath = `${documentPath}.kb-tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  try {
    const handle = await fsp.open(tmpPath, 'wx');
    try {
      await handle.writeFile(content, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.link(tmpPath, documentPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`refusing to overwrite existing transcript: ${relativePath}`);
    }
    throw err;
  } finally {
    await fsp.unlink(tmpPath).catch(() => {});
  }
  const kbDir = await resolveKnowledgeBaseDir(rootDir, kbName);
  return path.relative(kbDir, documentPath).split(path.sep).join('/');
}

async function safeResolveKbPath(
  rootDir: string,
  kbName: string,
  relativePath: string,
): Promise<string | null> {
  try {
    return await resolveKbPath(
      rootDir,
      kbName,
      relativePath,
      { mustExist: false },
    );
  } catch {
    return null;
  }
}

function defaultAskTranscriptTitle(question: string): string {
  const compact = question.replace(/\s+/g, ' ').trim();
  const suffix = compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
  return `Ask transcript - ${suffix}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function reportAskFailure(
  format: 'md' | 'json',
  failure: ReturnType<typeof classifyKbAskError>,
  code = exitCodeForFailure(failure),
): number {
  if (format === 'json') {
    process.stdout.write(formatKbAskFailureJson(failure));
  } else {
    process.stderr.write(formatKbAskFailureStderr(failure));
  }
  return code;
}

function requestedAskFormat(rest: string[]): 'md' | 'json' {
  return rest.includes('--format=json') ? 'json' : 'md';
}

async function readAllStdin(): Promise<string> {
  const chunks: string[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => chunks.push(String(chunk)));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}
