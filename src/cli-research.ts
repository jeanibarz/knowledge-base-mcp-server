import * as fsp from 'fs/promises';
import * as path from 'path';
import { readFileSync, realpathSync } from 'fs';
import { resolveActiveModel } from './active-model.js';
import { captureProcessOutput, loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import { runSearch } from './cli-search.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import { describeKnowledgeBase, listKnowledgeBases } from './kb-fs.js';
import { computeKbStats, type KbStatsPayload, type KbStatsRow } from './kb-stats.js';

export const RESEARCH_HELP = `kb research — read-only KB evidence planning and collection

Usage:
  kb research plan "<question>" [--format=md|json] [--include-kb=<name>] [--exclude-kb=<name>] [--max-shelves=<n>]
  kb research collect "<question>" --run-dir <path> [--format=md|json] [--include-kb=<name>] [--exclude-kb=<name>] [--max-shelves=<n>]

The workflow is deterministic: it reads KB descriptions and stats, selects
likely shelves and queries, then collect uses existing hybrid search. It does
not call an LLM, trigger local-research-agent, or write KB notes.

Commands:
  plan                  Print a deterministic retrieval plan.
  collect               Create run artifacts: run.json, plan.json, ledger.json,
                        evidence_packet.md, and events.jsonl.

Options:
  --run-dir <path>      Directory for collect artifacts.
  --run-dir=<path>      Same as above.
  --format=md|json      Output format (default: md).
  --k=<int>             Results per query/shelf search during collect (default: 5).
  --kb=<name>           Include a shelf explicitly (alias for --include-kb).
  --include-kb=<name>   Include a shelf explicitly; repeatable.
  --exclude-kb=<name>   Exclude a shelf; repeatable.
  --max-shelves=<int>   Maximum automatically selected shelves (default: 5).
  --help, -h            Show this help.

Examples:
  kb research plan "autonomous research agents and evals" --format=json
  kb research collect "autonomous research agents and evals" --run-dir runs/agents --format=json
`;

type OutputFormat = 'md' | 'json';
type ResearchAction = 'plan' | 'collect';
type RetrievalMode = 'hybrid';

interface ResearchArgs {
  action: ResearchAction;
  question: string;
  format: OutputFormat;
  runDir?: string;
  k: number;
  includeShelves: string[];
  excludeShelves: string[];
  maxShelves: number;
}

export interface ShelfDescription {
  name: string;
  description: string;
}

export interface SelectedShelf {
  name: string;
  description: string;
  file_count: number;
  chunk_count: number;
  score: number;
  reasons: string[];
  risks: ResearchRisk[];
}

export interface ResearchRisk {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  shelf?: string;
}

export interface ResearchQuery {
  id: string;
  text: string;
  purpose: string;
  shelves: string[];
}

export interface ResearchPlan {
  schema_version: 'kb-research-plan.v1';
  question: string;
  selected_shelves: SelectedShelf[];
  queries: ResearchQuery[];
  retrieval: {
    mode: RetrievalMode;
    k: number;
  };
  risks: ResearchRisk[];
}

interface ResearchPlanOptions {
  includeShelves?: string[];
  excludeShelves?: string[];
  maxShelves?: number;
}

interface EvidenceSourceGroup {
  label: string;
  entries: LedgerEntry[];
  bestScore: number | null;
}

export interface LedgerEntry {
  source_id: string;
  shelf: string;
  relative_path: string | null;
  line_range: { from: number; to: number } | null;
  query: string;
  retrieval_mode: RetrievalMode;
  score: number | null;
  excerpt: string;
  source_kind: string | null;
  source_generation: string | null;
  risk_flags: string[];
}

export interface ResearchLedger {
  schema_version: 'kb-research-ledger.v1';
  question: string;
  retrieval_mode: RetrievalMode;
  entries: LedgerEntry[];
  risks: ResearchRisk[];
  search_failures: SearchFailureEvent[];
}

interface SearchFailureEvent {
  query_id: string;
  query: string;
  shelf: string;
  exit_code: number;
  message: string;
}

interface SearchResult {
  score?: number | null;
  content?: string;
  metadata?: Record<string, unknown>;
  chunk_id?: string;
  injection_signals?: unknown[];
}

interface SearchPayload {
  mode?: string;
  results?: SearchResult[];
  retrievers?: {
    lexical?: { failed?: number };
  };
  error?: { code?: string; message?: string };
}

interface SearchResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: SearchPayload | null;
}

