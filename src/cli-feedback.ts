import * as path from 'path';
import {
  appendFeedbackEntry,
  appendPromotedCaseToFixtureFile,
  buildPromotedEvalFixture,
  DEFAULT_FEEDBACK_SUMMARY_TOP,
  dumpPromotedEvalFixture,
  FEEDBACK_SUMMARY_SCHEMA_VERSION,
  feedbackLedgerPath,
  readFeedbackLedger,
  readFeedbackLedgerWithStats,
  summarizeFeedbackEntries,
  type FeedbackLedgerEntry,
  type FeedbackSummary,
  type FeedbackVerdict,
  type PromotedFixture,
} from './feedback-ledger.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { resolveKnowledgeBaseDir } from './kb-fs.js';
import type { SearchMode } from './search-core.js';

type FeedbackArgs = FeedbackAddArgs | FeedbackListArgs | FeedbackPromoteArgs | FeedbackSummaryArgs;

interface FeedbackBaseArgs {
  action: 'add' | 'list' | 'promote' | 'summary';
  kb: string;
  format: 'md' | 'json';
}

interface FeedbackAddArgs extends FeedbackBaseArgs {
  action: 'add';
  query: string;
  source: string;
  verdict?: FeedbackVerdict;
  relevance?: number;
  chunkId?: string;
  taskContext?: string;
  note?: string;
  groups: string[];
}

interface FeedbackListArgs extends FeedbackBaseArgs {
  action: 'list';
  query?: string;
  limit: number;
}

interface FeedbackPromoteArgs extends FeedbackBaseArgs {
  action: 'promote';
  query: string;
  name?: string;
  k?: number;
  mode?: SearchMode;
  gate?: boolean;
  fixture?: string;
  yes: boolean;
}

interface FeedbackSummaryArgs extends FeedbackBaseArgs {
  action: 'summary';
  query?: string;
  top: number;
}

/** JSON envelope of `kb feedback summary --format=json`. */
export interface FeedbackSummaryReport extends FeedbackSummary {
  schema_version: typeof FEEDBACK_SUMMARY_SCHEMA_VERSION;
  kb: string;
  ledger_path: string;
  query: string | null;
  top: number;
  /** Torn/unparseable ledger lines skipped. Ledger-wide, even with --query. */
  malformed_line_count: number;
}

const DEFAULT_LIST_LIMIT = 50;

export const FEEDBACK_HELP = `kb feedback — record relevance judgments and promote them to eval fixtures

Usage:
  kb feedback add --kb=<name> --query=<query> --source=<rel-path>
                  [--chunk-id=<id>] [--verdict=relevant|irrelevant|stale|misleading]
                  [--relevance=<0..3>] [--task-context=<text>] [--note=<text>]
                  [--group=<label>]... [--format=md|json]
  kb feedback list --kb=<name> [--query=<query>] [--limit=<int>] [--format=md|json]
  kb feedback promote --kb=<name> --query=<query> [--name=<case-name>]
                      [--k=<int>] [--mode=dense|lexical|hybrid|auto] [--gate]
                      [--fixture=<path> --yes] [--format=md|json]
  kb feedback summary --kb=<name> [--query=<query>] [--top=<int>] [--format=md|json]

Records human or agent judgments in <kb>/.index/relevance-feedback.jsonl.
\`promote\` converts all rows for one query into a \`kb eval\` fixture case.
Without \`--fixture --yes\`, promote is read-only and prints YAML to stdout.
\`summary\` is read-only: it reports verdict counts, the relevant share
(rows with verdict relevant / all rows), mean graded relevance, group counts
and the sources most often judged irrelevant, stale or misleading.

Options:
  --kb=<name>            Knowledge base under KNOWLEDGE_BASES_ROOT_DIR.
  --query=<query>        Search query the judgment applies to.
  --source=<rel-path>    KB-relative source/result path to judge.
  --chunk-id=<id>        Optional result chunk id from kb search JSON/Markdown.
  --verdict=<value>      relevant, irrelevant, stale, or misleading
                         (default: relevant unless --relevance=0).
  --relevance=<0..3>     Graded relevance for eval metrics. Non-relevant
                         verdicts default to 0; relevant defaults to 3.
  --task-context=<text>  Hashed with SHA-256 before storage.
  --note=<text>          Short reviewer note stored in the ledger.
  --group=<label>        Intent/group label for diversity metrics. Repeatable.
  --limit=<int>          Max rows for list output (default ${DEFAULT_LIST_LIMIT}).
  --top=<int>            Max flagged sources in summary output
                         (default ${DEFAULT_FEEDBACK_SUMMARY_TOP}).
  --name=<case-name>     Eval case name for promote.
  --k=<int>              Optional eval case K.
  --mode=<mode>          Optional eval retrieval mode.
  --gate                 Mark the promoted case as gated.
  --fixture=<path>       YAML fixture file to append to. Requires --yes.
  --yes                  Required before promote writes --fixture.
  --format=md|json       Output format (default md).
  --help, -h             Show this help.
`;

