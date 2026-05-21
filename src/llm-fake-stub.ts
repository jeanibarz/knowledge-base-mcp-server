import * as fsp from 'fs/promises';
import { emitCanonicalLog } from './canonical-log.js';
import type {
  ChatCompletionOptions,
  ChatCompletionResult,
  LlmChatMessage,
} from './llm-client.js';

export const FAKE_LLM_ENDPOINT = 'mock://kb-llm-fake/v1/chat/completions';
const FAKE_LLM_MODEL = 'kb-fake-llm';

interface FakeResponseRule {
  contains?: string;
  system_contains?: string;
  user_contains?: string;
  content: string;
}

interface FakeAnswerRule {
  question_contains: string;
  answer: string;
}

interface FakePrefaceRule {
  chunk_contains: string;
  preface: string;
}

interface FakeJudgeRule {
  query_contains: string;
  overall?: 'relevant' | 'partial' | 'no-relevant-context';
  keep_contains?: string[];
  drop_contains?: string[];
}

export interface FakeLlmRules {
  responses?: FakeResponseRule[];
  answers?: FakeAnswerRule[];
  prefaces?: FakePrefaceRule[];
  judge?: FakeJudgeRule[];
  default_response?: string;
}

interface FakeOpenAiRequest {
  model?: unknown;
  messages?: unknown;
  temperature?: unknown;
}

interface ParsedCandidate {
  id: string;
  content: string;
}

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'answer',
  'chunk',
  'context',
  'does',
  'from',
  'have',
  'into',
  'only',
  'please',
  'query',
  'retrieved',
  'snippets',
  'that',
  'their',
  'there',
  'this',
  'with',
  'would',
]);

export function isFakeLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.KB_LLM_FAKE?.trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes';
}

export async function callFakeChatCompletion(
  options: ChatCompletionOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatCompletionResult> {
  const startedAt = Date.now();
  const rules = await loadFakeLlmRules(env);
  const content = generateFakeChatContent(options.messages, rules);
  const raw = fakeOpenAiChatCompletionResponse({
    model: options.model ?? FAKE_LLM_MODEL,
    messages: options.messages,
    temperature: options.temperature,
  }, rules);
  emitCanonicalLog({
    process: 'cli',
    event: 'llm.fake.chat',
    cmd: 'llm.fake.chat',
    model_id: FAKE_LLM_MODEL,
    llm_provider: 'fake',
    took_ms: Date.now() - startedAt,
  });
  return {
    content,
    model: FAKE_LLM_MODEL,
    raw,
  };
}

async function loadFakeLlmRules(env: NodeJS.ProcessEnv = process.env): Promise<FakeLlmRules> {
  const rulesPath = env.KB_LLM_FAKE_RULES?.trim();
  if (!rulesPath) return {};
  const raw = await fsp.readFile(rulesPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isFakeLlmRules(parsed)) {
    throw new Error(`invalid KB_LLM_FAKE_RULES file: ${rulesPath}`);
  }
  return parsed;
}

export function fakeOpenAiChatCompletionResponse(
  request: FakeOpenAiRequest,
  rules: FakeLlmRules = {},
): Record<string, unknown> {
  const messages = parseMessages(request.messages);
  const content = generateFakeChatContent(messages, rules);
  return {
    id: 'chatcmpl-kb-fake',
    object: 'chat.completion',
    created: 0,
    model: FAKE_LLM_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content,
        },
      },
    ],
    usage: {
      prompt_tokens: estimateTokens(messages.map((message) => message.content).join('\n')),
      completion_tokens: estimateTokens(content),
      total_tokens: estimateTokens(messages.map((message) => message.content).join('\n')) + estimateTokens(content),
    },
  };
}

export function generateFakeChatContent(
  messages: readonly LlmChatMessage[],
  rules: FakeLlmRules = {},
): string {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  const user = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const combined = `${system}\n${user}`;

  const responseOverride = matchResponseOverride(rules.responses ?? [], system, user, combined);
  if (responseOverride !== null) return responseOverride;

  if (/reply with exactly:\s*ok/i.test(combined)) return 'ok';
  if (/judge whether retrieved knowledge-base chunks are relevant/i.test(system)) {
    return JSON.stringify(buildJudgeResponse(user, rules));
  }
  if (/generate short retrieval-aware context strings/i.test(system) || user.includes('<chunk>')) {
    return buildPrefaceResponse(user, rules);
  }
  if (/Answer only from the provided knowledge-base snippets/i.test(system) || user.includes('Retrieved snippets:')) {
    return buildAskResponse(user, rules);
  }
  return rules.default_response ?? 'Fake LLM response from kb-fake-llm.';
}

