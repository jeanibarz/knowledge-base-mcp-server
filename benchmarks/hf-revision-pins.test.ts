// Issue #1270 — drift guard for Hugging Face dataset revision pins.
//
// The benchmark data-prep scripts download public datasets from the Hugging
// Face Hub. Without a pinned commit they follow the repo's moving `main` branch,
// so an upstream commit can silently change the corpus or qrels the committed
// benchmark numbers were computed on (this already happened to BRIGHT on
// 2026-11-07). This test fails if a `load_dataset(` call stops passing the pinned
// constant, a download URL or file listing stops using the resolved SHA, or the
// BRIGHT README snippet drifts from the script's pin. The static checks only read
// files; the `resolve_revision` checks run python3 offline (skipped without it).

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');

function read(relFromRepo: string): string {
  return fs.readFileSync(path.join(repoRoot, relFromRepo), 'utf8');
}

const SHA = /^[0-9a-f]{40}$/;

// file -> the exact `revision=` argument every load_dataset() call must pass.
const LOAD_DATASET_FILES: Array<[string, string]> = [
  ['benchmarks/scripts/ragqa_prepare.py', 'HOTPOTQA_REVISION'],
  ['benchmarks/scripts/fetch_bright_from_hf.py', 'BRIGHT_REVISION'],
  ['benchmarks/beir/fixtures/nanobeir/build-nanobeir-fixtures.py', 'revision'],
  ['benchmarks/bright/README.md', 'REVISION'],
];

/** Every `name(...)` call (not an import or a `def`), with its full argument text. */
function calls(source: string, name: string): string[] {
  const found: string[] = [];
  const re = new RegExp(`(?<!def )\\b${name}\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    found.push(source.slice(match.index, i));
  }
  return found;
}

/** The string assigned to a top-level Python constant, e.g. `NAME = "value"`. */
function constant(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'));
  if (!match) throw new Error(`constant ${name} not found`);
  return match[1];
}

describe('Hugging Face dataset revision pins (issue #1270)', () => {
  it.each(LOAD_DATASET_FILES)('every load_dataset() call in %s passes revision=%s', (rel, arg) => {
    const found = calls(read(rel), 'load_dataset');
    expect(found.length).toBeGreaterThan(0);
    for (const call of found) {
      expect(call).toMatch(new RegExp(`\\brevision=${arg}\\)$`));
    }
  });

  it('threads each NanoBEIR pin from DATASETS into build()', () => {
    const source = read('benchmarks/beir/fixtures/nanobeir/build-nanobeir-fixtures.py');
    expect(source).toMatch(/def build\(name: str, repo: str, revision: str\)/);
    expect(source).toMatch(/for name, \(repo, revision\) in DATASETS\.items\(\):\s*\n\s*build\(name, repo, revision\)/);
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
      // Every resolve/ URL interpolates a resolved SHA variable.
      const urls = [...source.matchAll(/resolve\/\{([^}]*)\}\//g)].map((m) => m[1]);
      expect(urls.length).toBeGreaterThan(0);
      for (const ref of urls) expect(['revision', 'corpus_rev', 'qrels_rev']).toContain(ref);
    });

    it('passes the resolved SHA to every file listing and shard download', () => {
      // The helpers default to "main" only for fetch_coir_from_hf.py, which is not pinned yet.
      const listings = calls(source, '_siblings');
      const shards = calls(source, '_read_parquet_shards');
      expect(listings).toEqual(['_siblings(corpus_repo, corpus_rev)', '_siblings(qrels_repo, qrels_rev)']);
      expect(shards).toEqual([
        '_read_parquet_shards(corpus_repo, corpus_files, corpus_rev)',
        '_read_parquet_shards(corpus_repo, queries_files, corpus_rev)',
      ]);
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

// resolve_revision() precedence, run in python3 with the network and pandas stubbed.
const hasPython = spawnSync('python3', ['--version']).status === 0;
(hasPython ? describe : describe.skip)('fetch_beir_from_hf.resolve_revision (python3)', () => {
  const PROBE = `
import json, sys, types
sys.modules["pandas"] = types.ModuleType("pandas")  # imported at module top; unused here
sys.path.insert(0, sys.argv[1])
import fetch_beir_from_hf as m
calls = []
def fake_api(path):
    calls.append(path)
    return {"sha": "c" * 40}
m._hf_api = fake_api
out = {
    "override": m.resolve_revision("BeIR/scifact", "a" * 40),
    "pinned": m.resolve_revision("BeIR/scifact"),
    "pin": m.PINNED_REVISIONS["BeIR/scifact"],
    "unpinned": m.resolve_revision("BeIR/not-pinned"),
    "calls": calls,
}
for bad in ("main", "abc123", ""):
    try:
        m.resolve_revision("BeIR/scifact", bad)
        out["accepted_" + (bad or "empty")] = True
    except SystemExit:
        pass
print(json.dumps(out))
`;

  it('prefers an override, then the pin, then main resolved once; rejects non-SHA or empty overrides', () => {
    const scriptsDir = path.join(repoRoot, 'benchmarks', 'scripts');
    const res = spawnSync('python3', ['-I', '-c', PROBE, scriptsDir], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.override).toBe('a'.repeat(40));
    expect(out.pinned).toBe(out.pin);
    expect(out.pin).toMatch(SHA);
    expect(out.unpinned).toBe('c'.repeat(40));
    expect(out.calls).toEqual(['BeIR/not-pinned/revision/main']);
    expect(out).not.toHaveProperty('accepted_main');
    expect(out).not.toHaveProperty('accepted_abc123');
    expect(out).not.toHaveProperty('accepted_empty');
    expect(res.stderr).toContain('BeIR/not-pinned has no pinned revision');
  });
});