export async function runFeedback(rest: string[]): Promise<number> {
  let parsed: FeedbackArgs;
  try {
    parsed = parseFeedbackArgs(rest);
  } catch (err) {
    process.stderr.write(`kb feedback: ${(err as Error).message}\n`);
    return 2;
  }

  let kbDir: string;
  try {
    kbDir = await resolveKnowledgeBaseDir(KNOWLEDGE_BASES_ROOT_DIR, parsed.kb);
  } catch (err) {
    process.stderr.write(`kb feedback: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    if (parsed.action === 'add') {
      const entry = await appendFeedbackEntry(kbDir, parsed);
      writeFeedbackAddResult(entry, feedbackLedgerPath(kbDir), parsed.format);
      return 0;
    }
    if (parsed.action === 'list') {
      const entries = (await readFeedbackLedger(kbDir))
        .filter((entry) => parsed.query === undefined || entry.query === parsed.query)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, parsed.limit);
      writeFeedbackListResult(entries, feedbackLedgerPath(kbDir), parsed.format);
      return 0;
    }
    if (parsed.action === 'summary') {
      const report = await buildFeedbackSummaryReport(kbDir, parsed);
      process.stdout.write(parsed.format === 'json'
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderFeedbackSummaryMarkdown(report));
      return 0;
    }

    const entries = await readFeedbackLedger(kbDir);
    const fixture = buildPromotedEvalFixture(entries, parsed);
    if (parsed.fixture !== undefined && parsed.yes) {
      const result = await appendPromotedCaseToFixtureFile(parsed.fixture, fixture);
      writeFeedbackPromoteWriteResult(parsed, result, parsed.format);
    } else {
      writeFeedbackPromotePreview(parsed, fixture, parsed.format);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`kb feedback: ${(err as Error).message}\n`);
    return 1;
  }
}

export function parseFeedbackArgs(rest: string[]): FeedbackArgs {
  const action = rest[0];
  if (action !== 'add' && action !== 'list' && action !== 'promote' && action !== 'summary') {
    throw new Error('missing action: add, list, promote, or summary');
  }

  const base = parseCommonArgs(action, rest.slice(1));
  if (base.kb.length === 0) throw new Error('missing --kb=<name>');

  if (action === 'add') {
    const out = base as FeedbackAddArgs;
    if (out.query === undefined) throw new Error('add requires --query=<query>');
    if (out.source === undefined) throw new Error('add requires --source=<rel-path>');
    return out;
  }
  if (action === 'list') {
    return base as FeedbackListArgs;
  }
  if (action === 'summary') {
    return base as FeedbackSummaryArgs;
  }

  const out = base as FeedbackPromoteArgs;
  if (out.query === undefined) throw new Error('promote requires --query=<query>');
  if (out.fixture !== undefined && !out.yes) throw new Error('--fixture=<path> requires --yes to write');
  if (out.fixture === undefined && out.yes) throw new Error('--yes requires --fixture=<path>');
  return out;
}

function parseCommonArgs(action: FeedbackArgs['action'], args: readonly string[]): FeedbackArgs {
  const base: FeedbackBaseArgs = { action, kb: '', format: 'md' };
  const out: Record<string, unknown> = {
    ...base,
    ...(action === 'add' ? { groups: [] } : {}),
    ...(action === 'list' ? { limit: DEFAULT_LIST_LIMIT } : {}),
    ...(action === 'promote' ? { yes: false } : {}),
    ...(action === 'summary' ? { top: DEFAULT_FEEDBACK_SUMMARY_TOP } : {}),
  };

  for (const raw of args) {
    if (raw.startsWith('--kb=')) { out.kb = nonEmptyValue(raw, '--kb='); continue; }
    if (raw.startsWith('--query=')) { out.query = nonEmptyValue(raw, '--query='); continue; }
    if (raw.startsWith('--format=')) {
      const value = nonEmptyValue(raw, '--format=');
      if (value !== 'md' && value !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = value;
      continue;
    }
    if (action === 'add' && raw.startsWith('--source=')) {
      out.source = nonEmptyValue(raw, '--source=');
      continue;
    }
    if (action === 'add' && raw.startsWith('--chunk-id=')) {
      out.chunkId = nonEmptyValue(raw, '--chunk-id=');
      continue;
    }
    if (action === 'add' && raw.startsWith('--verdict=')) {
      out.verdict = parseVerdict(nonEmptyValue(raw, '--verdict='));
      continue;
    }
    if (action === 'add' && raw.startsWith('--relevance=')) {
      out.relevance = parseBoundedNumber(raw, '--relevance=', 0, 3);
      continue;
    }
    if (action === 'add' && raw.startsWith('--task-context=')) {
      out.taskContext = nonEmptyValue(raw, '--task-context=');
      continue;
    }
    if (action === 'add' && raw.startsWith('--note=')) {
      out.note = nonEmptyValue(raw, '--note=');
      continue;
    }
    if (action === 'add' && raw.startsWith('--group=')) {
      (out.groups as string[]).push(nonEmptyValue(raw, '--group='));
      continue;
    }
    if (action === 'list' && raw.startsWith('--limit=')) {
      const value = Number(nonEmptyValue(raw, '--limit='));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid --limit: ${raw}`);
      out.limit = value;
      continue;
    }
    if (action === 'summary' && raw.startsWith('--top=')) {
      const value = Number(nonEmptyValue(raw, '--top='));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid --top: ${raw}`);
      out.top = value;
      continue;
    }
    if (action === 'promote' && raw.startsWith('--name=')) {
      out.name = nonEmptyValue(raw, '--name=');
      continue;
    }
    if (action === 'promote' && raw.startsWith('--k=')) {
      const value = Number(nonEmptyValue(raw, '--k='));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = value;
      continue;
    }
    if (action === 'promote' && raw.startsWith('--mode=')) {
      out.mode = parseSearchMode(raw);
      continue;
    }
    if (action === 'promote' && raw === '--gate') {
      out.gate = true;
      continue;
    }
    if (action === 'promote' && raw.startsWith('--fixture=')) {
      out.fixture = nonEmptyValue(raw, '--fixture=');
      continue;
    }
    if (action === 'promote' && raw === '--yes') {
      out.yes = true;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }

  return out as unknown as FeedbackArgs;
}

function writeFeedbackAddResult(
  entry: FeedbackLedgerEntry,
  ledgerPath: string,
  format: 'md' | 'json',
): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ ledger_path: ledgerPath, entry }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Recorded feedback ${entry.id}\n\n` +
    `- KB: ${entry.kb}\n` +
    `- Query: ${entry.query}\n` +
    `- Source: ${entry.source}\n` +
    `- Verdict: ${entry.verdict} (${entry.relevance})\n` +
    `- Ledger: ${ledgerPath}\n`,
  );
}

