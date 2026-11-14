// Issue #1270 — drift guard for Hugging Face dataset revision pins.
//
// The benchmark data-prep scripts download public datasets from the Hugging
// Face Hub. Without a pinned commit they follow the repo's moving `main` branch,
// so an upstream commit can silently change the corpus or qrels the committed
// benchmark numbers were computed on (this already happened to BRIGHT on
// 2026-11-07). This test fails if a `load_dataset(` call loses its `revision=`,
// a `resolve/main/` URL comes back, or the BRIGHT README snippet drifts from the
// script's pin. It only reads files: no network, no Python.

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');

function read(relFromRepo: string): string {
  return fs.readFileSync(path.join(repoRoot, relFromRepo), 'utf8');
}

const SHA = /^[0-9a-f]{40}$/;

const LOAD_DATASET_FILES = [
  'benchmarks/scripts/ragqa_prepare.py',
  'benchmarks/scripts/fetch_bright_from_hf.py',
  'benchmarks/beir/fixtures/nanobeir/build-nanobeir-fixtures.py',
  'benchmarks/bright/README.md',
];

/** Every `load_dataset(...)` call (not the import), with its full argument text. */
function loadDatasetCalls(source: string): string[] {
  const calls: string[] = [];
  const re = /\bload_dataset\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    calls.push(source.slice(match.index, i));
  }
  return calls;
}

/** The string assigned to a top-level Python constant, e.g. `NAME = "value"`. */
function constant(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'));
  if (!match) throw new Error(`constant ${name} not found`);
  return match[1];
}

describe('Hugging Face dataset revision pins (issue #1270)', () => {
  it.each(LOAD_DATASET_FILES)('every load_dataset() call in %s passes revision=', (rel) => {
    const calls = loadDatasetCalls(read(rel));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/\brevision\s*=/);
    }
  });

  it('pins hotpotqa and BRIGHT to full commit SHAs', () => {
    expect(constant(read('benchmarks/scripts/ragqa_prepare.py'), 'HOTPOTQA_REVISION')).toMatch(SHA);
    expect(constant(read('benchmarks/scripts/fetch_bright_from_hf.py'), 'BRIGHT_REVISION')).toMatch(SHA);
  });

  it('keeps the BRIGHT README snippet on the same revision as the export script', () => {
    const scriptRev = constant(read('benchmarks/scripts/fetch_bright_from_hf.py'), 'BRIGHT_REVISION');
    expect(constant(read('benchmarks/bright/README.md'), 'REVISION')).toBe(scriptRev);
  });

  it('pins every NanoBEIR fixture repo to a commit SHA', () => {
    const source = read('benchmarks/beir/fixtures/nanobeir/build-nanobeir-fixtures.py');
    const entries = [...source.matchAll(/"(nanobeir-[a-z0-9-]+)":\s*\("([^"]+)",\s*"([^"]+)"\)/g)];
    expect(entries.map((m) => m[1]).sort()).toEqual(['nanobeir-fiqa', 'nanobeir-scifact']);
    for (const [, , repo, revision] of entries) {
      expect(repo).toMatch(/^zeta-alpha-ai\//);
      expect(revision).toMatch(SHA);
    }
  });

  describe('fetch_beir_from_hf.py', () => {
    const source = read('benchmarks/scripts/fetch_beir_from_hf.py');

    it('never builds a resolve/main/ download URL', () => {
      expect(source).not.toMatch(/resolve\/main\//);
    });

    it('pins the corpus and qrels repo of every dataset the runbook fetches', () => {
      const block = source.match(/PINNED_REVISIONS[^=]*=\s*\{([\s\S]*?)\n\}/);
      expect(block).not.toBeNull();
      const pins = new Map([...block![1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
      for (const revision of pins.values()) expect(revision).toMatch(SHA);

      // benchmarks/REPRODUCE.md: `for d in scifact nfcorpus ...; do fetch_beir_from_hf.py --dataset "$d"`
      const loop = read('benchmarks/REPRODUCE.md').match(/for d in ([a-z0-9 -]+); do\s*\n\s*python3 benchmarks\/scripts\/fetch_beir_from_hf\.py/);
      expect(loop).not.toBeNull();
      const datasets = loop![1].trim().split(/\s+/);
      expect(datasets.length).toBeGreaterThan(0);
      for (const dataset of datasets) {
        expect(pins.get(`BeIR/${dataset}`)).toMatch(SHA);
        expect(pins.get(`BeIR/${dataset}-qrels`)).toMatch(SHA);
      }
    });
  });
});
