import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// Issue #1023 — the concurrency stress scenarios self-skip unless
// `KB_RUN_STRESS=1` is set, and for a long time no npm script or workflow set
// it, so the suite guarded nothing. These assertions pin the wiring that keeps
// the nightly job actually running the scenarios: if someone drops the env var
// from `test:stress`, or removes the nightly workflow's trigger/invocation,
// this test fails instead of the suite silently going green on skipped tests.

const repoRoot = path.resolve(__dirname, '..', '..');

describe('concurrency stress CI wiring', () => {
  it('exposes a test:stress script that flips the KB_RUN_STRESS gate on', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    const script = pkg.scripts?.['test:stress'];
    expect(script).toBeDefined();
    // The env var is what turns `describe.skip` into `describe`; without it the
    // scenarios skip and the suite proves nothing.
    expect(script).toContain('KB_RUN_STRESS=1');
    // Runs in the serial project, in-band, scoped to the stress scenarios.
    expect(script).toContain('--selectProjects serial');
    expect(script).toContain('--runInBand');
    expect(script).toContain('tests/stress/scenarios/');
  });

  it('wires a nightly + on-demand workflow that runs test:stress and asserts it did not skip', () => {
    const workflow = readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'concurrency-nightly.yml'),
      'utf8',
    );

    // Scheduled (nightly) and manually dispatchable, matching the issue's
    // "nightly (not per-PR) and allow workflow_dispatch" cost/noise bound.
    expect(workflow).toContain('schedule:');
    expect(workflow).toMatch(/cron:/);
    expect(workflow).toContain('workflow_dispatch:');

    // Actually runs the suite.
    expect(workflow).toContain('npm run test:stress');

    // Verifies the scenarios ran rather than skipped (jest exits 0 even when
    // every scenario is pending), so a silent skip fails the job.
    expect(workflow).toContain('numPassedTests');
    expect(workflow).toContain('numPendingTests');
  });
});
