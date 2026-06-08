// RFC 020 §5/§7 — the e2e RAG eval scorecard.
//
// Acceptance metric (milestone M4): "e2e scorecard recorded on held-out
// gold-bearing QA; panel self-consistency confidence + per-judge probe-measured
// bias coefficients reported (no human labels)."
//
// This module assembles a CascadeOutcome into a single reproducible scorecard
// and renders it to markdown. Per §7 provenance it records the panel
// composition (each judge family + model), the self-consistency K, the
// calibration method, and the per-judge bias coefficients alongside every score
// so cross-run comparisons are only made within the same eval configuration.
// Pure assembly + rendering — unit-testable on a synthetic outcome, no network.

import type { CascadeOutcome, ItemDecision } from './cascade.js';
import type { JudgeBiasProfile } from './bias-probes.js';

export const RAG_SCORECARD_SCHEMA_VERSION = 'kb.rag-eval-scorecard.v1';

export interface PanelComposition {
  /** judge name → model family. */
  judges: Array<{ name: string; family: string }>;
  distinctFamilies: number;
  selfConsistencyK: number;
  calibrationMethod: string | null;
  abstentionThreshold: number;
}

export interface ScorecardConfigProvenance {
  provider: string | null;
  embeddingModel: string | null;
  answererModel: string | null;
  thresholds: Record<string, number>;
  tier2Families: { entailment: string | null; semantic: string | null };
}

export interface BuildScorecardInput {
  generatedAt: string;
  gitSha: string;
  datasets: string[];
  outcome: CascadeOutcome;
  panel: PanelComposition;
  config: ScorecardConfigProvenance;
  caveats?: string[];
}

export interface RagScorecard {
  schema_version: typeof RAG_SCORECARD_SCHEMA_VERSION;
  generated_at: string;
  git_sha: string;
  datasets: string[];
  config: ScorecardConfigProvenance;
  panel: PanelComposition;
  tier1: CascadeOutcome['reference'];
  routing: {
    items: number;
    tier1Decided: number;
    tier2Decided: number;
    tier3Decided: number;
    tier3Abstained: number;
    pending: number;
  };
  /** Overall correctness over items that received a verdict (excludes pending). */
  correctness: { scored: number; correct: number; accuracy: number | null };
  panelConfidence: {
    meanSelfConsistency: number | null;
    meanCalibratedConfidence: number | null;
    abstentionRate: number | null;
  };
  /** Per-judge probe-measured bias coefficients (§5 Tier 4). */
  biasProfiles: JudgeBiasProfile[];
  decisions: ItemDecision[];
  caveats: string[];
}

export function buildScorecard(input: BuildScorecardInput): RagScorecard {
  const { outcome } = input;
  const scored = outcome.decisions.filter((d) => d.correct !== null);
  const correct = scored.filter((d) => d.correct === true).length;

  const panelItems = outcome.panelItems;
  const panelConfidence = {
    meanSelfConsistency: panelItems.length === 0
      ? null
      : round(mean(panelItems.map((p) => p.selfConsistencyAgreement))),
    meanCalibratedConfidence: panelItems.length === 0
      ? null
      : round(mean(panelItems.map((p) => p.calibratedConfidence))),
    abstentionRate: panelItems.length === 0
      ? null
      : round(panelItems.filter((p) => p.abstained).length / panelItems.length),
  };

  return {
    schema_version: RAG_SCORECARD_SCHEMA_VERSION,
    generated_at: input.generatedAt,
    git_sha: input.gitSha,
    datasets: input.datasets,
    config: input.config,
    panel: input.panel,
    tier1: outcome.reference,
    routing: {
      items: outcome.decisions.length,
      tier1Decided: outcome.tier1Decided,
      tier2Decided: outcome.tier2Decided,
      tier3Decided: outcome.tier3Decided,
      tier3Abstained: outcome.tier3Abstained,
      pending: outcome.pending,
    },
    correctness: {
      scored: scored.length,
      correct,
      accuracy: scored.length === 0 ? null : round(correct / scored.length),
    },
    panelConfidence,
    biasProfiles: outcome.biasProfiles,
    decisions: outcome.decisions,
    caveats: input.caveats ?? defaultScorecardCaveats(input),
  };
}

export function defaultScorecardCaveats(input: BuildScorecardInput): string[] {
  const caveats = [
    'Human-label-free: correctness comes from gold-bearing QA + automated cross-checks (RFC 020 §5), never human annotation.',
    'Deterministic-first cascade: Tier 1 (gold EM/F1 + context recall/precision) carries the weight; the judge panel only adjudicates the residue.',
  ];
  if (input.outcome.pending > 0) {
    caveats.push(
      `${input.outcome.pending} item(s) are PENDING — a downstream tier (NLI/semantic models or the live judge panel) was not wired in this run; ` +
        'no decision was fabricated for them. A full run needs real datasets, an NLI checkpoint, a BERTScore/COMET model, and ≥3 live judge families.',
    );
  }
  if (input.panel.distinctFamilies > 0 && input.panel.distinctFamilies < 3) {
    caveats.push(`Panel has only ${input.panel.distinctFamilies} distinct family(ies); the RFC requires ≥3 for bias cancellation.`);
  }
  return caveats;
}

