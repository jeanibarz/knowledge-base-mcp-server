import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';
import { atomicWriteFile } from './file-mutation.js';
import { normalizeRetrievalEvalFixture } from './retrieval-eval.js';

export const FEEDBACK_LEDGER_SCHEMA_VERSION = 'kb-feedback.v1';
export const FEEDBACK_LEDGER_FILENAME = 'relevance-feedback.jsonl';

export type FeedbackVerdict = 'relevant' | 'irrelevant' | 'stale' | 'misleading';

export interface FeedbackLedgerEntry {
  schema_version: typeof FEEDBACK_LEDGER_SCHEMA_VERSION;
  id: string;
  created_at: string;
  kb: string;
  query: string;
  source: string;
  verdict: FeedbackVerdict;
  relevance: number;
  chunk_id?: string;
  task_context_hash?: string;
  note?: string;
  groups?: string[];
}

export interface FeedbackAddInput {
  kb: string;
  query: string;
  source: string;
  verdict?: FeedbackVerdict;
  relevance?: number;
  chunkId?: string;
  taskContext?: string;
  note?: string;
  groups?: string[];
  now?: Date;
  id?: string;
}

export interface FeedbackPromoteOptions {
  kb: string;
  query: string;
  name?: string;
  k?: number;
  mode?: 'dense' | 'lexical' | 'hybrid' | 'auto';
  gate?: boolean;
}

export interface PromotedFixture {
  gate: boolean;
  mode?: 'dense' | 'lexical' | 'hybrid' | 'auto';
  cases: Array<Record<string, unknown>>;
}

export function feedbackLedgerPath(kbDir: string): string {
  return path.join(kbDir, '.index', FEEDBACK_LEDGER_FILENAME);
}

export async function appendFeedbackEntry(kbDir: string, input: FeedbackAddInput): Promise<FeedbackLedgerEntry> {
  const entry = buildFeedbackEntry(input);
  const ledgerPath = feedbackLedgerPath(kbDir);
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fsp.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf-8');
  return entry;
}

export async function readFeedbackLedger(kbDir: string): Promise<FeedbackLedgerEntry[]> {
  const ledgerPath = feedbackLedgerPath(kbDir);
  let raw: string;
  try {
    raw = await fsp.readFile(ledgerPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return parseFeedbackJsonl(raw);
}

export function parseFeedbackJsonl(raw: string): FeedbackLedgerEntry[] {
  const entries: FeedbackLedgerEntry[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`feedback ledger line ${idx + 1} is not valid JSON: ${(err as Error).message}`);
    }
    entries.push(normalizeFeedbackEntry(parsed, idx + 1));
  });
  return entries;
}

export function buildFeedbackEntry(input: FeedbackAddInput): FeedbackLedgerEntry {
  const verdict = input.verdict ?? defaultVerdict(input.relevance);
  const relevance = input.relevance ?? defaultRelevance(verdict);
  const groups = uniqueNonEmpty(input.groups ?? []);
  const entry: FeedbackLedgerEntry = {
    schema_version: FEEDBACK_LEDGER_SCHEMA_VERSION,
    id: input.id ?? crypto.randomUUID(),
    created_at: (input.now ?? new Date()).toISOString(),
    kb: nonEmpty(input.kb, 'kb'),
    query: nonEmpty(input.query, 'query'),
    source: nonEmpty(input.source, 'source'),
    verdict,
    relevance: validateRelevance(relevance),
    ...(input.chunkId !== undefined ? { chunk_id: nonEmpty(input.chunkId, 'chunk_id') } : {}),
    ...(input.taskContext !== undefined
      ? { task_context_hash: hashTaskContext(nonEmpty(input.taskContext, 'task_context')) }
      : {}),
    ...(input.note !== undefined ? { note: nonEmpty(input.note, 'note') } : {}),
    ...(groups.length > 0 ? { groups } : {}),
  };
  return normalizeFeedbackEntry(entry, 0);
}

