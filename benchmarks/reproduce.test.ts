// Issue #944 — tests for the one-command canonical benchmark reproduction.
//
// These exercise the argv composition and the orchestration seam with an
// injected `runBenchmark`, so they are hermetic (no dataset, no provider, no
// FAISS) and run in the fast parallel Jest project.

import * as os from 'os';
import * as path from 'path';
import { parseArgs as parseBeirArgs } from './beir/run.js';
import {
  buildLegArgv,
  parseReproduceArgs,
  runReproduce,
  type ReproduceDependencies,
  type ReproduceOptions,
} from './reproduce.js';

// Local structural alias so the test does not depend on the full BEIR report
// shape; runReproduce only reads the fields asserted here.
type BeirBenchmarkRunResultLike = Awaited<ReturnType<ReproduceDependencies['runBenchmark']>>;

function fakeRunResult(dataset: string, ndcgAt10: number): BeirBenchmarkRunResultLike {
  return {
    jsonPath: `/out/kb-${dataset}-dense-chunk-results.json`,
    trecPath: `/out/kb-${dataset}-dense-chunk-run.trec`,
    reportPath: `/out/kb-${dataset}-dense-chunk-report.md`,
    // Only `.report.metrics.ndcgAt10` is read by runReproduce.
    report: { metrics: { ndcgAt10 } },
  } as unknown as BeirBenchmarkRunResultLike;
}

describe('parseReproduceArgs', () => {
  it('defaults to a CI-safe, credential-free smoke config', () => {
    const options = parseReproduceArgs([]);
    expect(options.full).toBe(false);
    expect(options.provider).toBe('fake');
    expect(options.model).toBeUndefined();
    expect(options.datasets).toEqual(['gate-fixture']);
    expect(options.split).toBe('test');
    // Smoke runs against the committed offline fixture dir.
    expect(options.smokeFixtureDir).toContain(
      path.join('benchmarks', 'beir', 'fixtures', 'gate', 'gate-fixture'),
    );
    // Smoke must not write into the committed results tree by default.
    expect(options.outputDir).toContain(os.tmpdir());
  });

  it('resolves the canonical dense/nomic config under --full', () => {
    const options = parseReproduceArgs(['--full']);
    expect(options.full).toBe(true);
    expect(options.provider).toBe('ollama');
    expect(options.model).toBe('nomic-embed-text');
    // Exactly the published dense set committed under matrix/nomic — NOT the
    // full downloadable registry superset.
    expect(options.datasets).toEqual(['scifact', 'nfcorpus', 'fiqa', 'arguana', 'scidocs']);
    // Full run downloads real datasets — no offline fixture dir.
    expect(options.smokeFixtureDir).toBeUndefined();
    // Full run defaults to a temp dir so it never dirties the committed tree.
    expect(options.outputDir).toContain(os.tmpdir());
    expect(options.outputDir).not.toContain(path.join('benchmarks', 'results'));
  });

  it('forces the smoke path with --smoke', () => {
    expect(parseReproduceArgs(['--full', '--smoke']).full).toBe(false);
  });

  it('accepts the space-separated flag form and rejects a value-less flag', () => {
    expect(parseReproduceArgs(['--provider', 'huggingface']).provider).toBe('huggingface');
    expect(() => parseReproduceArgs(['--provider'])).toThrow(/requires a value/);
  });

  it('rejects an empty --datasets list', () => {
    expect(() => parseReproduceArgs(['--datasets=,,'])).toThrow(/at least one dataset/);
  });

  it('rejects a non-numeric --max-queries', () => {
    expect(() => parseReproduceArgs(['--max-queries=abc'])).toThrow(/positive integer/);
  });

  it('honors explicit overrides for provider, model, datasets, and output dir', () => {
    const options = parseReproduceArgs([
      '--full',
      '--provider=huggingface',
      '--model=custom-embed',
      '--datasets=scifact,fiqa',
      '--output-dir=/tmp/custom-out',
      '--max-queries=5',
    ]);
    expect(options.provider).toBe('huggingface');
    expect(options.model).toBe('custom-embed');
    expect(options.datasets).toEqual(['scifact', 'fiqa']);
    expect(options.outputDir).toBe(path.resolve('/tmp/custom-out'));
    expect(options.maxQueries).toBe(5);
  });

  it('rejects a non-positive --max-queries', () => {
    expect(() => parseReproduceArgs(['--max-queries=0'])).toThrow(/positive integer/);
  });

  it('rejects unknown arguments', () => {
    expect(() => parseReproduceArgs(['--nope'])).toThrow(/unknown argument/);
  });
});