export function formatScorecardMarkdown(scorecard: RagScorecard): string {
  const lines: string[] = [
    '# End-to-end RAG eval scorecard — human-label-free',
    '',
    'Four-tier cascade (RFC 020 §5, milestone M4). No human-annotated labels.',
    '',
    `- Datasets: ${scorecard.datasets.length > 0 ? scorecard.datasets.join(', ') : '(none)'}`,
    `- Provider/model: ${scorecard.config.provider ?? '(unset)'} / ${scorecard.config.embeddingModel ?? '(default)'}`,
    `- Answerer (kb ask LLM): ${scorecard.config.answererModel ?? '(unset)'}`,
    `- git SHA: ${scorecard.git_sha}`,
    '',
    '## Tier 1 — deterministic reference metrics',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Items | ${scorecard.tier1.items} |`,
    `| Exact-match | ${fmt(scorecard.tier1.exactMatch)} |`,
    `| Token-F1 | ${fmt(scorecard.tier1.tokenF1)} |`,
    `| Context recall | ${fmtNullable(scorecard.tier1.contextRecall)} |`,
    `| Context precision | ${fmtNullable(scorecard.tier1.contextPrecision)} |`,
    `| Items with gold facts | ${scorecard.tier1.itemsWithGoldFacts} |`,
    '',
    '## Cascade routing (deterministic-first)',
    '',
    '| Decided by | Items |',
    '| --- | ---: |',
    `| Tier 1 (deterministic) | ${scorecard.routing.tier1Decided} |`,
    `| Tier 2 (NLI + semantic) | ${scorecard.routing.tier2Decided} |`,
    `| Tier 3 (judge panel) | ${scorecard.routing.tier3Decided} |`,
    `| Tier 3 abstained | ${scorecard.routing.tier3Abstained} |`,
    `| Pending (tier not wired) | ${scorecard.routing.pending} |`,
    '',
    '## Correctness (scored items only)',
    '',
    `- Scored: ${scorecard.correctness.scored} / ${scorecard.routing.items}`,
    `- Correct: ${scorecard.correctness.correct}`,
    `- Accuracy: ${fmtNullable(scorecard.correctness.accuracy)}`,
    '',
    '## Tier 3 — panel self-consistency confidence',
    '',
    `- Distinct judge families: ${scorecard.panel.distinctFamilies} (RFC requires ≥3)`,
    `- Self-consistency K: ${scorecard.panel.selfConsistencyK}`,
    `- Calibration: ${scorecard.panel.calibrationMethod ?? '(none)'}`,
    `- Mean self-consistency: ${fmtNullable(scorecard.panelConfidence.meanSelfConsistency)}`,
    `- Mean calibrated confidence: ${fmtNullable(scorecard.panelConfidence.meanCalibratedConfidence)}`,
    `- Abstention rate: ${fmtNullable(scorecard.panelConfidence.abstentionRate)}`,
    '',
    '## Tier 4 — per-judge probe-measured bias coefficients',
    '',
  ];

  if (scorecard.biasProfiles.length === 0) {
    lines.push('No bias probes run (judge panel not wired in this run).');
  } else {
    lines.push(
      '| Judge | Family | Position flip | Verbosity | Self-pref | Bias coef | Dropped |',
      '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    );
    for (const profile of scorecard.biasProfiles) {
      lines.push([
        profile.judge,
        profile.family,
        fmt(profile.positionBias),
        signed(profile.verbosityBias),
        signed(profile.selfPreferenceBias),
        signed(profile.biasCoefficient),
        profile.dropped ? `yes (${profile.dropReason ?? ''})` : 'no',
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
  }

  if (scorecard.routing.pending > 0) {
    lines.push(
      '',
      '> **Partial run.** Some items are pending because a downstream tier was not',
      '> wired (no NLI/semantic checkpoint or no live judge panel in this',
      "> environment). No verdict was fabricated for them — see benchmarks/rag-eval/README.md.",
    );
  }

  lines.push('', '## Caveats', '');
  for (const caveat of scorecard.caveats) lines.push(`- ${caveat}`);
  return `${lines.join('\n')}\n`;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function fmt(value: number): string {
  return value.toFixed(4);
}

function fmtNullable(value: number | null): string {
  return value === null ? '—' : value.toFixed(4);
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}