export function buildPromotedEvalFixture(
  entries: readonly FeedbackLedgerEntry[],
  options: FeedbackPromoteOptions,
): PromotedFixture {
  const matching = entries.filter((entry) => entry.kb === options.kb && entry.query === options.query);
  if (matching.length === 0) {
    throw new Error(`no feedback entries found for query ${JSON.stringify(options.query)} in KB ${JSON.stringify(options.kb)}`);
  }

  const positive = new Map<string, FeedbackLedgerEntry>();
  const negative = new Map<string, FeedbackLedgerEntry>();
  for (const entry of matching) {
    const existingPositive = positive.get(entry.source);
    if (entry.relevance > 0 && entry.verdict === 'relevant') {
      positive.set(entry.source, chooseStrongerJudgment(existingPositive, entry));
      negative.delete(entry.source);
      continue;
    }
    if (!positive.has(entry.source)) {
      negative.set(entry.source, chooseLatestJudgment(negative.get(entry.source), entry));
    }
  }

  const relevantSources = Array.from(positive.values())
    .sort((a, b) => b.relevance - a.relevance || a.source.localeCompare(b.source))
    .map((entry) => ({
      source: entry.source,
      relevance: entry.relevance,
      ...(entry.groups !== undefined ? { groups: entry.groups } : {}),
    }));
  const forbiddenSources = Array.from(negative.values())
    .sort((a, b) => a.source.localeCompare(b.source))
    .map((entry) => entry.source);

  const fixture: PromotedFixture = {
    gate: false,
    cases: [{
      name: options.name ?? fixtureCaseName(options.query),
      query: options.query,
      kb: options.kb,
      ...(options.k !== undefined ? { k: options.k } : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.gate !== undefined ? { gate: options.gate } : {}),
      required_sources: relevantSources.map((entry) => entry.source),
      ...(forbiddenSources.length > 0 ? { forbidden_sources: forbiddenSources } : {}),
      ...(relevantSources.length > 0 ? { relevant_sources: relevantSources } : {}),
      stale_policy: 'allow_stale',
    }],
  };
  normalizeRetrievalEvalFixture(fixture);
  return fixture;
}

export function dumpPromotedEvalFixture(fixture: PromotedFixture): string {
  return yaml.dump(fixture, { lineWidth: -1, noRefs: true, sortKeys: false });
}

export async function appendPromotedCaseToFixtureFile(
  fixturePath: string,
  promoted: PromotedFixture,
): Promise<{ caseCount: number; created: boolean }> {
  let created = false;
  let mode: number | undefined;
  let fixture: PromotedFixture;
  try {
    mode = (await fsp.stat(fixturePath)).mode;
    const raw = await fsp.readFile(fixturePath, 'utf-8');
    const parsed = yaml.load(raw);
    fixture = normalizePromotableFixture(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    created = true;
    fixture = { gate: false, cases: [] };
  }

  fixture.cases.push(...promoted.cases);
  normalizeRetrievalEvalFixture(fixture);
  await fsp.mkdir(path.dirname(path.resolve(fixturePath)), { recursive: true });
  await atomicWriteFile(fixturePath, dumpPromotedEvalFixture(fixture), mode);
  return { caseCount: fixture.cases.length, created };
}

function normalizePromotableFixture(raw: unknown): PromotedFixture {
  if (!isRecord(raw)) throw new Error('fixture must be an object');
  const normalized = normalizeRetrievalEvalFixture(raw);
  const gate = typeof raw.gate === 'boolean' ? raw.gate : false;
  if (!Array.isArray(raw.cases)) throw new Error('fixture cases must be an array');
  const fixture: PromotedFixture = {
    gate,
    ...(normalized.mode !== undefined ? { mode: normalized.mode } : {}),
    cases: raw.cases.map((entry) => {
      if (!isRecord(entry)) throw new Error('fixture cases must contain objects');
      return { ...entry };
    }),
  };
  normalizeRetrievalEvalFixture(fixture);
  return fixture;
}

function normalizeFeedbackEntry(raw: unknown, lineNumber: number): FeedbackLedgerEntry {
  if (!isRecord(raw)) throw new Error(feedbackLinePrefix(lineNumber, 'entry must be an object'));
  if (raw.schema_version !== FEEDBACK_LEDGER_SCHEMA_VERSION) {
    throw new Error(feedbackLinePrefix(lineNumber, `unsupported schema_version: ${JSON.stringify(raw.schema_version)}`));
  }
  const groups = raw.groups === undefined ? undefined : normalizeGroups(raw.groups, lineNumber);
  return {
    schema_version: FEEDBACK_LEDGER_SCHEMA_VERSION,
    id: nonEmpty(raw.id, feedbackLinePrefix(lineNumber, 'id')),
    created_at: nonEmpty(raw.created_at, feedbackLinePrefix(lineNumber, 'created_at')),
    kb: nonEmpty(raw.kb, feedbackLinePrefix(lineNumber, 'kb')),
    query: nonEmpty(raw.query, feedbackLinePrefix(lineNumber, 'query')),
    source: nonEmpty(raw.source, feedbackLinePrefix(lineNumber, 'source')),
    verdict: normalizeVerdict(raw.verdict, lineNumber),
    relevance: validateRelevance(raw.relevance),
    ...(raw.chunk_id !== undefined ? { chunk_id: nonEmpty(raw.chunk_id, feedbackLinePrefix(lineNumber, 'chunk_id')) } : {}),
    ...(raw.task_context_hash !== undefined
      ? { task_context_hash: nonEmpty(raw.task_context_hash, feedbackLinePrefix(lineNumber, 'task_context_hash')) }
      : {}),
    ...(raw.note !== undefined ? { note: nonEmpty(raw.note, feedbackLinePrefix(lineNumber, 'note')) } : {}),
    ...(groups !== undefined && groups.length > 0 ? { groups } : {}),
  };
}

function defaultVerdict(relevance: number | undefined): FeedbackVerdict {
  return relevance === 0 ? 'irrelevant' : 'relevant';
}

function defaultRelevance(verdict: FeedbackVerdict): number {
  return verdict === 'relevant' ? 3 : 0;
}

function validateRelevance(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 3) {
    throw new Error('relevance must be a finite number in [0, 3]');
  }
  return raw;
}

