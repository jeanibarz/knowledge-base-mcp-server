import { describe, expect, it } from '@jest/globals';
import {
  computeDeltaG,
  computeDomainBreakdown,
  computeGeneralizationReport,
  formatDeltaG,
  type GeneralizationCell,
} from './generalization.js';

// Registry-grounded fixtures: scifact/nfcorpus/fiqa are tuned ("seen");
// arguana/scidocs/webis-touche2020 are reserved unseen-generality.
function cell(dataset: string, mode: string, ndcg: number, precision = 0.1): GeneralizationCell {
  return { dataset, mode, ndcgAt10: ndcg, precisionAt10: precision, queriesEvaluated: 10 };
}

describe('computeDeltaG', () => {
  it('computes Δ_g = (seen − unseen)/seen over the registry partition', () => {
    const cells = [
      cell('scifact', 'hybrid', 0.80),
      cell('nfcorpus', 'hybrid', 0.60),
      cell('fiqa', 'hybrid', 0.40), // seen mean = 0.60
      cell('arguana', 'hybrid', 0.50),
      cell('scidocs', 'hybrid', 0.30),
      cell('webis-touche2020', 'hybrid', 0.40), // unseen mean = 0.40
    ];
    const result = computeDeltaG(cells, 'hybrid');
    expect(result.seenMeanNdcgAt10).toBeCloseTo(0.6, 6);
    expect(result.unseenMeanNdcgAt10).toBeCloseTo(0.4, 6);
    // (0.6 - 0.4) / 0.6 = 0.3333...
    expect(result.deltaG).toBeCloseTo(0.333333, 5);
  });

  it('returns deltaG=null when the unseen side was not run (honest partial sweep)', () => {
    const cells = [cell('scifact', 'hybrid', 0.8), cell('nfcorpus', 'hybrid', 0.6)];
    const result = computeDeltaG(cells, 'hybrid');
    expect(result.seenMeanNdcgAt10).toBeCloseTo(0.7, 6);
    expect(result.unseenMeanNdcgAt10).toBeNull();
    expect(result.deltaG).toBeNull();
  });

  it('returns deltaG=null when the seen mean is zero (undefined ratio)', () => {
    const cells = [cell('scifact', 'lexical', 0), cell('arguana', 'lexical', 0.2)];
    expect(computeDeltaG(cells, 'lexical').deltaG).toBeNull();
  });

  it('honors a custom partition', () => {
    const cells = [cell('a', 'm', 1.0), cell('b', 'm', 0.5)];
    const result = computeDeltaG(cells, 'm', { tuned: ['a'], unseen: ['b'] });
    expect(result.deltaG).toBeCloseTo(0.5, 6);
  });
});

describe('computeDomainBreakdown', () => {
  it('averages nDCG@10/precision@10 per registry domain for one mode', () => {
    const cells = [
      cell('scifact', 'hybrid', 0.8, 0.2), // scientific fact-checking
      cell('nfcorpus', 'hybrid', 0.6, 0.1), // bio-medical
      cell('trec-covid', 'hybrid', 0.4, 0.3), // bio-medical
      cell('fiqa', 'dense', 0.9), // other mode — excluded
    ];
    const rows = computeDomainBreakdown(cells, 'hybrid');
    const bio = rows.find((r) => r.domain === 'bio-medical');
    expect(bio?.datasets).toEqual(['nfcorpus', 'trec-covid']);
    expect(bio?.meanNdcgAt10).toBeCloseTo(0.5, 6);
    expect(bio?.meanPrecisionAt10).toBeCloseTo(0.2, 6);
    expect(bio?.queriesEvaluated).toBe(20);
    // Rows are sorted by domain.
    expect(rows.map((r) => r.domain)).toEqual([...rows.map((r) => r.domain)].sort());
  });

  it('buckets unregistered datasets under "unknown" rather than dropping them', () => {
    const rows = computeDomainBreakdown([cell('mystery', 'hybrid', 0.5)], 'hybrid');
    expect(rows.some((r) => r.domain === 'unknown')).toBe(true);
  });
});

describe('computeGeneralizationReport', () => {
  it('reports per-domain + Δ_g for every requested mode', () => {
    const cells = [
      cell('scifact', 'hybrid', 0.8),
      cell('arguana', 'hybrid', 0.4),
      cell('scifact', 'lexical', 0.6),
    ];
    const report = computeGeneralizationReport(cells, ['hybrid', 'lexical']);
    expect(report.modes.map((m) => m.mode)).toEqual(['hybrid', 'lexical']);
    expect(report.tunedDatasets).toContain('scifact');
    expect(report.unseenGeneralityDatasets).toContain('arguana');
    const hybrid = report.modes.find((m) => m.mode === 'hybrid');
    expect(hybrid?.deltaG.deltaG).toBeCloseTo(0.5, 6);
  });
});

describe('formatDeltaG', () => {
  it('renders a signed percentage or n/a', () => {
    expect(formatDeltaG(0.3333)).toBe('+33.33%');
    expect(formatDeltaG(-0.05)).toBe('-5.00%');
    expect(formatDeltaG(null)).toBe('n/a');
  });
});
