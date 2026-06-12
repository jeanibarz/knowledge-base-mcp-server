// RFC 020 milestone M5 (issue #565) — take ONE Tier-1 technique through the full
// harness and produce a documented ship/no-ship decision backed by evidence.
//
// The Tier-1 candidate adjudicated here is the **reranker upgrade** (the default
// cross-encoder `Xenova/ms-marco-MiniLM-L-6-v2` → a stronger model such as
// `BAAI/bge-reranker-v2-m3` / `Qwen3-Reranker`), selectable through the existing
// `KB_RERANK_MODEL` plug point. Per RFC §9 the upgrade is NOT a universal win —
// the KB survey found cross-encoders *degrade* high-precision/lexical domains
// (code, skills). So the upgrade ships only behind:
//
//   (a) a **per-domain measurement gate** — measure nDCG@10 per domain, not just
//       the BEIR mean, and enable rerank only where it significantly improves;
//   (b) a **skip-rerank fallback** — domains where it regresses (or shows no
//       significant gain) are added to `KB_RERANK_SKIP_DOMAINS` and keep the
//       cheaper, un-reranked path.
//
// This module is the adjudicator. It consumes:
//   - per-domain BEIR per-query nDCG@10 vectors (baseline reranker vs candidate
//     reranker), compared with the §3 significance machinery (paired bootstrap /
//     t-test + Bonferroni/Holm family correction, wild-cluster when clustered);
//   - the §5 human-label-free e2e RAG veto numbers (faithfulness / answer
//     correctness), which hard-veto a ship even when BEIR improves.
//
// It emits a structured decision (`ship` / `ship-gated` / `no-ship`), the
// resulting per-domain policy (which domains enable rerank, which skip), the
// recommended `KB_RERANK_MODEL` + `KB_RERANK_SKIP_DOMAINS` config to realize it,
// and a markdown adjudication report.
//
// Honesty contract (issue #565 step 4): this module never fabricates a benchmark
// number. A real run needs BEIR datasets + a real embedding model + the candidate
// cross-encoder + (for the e2e leg) live judges. Where any of those is missing
// the adjudication is marked **provisional** and the missing evidence is listed
// in `pending` — the decision machinery + unit tests still ship, and the report
// self-describes what is outstanding.

import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  compareSamples,
  compareFamily,
  loadRunScores,
  pairScores,
  type ComparisonResult,
  type CorrectionMethod,
  type PerQueryScore,
  type Verdict,
  DEFAULT_ALPHA,
} from '../significance.js';

export const DEFAULT_BASELINE_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
export const DEFAULT_CANDIDATE_RERANK_MODEL = 'BAAI/bge-reranker-v2-m3';
// A drop larger than this on a §5 e2e metric vetoes the ship (RFC §5 — "a
// retrieval gain that drops faithfulness/correctness does not ship").
export const DEFAULT_E2E_VETO_TOLERANCE = 0.01;

export type DomainAction = 'enable' | 'skip';
export type ShipDecision = 'ship' | 'ship-gated' | 'no-ship';

/** Per-domain BEIR evidence: paired per-query nDCG@10 for baseline vs candidate. */
export interface DomainEvidence {
  /** Domain/dataset name; also the value that lands on KB_RERANK_SKIP_DOMAINS. */
  domain: string;
  /** Retrieval mode (informational, e.g. `hybrid+rerank`). */
  mode?: string | null;
  baseline: readonly PerQueryScore[];
  candidate: readonly PerQueryScore[];
}

export interface DomainAdjudication {
  domain: string;
  mode: string | null;
  n: number;
  meanDelta: number;
  rawPValue: number;
  adjustedPValue: number;
  /** Verdict after family-wise multiple-comparison correction (§3). */
  verdict: Verdict;
  action: DomainAction;
  rationale: string;
}