function normalizeVerdict(raw: unknown, lineNumber: number): FeedbackVerdict {
  if (raw === 'relevant' || raw === 'irrelevant' || raw === 'stale' || raw === 'misleading') {
    return raw;
  }
  throw new Error(feedbackLinePrefix(lineNumber, `invalid verdict: ${JSON.stringify(raw)}`));
}

function normalizeGroups(raw: unknown, lineNumber: number): string[] {
  if (!Array.isArray(raw)) throw new Error(feedbackLinePrefix(lineNumber, 'groups must be an array'));
  return uniqueNonEmpty(raw.map((entry) => nonEmpty(entry, feedbackLinePrefix(lineNumber, 'group'))));
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => nonEmpty(value, 'group'))));
}

function hashTaskContext(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixtureCaseName(query: string): string {
  return query.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80) || 'feedback case';
}

function chooseStrongerJudgment(
  existing: FeedbackLedgerEntry | undefined,
  incoming: FeedbackLedgerEntry,
): FeedbackLedgerEntry {
  if (existing === undefined) return incoming;
  if (incoming.relevance > existing.relevance) return mergeGroups(incoming, existing);
  if (incoming.relevance < existing.relevance) return mergeGroups(existing, incoming);
  return chooseLatestJudgment(existing, incoming);
}

function chooseLatestJudgment(
  existing: FeedbackLedgerEntry | undefined,
  incoming: FeedbackLedgerEntry,
): FeedbackLedgerEntry {
  if (existing === undefined) return incoming;
  return Date.parse(incoming.created_at) >= Date.parse(existing.created_at)
    ? mergeGroups(incoming, existing)
    : mergeGroups(existing, incoming);
}

function mergeGroups(primary: FeedbackLedgerEntry, secondary: FeedbackLedgerEntry): FeedbackLedgerEntry {
  const groups = uniqueNonEmpty([...(primary.groups ?? []), ...(secondary.groups ?? [])]);
  return {
    ...primary,
    ...(groups.length > 0 ? { groups } : {}),
  };
}

function feedbackLinePrefix(lineNumber: number, message: string): string {
  return lineNumber > 0 ? `feedback ledger line ${lineNumber}: ${message}` : message;
}

function nonEmpty(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
