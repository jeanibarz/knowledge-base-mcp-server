import * as fsp from 'fs/promises';
import yaml from 'js-yaml';
import { FaissIndexManager } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  resolveActiveModel,
} from './active-model.js';
import { computeStaleness, type SearchMode } from './cli-search.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import {
  evaluateRetrievalCase,
  formatRetrievalEvalMarkdown,
  normalizeRetrievalEvalFixture,
  retrieveForRetrievalEvalCase,
  retrievalEvalExitCode,
  summarizeRetrievalEval,
  type RetrievalEvalAggregateRankedMetrics,
  type RetrievalEvalAggregateDiversityMetrics,
  type RetrievalEvalDiversityMetrics,
  type RetrievalEvalFixture,
  type RetrievalEvalRankedMetrics,
} from './retrieval-eval.js';

interface EvalArgs {
  fixturePath: string | null;
  model?: string;
  format: 'md' | 'json';
  k: number;
  threshold: number;
  mode?: SearchMode;
}

const DEFAULT_K = 10;
const DEFAULT_THRESHOLD = 2;

export const EVAL_HELP = `kb eval — run fixture-driven retrieval checks

Usage:
  kb eval <fixture.yml|json> [--model=<id>] [--k=<int>] [--threshold=<float>]
                              [--mode=dense|lexical|hybrid|auto] [--format=md|json]

Reads cases from a YAML or JSON fixture and runs each query against the
active model's index. Each case can set \`query\`, optional \`kb\`,
\`required_sources\`, \`forbidden_sources\`, \`expected_metadata\`,
\`relevant_sources\`/\`judgments\`, optional judgement \`groups\`/\`intents\`,
\`max_duplicate_groups\`, \`stale_policy\`, and \`gate\`.

Failing ungated cases print warnings and exit 0; failing GATED cases
exit 1, suitable for CI gates.

Arguments:
  <fixture.yml|json>    Path to fixture file. Format inferred from extension.

Options:
  --model=<id>          Override the active model for the run (RFC 013).
  --k=<int>             Top-K results per case (default: ${DEFAULT_K}).
  --threshold=<float>   Max similarity score; lower = closer (default: ${DEFAULT_THRESHOLD}).
                        Dense-only; lexical and hybrid modes ignore it.
  --mode=dense|lexical|hybrid|auto
                        Retrieval mode (default: dense). Fixture-level mode
                        sets a default; case-level mode overrides both.
  --format=md|json      Output format (default: md).
  --help, -h            Show this help.

Fixture example (YAML):
  gate: false
  cases:
    - name: deployment runbook
      query: rollback procedure
      kb: work
      gate: true
      required_sources: [runbooks/deploy.md]
      forbidden_sources: [archive/old-deploy.md]
      expected_metadata:
        frontmatter.status: approved
      relevant_sources:
        - source: runbooks/deploy.md
          relevance: 3
          intent: procedure
      max_duplicate_groups: 1
      stale_policy: fresh
`;