export interface ResearchDeps {
  loadShelfDescriptions: () => Promise<ShelfDescription[]>;
  loadStats: () => Promise<KbStatsPayload>;
  searchHybrid: (input: { query: string; shelf: string; k: number }) => Promise<SearchResponse>;
  now: () => Date;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_DEPS: ResearchDeps = {
  loadShelfDescriptions: loadShelfDescriptions,
  loadStats: loadStats,
  searchHybrid: defaultSearchHybrid,
  now: () => new Date(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runResearch(
  rest: string[],
  deps: ResearchDeps = DEFAULT_DEPS,
): Promise<number> {
  let parsed: ResearchArgs;
  try {
    parsed = parseResearchArgs(rest);
  } catch (err) {
    deps.stderr(`kb research: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    if (parsed.action === 'plan') {
      const plan = await buildResearchPlan(parsed.question, parsed.k, deps, researchPlanOptions(parsed));
      deps.stdout(parsed.format === 'json'
        ? `${JSON.stringify(plan, null, 2)}\n`
        : formatPlanMarkdown(plan));
      return 0;
    }

    const result = await collectResearch(parsed, deps);
    deps.stdout(parsed.format === 'json'
      ? `${JSON.stringify(result.summary, null, 2)}\n`
      : formatCollectMarkdown(result.summary));
    return result.exitCode;
  } catch (err) {
    deps.stderr(`kb research: ${(err as Error).message}\n`);
    return 1;
  }
}

export function parseResearchArgs(rest: string[]): ResearchArgs {
  const action = rest[0];
  if (action !== 'plan' && action !== 'collect') {
    throw new Error("expected subcommand 'plan' or 'collect'");
  }

  let question: string | undefined;
  let format: OutputFormat = 'md';
  let runDir: string | undefined;
  let k = 5;
  const includeShelves: string[] = [];
  const excludeShelves: string[] = [];
  let maxShelves = 5;

  for (let i = 1; i < rest.length; i++) {
    const raw = rest[i];
    if (raw === '--run-dir') {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error('missing value for --run-dir');
      runDir = value;
      continue;
    }
    if (raw.startsWith('--run-dir=')) {
      const value = raw.slice('--run-dir='.length);
      if (value === '') throw new Error('empty --run-dir value');
      runDir = value;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format value '${value}' (expected md or json)`);
      }
      format = value;
      continue;
    }
    if (raw.startsWith('--k=')) {
      const value = Number(raw.slice('--k='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid --k: ${raw}`);
      k = value;
      continue;
    }
    if (raw === '--kb' || raw === '--include-kb' || raw === '--exclude-kb') {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${raw}`);
      if (raw === '--exclude-kb') excludeShelves.push(value);
      else includeShelves.push(value);
      continue;
    }
    if (raw.startsWith('--kb=') || raw.startsWith('--include-kb=')) {
      const flag = raw.startsWith('--kb=') ? '--kb' : '--include-kb';
      const value = raw.slice(`${flag}=`.length).trim();
      if (value === '') throw new Error(`empty ${flag} value`);
      includeShelves.push(value);
      continue;
    }
    if (raw.startsWith('--exclude-kb=')) {
      const value = raw.slice('--exclude-kb='.length).trim();
      if (value === '') throw new Error('empty --exclude-kb value');
      excludeShelves.push(value);
      continue;
    }
    if (raw.startsWith('--max-shelves=')) {
      const value = Number(raw.slice('--max-shelves='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid --max-shelves: ${raw}`);
      maxShelves = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    if (question === undefined) {
      question = raw;
      continue;
    }
    throw new Error(`unexpected argument: ${raw}`);
  }

  if (question === undefined || question.trim() === '') {
    throw new Error(`missing <question> for ${action}`);
  }
  if (action === 'collect' && (runDir === undefined || runDir.trim() === '')) {
    throw new Error('collect requires --run-dir <path>');
  }
  const conflicts = intersectNames(includeShelves, excludeShelves);
  if (conflicts.length > 0) {
    throw new Error(`cannot include and exclude the same shelf: ${conflicts.join(', ')}`);
  }

  return {
    action,
    question: question.trim(),
    format,
    ...(runDir !== undefined ? { runDir } : {}),
    k,
    includeShelves: uniqueNames(includeShelves),
    excludeShelves: uniqueNames(excludeShelves),
    maxShelves,
  };
}

export async function buildResearchPlan(
  question: string,
  k: number,
  deps: Pick<ResearchDeps, 'loadShelfDescriptions' | 'loadStats'>,
  options: ResearchPlanOptions = {},
): Promise<ResearchPlan> {
  const [descriptions, stats] = await Promise.all([
    deps.loadShelfDescriptions(),
    deps.loadStats(),
  ]);
  const selected = selectShelves(question, descriptions, stats.knowledge_bases, options);
  const risks = selected.flatMap((shelf) => shelf.risks);
  return {
    schema_version: 'kb-research-plan.v1',
    question,
    selected_shelves: selected,
    queries: buildQueries(question, selected),
    retrieval: {
      mode: 'hybrid',
      k,
    },
    risks,
  };
}

interface CollectResult {
  exitCode: number;
  summary: {
    schema_version: 'kb-research-collect-summary.v1';
    question: string;
    run_dir: string;
    status: 'complete' | 'failed';
    artifact_paths: Record<string, string>;
    evidence_count: number;
    risk_count: number;
    search_failure_count: number;
  };
}

async function collectResearch(args: ResearchArgs, deps: ResearchDeps): Promise<CollectResult> {
  if (!args.runDir) throw new Error('collect requires --run-dir <path>');
  const runDir = path.resolve(args.runDir);
  await fsp.mkdir(runDir, { recursive: true });
  const eventsPath = path.join(runDir, 'events.jsonl');
  await fsp.writeFile(eventsPath, '');

  const startedAt = deps.now().toISOString();
  await appendEvent(eventsPath, {
    type: 'collect_started',
    at: startedAt,
    question: args.question,
    run_dir: runDir,
  });

  const plan = await buildResearchPlan(args.question, args.k, deps, researchPlanOptions(args));
  await appendEvent(eventsPath, {
    type: 'plan_created',
    at: deps.now().toISOString(),
    selected_shelves: plan.selected_shelves.map((shelf) => shelf.name),
    queries: plan.queries.map((query) => query.text),
  });

  const entries: LedgerEntry[] = [];
  const searchFailures: SearchFailureEvent[] = [];
  const coverageRiskShelves = new Set(
    plan.risks
      .filter((risk) => risk.code === 'dense_index_empty_coverage' && risk.shelf)
      .map((risk) => risk.shelf as string),
  );

  for (const query of plan.queries) {
    for (const shelf of query.shelves) {
      const response = await deps.searchHybrid({
        query: query.text,
        shelf,
        k: plan.retrieval.k,
      });
      const searchFailureMessage = getSearchFailureMessage(response);
      if (searchFailureMessage !== null) {
        const failure = {
          query_id: query.id,
          query: query.text,
          shelf,
          exit_code: response.exitCode,
          message: searchFailureMessage,
        };
        searchFailures.push(failure);
        await appendEvent(eventsPath, { type: 'search_failure', at: deps.now().toISOString(), ...failure });
        continue;
      }
      const results = response.payload?.results ?? [];
      await appendEvent(eventsPath, {
        type: 'search_completed',
        at: deps.now().toISOString(),
        query_id: query.id,
        query: query.text,
        shelf,
        result_count: results.length,
      });
      results.forEach((result, index) => {
        entries.push(toLedgerEntry({
          result,
          query: query.text,
          shelf,
          index,
          coverageRisk: coverageRiskShelves.has(shelf),
        }));
      });
    }
  }

  const ledger: ResearchLedger = {
    schema_version: 'kb-research-ledger.v1',
    question: args.question,
    retrieval_mode: 'hybrid',
    entries,
    risks: plan.risks,
    search_failures: searchFailures,
  };

  const status = searchFailures.length > 0 ? 'failed' : 'complete';
  const artifactPaths = {
    run: path.join(runDir, 'run.json'),
    plan: path.join(runDir, 'plan.json'),
    ledger: path.join(runDir, 'ledger.json'),
    evidence_packet: path.join(runDir, 'evidence_packet.md'),
    events: eventsPath,
  };
  const run = {
    schema_version: 'kb-research-run.v1',
    question: args.question,
    command: 'kb research collect',
    run_dir: runDir,
    started_at: startedAt,
    finished_at: deps.now().toISOString(),
    status,
    artifact_paths: artifactPaths,
  };

  await writeJsonAtomic(artifactPaths.run, run);
  await writeJsonAtomic(artifactPaths.plan, plan);
  await writeJsonAtomic(artifactPaths.ledger, ledger);
  await writeTextAtomic(artifactPaths.evidence_packet, formatEvidencePacket(plan, ledger));
  await appendEvent(eventsPath, {
    type: 'artifacts_written',
    at: deps.now().toISOString(),
    status,
    artifact_paths: artifactPaths,
  });

  return {
    exitCode: searchFailures.length > 0 ? 1 : 0,
    summary: {
      schema_version: 'kb-research-collect-summary.v1',
      question: args.question,
      run_dir: runDir,
      status,
      artifact_paths: artifactPaths,
      evidence_count: entries.length,
      risk_count: ledger.risks.length,
      search_failure_count: searchFailures.length,
    },
  };
}

function selectShelves(
  question: string,
  descriptions: ShelfDescription[],
  statsRows: Record<string, KbStatsRow>,
  options: ResearchPlanOptions = {},
): SelectedShelf[] {
  const questionTokens = tokenize(question);
  const questionText = canonicalPhrase(question);
  const maxShelves = options.maxShelves ?? 5;
  const includeNames = uniqueNames(options.includeShelves ?? []);
  const excludeNames = new Set(uniqueNames(options.excludeShelves ?? []));
  const byName = new Map(descriptions.map((shelf) => [shelf.name, shelf.description]));
  for (const name of Object.keys(statsRows)) {
    if (!byName.has(name)) byName.set(name, '');
  }
  const knownNames = new Set(byName.keys());
  const unknownIncludes = includeNames.filter((name) => !knownNames.has(name));
  if (unknownIncludes.length > 0) {
    throw new Error(`unknown shelf in --include-kb/--kb: ${unknownIncludes.join(', ')}`);
  }
  const unknownExcludes = [...excludeNames].filter((name) => !knownNames.has(name));
  if (unknownExcludes.length > 0) {
    throw new Error(`unknown shelf in --exclude-kb: ${unknownExcludes.join(', ')}`);
  }
  const includeSet = new Set(includeNames);

  const shelves = [...byName.entries()].map(([name, description]) => {
    const nameTokens = tokenize(name.replace(/[-_]/g, ' '));
    const descriptionTokens = tokenize(description);
    const nameMatches = matchedMeaningfulTokens(questionTokens, nameTokens);
    const compoundNameMatch = matchedCompoundNameTokens(questionTokens, nameTokens);
    const descriptionMatches = matchedMeaningfulTokens(questionTokens, descriptionTokens);
    const exactNameHit = questionText.includes(canonicalPhrase(name)) ? 1 : 0;
    const stats = statsRows[name] ?? emptyStatsRow();
    const explicitlyIncluded = includeSet.has(name);
    const score =
      exactNameHit * 12 +
      compoundNameMatch.score +
      nameMatches.length * 5 +
      descriptionMatches.length * 2 +
      (explicitlyIncluded ? 100 : 0);
    const reasons = [
      ...(explicitlyIncluded ? ['explicitly included by operator'] : []),
      ...(exactNameHit ? ['question mentions shelf name'] : []),
      ...(nameMatches.length > 0
        ? [`${nameMatches.length} shelf-name token match${nameMatches.length === 1 ? '' : 'es'} (${nameMatches.join(', ')})`]
        : []),
      ...(compoundNameMatch.tokens.length > 0
        ? [`compound shelf-name match (${compoundNameMatch.tokens.join(', ')})`]
        : []),
      ...(descriptionMatches.length > 0
        ? [`${descriptionMatches.length} description token match${descriptionMatches.length === 1 ? '' : 'es'} (${descriptionMatches.join(', ')})`]
        : []),
      ...(stats.file_count > 0 ? ['shelf has indexed-source files'] : []),
    ];
    const risks = buildShelfRisks(name, stats);
    return {
      name,
      description,
      file_count: stats.file_count,
      chunk_count: stats.chunk_count,
      score,
      reasons,
      risks,
    };
  });

  const available = shelves.filter((shelf) => shelf.file_count > 0 && !excludeNames.has(shelf.name));
  const included = available
    .filter((shelf) => includeSet.has(shelf.name))
    .sort(compareShelves);
  const relevant = available
    .filter((shelf) => !includeSet.has(shelf.name) && shelf.score >= 2)
    .sort(compareShelves)
    .slice(0, maxShelves);
  if (included.length > 0 || relevant.length > 0) return [...included, ...relevant];

  return available
    .sort(compareShelves)
    .slice(0, Math.min(maxShelves, 3));
}

function buildShelfRisks(name: string, stats: KbStatsRow): ResearchRisk[] {
  if (stats.file_count > 0 && stats.chunk_count === 0) {
    return [{
      code: 'dense_index_empty_coverage',
      severity: 'warning',
      shelf: name,
      message: `${name} has ${stats.file_count} file(s) but 0 dense chunks; collect will still use hybrid search.`,
    }];
  }
  return [];
}

function compareShelves(a: SelectedShelf, b: SelectedShelf): number {
  return (
    b.score - a.score ||
    b.chunk_count - a.chunk_count ||
    b.file_count - a.file_count ||
    a.name.localeCompare(b.name)
  );
}

function buildQueries(question: string, shelves: SelectedShelf[]): ResearchQuery[] {
  const shelfNames = shelves.map((shelf) => shelf.name);
  const keywords = tokenizeForQuery(question).slice(0, 8).join(' ');
  const shelfTerms = shelfNames.slice(0, 3).map((name) => name.replace(/[-_]/g, ' ')).join(' ');
  const candidates = [
    { text: question, purpose: 'original research question' },
    { text: keywords || question, purpose: 'keyword-focused retrieval' },
    { text: [question, shelfTerms].filter(Boolean).join(' '), purpose: 'question plus selected-shelf vocabulary' },
  ];

  const seen = new Set<string>();
  const queries: ResearchQuery[] = [];
  for (const candidate of candidates) {
    const key = candidate.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({
      id: `q${queries.length + 1}`,
      text: candidate.text,
      purpose: candidate.purpose,
      shelves: shelfNames,
    });
  }
  return queries;
}

function tokenize(value: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of value.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []) {
    addSelectionToken(raw.replace(/^-+|-+$/g, ''), seen, tokens);
    for (const part of raw.split('-')) {
      addSelectionToken(part.replace(/^-+|-+$/g, ''), seen, tokens);
    }
  }
  return tokens;
}

function addSelectionToken(raw: string, seen: Set<string>, tokens: string[]): void {
  if (raw === '') return;
  const token = normalizeToken(raw);
  if (STOP_WORDS.has(token) || seen.has(token)) return;
  seen.add(token);
  tokens.push(token);
}

function normalizeToken(token: string): string {
  if (token === 'evals' || token === 'evaluations' || token === 'evaluation') return 'eval';
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (
    token.length > 3 &&
    token.endsWith('s') &&
    !token.endsWith('ss') &&
    !token.endsWith('us') &&
    !token.endsWith('ous') &&
    !token.endsWith('is') &&
    !token.endsWith('ias')
  ) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenizeForQuery(value: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of value.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []) {
    const token = raw.replace(/^-+|-+$/g, '');
    if (token === '') continue;
    const normalized = normalizeToken(token);
    if (STOP_WORDS.has(normalized) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function matchedMeaningfulTokens(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token) && !BROAD_SELECTION_TOKENS.has(token));
}

function matchedCompoundNameTokens(questionTokens: string[], nameTokens: string[]): { tokens: string[]; score: number } {
  const uniqueNameTokens = [...new Set(nameTokens)].filter((token) => !STOP_WORDS.has(token));
  if (uniqueNameTokens.length < 2) return { tokens: [], score: 0 };
  const questionSet = new Set(questionTokens);
  const matched = uniqueNameTokens.filter((token) => questionSet.has(token));
  if (matched.length !== uniqueNameTokens.length) return { tokens: [], score: 0 };
  return {
    tokens: matched,
    score: matched.includes('llm') ? 10 : 4,
  };
}

function canonicalPhrase(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')} `;
}

function uniqueNames(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function intersectNames(left: string[], right: string[]): string[] {
  const rightSet = new Set(uniqueNames(right));
  return uniqueNames(left).filter((name) => rightSet.has(name));
}

function researchPlanOptions(args: Pick<ResearchArgs, 'includeShelves' | 'excludeShelves' | 'maxShelves'>): ResearchPlanOptions {
  return {
    includeShelves: args.includeShelves,
    excludeShelves: args.excludeShelves,
    maxShelves: args.maxShelves,
  };
}

const BROAD_SELECTION_TOKENS = new Set([
  'agent', 'llm', 'task', 'lesson', 'job', 'search', 'note', 'notes', 'tool', 'workflow',
]);

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'and', 'approach', 'are', 'as',
  'between', 'can', 'could', 'does', 'end', 'for', 'from', 'have', 'how',
  'into', 'its', 'over', 'research', 'should', 'that', 'the', 'their',
  'then', 'there', 'this', 'through', 'use', 'using', 'what', 'when', 'where',
  'which', 'with', 'would',
]);

function emptyStatsRow(): KbStatsRow {
  return {
    file_count: 0,
    chunk_count: 0,
    total_bytes_indexed: 0,
    last_updated_at: null,
  };
}

function toLedgerEntry(input: {
  result: SearchResult;
  query: string;
  shelf: string;
  index: number;
  coverageRisk: boolean;
}): LedgerEntry {
  const metadata = input.result.metadata ?? {};
  const shelf = inferShelf(metadata, input.shelf);
  const relativePath = inferRelativePath(metadata, shelf);
  const lineRange = inferLineRange(metadata, input.result.chunk_id);
  const riskFlags = [
    ...(input.coverageRisk ? ['dense_index_empty_coverage'] : []),
    ...(lineRange === null ? ['missing_line_range'] : []),
    ...(relativePath === null ? ['missing_relative_path'] : []),
    ...((input.result.injection_signals?.length ?? 0) > 0 ? ['injection_signals'] : []),
  ];
  return {
    source_id: input.result.chunk_id ?? fallbackSourceId(shelf, relativePath, lineRange, input.index),
    shelf,
    relative_path: relativePath,
    line_range: lineRange,
    query: input.query,
    retrieval_mode: 'hybrid',
    score: typeof input.result.score === 'number' ? input.result.score : null,
    excerpt: excerpt(input.result.content ?? ''),
    source_kind: inferSourceKind(metadata, relativePath),
    source_generation: inferSourceGeneration(metadata),
    risk_flags: riskFlags,
  };
}

function getSearchFailureMessage(response: SearchResponse): string | null {
  if (response.exitCode !== 0 || response.payload?.error) {
    return response.payload?.error?.message ?? response.stderr.trim() ?? 'kb search failed';
  }
  const lexicalFailures = response.payload?.retrievers?.lexical?.failed;
  if (typeof lexicalFailures === 'number' && lexicalFailures > 0) {
    return response.stderr.trim() || `hybrid lexical leg failed for ${lexicalFailures} knowledge base(s)`;
  }
  return null;
}

function inferShelf(metadata: Record<string, unknown>, fallback: string): string {
  const value = metadata.knowledgeBase;
  if (typeof value === 'string' && value.trim() !== '') return value;
  const relativePath = metadata.relativePath;
  if (typeof relativePath === 'string' && relativePath.includes('/')) {
    const [head] = relativePath.split('/');
    if (head) return head;
  }
  return fallback;
}

function inferRelativePath(metadata: Record<string, unknown>, shelf: string): string | null {
  const relativePath = metadata.relativePath;
  if (typeof relativePath === 'string' && relativePath.trim() !== '') {
    return stripShelfPrefix(relativePath.trim(), shelf);
  }
  const source = metadata.source;
  if (typeof source === 'string' && source.trim() !== '') {
    const normalized = source.split(path.sep).join('/');
    const marker = `/${shelf}/`;
    const index = normalized.indexOf(marker);
    if (index >= 0) return normalized.slice(index + marker.length);
    return stripShelfPrefix(normalized, shelf);
  }
  return null;
}

function stripShelfPrefix(value: string, shelf: string): string {
  const normalized = value.split(path.sep).join('/');
  return normalized.startsWith(`${shelf}/`) ? normalized.slice(shelf.length + 1) : normalized;
}

function inferLineRange(
  metadata: Record<string, unknown>,
  chunkId: string | undefined,
): { from: number; to: number } | null {
  const loc = metadata.loc;
  if (loc && typeof loc === 'object') {
    const lines = (loc as Record<string, unknown>).lines;
    if (lines && typeof lines === 'object') {
      const from = (lines as Record<string, unknown>).from;
      const to = (lines as Record<string, unknown>).to;
      if (isPositiveInteger(from)) {
        return { from, to: isPositiveInteger(to) ? to : from };
      }
    }
  }
  const match = /#L(\d+)-L(\d+)$/.exec(chunkId ?? '');
  if (!match) return null;
  return { from: Number(match[1]), to: Number(match[2]) };
}

function inferSourceKind(metadata: Record<string, unknown>, relativePath: string | null): string | null {
  const frontmatter = metadata.frontmatter;
  if (frontmatter && typeof frontmatter === 'object') {
    for (const key of ['source_kind', 'kind', 'type']) {
      const value = (frontmatter as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  if (!relativePath) return null;
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.txt') return 'text';
  return ext ? ext.slice(1) : null;
}

function inferSourceGeneration(metadata: Record<string, unknown>): string | null {
  for (const key of ['source_generation', 'generation']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  const frontmatter = metadata.frontmatter;
  if (frontmatter && typeof frontmatter === 'object') {
    for (const key of ['source_generation', 'generation', 'generated_by']) {
      const value = (frontmatter as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return null;
}

function fallbackSourceId(
  shelf: string,
  relativePath: string | null,
  lineRange: { from: number; to: number } | null,
  index: number,
): string {
  const location = lineRange ? `L${lineRange.from}-L${lineRange.to}` : `result-${index + 1}`;
  return `${shelf}/${relativePath ?? 'unknown'}#${location}`;
}

function excerpt(content: string): string {
  return content.trim().replace(/\s+/g, ' ').slice(0, 600);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function formatPlanMarkdown(plan: ResearchPlan): string {
  return [
    '# KB Research Plan',
    '',
    `Question: ${plan.question}`,
    '',
    '## Selected Shelves',
    '',
    ...plan.selected_shelves.map((shelf) => (
      `- ${shelf.name} (${shelf.file_count} files, ${shelf.chunk_count} chunks): ` +
      `${shelf.reasons.join('; ') || 'fallback selection'}`
    )),
    '',
    '## Queries',
    '',
    ...plan.queries.map((query) => `- ${query.id}: ${query.text}`),
    '',
    '## Risks',
    '',
    ...(plan.risks.length === 0
      ? ['- None detected.']
      : plan.risks.map((risk) => `- ${risk.code}: ${risk.message}`)),
    '',
  ].join('\n');
}

function formatCollectMarkdown(summary: CollectResult['summary']): string {
  return [
    '# KB Research Collect',
    '',
    `Status: ${summary.status}`,
    `Run directory: ${summary.run_dir}`,
    `Evidence entries: ${summary.evidence_count}`,
    `Risks: ${summary.risk_count}`,
    `Search failures: ${summary.search_failure_count}`,
    '',
  ].join('\n');
}

function formatEvidencePacket(plan: ResearchPlan, ledger: ResearchLedger): string {
  const found = groupEvidenceBySource(ledger.entries).slice(0, 50);
  const sources = uniqueSources(ledger.entries);
  return [
    '# Evidence Packet',
    '',
    '## Question',
    '',
    plan.question,
    '',
    '## Selected Shelves',
    '',
    ...plan.selected_shelves.map((shelf) => (
      `- ${shelf.name}: ${shelf.file_count} files, ${shelf.chunk_count} chunks` +
      (shelf.description ? ` — ${shelf.description}` : '')
    )),
    '',
    '## Queries',
    '',
    ...plan.queries.map((query) => `- ${query.id}: ${query.text}`),
    '',
    '## Evidence Found',
    '',
    ...(found.length === 0
      ? ['- No evidence found.']
      : found.map((group, index) => (
          `${index + 1}. ${group.label} — ${group.entries.length} passage${group.entries.length === 1 ? '' : 's'}, ` +
          `best score ${formatScore(group.bestScore)}\n\n` +
          group.entries.slice(0, 3).map((entry) => (
            `   - ${formatLineRange(entry)} via "${entry.query}": ${entry.excerpt || '(empty excerpt)'}`
          )).join('\n') +
          (group.entries.length > 3 ? `\n   - ... ${group.entries.length - 3} more passage(s) from this source` : '')
        ))),
    '',
    '## Evidence Gaps',
    '',
    ...formatEvidenceGaps(plan, ledger),
    '',
    '## Sources',
    '',
    ...(sources.length === 0 ? ['- None.'] : sources.map((source) => `- ${source}`)),
    '',
  ].join('\n');
}

function formatEvidenceGaps(plan: ResearchPlan, ledger: ResearchLedger): string[] {
  const gaps: string[] = [];
  if (ledger.entries.length === 0) {
    gaps.push('- No retrieved passages were recorded.');
  }
  for (const risk of plan.risks) {
    gaps.push(`- ${risk.code}: ${risk.message}`);
  }
  for (const failure of ledger.search_failures) {
    gaps.push(`- search_failure: ${failure.shelf} / ${failure.query_id} exited ${failure.exit_code}: ${failure.message}`);
  }
  const queriesWithEvidence = new Set(ledger.entries.map((entry) => entry.query));
  for (const query of plan.queries) {
    if (!queriesWithEvidence.has(query.text)) {
      gaps.push(`- no_evidence_for_query: ${query.id} (${query.text})`);
    }
  }
  return gaps.length === 0 ? ['- None detected.'] : gaps;
}

function uniqueSources(entries: LedgerEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const source = formatSourceGroupLabel(entry);
    if (seen.has(source)) continue;
    seen.add(source);
    out.push(source);
  }
  return out;
}

function formatSourceLabel(entry: LedgerEntry): string {
  const range = entry.line_range ? `#L${entry.line_range.from}-L${entry.line_range.to}` : '';
  return `${entry.shelf}/${entry.relative_path ?? 'unknown'}${range}`;
}

function formatSourceGroupLabel(entry: LedgerEntry): string {
  return `${entry.shelf}/${entry.relative_path ?? 'unknown'}`;
}

function formatLineRange(entry: LedgerEntry): string {
  if (!entry.line_range) return formatSourceLabel(entry);
  return `L${entry.line_range.from}-L${entry.line_range.to}`;
}

function groupEvidenceBySource(entries: LedgerEntry[]): EvidenceSourceGroup[] {
  const groups = new Map<string, { label: string; entries: LedgerEntry[]; bestScore: number | null; seen: Set<string> }>();
  for (const entry of entries) {
    const label = formatSourceGroupLabel(entry);
    const key = label;
    let group = groups.get(key);
    if (!group) {
      group = { label, entries: [], bestScore: null, seen: new Set<string>() };
      groups.set(key, group);
    }
    const dedupeKey = `${formatSourceLabel(entry)}\0${entry.query}\0${entry.excerpt}`;
    if (group.seen.has(dedupeKey)) continue;
    group.seen.add(dedupeKey);
    group.entries.push(entry);
    if (entry.score !== null && (group.bestScore === null || entry.score > group.bestScore)) {
      group.bestScore = entry.score;
    }
  }
  return [...groups.values()].map(({ label, entries: groupedEntries, bestScore }) => ({
    label,
    entries: groupedEntries,
    bestScore,
  }));
}

function formatScore(score: number | null): string {
  return score === null ? 'n/a' : String(Number(score.toFixed(4)));
}

async function appendEvent(filePath: string, event: Record<string, unknown>): Promise<void> {
  await fsp.appendFile(filePath, `${JSON.stringify(event)}\n`);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, value);
  await fsp.rename(tmp, filePath);
}

async function loadShelfDescriptions(): Promise<ShelfDescription[]> {
  const names = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  const descriptions = await Promise.all(
    names.map(async (name) => ({
      name,
      description: await describeKnowledgeBase(KNOWLEDGE_BASES_ROOT_DIR, name),
    })),
  );
  return descriptions;
}

async function loadStats(): Promise<KbStatsPayload> {
  await FaissIndexManager.bootstrapLayout();
  const activeModelId = await resolveActiveModel();
  const manager = await loadManagerForModel(activeModelId);
  await loadWithJsonRetry(manager);
  return computeKbStats(manager, {
    serverVersion: readPackageVersion(),
    startedAt: Date.now(),
  });
}

async function defaultSearchHybrid(input: {
  query: string;
  shelf: string;
  k: number;
}): Promise<SearchResponse> {
  const captured = await captureProcessOutput(() => runSearch([
    input.query,
    `--kb=${input.shelf}`,
    '--mode=hybrid',
    '--format=json',
    `--k=${input.k}`,
  ]));
  let payload: SearchPayload | null = null;
  if (captured.stdout.trim() !== '') {
    try {
      payload = JSON.parse(captured.stdout) as SearchPayload;
    } catch {
      payload = null;
    }
  }
  return { ...captured, payload };
}

function readPackageVersion(): string {
  try {
    const here = realpathSync(process.argv[1] ?? path.join(process.cwd(), 'build', 'cli.js'));
    const pkgPath = path.join(path.dirname(here), '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