/** One §5 e2e metric the candidate must not regress past tolerance. */
export interface E2eMetricInput {
  metric: string;
  baseline: number;
  candidate: number;
  /** Allowed drop before the veto fires. Defaults to DEFAULT_E2E_VETO_TOLERANCE. */
  tolerance?: number;
}

export interface E2eVeto {
  metric: string;
  baseline: number;
  candidate: number;
  tolerance: number;
  delta: number;
  vetoed: boolean;
}

export interface AdjudicateRerankInput {
  candidateModel: string;
  baselineModel: string;
  domains: readonly DomainEvidence[];
  e2e?: readonly E2eMetricInput[];
  correction?: CorrectionMethod;
  alpha?: number;
  /** Use the wild-cluster bootstrap-t per domain (queries cluster by dataset). */
  clusterByDataset?: boolean;
  /** Outstanding evidence that makes the decision provisional (never fabricated). */
  pending?: readonly string[];
  /** Force the provisional flag even if `pending` is empty (e.g. fake-provider runs). */
  provisional?: boolean;
}

export interface RerankAdjudication {
  schema_version: 'kb.rerank-adjudication.v1';
  candidateModel: string;
  baselineModel: string;
  decision: ShipDecision;
  correction: CorrectionMethod;
  alpha: number;
  domains: DomainAdjudication[];
  enabledDomains: string[];
  skipDomains: string[];
  e2e: E2eVeto[];
  e2eVetoed: boolean;
  provisional: boolean;
  pending: string[];
  recommendedConfig: { KB_RERANK_MODEL: string; KB_RERANK_SKIP_DOMAINS: string };
  meanDelta: number | null;
  summary: string;
}

/**
 * Adjudicate the reranker upgrade across domains + the e2e veto. Pure and
 * deterministic (the significance bootstrap is seeded), so the same evidence
 * always yields the same decision — the property the unit tests and a
 * reproducible report both depend on.
 */
export function adjudicateRerank(input: AdjudicateRerankInput): RerankAdjudication {
  const correction: CorrectionMethod = input.correction ?? 'holm';
  const alpha = input.alpha ?? DEFAULT_ALPHA;

  // 1. Per-domain significance comparison (§3), then family correction across
  //    the domains so comparing many at once does not inflate false positives.
  const comparisons: ComparisonResult[] = input.domains.map((domain) => {
    const { samples } = pairScores(domain.baseline, domain.candidate);
    return compareSamples(samples, {
      label: domain.domain,
      alpha,
      clusterByDataset: input.clusterByDataset ?? false,
    });
  });
  const family = compareFamily(comparisons, correction, alpha);

  // 2. Per-domain gate (§9): enable rerank only where it is a *significant*
  //    improvement; skip everywhere else (regression, no-significant-change, or
  //    inconclusive-below-noise-floor), because the cross-encoder costs latency
  //    and the KB survey shows it can silently degrade high-precision/lexical
  //    corpora.
  const domains: DomainAdjudication[] = family.comparisons.map((comparison, index) => {
    const evidence = input.domains[index];
    const verdict = comparison.correctedVerdict;
    const action: DomainAction = verdict === 'improvement' ? 'enable' : 'skip';
    return {
      domain: evidence.domain,
      mode: evidence.mode ?? null,
      n: comparison.n,
      meanDelta: round(comparison.meanDelta),
      rawPValue: comparison.wildCluster?.pValue ?? comparison.pValue,
      adjustedPValue: comparison.adjustedPValue,
      verdict,
      action,
      rationale: domainRationale(verdict, comparison.meanDelta),
    };
  });

  const enabledDomains = domains.filter((d) => d.action === 'enable').map((d) => d.domain);
  const skipDomains = domains.filter((d) => d.action === 'skip').map((d) => d.domain);

  // 3. §5 e2e veto — a faithfulness/correctness regression past tolerance kills
  //    the ship regardless of BEIR gains (the hard product-protection veto).
  const e2e: E2eVeto[] = (input.e2e ?? []).map((metric) => {
    const tolerance = metric.tolerance ?? DEFAULT_E2E_VETO_TOLERANCE;
    const delta = round(metric.candidate - metric.baseline);
    return {
      metric: metric.metric,
      baseline: metric.baseline,
      candidate: metric.candidate,
      tolerance,
      delta,
      vetoed: metric.candidate < metric.baseline - tolerance,
    };
  });
  const e2eVetoed = e2e.some((v) => v.vetoed);

  // 4. Overall decision.
  const decision: ShipDecision = e2eVetoed
    ? 'no-ship'
    : enabledDomains.length === 0
      ? 'no-ship'
      : skipDomains.length === 0
        ? 'ship'
        : 'ship-gated';

  const pending = [...(input.pending ?? [])];
  const provisional = (input.provisional ?? false) || pending.length > 0;

  const shipped = decision !== 'no-ship';
  const recommendedConfig = {
    KB_RERANK_MODEL: shipped ? input.candidateModel : input.baselineModel,
    // On a ship/ship-gated, the skip list is the domains the gate excluded. On a
    // no-ship there is nothing to gate (we stay on the baseline model).
    KB_RERANK_SKIP_DOMAINS: shipped ? skipDomains.join(',') : '',
  };

  const meanDelta = domains.length === 0
    ? null
    : round(domains.reduce((sum, d) => sum + d.meanDelta, 0) / domains.length);

  return {
    schema_version: 'kb.rerank-adjudication.v1',
    candidateModel: input.candidateModel,
    baselineModel: input.baselineModel,
    decision,
    correction,
    alpha,
    domains,
    enabledDomains,
    skipDomains,
    e2e,
    e2eVetoed,
    provisional,
    pending,
    recommendedConfig,
    meanDelta,
    summary: buildSummary({
      decision,
      domainsMeasured: domains.length,
      enabledDomains,
      skipDomains,
      e2eVetoed,
      provisional,
    }),
  };
}

