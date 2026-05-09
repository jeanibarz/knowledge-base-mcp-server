import { minimatch } from 'minimatch';
import type { ScoredDocument } from './formatter.js';
import type { Staleness } from './cli-search.js';

export type StalePolicy = 'allow_stale' | 'fresh' | 'stale';

export interface ExpectedMetadataRule {
  path: string;
  equals: unknown;
}

export interface RetrievalEvalCase {
  name: string;
  query: string;
  kb?: string;
  k?: number;
  threshold?: number;
  gate?: boolean;
  requiredSources: string[];
  forbiddenSources: string[];
  expectedMetadata: ExpectedMetadataRule[];
  maxDuplicateGroups?: number;
  stalePolicy: StalePolicy;
}

export interface RetrievalEvalCaseInput {
  name?: string;
  query: string;
  kb?: string;
  k?: number;
  threshold?: number;
  gate?: boolean;
  required_sources?: string[];
  forbidden_sources?: string[];
  expected_metadata?: Record<string, unknown> | Array<Record<string, unknown>>;
  max_duplicate_groups?: number;
  stale_policy?: StalePolicy | { expect?: StalePolicy };
}

export interface RetrievalEvalFixture {
  gate: boolean;
  cases: RetrievalEvalCase[];
}

export interface RetrievalEvalCaseResult {
  name: string;
  query: string;
  kb?: string;
  gate: boolean;
  passed: boolean;
  failures: string[];
  warnings: string[];
  resultCount: number;
  duplicateGroups: number;
}

export interface RetrievalEvalReport {
  cases: RetrievalEvalCaseResult[];
  total: number;
  passed: number;
  failed: number;
  gateFailed: number;
}

export function normalizeRetrievalEvalFixture(input: unknown): RetrievalEvalFixture {
  if (!isRecord(input)) {
    throw new Error('fixture must be an object with a cases array');
  }
  const gate = readOptionalBoolean(input, 'gate') ?? false;
  const rawCases = input.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error('fixture cases must be a non-empty array');
  }
  return {
    gate,
    cases: rawCases.map((raw, idx) => normalizeCase(raw, idx + 1)),
  };
}

export function evaluateRetrievalCase(
  fixtureCase: RetrievalEvalCase,
  results: readonly ScoredDocument[],
  staleness: Staleness,
  fixtureGate = false,
): RetrievalEvalCaseResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const required of fixtureCase.requiredSources) {
    if (!results.some((doc) => documentMatchesSource(doc, required))) {
      failures.push(`missing required source: ${required}`);
    }
  }

  for (const forbidden of fixtureCase.forbiddenSources) {
    if (results.some((doc) => documentMatchesSource(doc, forbidden))) {
      failures.push(`forbidden source present: ${forbidden}`);
    }
  }

  for (const expected of fixtureCase.expectedMetadata) {
    if (!results.some((doc) => metadataMatchesRule(doc.metadata, expected))) {
      failures.push(`expected metadata not found: ${expected.path} = ${JSON.stringify(expected.equals)}`);
    }
  }

  const duplicateGroups = countDuplicateSourceGroups(results);
  if (
    fixtureCase.maxDuplicateGroups !== undefined &&
    duplicateGroups > fixtureCase.maxDuplicateGroups
  ) {
    failures.push(
      `duplicate source groups ${duplicateGroups} exceeds budget ${fixtureCase.maxDuplicateGroups}`,
    );
  }

  const stale = isStale(staleness);
  if (fixtureCase.stalePolicy === 'fresh' && stale) {
    failures.push('stale policy expected fresh results, but the index has modified/new files');
  } else if (fixtureCase.stalePolicy === 'stale' && !stale) {
    failures.push('stale policy expected stale results, but the index is fresh');
  } else if (fixtureCase.stalePolicy === 'allow_stale' && stale) {
    warnings.push('index has modified/new files, but stale_policy allows stale results');
  }

  const gate = fixtureCase.gate ?? fixtureGate;
  return {
    name: fixtureCase.name,
    query: fixtureCase.query,
    ...(fixtureCase.kb !== undefined ? { kb: fixtureCase.kb } : {}),
    gate,
    passed: failures.length === 0,
    failures,
    warnings,
    resultCount: results.length,
    duplicateGroups,
  };
}

export function summarizeRetrievalEval(results: RetrievalEvalCaseResult[]): RetrievalEvalReport {
  const failed = results.filter((r) => !r.passed).length;
  return {
    cases: results,
    total: results.length,
    passed: results.length - failed,
    failed,
    gateFailed: results.filter((r) => r.gate && !r.passed).length,
  };
}

export function retrievalEvalExitCode(report: RetrievalEvalReport): number {
  return report.gateFailed > 0 ? 1 : 0;
}

