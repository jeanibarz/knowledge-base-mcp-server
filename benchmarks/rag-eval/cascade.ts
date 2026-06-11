// RFC 020 §5 — the four-tier cascade orchestrator (deterministic-first).
//
// "The scheme is a four-tier cascade, deterministic-first so the LLM is used
// only where nothing cheaper can decide." This module is the router: it scores
// every item with Tier 1, sends only what Tier 1 cannot conclusively decide to
// Tier 2 (NLI + semantic), and only the residue Tier 2 cannot decide to the
// Tier 3 judge panel (gated by Tier 4 bias probes). Each item's final verdict
// records WHICH tier decided it, so the scorecard can report how much weight the
// deterministic floor carried versus the model legs.
//
// Honesty constraint (§5 / "Failure modes"): the cascade NEVER fabricates a
// decision. If the Tier-2 models or the Tier-3 panel are not wired (infeasible
// without checkpoints / live judges), the items that would route there are
// recorded as `pending`, not silently scored — the scorecard then states the
// run is partial. Only tiers that actually ran contribute numbers.

import {
  aggregateReferenceScores,
  scoreReferenceItem,
  type ReferenceAggregate,
  type ReferenceOptions,
  type ReferenceScore,
} from './reference.js';
import {
  faithfulnessScore,
  semanticScore,
  type EntailmentModel,
  type SemanticSimilarityModel,
} from './model-metrics.js';
import {
  calibratePanel,
  gradePanelItem,
  type CalibratePanelOptions,
  type Judge,
  type PanelItemResult,
  type PanelOptions,
} from './panel.js';
import {
  probePanelBias,
  type BiasProbeOptions,
  type JudgeBiasProfile,
  type ProbeItem,
} from './bias-probes.js';
import type { GoldQaItem, RagAnswer } from './types.js';

export type DecidingTier = 'tier1' | 'tier2' | 'tier3' | 'pending';

export interface CascadeThresholds {
  /** Tier-1 token-F1 at/above which a short answer is conclusively correct. */
  tier1HighF1?: number;
  /** Tier-1 token-F1 at/below which a short answer is conclusively incorrect. */
  tier1LowF1?: number;
  /** Tier-2 faithfulness & semantic at/above which the item is correct. */
  tier2High?: number;
  /** Tier-2 faithfulness or semantic at/below which the item is incorrect. */
  tier2Low?: number;
}

export const DEFAULT_THRESHOLDS: Required<CascadeThresholds> = {
  tier1HighF1: 0.8,
  tier1LowF1: 0.2,
  tier2High: 0.7,
  tier2Low: 0.3,
};

export interface Tier2Config {
  entailment: EntailmentModel;
  semantic: SemanticSimilarityModel;
}

export interface Tier3Config {
  judges: Judge[];
  probes: ProbeItem[];
  panelOptions?: PanelOptions;
  probeOptions?: BiasProbeOptions;
  calibrateOptions?: CalibratePanelOptions;
}

export interface CascadeConfig {
  thresholds?: CascadeThresholds;
  referenceOptions?: ReferenceOptions;
  tier2?: Tier2Config;
  tier3?: Tier3Config;
}

export interface Tier2Detail {
  faithfulness: number;
  semantic: number;
}

export interface Tier3Detail {
  panelMeanOverall: number;
  calibratedConfidence: number;
  majorityPass: boolean;
  abstained: boolean;
  contributingJudges: number;
}

export interface ItemDecision {
  id: string;
  dataset: string;
  decidedBy: DecidingTier;
  /** Final correctness; null when abstained or pending (no fabricated label). */
  correct: boolean | null;
  reference: ReferenceScore;
  tier2?: Tier2Detail;
  tier3?: Tier3Detail;
  /** Set when decidedBy === 'pending' — why the item could not be scored. */
  pendingReason?: string;
}

export interface CascadeOutcome {
  decisions: ItemDecision[];
  reference: ReferenceAggregate;
  tier1Decided: number;
  tier2Decided: number;
  tier3Decided: number;
  tier3Abstained: number;
  pending: number;
  /** Per-judge bias profiles (Tier 4); empty when no panel ran. */
  biasProfiles: JudgeBiasProfile[];
  /** Calibrated panel items (Tier 3); empty when no panel ran. */
  panelItems: PanelItemResult[];
  panelCalibration: { method: string; fittedOn: number } | null;
}

