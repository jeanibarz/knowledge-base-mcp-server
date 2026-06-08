import { describe, expect, it } from '@jest/globals';
import { fitConfidenceCalibrator, fitIsotonic, fitRidge } from './calibration.js';

describe('fitIsotonic', () => {
  it('produces a monotone non-decreasing fit (PAV)', () => {
    // Non-monotone targets; PAV pools the violators.
    const cal = fitIsotonic([
      { feature: 0.1, target: 0.2 },
      { feature: 0.2, target: 0.1 },
      { feature: 0.3, target: 0.9 },
      { feature: 0.4, target: 0.8 },
    ]);
    const a = cal.predict(0.1);
    const b = cal.predict(0.25);
    const c = cal.predict(0.4);
    expect(a).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(c);
    expect(cal.method).toBe('isotonic');
  });

  it('clamps predictions to [0,1] and extrapolates flat at the ends', () => {
    const cal = fitIsotonic([
      { feature: 0.2, target: 0.3 },
      { feature: 0.8, target: 0.9 },
    ]);
    expect(cal.predict(-5)).toBe(0.3);
    expect(cal.predict(5)).toBe(0.9);
  });
});

describe('fitRidge', () => {
  it('recovers an affine relationship', () => {
    // target = 0.5*feature + 0.25, lambda small.
    const samples = [0, 0.25, 0.5, 0.75, 1].map((feature) => ({ feature, target: 0.5 * feature + 0.25 }));
    const cal = fitRidge(samples, 1e-6);
    expect(cal.predict(0.5)).toBeCloseTo(0.5, 2);
    expect(cal.method).toBe('ridge');
  });
});

describe('fitConfidenceCalibrator', () => {
  it('falls back to a clamped identity with <2 samples', () => {
    const cal = fitConfidenceCalibrator([{ feature: 0.7, target: 0.9 }]);
    expect(cal.fittedOn).toBe(1);
    expect(cal.predict(0.7)).toBe(0.7);
    expect(cal.predict(2)).toBe(1);
  });
});
