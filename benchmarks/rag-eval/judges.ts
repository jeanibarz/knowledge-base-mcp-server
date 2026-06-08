// RFC 020 §5 — Tier 3 judge builders.
//
// Two ways to make a `Judge` for the panel:
//
//   - `createLlmJudge` — a real LLM judge over the existing provider
//     abstraction (a `callChatCompletion`-like function is injected, so this
//     module has no static `src/` import; run.ts wires the compiled client).
//     It applies the §5 double-query A/B–B/A ordering and an independent
//     multi-dimensional rubric, varies temperature by self-consistency sample
//     so K samples are genuinely independent, and EXCLUDES the dataset name
//     from the prompt (§6 contamination control).
//
//   - `createStubJudge` — a deterministic, network-free judge for unit tests
//     and the `fake` cascade path: it scores the candidate by token-F1 against
//     the reference and the contexts, with optional injected biases so the
//     Tier-4 probes have something to detect. NEVER a real quality signal.

import { tokenF1Pair } from './reference.js';
import { rubricScores, RUBRIC_DIMENSIONS, type RubricDimension } from './types.js';
import type { Judge, JudgeGradeInput, JudgeRawVerdict } from './panel.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionLike {
  (options: {
    endpoint: string;
    model?: string;
    messages: ChatMessage[];
    temperature?: number;
    timeoutMs?: number;
  }): Promise<{ content: string; model: string | null }>;
}

export interface LlmJudgeOptions {
  name: string;
  family: string;
  endpoint: string;
  model?: string;
  timeoutMs?: number;
  /** Base temperature; sample index nudges it up for self-consistency spread. */
  baseTemperature?: number;
  chat: ChatCompletionLike;
}

const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

/**
 * A real LLM judge. The prompt presents the two answers as "Answer A" / "Answer
 * B" in the order dictated by `order` (candidate is A under `AB`, B under `BA`),
 * asks for a per-dimension 0–10 rubric score for EACH answer plus a preference,
 * and parses the JSON back. Self-consistency comes from raising temperature with
 * the sample index. The dataset name never appears in the prompt (§6).
 */
export function createLlmJudge(options: LlmJudgeOptions): Judge {
  return {
    name: options.name,
    family: options.family,
    async grade(input: JudgeGradeInput): Promise<JudgeRawVerdict> {
      const candidateIsA = input.order === 'AB';
      const answerA = candidateIsA ? input.candidate : input.reference;
      const answerB = candidateIsA ? input.reference : input.candidate;
      const temperature = (options.baseTemperature ?? 0.3) + input.sample * 0.15;
      const response = await options.chat({
        endpoint: options.endpoint,
        ...(options.model !== undefined ? { model: options.model } : {}),
        temperature,
        timeoutMs: options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
        messages: buildJudgeMessages(input.question, answerA, answerB, input.contexts),
      });
      return parseJudgeVerdict(response.content, candidateIsA);
    },
  };
}

export function buildJudgeMessages(
  question: string,
  answerA: string,
  answerB: string,
  contexts: readonly string[],
): ChatMessage[] {
  const contextBlock = contexts.length === 0
    ? '(no retrieved context)'
    : contexts.map((ctx, idx) => `[${idx + 1}] ${ctx}`).join('\n');
  return [
    {
      role: 'system',
      content: [
        'You are an impartial evaluator of answers to a question, grounded in retrieved context.',
        'Score EACH answer on three dimensions, integers 0-10:',
        'faithfulness (supported by the context, no hallucination), relevance (addresses the question correctly),',
        'completeness (covers what the question asks).',
        'Then state which answer you prefer overall.',
        'Return ONLY JSON: {"A":{"faithfulness":n,"relevance":n,"completeness":n},',
        '"B":{"faithfulness":n,"relevance":n,"completeness":n},"preferred":"A"|"B"|"tie"}.',
        'Judge only on quality; ignore answer length and ordering.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Question:\n${question}`,
        `Retrieved context:\n${contextBlock}`,
        `Answer A:\n${answerA}`,
        `Answer B:\n${answerB}`,
        'JSON only.',
      ].join('\n\n'),
    },
  ];
}

interface RawRubric { faithfulness?: unknown; relevance?: unknown; completeness?: unknown }
interface RawJudge { A?: RawRubric; B?: RawRubric; preferred?: unknown }

export function parseJudgeVerdict(content: string, candidateIsA: boolean): JudgeRawVerdict {
  const parsed = parseJson(content);
  const candidateRubric = candidateIsA ? parsed.A : parsed.B;
  const dimensions = rubricScores((dimension) => normalizeTen(readDimension(candidateRubric, dimension)));
  const preferredSlot = parsed.preferred === 'A' || parsed.preferred === 'B' ? parsed.preferred : 'tie';
  const preferredCandidate = preferredSlot === (candidateIsA ? 'A' : 'B');
  return { dimensions, preferredCandidate };
}

function readDimension(rubric: RawRubric | undefined, dimension: RubricDimension): number {
  const value = rubric?.[dimension];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeTen(value: number): number {
  return Math.min(1, Math.max(0, value / 10));
}

function parseJson(content: string): RawJudge {
  const stripped = stripFence(content.trim());
  try {
    return JSON.parse(stripped) as RawJudge;
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1)) as RawJudge;
      } catch {
        return {};
      }
    }
    return {};
  }
}

function stripFence(content: string): string {
  const match = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : content;
}

// ---------------------------------------------------------------------------
// Deterministic stub judge — hermetic tests + the `fake` cascade path.
// ---------------------------------------------------------------------------

export interface StubJudgeOptions {
  name: string;
  family: string;
}

/**
 * A deterministic stub judge for hermetic tests and the `fake` cascade path.
 * Faithfulness = token-F1 of the candidate vs the joined contexts;
 * relevance/completeness = token-F1 of the candidate vs the reference. The
 * preference goes to whichever of candidate/reference scores higher against the
 * contexts, computed identically for both orderings — so an unbiased stub shows
 * NO position flip, which is exactly what the Tier-4 position probe should read
 * off a clean judge. Output is a pure function of the inputs, so tests are
 * reproducible. NEVER a real quality signal.
 */
export function createStubJudge(options: StubJudgeOptions): Judge {
  return {
    name: options.name,
    family: options.family,
    async grade(input: JudgeGradeInput): Promise<JudgeRawVerdict> {
      const contextText = input.contexts.join(' ');
      const faithfulness = input.contexts.length === 0
        ? tokenF1Pair(input.candidate, input.reference)
        : tokenF1Pair(input.candidate, contextText);
      const relevance = tokenF1Pair(input.candidate, input.reference);
      const dimensions = rubricScores((dimension) => (dimension === 'faithfulness' ? faithfulness : relevance));
      // Order-invariant preference: compare candidate vs reference on the same
      // signal regardless of which slot each occupies → no position bias.
      const candidateSignal = input.contexts.length === 0 ? relevance : faithfulness;
      const referenceSignal = tokenF1Pair(input.reference, contextText || input.candidate);
      return { dimensions, preferredCandidate: candidateSignal >= referenceSignal };
    },
  };
}

export const RUBRIC_DIMENSION_KEYS = RUBRIC_DIMENSIONS;