/**
 * Run the full cascade over the gold items and the system's answers. Answers
 * are paired to items by id; an item with no answer is recorded `pending`
 * (the system produced nothing to score, never a fabricated 0).
 */
export async function runCascade(
  items: readonly GoldQaItem[],
  answers: readonly RagAnswer[],
  config: CascadeConfig = {},
): Promise<CascadeOutcome> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...config.thresholds };
  const answerById = new Map(answers.map((answer) => [answer.id, answer]));

  const decisions: ItemDecision[] = [];
  const references: ReferenceScore[] = [];
  const tier2Residue: Array<{ item: GoldQaItem; answer: RagAnswer; reference: ReferenceScore }> = [];

  // --- Tier 1: deterministic reference metrics on every item. ---
  for (const item of items) {
    const answer = answerById.get(item.id);
    if (answer === undefined) {
      const reference = scoreReferenceItem(item, { id: item.id, answer: '', contexts: [] }, config.referenceOptions);
      references.push(reference);
      decisions.push(pendingDecision(item, reference, 'no system answer for this item'));
      continue;
    }
    const reference = scoreReferenceItem(item, answer, config.referenceOptions);
    references.push(reference);

    const tier1 = decideTier1(item, reference, thresholds);
    if (tier1 !== null) {
      decisions.push({ id: item.id, dataset: item.dataset, decidedBy: 'tier1', correct: tier1, reference });
    } else {
      tier2Residue.push({ item, answer, reference });
    }
  }

  // --- Tier 2: NLI + semantic on the residue (when wired). ---
  const tier3Residue: Array<{ item: GoldQaItem; answer: RagAnswer; reference: ReferenceScore; tier2?: Tier2Detail }> = [];
  for (const entry of tier2Residue) {
    if (config.tier2 === undefined) {
      // Tier 2 (NLI/semantic checkpoints) is environment-heavy and often
      // unavailable. When it is unwired but the live judge panel (Tier 3) IS
      // configured, route the residue straight to the judges rather than
      // stranding it `pending` — a "deterministic Tier 1 + judge panel"
      // operational mode. Without Tier 3 either, the item is pending as before
      // (no fabricated verdict).
      if (config.tier3 !== undefined) {
        tier3Residue.push({ item: entry.item, answer: entry.answer, reference: entry.reference });
      } else {
        decisions.push(pendingDecision(entry.item, entry.reference, 'Tier 2 models (NLI/semantic) not configured'));
      }
      continue;
    }
    const faithfulness = (await faithfulnessScore(entry.answer.answer, entry.answer.contexts, config.tier2.entailment)).faithfulness;
    const semantic = await semanticScore(entry.answer.answer, entry.item.goldAnswers, config.tier2.semantic);
    const tier2: Tier2Detail = { faithfulness, semantic };
    const decision = decideTier2(tier2, thresholds);
    if (decision !== null) {
      decisions.push({ id: entry.item.id, dataset: entry.item.dataset, decidedBy: 'tier2', correct: decision, reference: entry.reference, tier2 });
    } else {
      tier3Residue.push({ ...entry, tier2 });
    }
  }

  // --- Tier 4 probes + Tier 3 panel on the subjective residue (when wired). ---
  let biasProfiles: JudgeBiasProfile[] = [];
  let panelItems: PanelItemResult[] = [];
  let panelCalibration: { method: string; fittedOn: number } | null = null;

  if (config.tier3 === undefined || tier3Residue.length === 0) {
    for (const entry of tier3Residue) {
      decisions.push(pendingDecision(entry.item, entry.reference, 'Tier 3 judge panel not configured', entry.tier2));
    }
  } else {
    const probe = await probePanelBias(config.tier3.judges, config.tier3.probes, config.tier3.probeOptions);
    biasProfiles = probe.profiles;

    // Judge calls are independent and network-bound, so grade items with
    // bounded concurrency instead of strictly serially — a 150-item panel with
    // self-consistency K and A/B+B/A ordering is thousands of sequential ~7s
    // calls otherwise (hours). Concurrency is capped (default 4, override via
    // KB_RAGEVAL_PANEL_CONCURRENCY) to respect provider rate limits; result
    // order is preserved so calibration sees a stable sequence.
    const tier3 = config.tier3;
    const panelConcurrency = readPanelConcurrency();
    const rawItems = await mapBoundedOrdered(tier3Residue, panelConcurrency, (entry) => gradePanelItem(
      {
        id: entry.item.id,
        question: entry.item.question,
        candidate: entry.answer.answer,
        reference: entry.item.goldAnswers[0] ?? '',
        contexts: entry.answer.contexts.map((ctx) => ctx.text),
      },
      tier3.judges,
      { ...tier3.panelOptions, biasCoefficients: probe.biasCoefficients, droppedJudges: probe.droppedJudges },
    ));
    const calibrated = calibratePanel(rawItems, config.tier3.calibrateOptions);
    panelItems = calibrated.items;
    panelCalibration = calibrated.summary.calibration;

    const byId = new Map(tier3Residue.map((entry) => [entry.item.id, entry]));
    for (const panelItem of calibrated.items) {
      const entry = byId.get(panelItem.id);
      if (entry === undefined) continue;
      const tier3: Tier3Detail = {
        panelMeanOverall: panelItem.panelMeanOverall,
        calibratedConfidence: panelItem.calibratedConfidence,
        majorityPass: panelItem.panelMajorityPass,
        abstained: panelItem.abstained,
        contributingJudges: panelItem.contributingJudges,
      };
      decisions.push({
        id: entry.item.id,
        dataset: entry.item.dataset,
        decidedBy: panelItem.abstained ? 'pending' : 'tier3',
        correct: panelItem.abstained ? null : panelItem.panelMajorityPass,
        reference: entry.reference,
        tier2: entry.tier2,
        tier3,
        ...(panelItem.abstained ? { pendingReason: 'Tier 3 abstained (low calibrated confidence)' } : {}),
      });
    }
  }

  return assembleOutcome(items, decisions, references, biasProfiles, panelItems, panelCalibration);
}