function writeFeedbackListResult(
  entries: readonly FeedbackLedgerEntry[],
  ledgerPath: string,
  format: 'md' | 'json',
): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ ledger_path: ledgerPath, entries }, null, 2)}\n`);
    return;
  }
  const lines = [`# kb feedback`, '', `Ledger: ${ledgerPath}`, '', `Entries: ${entries.length}`, ''];
  for (const entry of entries) {
    lines.push(`- ${entry.created_at} ${entry.verdict}(${entry.relevance}) ${entry.source}`);
    lines.push(`  query: ${entry.query}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Read-only: reads the ledger once and never writes or creates it. */
export async function buildFeedbackSummaryReport(
  kbDir: string,
  args: { kb: string; query?: string; top: number },
): Promise<FeedbackSummaryReport> {
  const { entries, malformedLineCount } = await readFeedbackLedgerWithStats(kbDir);
  const matching = args.query === undefined ? entries : entries.filter((entry) => entry.query === args.query);
  return {
    schema_version: FEEDBACK_SUMMARY_SCHEMA_VERSION,
    kb: args.kb,
    ledger_path: feedbackLedgerPath(kbDir),
    query: args.query ?? null,
    top: args.top,
    malformed_line_count: malformedLineCount,
    ...summarizeFeedbackEntries(matching, { top: args.top }),
  };
}

export function renderFeedbackSummaryMarkdown(report: FeedbackSummaryReport): string {
  const v = report.verdict_counts;
  const lines = ['# kb feedback summary', '', `Ledger: ${report.ledger_path}`];
  if (report.query !== null) lines.push(`Query: ${report.query}`);
  lines.push(
    '',
    `- Entries: ${report.total_entries} (${report.distinct_queries} queries, ${report.distinct_sources} sources)`,
    `- Relevant share: ${report.relevant_share === null
      ? 'n/a'
      : `${(report.relevant_share * 100).toFixed(1)}% (${v.relevant}/${report.total_entries})`}`,
    `- Mean relevance: ${report.mean_relevance === null ? 'n/a' : report.mean_relevance.toFixed(2)} (0..3)`,
    `- Verdicts: relevant ${v.relevant}, irrelevant ${v.irrelevant}, stale ${v.stale}, misleading ${v.misleading}`,
    `- Skipped malformed lines: ${report.malformed_line_count}`,
    '',
    '## Groups',
    '',
  );
  if (report.group_counts.length === 0) lines.push('No group labels.');
  for (const { group, count } of report.group_counts) lines.push(`- ${group}: ${count}`);
  lines.push('', `## Most-flagged sources (top ${report.top})`, '');
  if (report.top_flagged_sources.length === 0) lines.push('No flagged sources.');
  for (const source of report.top_flagged_sources) {
    const c = source.verdict_counts;
    lines.push(
      `- ${source.source}: ${source.flagged_count} flagged ` +
      `(irrelevant ${c.irrelevant}, stale ${c.stale}, misleading ${c.misleading}; relevant ${c.relevant}), ` +
      `last ${source.last_flagged_at}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function writeFeedbackPromotePreview(
  parsed: FeedbackPromoteArgs,
  fixture: PromotedFixture,
  format: 'md' | 'json',
): void {
  const yamlText = dumpPromotedEvalFixture(fixture);
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({
      query: parsed.query,
      fixture_path: parsed.fixture ?? null,
      wrote: false,
      fixture_yaml: yamlText,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(yamlText);
}

function writeFeedbackPromoteWriteResult(
  parsed: FeedbackPromoteArgs,
  result: { caseCount: number; created: boolean },
  format: 'md' | 'json',
): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({
      fixture_path: parsed.fixture,
      wrote: true,
      created: result.created,
      case_count: result.caseCount,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Updated ${path.resolve(parsed.fixture!)}\n\n` +
    `- Created: ${result.created ? 'yes' : 'no'}\n` +
    `- Cases: ${result.caseCount}\n`,
  );
}

function parseVerdict(value: string): FeedbackVerdict {
  if (value === 'relevant' || value === 'irrelevant' || value === 'stale' || value === 'misleading') {
    return value;
  }
  throw new Error(`invalid --verdict: ${JSON.stringify(value)}`);
}

function parseSearchMode(raw: string): SearchMode {
  const value = nonEmptyValue(raw, '--mode=');
  if (value !== 'dense' && value !== 'lexical' && value !== 'hybrid' && value !== 'auto') {
    throw new Error(`invalid --mode: ${raw}`);
  }
  return value;
}

function parseBoundedNumber(raw: string, prefix: string, min: number, max: number): number {
  const value = Number(nonEmptyValue(raw, prefix));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`invalid ${prefix.slice(0, -1)}: ${raw}`);
  }
  return value;
}

function nonEmptyValue(raw: string, prefix: string): string {
  const value = raw.slice(prefix.length);
  if (value.length === 0) throw new Error(`${prefix}<value> requires a non-empty value`);
  return value;
}
