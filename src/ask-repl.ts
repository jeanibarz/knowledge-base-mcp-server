// Interactive `kb ask -i` REPL (#649). A readline loop that reuses the existing
// answering core (src/ask-core.ts): the first question retrieves evidence, and
// follow-up turns reuse the cached evidence (re-retrieving only on `/refresh`,
// `/reset`, or a `/kb` switch). The REPL chrome — prompt, sources, notices — is
// written to stderr so the answer text on stdout stays pipe-clean, mirroring the
// `kb search -i` picker (src/cli-search-picker.ts). Honors NO_COLOR; the non-TTY
// fall-back to one-shot lives in the caller (src/cli-ask.ts).

import * as readline from 'readline';
import {
  answerWithEvidence,
  retrieveAskEvidence,
  type AskEvidence,
  type AskExecutionArgs,
  type AskKnowledgeResult,
  type RunAskCoreDeps,
} from './ask-core.js';
import { readLlmContextPolicy } from './sensitivity-policy.js';
import { nowMs } from './timing-core.js';

/** Default number of prior Q/A exchanges folded into follow-up context. */
export const DEFAULT_REPL_HISTORY_LIMIT = 6;
/** Per-answer character cap when an exchange is replayed as follow-up context. */
const HISTORY_ANSWER_CHAR_CAP = 600;

export const REPL_HELP = `Interactive ask — commands:
  <question>      Ask a question. The first question retrieves evidence;
                  follow-ups reuse it until you /refresh, /reset, or /kb.
  /sources        List the citations behind the most recent answer.
  /kb <name>      Scope retrieval to a knowledge base (refreshes evidence).
  /kb             Show the current knowledge-base scope.
  /refresh        Drop cached evidence; the next question re-retrieves (rescan).
  /save [title]   Save the last exchange as a transcript note (needs a KB).
  /reset          Clear cached evidence and conversation history.
  /help, /?       Show this help.
  /exit, /quit    Leave the interactive session.`;

export type ReplCommand =
  | { type: 'question'; text: string }
  | { type: 'sources' }
  | { type: 'kb'; name: string | null }
  | { type: 'save'; title?: string }
  | { type: 'reset' }
  | { type: 'refresh' }
  | { type: 'help' }
  | { type: 'exit' }
  | { type: 'empty' }
  | { type: 'unknown'; command: string };

export interface ReplHistoryTurn {
  question: string;
  answer: string;
  /** Absolute source paths used to ground this answer, if any. */
  sourcePaths?: string[];
}

export interface AskReplSession {
  kb: string | undefined;
  /** Cached retrieval evidence reused across follow-ups (null forces a retrieve). */
  evidence: AskEvidence | null;
  /** When true, the next retrieval rescans KB files (set by /refresh). */
  forceRescan: boolean;
  lastResult: AskKnowledgeResult | null;
  lastQuestion: string | null;
  history: ReplHistoryTurn[];
}

export interface SaveTranscriptInput {
  result: AskKnowledgeResult;
  question: string;
  kb: string;
  title?: string;
}

export interface SaveTranscriptResult {
  kb: string;
  path: string;
}

export interface RunAskReplOptions {
  /** Retrieval/answer parameters shared by every turn (question is per-turn). */
  baseArgs: AskExecutionArgs;
  coreDeps: RunAskCoreDeps;
  input?: NodeJS.ReadableStream;
  /** Answer text sink (defaults to stdout); kept clean for piping. */
  output?: NodeJS.WritableStream;
  /** REPL chrome sink — prompt, sources, notices (defaults to stderr). */
  errOutput?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  /** Optional initial question (e.g. `kb ask -i "first question"`). */
  seedQuestion?: string;
  /** Persists the last exchange for /save; omitted when saving is unavailable. */
  saveTranscript?: (input: SaveTranscriptInput) => Promise<SaveTranscriptResult>;
  historyLimit?: number;
  now?: () => number;
}

export function createReplSession(kb?: string): AskReplSession {
  return {
    kb: kb !== undefined && kb.trim() !== '' ? kb : undefined,
    evidence: null,
    forceRescan: false,
    lastResult: null,
    lastQuestion: null,
    history: [],
  };
}