export async function runEval(rest: string[]): Promise<number> {
  let parsed: EvalArgs;
  try {
    parsed = parseEvalArgs(rest);
  } catch (err) {
    process.stderr.write(`kb eval: ${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.fixturePath === null) {
    process.stderr.write('kb eval: missing <fixture> or --fixture=<path>\n');
    return 2;
  }

  let fixture: RetrievalEvalFixture;
  try {
    fixture = await loadEvalFixture(parsed.fixturePath);
  } catch (err) {
    process.stderr.write(`kb eval: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    await FaissIndexManager.bootstrapLayout();
  } catch (err) {
    process.stderr.write(`kb eval: layout bootstrap failed: ${(err as Error).message}\n`);
    return 1;
  }

  let activeModelId: string;
  try {
    activeModelId = await resolveActiveModel({ explicitOverride: parsed.model });
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      process.stderr.write(`kb eval: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`kb eval: ${(err as Error).message}\n`);
    return 1;
  }

  let manager: FaissIndexManager;
  try {
    manager = await loadManagerForModel(activeModelId);
    await loadWithJsonRetry(manager);
  } catch (err) {
    process.stderr.write(`kb eval: ${(err as Error).message}\n`);
    return 1;
  }

  const results = [];
  for (const fixtureCase of fixture.cases) {
    try {
      const requestedMode = fixtureCase.mode ?? parsed.mode ?? fixture.mode ?? 'dense';
      const search = await retrieveForRetrievalEvalCase(fixtureCase, {
        manager,
        defaultK: parsed.k,
        defaultThreshold: parsed.threshold,
      }, requestedMode);
      const staleness = await computeStaleness(activeModelId, fixtureCase.kb);
      results.push(evaluateRetrievalCase(fixtureCase, search.results, staleness, fixture.gate, search));
    } catch (err) {
      process.stderr.write(`kb eval: ${fixtureCase.name}: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const report = summarizeRetrievalEval(results);
  if (parsed.format === 'json') {
    process.stdout.write(`${JSON.stringify(toJsonReport(report), null, 2)}\n`);
  } else {
    process.stdout.write(formatRetrievalEvalMarkdown(report));
  }
  return retrievalEvalExitCode(report);
}

export function parseEvalArgs(rest: string[]): EvalArgs {
  const out: EvalArgs = {
    fixturePath: null,
    format: 'md',
    k: DEFAULT_K,
    threshold: DEFAULT_THRESHOLD,
  };

  for (const raw of rest) {
    if (raw.startsWith('--fixture=')) {
      const value = raw.slice('--fixture='.length);
      if (value.length === 0) throw new Error('--fixture=<path> requires a non-empty value');
      out.fixturePath = value;
      continue;
    }
    if (raw.startsWith('--model=')) {
      out.model = raw.slice('--model='.length);
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = value;
      continue;
    }
    if (raw.startsWith('--mode=')) {
      const value = raw.slice('--mode='.length);
      if (value !== 'dense' && value !== 'lexical' && value !== 'hybrid' && value !== 'auto') {
        throw new Error(`invalid --mode: ${raw} (expected 'dense', 'lexical', 'hybrid', or 'auto')`);
      }
      out.mode = value;
      continue;
    }
    if (raw.startsWith('--k=')) {
      const value = Number(raw.slice('--k='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = value;
      continue;
    }
    if (raw.startsWith('--threshold=')) {
      const value = Number(raw.slice('--threshold='.length));
      if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid --threshold: ${raw}`);
      out.threshold = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    if (out.fixturePath !== null) throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
    out.fixturePath = raw;
  }

  return out;
}

async function loadEvalFixture(fixturePath: string): Promise<RetrievalEvalFixture> {
  const raw = await fsp.readFile(fixturePath, 'utf-8');
  const parsed = fixturePath.endsWith('.json')
    ? JSON.parse(raw) as unknown
    : yaml.load(raw);
  return normalizeRetrievalEvalFixture(parsed);
}

export function toJsonReport(report: ReturnType<typeof summarizeRetrievalEval>): unknown {
  return {
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    gate_failed: report.gateFailed,
    diversity_metrics: toJsonAggregateDiversityMetrics(report.diversityMetrics),
    ...(report.rankedMetrics !== undefined ? {
      ranked_metrics: toJsonAggregateRankedMetrics(report.rankedMetrics),
    } : {}),
    cases: report.cases.map((result) => ({
      name: result.name,
      query: result.query,
      ...(result.kb !== undefined ? { kb: result.kb } : {}),
      gate: result.gate,
      requested_mode: result.requestedMode,
      effective_mode: result.effectiveMode,
      ...(result.autoMode !== undefined ? { auto_mode: result.autoMode } : {}),
      passed: result.passed,
      failures: result.failures,
      warnings: result.warnings,
      result_count: result.resultCount,
      duplicate_groups: result.duplicateGroups,
      diversity_metrics: toJsonDiversityMetrics(result.diversityMetrics),
      ...(result.rankedMetrics !== undefined ? {
        ranked_metrics: toJsonRankedMetrics(result.rankedMetrics),
      } : {}),
    })),
  };
}

function toJsonDiversityMetrics(metrics: RetrievalEvalDiversityMetrics): unknown {
  return {
    source: {
      k: metrics.source.k,
      result_count: metrics.source.resultCount,
      unique_source_count_at_k: metrics.source.uniqueSourceCountAtK,
      duplicate_source_groups_at_k: metrics.source.duplicateSourceGroupsAtK,
      max_source_share_at_k: metrics.source.maxSourceShareAtK,
    },
    ...(metrics.intent !== undefined ? {
      intent: {
        k: metrics.intent.k,
        group_count: metrics.intent.groupCount,
        retrieved_group_count_at_k: metrics.intent.retrievedGroupCountAtK,
        intent_recall_at_k: metrics.intent.intentRecallAtK,
        alpha_ndcg_at_k: metrics.intent.alphaNdcgAtK,
      },
    } : {}),
  };
}

function toJsonRankedMetrics(metrics: RetrievalEvalRankedMetrics): unknown {
  return {
    k: metrics.k,
    judged_relevant_count: metrics.judgedRelevantCount,
    retrieved_relevant_count: metrics.retrievedRelevantCount,
    ndcg_at_10: metrics.ndcgAt10,
    mrr_at_10: metrics.mrrAt10,
    recall_at_k: metrics.recallAtK,
    precision_at_k: metrics.precisionAtK,
    map: metrics.map,
    map_at_k: metrics.mapAtK,
    hit_rate: metrics.hitRate,
  };
}

function toJsonAggregateDiversityMetrics(metrics: RetrievalEvalAggregateDiversityMetrics): unknown {
  return {
    source: {
      case_count: metrics.source.caseCount,
      unique_source_count_at_k: metrics.source.uniqueSourceCountAtK,
      duplicate_source_groups_at_k: metrics.source.duplicateSourceGroupsAtK,
      max_source_share_at_k: metrics.source.maxSourceShareAtK,
    },
    ...(metrics.intent !== undefined ? {
      intent: {
        case_count: metrics.intent.caseCount,
        intent_recall_at_k: metrics.intent.intentRecallAtK,
        alpha_ndcg_at_k: metrics.intent.alphaNdcgAtK,
      },
    } : {}),
  };
}

function toJsonAggregateRankedMetrics(metrics: RetrievalEvalAggregateRankedMetrics): unknown {
  return {
    judged_case_count: metrics.judgedCaseCount,
    ndcg_at_10: metrics.ndcgAt10,
    mrr_at_10: metrics.mrrAt10,
    recall_at_k: metrics.recallAtK,
    precision_at_k: metrics.precisionAtK,
    map: metrics.map,
    map_at_k: metrics.mapAtK,
    hit_rate: metrics.hitRate,
  };
}
