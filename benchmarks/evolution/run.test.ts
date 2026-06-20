import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BenchmarkReport } from '../types.js';

const execFileAsync = promisify(execFile);

describe('bench:evol runner', () => {
  it('writes decision and markdown artifacts from precomputed reports', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-evol-run-test-'));
    const championPath = path.join(tmp, 'champion.json');
    const candidatePath = path.join(tmp, 'candidate.json');
    const planPath = path.join(tmp, 'plan.json');
    const outDir = path.join(tmp, 'out');

    await fsp.writeFile(championPath, JSON.stringify(reportWith(100)), 'utf-8');
    await fsp.writeFile(candidatePath, JSON.stringify(reportWith(80)), 'utf-8');
    await fsp.writeFile(planPath, JSON.stringify({
      schema_version: 'kb.evolution-plan.v1',
      run_id: 'iter-artifact',
      objective: {
        metric_path: 'scenarios.warm_query.p95_ms',
        direction: 'lower',
        min_absolute_improvement: 5,
      },
      champion: { id: 'champion', report: championPath },
      candidates: [{ id: 'candidate', report: candidatePath }],
    }), 'utf-8');

    const completed = await execFileAsync('node', [
      '--import',
      'tsx',
      path.join(process.cwd(), 'benchmarks/evolution/run.ts'),
      `--plan=${planPath}`,
      `--out-dir=${outDir}`,
    ], { cwd: process.cwd() });

    expect(completed.stdout).toContain('Decision:');
    const decision = JSON.parse(await fsp.readFile(path.join(outDir, 'decision.json'), 'utf-8'));
    const report = await fsp.readFile(path.join(outDir, 'report.md'), 'utf-8');
    expect(decision).toMatchObject({
      schema_version: 'kb.evolution-decision.v1',
      winner: 'candidate',
      promoted: true,
    });
    expect(report).toContain('Promoted: yes');
    expect(await exists(path.join(outDir, 'reports', 'candidate.json'))).toBe(true);
  });
});

function reportWith(warmP95Ms: number): BenchmarkReport {
  return {
    arch: 'x64',
    git_sha: 'abc123',
    node_version: 'v24.11.1',
    os: 'linux',
    provider: 'stub',
    scenarios: {
      cold_index: { chunks: 600, files: 100, ms: 10_000 },
      cold_start: { fixture_documents: 100, ms: 40, rss_bytes: 90 * 1024 * 1024 },
      memory_peak: {
        chunk_count: 600,
        files: 100,
        heap_used_bytes: 50 * 1024 * 1024,
        rss_bytes: 120 * 1024 * 1024,
      },
      retrieval_quality: {
        default_fanout_factor: 3,
        default_loaded_kbs: 5,
        default_recall_at_10: 0.98,
        query_count: 50,
        sweep: [],
      },
      warm_query: { p50_ms: 80, p95_ms: warmP95Ms, p99_ms: 120, repetitions: 30 },
    },
    version: 1,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}
