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
  formatKbSearchFailureJson,
  formatKbSearchFailureStderr,
} from './search-errors-core.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
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
  type AskKnowledgeResult,
  type AskLlmPayload,
  type AskRetrievalPayload,
  type RunAskCoreDeps,
} from './ask-core.js';

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
  --k=<int>             Retrieval top-K (default 8).
  --context-budget-tokens=<int>
                        Approximate token budget for snippets sent to the LLM
                        (default 6000).
  --refresh             Re-scan KB files before retrieval.
  --endpoint=<url>      OpenAI-compatible chat endpoint for this call only.
  --llm-profile=<name>  Use a saved \`kb llm\` profile.
  --format=md|json      Output format (default: md).
  --timing              Include elapsed milliseconds for retrieval and LLM stages.
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
  timing: boolean;
  saveTranscript: boolean;
  title?: string;
  yes: boolean;
  taskContext?: string;
  gate?: RelevanceGateOverride;
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
};

export async function runAsk(rest: string[], deps: RunAskDeps = defaultRunAskDeps): Promise<number> {
  const totalStartedAt = nowMs();
  let args: AskArgs;
  try {
    args = parseAskArgs(rest);
  } catch (err) {
    process.stderr.write(`kb ask: ${(err as Error).message}\n`);
    return 2;
  }
  if (args.stdin && args.question === null) {
    args.question = await readAllStdin();
  }
  if (args.question === null || args.question.trim() === '') {
    process.stderr.write('kb ask: missing <question> (or use --stdin)\n');
    return 2;
  }

  let result: AskKnowledgeResult;
  try {
    result = await executeAsk({ ...args, question: args.question }, toRunAskCoreDeps(deps), totalStartedAt);
  } catch (err) {
    if (err instanceof AskExecutionError) {
      if (err.failure !== undefined) {
        if (args.format === 'json') process.stdout.write(formatKbSearchFailureJson(err.failure));
        else process.stderr.write(formatKbSearchFailureStderr(err.failure));
        return err.exitCode;
      }
      return reportAskError(args.format, `kb ask: ${err.message}`, err.exitCode);
    }
    return reportAskError(args.format, `kb ask: ${(err as Error).message}`, 1);
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
      return reportAskError(args.format, `kb ask: ${writeError.message}`, 1);
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
    process.stdout.write(`${result.answer}\n\n`);
    if (result.citations.length > 0) {
      process.stdout.write('## Sources\n\n');
      for (const c of result.citations) {
        const kb = c.knowledge_base ? `${c.knowledge_base}:` : '';
        const score = typeof c.score === 'number' ? ` (score ${c.score.toFixed(2)})` : '';
        const chunk = c.chunk_id ? ` - chunk ${c.chunk_id}` : '';
        process.stdout.write(`- ${kb}${c.path}${score}${chunk}\n`);
      }
    }
    process.stdout.write(`\n> _LLM: ${result.llm.profile} (${result.llm.mode}) at ${result.llm.endpoint}; retrieval model: ${result.retrieval.embedding_model}._\n`);
    const totalChunks = result.context_packing.included_chunks + result.context_packing.excluded_chunks;
    process.stdout.write(`> _Context: ${result.context_packing.included_chunks}/${totalChunks} chunks, approx ${result.context_packing.estimated_tokens}/${result.context_packing.budget_tokens} tokens`);
    if (result.context_packing.truncated_chunks > 0) {
      process.stdout.write(`, ${result.context_packing.truncated_chunks} truncated`);
    }
    process.stdout.write('._\n');
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

export function parseAskArgs(rest: string[]): AskArgs {
  const out: AskArgs = {
    question: null,
    k: 8,
    contextBudgetTokens: DEFAULT_ASK_CONTEXT_BUDGET_TOKENS,
    refresh: false,
    stdin: false,
    format: 'md',
    timing: false,
    saveTranscript: false,
    yes: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw === '--stdin') { out.stdin = true; continue; }
    if (raw === '--timing') { out.timing = true; continue; }
    if (raw === '--save-transcript') { out.saveTranscript = true; continue; }
    if (raw === '--yes') { out.yes = true; continue; }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--model=')) { out.model = raw.slice('--model='.length); continue; }
    if (raw.startsWith('--llm-profile=')) { out.llmProfile = raw.slice('--llm-profile='.length); continue; }
    if (raw.startsWith('--endpoint=')) { out.endpoint = raw.slice('--endpoint='.length); continue; }
    if (raw.startsWith('--title=')) { out.title = raw.slice('--title='.length); continue; }
    if (raw === '--title') {
      const next = rest[i + 1];
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

function reportAskError(format: 'md' | 'json', message: string, code: number): number {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  return code;
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