export function formatRetrievalEvalMarkdown(report: RetrievalEvalReport): string {
  const lines = ['# kb eval', ''];
  for (const result of report.cases) {
    const status = result.passed ? 'PASS' : result.gate ? 'FAIL' : 'WARN';
    const scope = result.kb === undefined ? 'all KBs' : `kb=${result.kb}`;
    lines.push(
      `- ${status} ${result.name} (${scope}, ${result.resultCount} result(s), duplicate groups: ${result.duplicateGroups})`,
    );
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  lines.push('');
  lines.push(
    `Summary: ${report.passed}/${report.total} passed; ${report.failed} failed; ${report.gateFailed} gate failure(s).`,
  );
  return `${lines.join('\n')}\n`;
}

function normalizeCase(raw: unknown, caseNumber: number): RetrievalEvalCase {
  if (!isRecord(raw)) {
    throw new Error(`case ${caseNumber} must be an object`);
  }
  const query = readRequiredString(raw, 'query', `case ${caseNumber}`);
  const kb = readOptionalString(raw, 'kb');
  const k = readOptionalPositiveInteger(raw, 'k');
  const threshold = readOptionalPositiveNumber(raw, 'threshold');
  const gate = readOptionalBoolean(raw, 'gate');
  const maxDuplicateGroups = readOptionalNonNegativeInteger(raw, 'max_duplicate_groups');
  return {
    name: readOptionalString(raw, 'name') ?? `case ${caseNumber}`,
    query,
    ...(kb !== undefined ? { kb } : {}),
    ...(k !== undefined ? { k } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(gate !== undefined ? { gate } : {}),
    requiredSources: readOptionalStringArray(raw, 'required_sources') ?? [],
    forbiddenSources: readOptionalStringArray(raw, 'forbidden_sources') ?? [],
    expectedMetadata: normalizeExpectedMetadata(raw.expected_metadata, caseNumber),
    ...(maxDuplicateGroups !== undefined ? { maxDuplicateGroups } : {}),
    stalePolicy: normalizeStalePolicy(raw.stale_policy, caseNumber),
  };
}

function normalizeExpectedMetadata(raw: unknown, caseNumber: number): ExpectedMetadataRule[] {
  if (raw === undefined) return [];
  if (isRecord(raw)) {
    return Object.entries(raw).map(([path, equals]) => ({ path, equals }));
  }
  if (Array.isArray(raw)) {
    const rules: ExpectedMetadataRule[] = [];
    raw.forEach((entry, idx) => {
      if (!isRecord(entry)) {
        throw new Error(`case ${caseNumber} expected_metadata[${idx}] must be an object`);
      }
      for (const [path, equals] of Object.entries(entry)) {
        rules.push({ path, equals });
      }
    });
    return rules;
  }
  throw new Error(`case ${caseNumber} expected_metadata must be an object or array of objects`);
}

function normalizeStalePolicy(raw: unknown, caseNumber: number): StalePolicy {
  if (raw === undefined) return 'allow_stale';
  const candidate = isRecord(raw) ? raw.expect : raw;
  if (candidate === 'allow_stale' || candidate === 'fresh' || candidate === 'stale') {
    return candidate;
  }
  throw new Error(
    `case ${caseNumber} stale_policy must be "allow_stale", "fresh", or "stale"`,
  );
}

function documentMatchesSource(doc: ScoredDocument, pattern: string): boolean {
  return sourceIdentities(doc).some((source) => sourceMatches(source, pattern));
}

function sourceIdentities(doc: ScoredDocument): string[] {
  const metadata = doc.metadata as Record<string, unknown>;
  const candidates = [metadata.source, metadata.relativePath];
  return candidates.filter((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.trim() !== '');
}

function sourceMatches(source: string, pattern: string): boolean {
  if (source === pattern) return true;
  if (source.endsWith(`/${pattern}`)) return true;
  return minimatch(source, pattern, { dot: true });
}

function countDuplicateSourceGroups(results: readonly ScoredDocument[]): number {
  const counts = new Map<string, number>();
  results.forEach((doc, idx) => {
    const key = sourceIdentities(doc)[0] ?? `(unknown source ${idx + 1})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return Array.from(counts.values()).filter((count) => count > 1).length;
}

function metadataMatchesRule(metadata: unknown, rule: ExpectedMetadataRule): boolean {
  return deepEqual(readPath(metadata, rule.path), rule.equals);
}

function readPath(input: unknown, dotPath: string): unknown {
  let current = input;
  for (const segment of dotPath.split('.')) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isStale(s: Staleness): boolean {
  return s.modifiedFiles + s.newFiles > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(
  input: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context} requires non-empty ${key}`);
  }
  return value;
}

function readOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
  return value;
}

function readOptionalStringArray(
  input: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return value;
}

function readOptionalPositiveInteger(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function readOptionalNonNegativeInteger(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function readOptionalPositiveNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return value;
}
