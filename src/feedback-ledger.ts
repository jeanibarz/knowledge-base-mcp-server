import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
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

export interface ParsedFeedbackLedger {
  entries: FeedbackLedgerEntry[];
  /**
   * Number of non-empty lines that could not be parsed as JSON and were
   * skipped (e.g. a torn final line from a crash mid-append). Mirrors the
   * canonical-log reader's `malformed_canonical_line_count`.
   */
  malformedLineCount: number;
}

export const FEEDBACK_SUMMARY_SCHEMA_VERSION = 'kb-feedback-summary.v1';
export const DEFAULT_FEEDBACK_SUMMARY_TOP = 10;

const FEEDBACK_VERDICTS: readonly FeedbackVerdict[] = ['relevant', 'irrelevant', 'stale', 'misleading'];

export type FeedbackVerdictCounts = Record<FeedbackVerdict, number>;

export interface FeedbackFlaggedSource {
  source: string;
  /** Rows for this source whose verdict is irrelevant, stale, or misleading. */
  flagged_count: number;
  /** Every row for this source, broken down by verdict. */
  verdict_counts: FeedbackVerdictCounts;
  /** created_at of the newest flagged row for this source. */
  last_flagged_at: string;
}

export interface FeedbackSummary {
  total_entries: number;
  distinct_queries: number;
  distinct_sources: number;
  verdict_counts: FeedbackVerdictCounts;
  /**
   * verdict_counts.relevant / total_entries, rounded to 4 decimals; null when
   * there are no rows. Counts rows (judgments), not distinct query/source
   * pairs, and uses the stored verdict only. The ledger always stores a
   * verdict: when only --relevance was given at write time, relevance 0
   * became `irrelevant` and 1..3 became `relevant`.
   */
  relevant_share: number | null;
  /** Mean of the graded relevance (0..3) over all rows, 4 decimals; null when empty. */
  mean_relevance: number | null;
  /** Rows per group label, count descending then label ascending. */
  group_counts: Array<{ group: string; count: number }>;
  /** Sources with at least one non-relevant row, most-flagged first, at most `top`. */
  top_flagged_sources: FeedbackFlaggedSource[];
}

/**
 * Aggregate feedback rows into verdict counts, the relevant share, the mean
 * graded relevance, per-group counts and the most-flagged sources. Pure: the
 * caller reads (and filters) the ledger.
 */
export function summarizeFeedbackEntries(
  entries: readonly FeedbackLedgerEntry[],
  options: { top?: number } = {},
): FeedbackSummary {
  const top = options.top ?? DEFAULT_FEEDBACK_SUMMARY_TOP;
  const verdictCounts = emptyVerdictCounts();
  const queries = new Set<string>();
  const groups = new Map<string, number>();
  const sources = new Map<string, { verdict_counts: FeedbackVerdictCounts; last_flagged_at?: string }>();
  let relevanceSum = 0;

  for (const entry of entries) {
    verdictCounts[entry.verdict]++;
    queries.add(entry.query);
    relevanceSum += entry.relevance;
    for (const group of entry.groups ?? []) groups.set(group, (groups.get(group) ?? 0) + 1);

    let source = sources.get(entry.source);
    if (source === undefined) {
      source = { verdict_counts: emptyVerdictCounts() };
      sources.set(entry.source, source);
    }
    source.verdict_counts[entry.verdict]++;
    if (entry.verdict !== 'relevant'
      && (source.last_flagged_at === undefined || entry.created_at > source.last_flagged_at)) {
      source.last_flagged_at = entry.created_at;
    }
  }

  const total = entries.length;
  const flagged: FeedbackFlaggedSource[] = [];
  for (const [source, stats] of sources) {
    if (stats.last_flagged_at === undefined) continue;
    flagged.push({
      source,
      flagged_count: stats.verdict_counts.irrelevant + stats.verdict_counts.stale + stats.verdict_counts.misleading,
      verdict_counts: stats.verdict_counts,
      last_flagged_at: stats.last_flagged_at,
    });
  }
  flagged.sort((a, b) => b.flagged_count - a.flagged_count || compareStrings(a.source, b.source));

  return {
    total_entries: total,
    distinct_queries: queries.size,
    distinct_sources: sources.size,
    verdict_counts: verdictCounts,
    relevant_share: total === 0 ? null : round4(verdictCounts.relevant / total),
    mean_relevance: total === 0 ? null : round4(relevanceSum / total),
    group_counts: Array.from(groups, ([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count || compareStrings(a.group, b.group)),
    top_flagged_sources: flagged.slice(0, top),
  };
}

function emptyVerdictCounts(): FeedbackVerdictCounts {
  return Object.fromEntries(FEEDBACK_VERDICTS.map((verdict) => [verdict, 0])) as FeedbackVerdictCounts;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Locale-independent ordering so the output is identical on every host. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
  return (await readFeedbackLedgerWithStats(kbDir)).entries;
}

export async function readFeedbackLedgerWithStats(kbDir: string): Promise<ParsedFeedbackLedger> {
  const ledgerPath = feedbackLedgerPath(kbDir);
  let raw: string;
  try {
    raw = await fsp.readFile(ledgerPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], malformedLineCount: 0 };
    throw err;
  }
  return parseFeedbackJsonl(raw);
}

export function parseFeedbackJsonl(raw: string): ParsedFeedbackLedger {
  const entries: FeedbackLedgerEntry[] = [];
  let malformedLineCount = 0;
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A non-parseable line is almost always a torn write (crash mid-append)
      // or other byte-level corruption. Skip and count it rather than bricking
      // the whole read; well-formed-but-schema-invalid lines still throw below
      // so genuine format/version mismatches stay loud.
      malformedLineCount++;
      return;
    }
    entries.push(normalizeFeedbackEntry(parsed, idx + 1));
  });
  return { entries, malformedLineCount };
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