describe('buildLegArgv', () => {
  const base: ReproduceOptions = {
    full: false,
    provider: 'fake',
    model: undefined,
    datasets: ['gate-fixture'],
    split: 'test',
    outputDir: '/out',
    cacheDir: '/cache',
    workspaceRoot: '/ws',
    smokeFixtureDir: '/fixtures/gate',
    maxQueries: undefined,
  };

  it('composes the canonical dense flags and the offline fixture for smoke', () => {
    const argv = buildLegArgv(base, 'gate-fixture');
    expect(argv).toContain('--mode=dense');
    expect(argv).toContain('--provider=fake');
    expect(argv).toContain('--dataset=gate-fixture');
    expect(argv).toContain('--dataset-dir=/fixtures/gate');
    expect(argv).toContain('--workspace-root=/ws');
    // Smoke leaves the model unset so `fake` self-defaults.
    expect(argv.some((a) => a.startsWith('--model='))).toBe(false);
  });

  it('pins the canonical model and omits the fixture dir for a full leg', () => {
    const argv = buildLegArgv(
      { ...base, full: true, provider: 'ollama', model: 'nomic-embed-text', smokeFixtureDir: undefined },
      'scifact',
    );
    expect(argv).toContain('--provider=ollama');
    expect(argv).toContain('--model=nomic-embed-text');
    expect(argv).toContain('--dataset=scifact');
    expect(argv.some((a) => a.startsWith('--dataset-dir='))).toBe(false);
  });

  it('passes --max-queries through when set', () => {
    const argv = buildLegArgv({ ...base, maxQueries: 3 }, 'gate-fixture');
    expect(argv).toContain('--max-queries=3');
  });

  // Contract test: the composed argv must be accepted by the real BEIR parser.
  // This catches flag-name drift between reproduce.ts and beir/run.ts at zero
  // FAISS/embedding cost — the exact class the manual smoke run proved by hand.
  it('emits argv that the downstream BEIR parser accepts (smoke leg)', () => {
    const options = parseReproduceArgs([]);
    expect(() => parseBeirArgs(buildLegArgv(options, options.datasets[0]))).not.toThrow();
  });

  it('emits argv that the downstream BEIR parser accepts (full leg)', () => {
    const options = parseReproduceArgs(['--full']);
    // A bare --dataset with no --dataset-dir is only valid for a registry-known
    // dataset, so this also confirms the canonical dataset names are known.
    for (const dataset of options.datasets) {
      expect(() => parseBeirArgs(buildLegArgv(options, dataset))).not.toThrow();
    }
  });
});

describe('runReproduce', () => {
  it('runs one leg per dataset and collects artifact locations', async () => {
    const seen: string[][] = [];
    const deps: ReproduceDependencies = {
      runBenchmark: async (argv) => {
        seen.push(argv);
        const dataset = argv
          .find((a) => a.startsWith('--dataset='))!
          .replace('--dataset=', '');
        return fakeRunResult(dataset, dataset === 'scifact' ? 0.7 : 0.5);
      },
    };
    const options = parseReproduceArgs(['--full', '--datasets=scifact,fiqa']);
    const result = await runReproduce(options, deps);

    expect(result.mode).toBe('full');
    expect(result.provider).toBe('ollama');
    // Passthrough of the canonical model and the resolved output dir into the
    // operator-facing result/summary.
    expect(result.model).toBe('nomic-embed-text');
    expect(result.outputDir).toBe(options.outputDir);
    expect(result.legs.map((l) => l.dataset)).toEqual(['scifact', 'fiqa']);
    expect(result.legs[0].ndcgAt10).toBe(0.7);
    expect(result.legs[0].jsonPath).toContain('scifact');
    expect(seen).toHaveLength(2);
  });

  it('propagates a leg failure instead of swallowing it', async () => {
    const seen: string[] = [];
    const deps: ReproduceDependencies = {
      runBenchmark: async (argv) => {
        const dataset = argv.find((a) => a.startsWith('--dataset='))!.replace('--dataset=', '');
        seen.push(dataset);
        if (dataset === 'fiqa') throw new Error('boom');
        return fakeRunResult(dataset, 0.5);
      },
    };
    const options = parseReproduceArgs(['--full', '--datasets=scifact,fiqa,arguana']);
    await expect(runReproduce(options, deps)).rejects.toThrow(/boom/);
    // Fail-fast: the third leg never ran.
    expect(seen).toEqual(['scifact', 'fiqa']);
  });

  it('drives the smoke fixture leg through the injected runner', async () => {
    const deps: ReproduceDependencies = {
      runBenchmark: async () => fakeRunResult('gate-fixture', 0.42),
    };
    const result = await runReproduce(parseReproduceArgs([]), deps);
    expect(result.mode).toBe('smoke');
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0].dataset).toBe('gate-fixture');
  });
});