function matchResponseOverride(
  rules: FakeResponseRule[],
  system: string,
  user: string,
  combined: string,
): string | null {
  for (const rule of rules) {
    if (rule.contains !== undefined && !includesFolded(combined, rule.contains)) continue;
    if (rule.system_contains !== undefined && !includesFolded(system, rule.system_contains)) continue;
    if (rule.user_contains !== undefined && !includesFolded(user, rule.user_contains)) continue;
    return rule.content;
  }
  return null;
}

function buildJudgeResponse(user: string, rules: FakeLlmRules): {
  overall: 'relevant' | 'partial' | 'no-relevant-context';
  verdicts: Array<{ id: string; decision: 'keep' | 'drop'; reason: string }>;
} {
  const query = extractSection(user, 'Query:', 'Candidates:');
  const taskContext = extractSection(user, 'Task context:', 'Query:');
  const queryHaystack = `${taskContext}\n${query}`;
  const candidates = parseJudgeCandidates(user);
  const rule = (rules.judge ?? []).find((entry) => includesFolded(queryHaystack, entry.query_contains));
  const terms = importantTerms(queryHaystack);
  let kept = 0;

  const verdicts = candidates.map((candidate) => {
    const contentLower = candidate.content.toLowerCase();
    const ruleDecision = ruleDecisionForCandidate(rule, contentLower);
    const matchedTerm = terms.find((term) => contentLower.includes(term));
    const keep = ruleDecision ?? (matchedTerm !== undefined || terms.length === 0);
    if (keep) kept += 1;
    return {
      id: candidate.id,
      decision: keep ? 'keep' as const : 'drop' as const,
      reason: keep
        ? `${matchedTerm ?? firstContentTerm(candidate.content) ?? 'content'} match`
        : `${firstContentTerm(candidate.content) ?? 'content'} lacks query match`,
    };
  });

  const overall = rule?.overall ?? (
    kept === 0
      ? 'no-relevant-context'
      : 'relevant'
  );
  return { overall, verdicts };
}

function ruleDecisionForCandidate(rule: FakeJudgeRule | undefined, contentLower: string): boolean | undefined {
  if (rule === undefined) return undefined;
  if (rule.keep_contains && rule.keep_contains.length > 0) {
    return rule.keep_contains.some((term) => contentLower.includes(term.toLowerCase()));
  }
  if (rule.drop_contains && rule.drop_contains.length > 0) {
    return !rule.drop_contains.some((term) => contentLower.includes(term.toLowerCase()));
  }
  return true;
}

function parseJudgeCandidates(user: string): ParsedCandidate[] {
  const rows: ParsedCandidate[] = [];
  const regex = /id:\s*([^\n]+)\nsource:\s*[^\n]*\ncontent:\n([\s\S]*?)(?=\n\n---\n\nCandidate \d+|\n\nJSON shape:|$)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(user)) !== null) {
    rows.push({
      id: match[1].trim(),
      content: match[2].trim(),
    });
  }
  return rows;
}

function buildPrefaceResponse(user: string, rules: FakeLlmRules): string {
  const chunk = extractTagged(user, 'chunk');
  const rule = (rules.prefaces ?? []).find((entry) => includesFolded(chunk, entry.chunk_contains));
  if (rule !== undefined) return rule.preface;

  const documentBody = extractTagged(user, 'document');
  const heading = nearestHeading(documentBody, chunk);
  const topic = firstSentence(chunk) ?? firstContentTerm(chunk) ?? 'the selected passage';
  const punctuation = /[.!?]$/.test(topic) ? '' : '.';
  return `In ${heading}, this chunk discusses ${topic}${punctuation}`;
}

function buildAskResponse(user: string, rules: FakeLlmRules): string {
  const question = extractSection(user, 'Question:', 'Retrieved snippets:');
  const answerRule = (rules.answers ?? []).find((entry) => includesFolded(question, entry.question_contains));
  if (answerRule !== undefined) return answerRule.answer;
  if (user.includes('(no snippets retrieved)')) {
    return 'I do not have enough retrieved context to answer that from the knowledge base.';
  }
  const snippet = parseFirstAskSnippet(user);
  if (snippet === null) {
    return 'I do not have enough retrieved context to answer that from the knowledge base.';
  }
  const sentence = firstSentence(snippet.content) ?? snippet.content.slice(0, 160).trim();
  const source = snippet.path === null ? 'the retrieved snippet' : snippet.path;
  return `Fake answer: ${sentence} Source: ${source}.`;
}

