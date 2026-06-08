// RFC 020 §6 — the generalization guardrail (per-domain breakdown + Δ_g).
//
// The product promise is *general* knowledge research, so the program is built
// so leaderboard climbing cannot quietly erode generality. The headline
// multi-domain mean (§2) is the first anti-overfitting metric; this module adds
// the two §6 structural probes that a mean alone hides:
//
//   1. **Per-domain breakdown.** The same mode can win on QA and lose on
//      argument retrieval; averaging buries that. The breakdown reports the mean
//      nDCG@10 / precision@10 per domain bucket so a domain-localized regression
//      is visible.
//
//   2. **Δ_g = (score_seen − score_unseen) / score_seen.** Reported between the
//      tuned/dev datasets ("seen") and a reserved unseen-generality set
//      ("unseen") that is *never tuned on* and distinct from the per-dataset
//      test split used for the headline. A widening Δ_g is the overfitting alarm
//      a multi-domain mean cannot surface — a config can lift the mean while
//      pulling further ahead on the corpora it was tuned against.
//
// Everything here is a pure function over already-scored matrix cells, so it is
// deterministic and unit-testable from stub inputs (no datasets, no model).
// `significance.ts` is the companion tool: Δ_g answers "is the gap widening?",
// while a paired comparator over two modes' per-query vectors answers "is the
// difference real?". The two compose — Δ_g flags the suspect, significance
// convicts it.

import { domainOf, tunedDatasets, unseenGeneralityDatasets } from './registry.js';

/** The minimal per-(dataset × mode) shape the generalization math needs. */
export interface GeneralizationCell {
  dataset: string;
  mode: string;
  ndcgAt10: number;
  precisionAt10: number;
  queriesEvaluated: number;
}

export interface DomainBreakdownRow {
  domain: string;
  datasets: string[];
  meanNdcgAt10: number;
  meanPrecisionAt10: number;
  queriesEvaluated: number;
}

export interface DeltaGResult {
  mode: string;
  seenDatasets: string[];
  unseenDatasets: string[];
  /** Mean nDCG@10 over the tuned ("seen") datasets present in the cells. */
  seenMeanNdcgAt10: number | null;
  /** Mean nDCG@10 over the reserved unseen-generality datasets present. */
  unseenMeanNdcgAt10: number | null;
  /**
   * Δ_g = (seen − unseen) / seen. null when either side is absent from the run
   * or the seen mean is 0 (the ratio is undefined). A higher Δ_g means the mode
   * does relatively worse on held-out domains — the overfitting direction.
   */
  deltaG: number | null;
}

export interface ModeGeneralization {
  mode: string;
  domains: DomainBreakdownRow[];
  deltaG: DeltaGResult;
}

export interface GeneralizationReport {
  modes: ModeGeneralization[];
  /** Echo of the registry partition the Δ_g used, for the ledger/provenance. */
  tunedDatasets: string[];
  unseenGeneralityDatasets: string[];
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return round(sum / values.length);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Per-domain mean nDCG@10 / precision@10 for one mode. Domains are taken from
 * the registry; cells for an unregistered dataset fall into the 'unknown'
 * bucket rather than being dropped, so a typo'd dataset name is visible instead
 * of silently missing. Rows are sorted by domain for stable output.
 */
export function computeDomainBreakdown(
  cells: readonly GeneralizationCell[],
  mode: string,
): DomainBreakdownRow[] {
  const byDomain = new Map<string, GeneralizationCell[]>();
  for (const cell of cells) {
    if (cell.mode !== mode) continue;
    const domain = domainOf(cell.dataset);
    const bucket = byDomain.get(domain);
    if (bucket === undefined) byDomain.set(domain, [cell]);
    else bucket.push(cell);
  }
  const rows: DomainBreakdownRow[] = [];
  for (const [domain, domainCells] of byDomain) {
    rows.push({
      domain,
      datasets: domainCells.map((c) => c.dataset).sort(),
      meanNdcgAt10: mean(domainCells.map((c) => c.ndcgAt10)) ?? 0,
      meanPrecisionAt10: mean(domainCells.map((c) => c.precisionAt10)) ?? 0,
      queriesEvaluated: domainCells.reduce((acc, c) => acc + c.queriesEvaluated, 0),
    });
  }
  return rows.sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * Δ_g for one mode over the registry's tuned vs unseen-generality partition.
 * Only datasets actually present in `cells` contribute, so a partial run (e.g.
 * the CI subset alone, with no unseen datasets) yields `deltaG: null` rather
 * than a fabricated number — the report says "not computable", which is the
 * honest answer when the unseen side wasn't run.
 */
export function computeDeltaG(
  cells: readonly GeneralizationCell[],
  mode: string,
  partition: { tuned: readonly string[]; unseen: readonly string[] } = {
    tuned: tunedDatasets(),
    unseen: unseenGeneralityDatasets(),
  },
): DeltaGResult {
  const tunedSet = new Set(partition.tuned);
  const unseenSet = new Set(partition.unseen);
  const seenCells = cells.filter((c) => c.mode === mode && tunedSet.has(c.dataset));
  const unseenCells = cells.filter((c) => c.mode === mode && unseenSet.has(c.dataset));

  const seenMean = mean(seenCells.map((c) => c.ndcgAt10));
  const unseenMean = mean(unseenCells.map((c) => c.ndcgAt10));
  const deltaG = seenMean !== null && unseenMean !== null && seenMean !== 0
    ? round((seenMean - unseenMean) / seenMean)
    : null;

  return {
    mode,
    seenDatasets: seenCells.map((c) => c.dataset).sort(),
    unseenDatasets: unseenCells.map((c) => c.dataset).sort(),
    seenMeanNdcgAt10: seenMean,
    unseenMeanNdcgAt10: unseenMean,
    deltaG,
  };
}

export function computeGeneralizationReport(
  cells: readonly GeneralizationCell[],
  modes: readonly string[],
  partition: { tuned: readonly string[]; unseen: readonly string[] } = {
    tuned: tunedDatasets(),
    unseen: unseenGeneralityDatasets(),
  },
): GeneralizationReport {
  return {
    modes: modes.map((mode) => ({
      mode,
      domains: computeDomainBreakdown(cells, mode),
      deltaG: computeDeltaG(cells, mode, partition),
    })),
    tunedDatasets: [...partition.tuned],
    unseenGeneralityDatasets: [...partition.unseen],
  };
}

export function formatDeltaG(value: number | null): string {
  if (value === null) return 'n/a';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}