function domainRationale(verdict: Verdict, meanDelta: number): string {
  switch (verdict) {
    case 'improvement':
      return `significant nDCG@10 gain (Δ=${signed(meanDelta)}) after family correction → enable rerank`;
    case 'regression':
      return `significant nDCG@10 regression (Δ=${signed(meanDelta)}) → skip-rerank fallback (RFC §9)`;
    default:
      return `no significant change (Δ=${signed(meanDelta)}) → skip (rerank latency unjustified without a measured gain)`;
  }
}

function buildSummary(parts: {
  decision: ShipDecision;
  domainsMeasured: number;
  enabledDomains: readonly string[];
  skipDomains: readonly string[];
  e2eVetoed: boolean;
  provisional: boolean;
}): string {
  const prefix = parts.provisional ? 'PROVISIONAL ' : '';
  if (parts.decision === 'no-ship') {
    const why = parts.e2eVetoed
      ? 'the e2e RAG veto fired (faithfulness/correctness regressed past tolerance)'
      : parts.domainsMeasured === 0
        ? 'no per-domain BEIR evidence was supplied — the load-bearing runs are pending'
        : 'no domain showed a significant nDCG@10 improvement';
    return `${prefix}NO-SHIP — ${why}; stay on the baseline reranker.`;
  }
  const enabled = parts.enabledDomains.join(', ') || '(none)';
  if (parts.decision === 'ship') {
    return `${prefix}SHIP — every measured domain improved significantly and the e2e veto passed; enable the candidate on: ${enabled}.`;
  }
  const skipped = parts.skipDomains.join(', ') || '(none)';
  return `${prefix}SHIP-GATED — enable the candidate on [${enabled}] and keep the skip-rerank fallback on [${skipped}] (RFC §9 per-domain gate); e2e veto passed.`;
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

export function renderAdjudicationMarkdown(adjudication: RerankAdjudication): string {
  const lines: string[] = [
    '# Reranker upgrade adjudication — RFC 020 M5 (issue #565)',
    '',
    `**Decision: ${adjudication.decision.toUpperCase()}**${adjudication.provisional ? ' _(provisional)_' : ''}`,
    '',
    adjudication.summary,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Candidate reranker | \`${adjudication.candidateModel}\` |`,
    `| Baseline reranker | \`${adjudication.baselineModel}\` |`,
    `| Multiple-comparison correction | ${adjudication.correction} (α=${adjudication.alpha}) |`,
    `| Domains measured | ${adjudication.domains.length} |`,
    `| e2e veto | ${adjudication.e2eVetoed ? 'TRIGGERED' : adjudication.e2e.length > 0 ? 'passed' : 'not measured'} |`,
    '',
    '## Per-domain gate (§3 significance + §9 per-domain measurement)',
    '',
  ];

  if (adjudication.domains.length === 0) {
    lines.push('_No per-domain BEIR evidence supplied — see pending evidence below._', '');
  } else {
    lines.push(
      '| Domain | Mode | n | Mean ΔnDCG@10 | adj p | Verdict | Action |',
      '| --- | --- | ---: | ---: | ---: | --- | --- |',
    );
    for (const d of adjudication.domains) {
      lines.push([
        d.domain,
        d.mode ?? '-',
        String(d.n),
        signed(d.meanDelta),
        formatP(d.adjustedPValue),
        d.verdict.toUpperCase(),
        d.action === 'enable' ? 'ENABLE rerank' : 'SKIP (fallback)',
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
  }

  lines.push('## End-to-end RAG veto (§5)', '');
  if (adjudication.e2e.length === 0) {
    lines.push('_No e2e metrics supplied — the §5 veto is PENDING (needs gold-QA answers + the judge panel)._', '');
  } else {
    lines.push(
      '| Metric | Baseline | Candidate | Δ | Tolerance | Veto |',
      '| --- | ---: | ---: | ---: | ---: | --- |',
    );
    for (const v of adjudication.e2e) {
      lines.push([
        v.metric,
        v.baseline.toFixed(4),
        v.candidate.toFixed(4),
        signed(v.delta),
        `−${v.tolerance.toFixed(4)}`,
        v.vetoed ? '**VETO**' : 'ok',
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
  }

  lines.push(
    '## Recommended configuration',
    '',
    'To realize this decision through the production plug points:',
    '',
    '```bash',
    `export KB_RERANK=on`,
    `export KB_RERANK_MODEL=${adjudication.recommendedConfig.KB_RERANK_MODEL}`,
    adjudication.recommendedConfig.KB_RERANK_SKIP_DOMAINS !== ''
      ? `export KB_RERANK_SKIP_DOMAINS=${adjudication.recommendedConfig.KB_RERANK_SKIP_DOMAINS}`
      : `# KB_RERANK_SKIP_DOMAINS: (none — no domain was gated out)`,
    '```',
    '',
  );

  if (adjudication.pending.length > 0) {
    lines.push('## Pending evidence (decision is provisional)', '');
    for (const item of adjudication.pending) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push(
    '---',
    '',
    'Decision rule: **NO-SHIP** if the §5 e2e veto fires or no domain shows a',
    'significant nDCG@10 gain; **SHIP-GATED** if some domains improve and others',
    'are gated out via the skip-rerank fallback; **SHIP** only if every measured',
    'domain improves and the e2e veto passes. No benchmark number is fabricated —',
    'a provisional decision lists its outstanding evidence above (issue #565).',
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Evidence loading (BEIR run files + e2e scorecards)
// ---------------------------------------------------------------------------

export interface DomainManifestEntry {
  domain: string;
  mode?: string | null;
  baseline: string | string[];
  candidate: string | string[];
}

export interface E2eScorecardVeto {
  /** Scorecard metrics to compare: dotted paths into the RagScorecard. */
  metrics: string[];
  baseline: string;
  candidate: string;
  tolerance?: number;
}

export interface AdjudicationManifest {
  candidateModel?: string;
  baselineModel?: string;
  correction?: CorrectionMethod;
  alpha?: number;
  clusterByDataset?: boolean;
  domains?: DomainManifestEntry[];
  e2e?: E2eMetricInput[];
  e2eScorecards?: E2eScorecardVeto;
  pending?: string[];
  provisional?: boolean;
}

/** Resolve a manifest into a ready-to-adjudicate input (loads run files). */
export async function loadAdjudicationInput(
  manifest: AdjudicationManifest,
  manifestDir: string,
): Promise<AdjudicateRerankInput> {
  const domains: DomainEvidence[] = [];
  for (const entry of manifest.domains ?? []) {
    const baseline = await loadRunScores(toPathList(entry.baseline).map((p) => path.resolve(manifestDir, p)));
    const candidate = await loadRunScores(toPathList(entry.candidate).map((p) => path.resolve(manifestDir, p)));
    domains.push({ domain: entry.domain, mode: entry.mode ?? null, baseline, candidate });
  }

  const e2e: E2eMetricInput[] = [...(manifest.e2e ?? [])];
  if (manifest.e2eScorecards !== undefined) {
    const spec = manifest.e2eScorecards;
    const baselineCard = await readJson(path.resolve(manifestDir, spec.baseline));
    const candidateCard = await readJson(path.resolve(manifestDir, spec.candidate));
    for (const metric of spec.metrics) {
      const baseline = numericAtPath(baselineCard, metric);
      const candidate = numericAtPath(candidateCard, metric);
      if (baseline === null || candidate === null) {
        // A pending/unscored metric is not fabricated — it is skipped and the
        // caller's `pending` list should note it.
        continue;
      }
      e2e.push({ metric, baseline, candidate, ...(spec.tolerance !== undefined ? { tolerance: spec.tolerance } : {}) });
    }
  }

  return {
    candidateModel: manifest.candidateModel ?? DEFAULT_CANDIDATE_RERANK_MODEL,
    baselineModel: manifest.baselineModel ?? DEFAULT_BASELINE_RERANK_MODEL,
    domains,
    e2e,
    ...(manifest.correction !== undefined ? { correction: manifest.correction } : {}),
    ...(manifest.alpha !== undefined ? { alpha: manifest.alpha } : {}),
    ...(manifest.clusterByDataset !== undefined ? { clusterByDataset: manifest.clusterByDataset } : {}),
    ...(manifest.pending !== undefined ? { pending: manifest.pending } : {}),
    ...(manifest.provisional !== undefined ? { provisional: manifest.provisional } : {}),
  };
}

/** Read a dotted numeric path out of a parsed JSON object; null when absent/non-numeric. */
export function numericAtPath(root: unknown, dottedPath: string): number | null {
  let current: unknown = root;
  for (const key of dottedPath.split('.')) {
    if (typeof current !== 'object' || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : null;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(filePath, 'utf-8'));
}

function toPathList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function round(value: number): number {
  return Number(value.toFixed(6));
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

function formatP(value: number): string {
  if (value < 1e-4 && value > 0) return '<0.0001';
  return value.toFixed(4);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  manifestPath: string;
  outputDir: string;
  reportName: string;
  enforceFailures: boolean;
  summaryPath?: string;
  repoRoot: string;
}

export function parseAdjudicateArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const repoRoot = process.cwd();
  const options: CliOptions = {
    manifestPath: '',
    outputDir: path.join(repoRoot, 'benchmarks', 'results', 'adjudication'),
    reportName: 'reranker-adjudication',
    enforceFailures: parseBool(env.BENCH_ADJUDICATION_FAIL),
    summaryPath: env.GITHUB_STEP_SUMMARY,
    repoRoot,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const [flag, inlineValue] = token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined];
    const readValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      const value = argv[i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (flag === '--manifest') {
      options.manifestPath = path.resolve(readValue());
    } else if (flag === '--output-dir') {
      options.outputDir = path.resolve(readValue());
    } else if (flag === '--report-name') {
      options.reportName = readValue();
    } else if (flag === '--fail-on-no-ship') {
      options.enforceFailures = true;
    } else if (flag === '--summary') {
      options.summaryPath = path.resolve(readValue());
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(adjudicateHelpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  if (options.manifestPath === '') throw new Error('adjudicate: --manifest is required');
  return options;
}

function parseBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function adjudicateHelpText(): string {
  return `kb reranker-upgrade adjudicator — RFC 020 M5 (issue #565)

Usage:
  npm run bench:adjudicate -- --manifest benchmarks/results/adjudication/manifest.json

Takes ONE Tier-1 reranker upgrade through the full harness and emits a
ship/no-ship decision: per-domain §3 significance (with Bonferroni/Holm family
correction) + the §5 e2e RAG veto + the §9 per-domain gate / skip-rerank
fallback. Writes <report-name>.json and <report-name>.md under --output-dir.

Manifest (JSON):
  {
    "candidateModel": "BAAI/bge-reranker-v2-m3",
    "baselineModel": "Xenova/ms-marco-MiniLM-L-6-v2",
    "correction": "holm", "alpha": 0.05, "clusterByDataset": false,
    "domains": [
      { "domain": "scifact", "mode": "hybrid+rerank",
        "baseline": "scifact-baseline-results.json",
        "candidate": "scifact-candidate-results.json" }
    ],
    "e2e": [ { "metric": "faithfulness", "baseline": 0.90, "candidate": 0.89, "tolerance": 0.01 } ],
    "e2eScorecards": { "metrics": ["correctness.accuracy"], "baseline": "base.json", "candidate": "cand.json" },
    "pending": ["real BEIR runs outstanding"], "provisional": true
  }

Options:
  --manifest=<path>     Adjudication manifest (required).
  --output-dir=<path>   Report dir. Default: benchmarks/results/adjudication.
  --report-name=<name>  Basename for the .json/.md report. Default: reranker-adjudication.
  --fail-on-no-ship     Exit 1 on a NO-SHIP decision (env: BENCH_ADJUDICATION_FAIL=1).
  --summary=<path>      Append markdown to this file (CI step summary).
`;
}

export interface RunAdjudicateResult {
  adjudication: RerankAdjudication;
  jsonPath: string;
  markdownPath: string;
}

export async function runAdjudicateCli(options: CliOptions): Promise<RunAdjudicateResult> {
  const manifest = (await readJson(options.manifestPath)) as AdjudicationManifest;
  const input = await loadAdjudicationInput(manifest, path.dirname(options.manifestPath));
  const adjudication = adjudicateRerank(input);

  await fsp.mkdir(options.outputDir, { recursive: true });
  const jsonPath = path.join(options.outputDir, `${options.reportName}.json`);
  const markdownPath = path.join(options.outputDir, `${options.reportName}.md`);
  await fsp.writeFile(jsonPath, `${JSON.stringify(adjudication, null, 2)}\n`, 'utf-8');
  const markdown = renderAdjudicationMarkdown(adjudication);
  await fsp.writeFile(markdownPath, markdown, 'utf-8');
  if (options.summaryPath !== undefined) {
    await fsp.appendFile(options.summaryPath, markdown, 'utf-8');
  }
  return { adjudication, jsonPath, markdownPath };
}

async function main(): Promise<void> {
  const options = parseAdjudicateArgs(process.argv.slice(2), process.env);
  const { adjudication, jsonPath, markdownPath } = await runAdjudicateCli(options);
  process.stdout.write(`${jsonPath}\n${markdownPath}\n`);
  process.stdout.write(`decision=${adjudication.decision}${adjudication.provisional ? ' (provisional)' : ''}\n`);
  if (options.enforceFailures && adjudication.decision === 'no-ship') {
    process.exitCode = 1;
  }
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'adjudication', 'adjudicate.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'adjudication', 'adjudicate.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