/** Tier-1 verdict: true/false when conclusive, null when it must escalate. */
export function decideTier1(
  item: GoldQaItem,
  reference: ReferenceScore,
  thresholds: Required<CascadeThresholds>,
): boolean | null {
  if (item.answerType !== 'short' || !reference.hasGoldAnswer) return null;
  if (reference.exactMatch === 1 || reference.tokenF1 >= thresholds.tier1HighF1) return true;
  if (reference.tokenF1 <= thresholds.tier1LowF1) return false;
  return null;
}

/** Tier-2 verdict: true/false when conclusive, null when it must escalate. */
export function decideTier2(tier2: Tier2Detail, thresholds: Required<CascadeThresholds>): boolean | null {
  if (tier2.faithfulness >= thresholds.tier2High && tier2.semantic >= thresholds.tier2High) return true;
  if (tier2.faithfulness <= thresholds.tier2Low || tier2.semantic <= thresholds.tier2Low) return false;
  return null;
}

function pendingDecision(
  item: GoldQaItem,
  reference: ReferenceScore,
  reason: string,
  tier2?: Tier2Detail,
): ItemDecision {
  return {
    id: item.id,
    dataset: item.dataset,
    decidedBy: 'pending',
    correct: null,
    reference,
    ...(tier2 !== undefined ? { tier2 } : {}),
    pendingReason: reason,
  };
}

function assembleOutcome(
  items: readonly GoldQaItem[],
  decisions: ItemDecision[],
  references: readonly ReferenceScore[],
  biasProfiles: JudgeBiasProfile[],
  panelItems: PanelItemResult[],
  panelCalibration: { method: string; fittedOn: number } | null,
): CascadeOutcome {
  // Preserve input order for stable reports.
  const order = new Map(items.map((item, index) => [item.id, index]));
  decisions.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return {
    decisions,
    reference: aggregateReferenceScores(references),
    tier1Decided: decisions.filter((d) => d.decidedBy === 'tier1').length,
    tier2Decided: decisions.filter((d) => d.decidedBy === 'tier2').length,
    tier3Decided: decisions.filter((d) => d.decidedBy === 'tier3').length,
    tier3Abstained: decisions.filter((d) => d.decidedBy === 'pending' && d.tier3?.abstained === true).length,
    pending: decisions.filter((d) => d.decidedBy === 'pending').length,
    biasProfiles,
    panelItems,
    panelCalibration,
  };
}

// --- Bounded-concurrency helper (self-contained; the panel's only parallelism
// need). Preserves input order in the output so downstream calibration sees a
// stable sequence regardless of completion order. ---
function readPanelConcurrency(): number {
  const raw = process.env.KB_RAGEVAL_PANEL_CONCURRENCY;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 4;
  return Math.min(Math.floor(parsed), 16);
}

async function mapBoundedOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