function parseFirstAskSnippet(user: string): { path: string | null; content: string } | null {
  const match = user.match(/Snippet 1\nScore:[^\n]*\nMetadata:\s*([^\n]+)\nContent:\n([\s\S]*?)(?=\n\n---\n\nSnippet \d+|$)/);
  if (match === null) return null;
  let pathValue: string | null = null;
  try {
    const metadata = JSON.parse(match[1]) as { relativePath?: unknown; source?: unknown; knowledgeBase?: unknown };
    const path = typeof metadata.relativePath === 'string'
      ? metadata.relativePath
      : typeof metadata.source === 'string'
        ? metadata.source
        : null;
    pathValue = typeof metadata.knowledgeBase === 'string' && path !== null
      ? `${metadata.knowledgeBase}:${path}`
      : path;
  } catch {
    pathValue = null;
  }
  return { path: pathValue, content: match[2].trim() };
}

function nearestHeading(documentBody: string, chunk: string): string {
  const index = chunk.trim() === '' ? -1 : documentBody.indexOf(chunk);
  const prefix = index >= 0 ? documentBody.slice(0, index) : documentBody;
  const headings = [...prefix.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].trim());
  const heading = headings.at(-1) ?? [...documentBody.matchAll(/^#{1,6}\s+(.+)$/gm)].at(0)?.[1]?.trim();
  return heading ? `section "${heading}"` : 'the source document';
}

function extractSection(input: string, startMarker: string, endMarker: string): string {
  const start = input.indexOf(startMarker);
  if (start < 0) return '';
  const contentStart = start + startMarker.length;
  const end = input.indexOf(endMarker, contentStart);
  return (end < 0 ? input.slice(contentStart) : input.slice(contentStart, end)).trim();
}

function extractTagged(input: string, tag: string): string {
  const match = input.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  return match?.[1]?.trim() ?? '';
}

function parseMessages(value: unknown): LlmChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LlmChatMessage[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const role = (entry as { role?: unknown }).role;
    const content = (entry as { content?: unknown }).content;
    if ((role !== 'system' && role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      return [];
    }
    return [{ role, content }];
  });
}

function isFakeLlmRules(value: unknown): value is FakeLlmRules {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    optionalArray(v.responses, isFakeResponseRule) &&
    optionalArray(v.answers, isFakeAnswerRule) &&
    optionalArray(v.prefaces, isFakePrefaceRule) &&
    optionalArray(v.judge, isFakeJudgeRule) &&
    (v.default_response === undefined || typeof v.default_response === 'string')
  );
}

function isFakeResponseRule(value: unknown): value is FakeResponseRule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.content === 'string' &&
    (v.contains === undefined || typeof v.contains === 'string') &&
    (v.system_contains === undefined || typeof v.system_contains === 'string') &&
    (v.user_contains === undefined || typeof v.user_contains === 'string')
  );
}

function isFakeAnswerRule(value: unknown): value is FakeAnswerRule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.question_contains === 'string' && typeof v.answer === 'string';
}

function isFakePrefaceRule(value: unknown): value is FakePrefaceRule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.chunk_contains === 'string' && typeof v.preface === 'string';
}

function isFakeJudgeRule(value: unknown): value is FakeJudgeRule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.query_contains === 'string' &&
    (v.overall === undefined || v.overall === 'relevant' || v.overall === 'partial' || v.overall === 'no-relevant-context') &&
    optionalStringArray(v.keep_contains) &&
    optionalStringArray(v.drop_contains)
  );
}

function optionalArray<T>(value: unknown, guard: (entry: unknown) => entry is T): boolean {
  return value === undefined || (Array.isArray(value) && value.every(guard));
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}

function includesFolded(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function importantTerms(input: string): string[] {
  return input
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .match(/[a-z0-9_/-]{3,}/g)
    ?.filter((term) => !STOP_WORDS.has(term)) ?? [];
}

function firstContentTerm(input: string): string | null {
  return importantTerms(input)[0] ?? null;
}

function firstSentence(input: string): string | null {
  const cleaned = input
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return null;
  const match = cleaned.match(/^(.{1,220}?[.!?])(?:\s|$)/);
  return (match?.[1] ?? cleaned.slice(0, 180)).trim();
}

function estimateTokens(input: string): number {
  const trimmed = input.trim();
  return trimmed === '' ? 0 : Math.max(1, Math.ceil(trimmed.length / 4));
}