export function parseReplLine(line: string): ReplCommand {
  const trimmed = line.trim();
  if (trimmed === '') return { type: 'empty' };
  if (!trimmed.startsWith('/')) return { type: 'question', text: trimmed };

  const body = trimmed.slice(1);
  const spaceIndex = body.search(/\s/);
  const command = (spaceIndex === -1 ? body : body.slice(0, spaceIndex)).toLowerCase();
  const arg = spaceIndex === -1 ? '' : body.slice(spaceIndex + 1).trim();

  switch (command) {
    case 'sources':
      return { type: 'sources' };
    case 'kb':
      return { type: 'kb', name: arg === '' ? null : arg };
    case 'save':
      return arg === '' ? { type: 'save' } : { type: 'save', title: arg };
    case 'reset':
      return { type: 'reset' };
    case 'refresh':
      return { type: 'refresh' };
    case 'help':
    case '?':
      return { type: 'help' };
    case 'exit':
    case 'quit':
    case 'q':
      return { type: 'exit' };
    default:
      return { type: 'unknown', command };
  }
}

export function replColorEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return true;
}

/** Render the citations behind a result as a stderr-friendly block. */
export function formatSourcesBlock(result: AskKnowledgeResult): string {
  if (result.citations.length === 0) {
    return 'Sources: none (the answer cited no retrieved chunks).\n';
  }
  const lines = ['Sources:'];
  for (const c of result.citations) {
    const kb = c.knowledge_base ? `${c.knowledge_base}:` : '';
    const score = typeof c.score === 'number' ? ` (score ${c.score.toFixed(2)})` : '';
    const chunk = c.chunk_id ? ` - chunk ${c.chunk_id}` : '';
    lines.push(`  - ${kb}${c.path}${score}${chunk}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Fold recent exchanges into a compact, bounded task-context block so follow-up
 * turns carry conversational memory without re-retrieving. Only passed to the
 * answer phase (never the retrieval phase), so it never perturbs the relevance
 * gate.
 */
export function buildHistoryContext(history: ReplHistoryTurn[], limit: number): string {
  if (history.length === 0) return '';
  const recent = history.slice(-limit);
  const lines = ['Earlier conversation in this session (most recent last):'];
  for (const turn of recent) {
    lines.push(`Q: ${turn.question}`);
    lines.push(`A: ${truncate(turn.answer, HISTORY_ANSWER_CHAR_CAP)}`);
  }
  return lines.join('\n');
}

function truncate(value: string, cap: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > cap ? `${compact.slice(0, cap - 1)}…` : compact;
}

/** Drop prior answers whose grounding source is no longer LLM-eligible. */
async function filterHistoryByCurrentPolicy(history: ReplHistoryTurn[]): Promise<void> {
  const retained: ReplHistoryTurn[] = [];
  for (const turn of history) {
    // In-memory history without provenance cannot be proven safe after a
    // policy change, so fail closed and omit the answer from the next prompt.
    if (turn.sourcePaths === undefined) continue;
    const eligible = await Promise.all(turn.sourcePaths.map(async (source) => {
      const snapshot = await readLlmContextPolicy(source);
      return snapshot.readable && snapshot.valid && snapshot.policy?.no_llm_context !== true;
    }));
    if (eligible.every(Boolean)) retained.push(turn);
  }
  history.splice(0, history.length, ...retained);
}

export async function runAskRepl(opts: RunAskReplOptions): Promise<number> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const errOutput = opts.errOutput ?? process.stderr;
  const env = opts.env ?? process.env;
  const color = replColorEnabled(env);
  const historyLimit = opts.historyLimit ?? DEFAULT_REPL_HISTORY_LIMIT;
  const now = opts.now ?? nowMs;

  const session = createReplSession(opts.baseArgs.kb);
  const promptText = color ? '\x1b[1mkb›\x1b[0m ' : 'kb> ';
  const promptOut = (): void => { errOutput.write(promptText); };

  errOutput.write('Interactive ask — type a question, /help for commands, /exit to quit.\n');
  if (session.kb !== undefined) errOutput.write(`Knowledge base: ${session.kb}\n`);

  const buildTurnArgs = (question: string, refresh: boolean, withHistory: boolean): AskExecutionArgs => {
    const taskContext = withHistory ? buildHistoryContext(session.history, historyLimit) : '';
    return {
      ...opts.baseArgs,
      ...(session.kb !== undefined ? { kb: session.kb } : { kb: undefined }),
      question,
      refresh,
      timing: false,
      ...(taskContext !== '' ? { taskContext } : {}),
    };
  };

  const handleQuestion = async (text: string): Promise<void> => {
    try {
      if (session.evidence === null) {
        const retrievalArgs = buildTurnArgs(text, session.forceRescan, false);
        session.evidence = await retrieveAskEvidence(retrievalArgs, opts.coreDeps);
        session.forceRescan = false;
      }
      await filterHistoryByCurrentPolicy(session.history);
      let streamed = false;
      const answerArgs: AskExecutionArgs = {
        ...buildTurnArgs(text, false, true),
        onAnswerToken: (token: string) => {
          streamed = true;
          output.write(token);
        },
      };
      const result = await answerWithEvidence(answerArgs, session.evidence, opts.coreDeps, now());
      if (!streamed) output.write(result.answer);
      output.write('\n');

      session.lastResult = result;
      session.lastQuestion = text;
      session.history.push({
        question: text,
        answer: result.answer,
        sourcePaths: session.evidence?.llmContextSourcePaths ?? [],
      });
      if (session.history.length > historyLimit) {
        session.history.splice(0, session.history.length - historyLimit);
      }
      errOutput.write(formatSourcesBlock(result));
    } catch (err) {
      // A failed turn (LLM down, retrieval error) must not kill the session. A
      // retrieval failure leaves evidence null so the next question retries; an
      // answer failure keeps the cached evidence for reuse.
      errOutput.write(`ask failed: ${(err as Error).message}\n`);
    }
  };

  const handleSave = async (title: string | undefined): Promise<void> => {
    if (session.lastResult === null || session.lastQuestion === null) {
      errOutput.write('Nothing to save yet — ask a question first.\n');
      return;
    }
    if (opts.saveTranscript === undefined) {
      errOutput.write('Saving transcripts is not available in this session.\n');
      return;
    }
    if (session.kb === undefined) {
      errOutput.write('/save needs a knowledge base — start with --kb=<name> or use /kb <name>.\n');
      return;
    }
    try {
      const saved = await opts.saveTranscript({
        result: session.lastResult,
        question: session.lastQuestion,
        kb: session.kb,
        ...(title !== undefined ? { title } : {}),
      });
      errOutput.write(`Saved transcript: ${saved.kb}:${saved.path}\n`);
    } catch (err) {
      errOutput.write(`save failed: ${(err as Error).message}\n`);
    }
  };

  const handle = async (command: ReplCommand): Promise<void> => {
    switch (command.type) {
      case 'question':
        await handleQuestion(command.text);
        return;
      case 'sources':
        if (session.lastResult === null) errOutput.write('No sources yet — ask a question first.\n');
        else errOutput.write(formatSourcesBlock(session.lastResult));
        return;
      case 'kb':
        if (command.name === null) {
          errOutput.write(`Knowledge base: ${session.kb ?? 'all (unscoped)'}\n`);
        } else {
          session.kb = command.name;
          session.evidence = null;
          errOutput.write(`Switched to knowledge base: ${command.name} (evidence refreshes on next question).\n`);
        }
        return;
      case 'refresh':
        session.evidence = null;
        session.forceRescan = true;
        errOutput.write('Evidence cleared; the next question re-retrieves (with a KB rescan).\n');
        return;
      case 'reset':
        session.evidence = null;
        session.forceRescan = false;
        session.lastResult = null;
        session.lastQuestion = null;
        session.history = [];
        errOutput.write('Session reset.\n');
        return;
      case 'save':
        await handleSave(command.title);
        return;
      case 'help':
        errOutput.write(`${REPL_HELP}\n`);
        return;
      case 'unknown':
        errOutput.write(`Unknown command: /${command.command} — type /help for commands.\n`);
        return;
      case 'empty':
      case 'exit':
        return;
    }
  };

  return new Promise<number>((resolve) => {
    const rl = readline.createInterface({ input, terminal: false });
    let queue: Promise<void> = Promise.resolve();
    let closed = false;

    const enqueue = (fn: () => Promise<void>): void => {
      queue = queue.then(fn).catch((err) => {
        errOutput.write(`repl error: ${(err as Error).message}\n`);
      });
    };

    if (opts.seedQuestion !== undefined && opts.seedQuestion.trim() !== '') {
      enqueue(async () => {
        await handle({ type: 'question', text: opts.seedQuestion!.trim() });
        if (!closed) promptOut();
      });
    } else {
      promptOut();
    }

    rl.on('line', (line) => {
      const command = parseReplLine(line);
      if (command.type === 'exit') {
        closed = true;
        rl.close();
        return;
      }
      enqueue(async () => {
        await handle(command);
        if (!closed) promptOut();
      });
    });

    rl.on('close', () => {
      closed = true;
      queue.then(() => resolve(0)).catch(() => resolve(0));
    });
  });
}
