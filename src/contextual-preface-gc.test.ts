import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCache, parseCacheArgs } from './cli-cache.js';
import { applyPrefaceGc, planPrefaceGc } from './contextual-preface-gc.js';

describe('contextual preface sidecar gc (#1203)', () => {
  let lockCalls = 0;
  const lock = async <T,>(action: () => Promise<T>): Promise<T> => { lockCalls += 1; return action(); };
  let tmp: string;
  let sidecarRoot: string;
  let kbRoot: string;

  beforeEach(async () => {
    lockCalls = 0;
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-preface-gc-'));
    sidecarRoot = path.join(tmp, 'faiss', '.contextual-prefaces');
    kbRoot = path.join(tmp, 'kbs');
    await fsp.mkdir(kbRoot, { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function writeSidecar(kb: string, name: string, body: Record<string, unknown> | string): Promise<string> {
    const dir = path.join(sidecarRoot, kb);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    await fsp.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  }

  async function exists(p: string): Promise<boolean> {
    return fsp.access(p).then(() => true, () => false);
  }

  async function fixture() {
    await fsp.mkdir(path.join(kbRoot, 'notes'), { recursive: true });
    const live = path.join(kbRoot, 'notes', 'live.md');
    await fsp.writeFile(live, 'hi');
    const gone = path.join(kbRoot, 'notes', 'gone.md');
    return {
      liveSidecar: await writeSidecar('notes', 'live', { source: live, knowledge_base: 'notes' }),
      goneSidecar: await writeSidecar('notes', 'gone', { source: gone, knowledge_base: 'notes' }),
      noSourceSidecar: await writeSidecar('notes', 'nosrc', { knowledge_base: 'notes' }),
      corruptSidecar: await writeSidecar('notes', 'corrupt', '{not json'),
      // KB directory "shelf" is missing: its sidecars must be skipped.
      missingKbSidecar: await writeSidecar('shelf', 'x', { source: path.join(kbRoot, 'shelf', 'x.md'), knowledge_base: 'shelf' }),
    };
  }

  it('plans only sidecars whose source is gone and deletes nothing', async () => {
    const f = await fixture();
    const plan = await planPrefaceGc({ sidecarRoot, knowledgeBasesRoot: kbRoot });
    expect(plan.orphans.map((o) => o.path)).toEqual([f.goneSidecar]);
    expect(plan.summary.orphan_count).toBe(1);
    expect(plan.summary.orphan_bytes).toBeGreaterThan(0);
    expect(plan.inventory.sidecar_count).toBe(5);
    expect(plan.inventory.kept_unknown_count).toBe(2);
    expect(plan.skipped_kbs).toEqual([
      { kb: 'shelf', kb_dir: path.join(kbRoot, 'shelf'), sidecar_count: 1 },
    ]);
    for (const p of Object.values(f)) expect(await exists(p)).toBe(true);
  });

  it('apply deletes exactly the listed orphans', async () => {
    const f = await fixture();
    const plan = await planPrefaceGc({ sidecarRoot, knowledgeBasesRoot: kbRoot });
    const result = await applyPrefaceGc(plan, { sidecarRoot, withLock: lock });
    expect(result.applied_summary).toMatchObject({ deleted_count: 1, failed_count: 0 });
    expect(lockCalls).toBe(1);
    expect(await exists(f.goneSidecar)).toBe(false);
    for (const p of [f.liveSidecar, f.noSourceSidecar, f.corruptSidecar, f.missingKbSidecar]) {
      expect(await exists(p)).toBe(true);
    }
  });

  it('refuses to delete paths outside the sidecar root', async () => {
    const victim = path.join(tmp, 'victim.json');
    await fsp.writeFile(victim, '{}');
    const plan = await planPrefaceGc({ sidecarRoot, knowledgeBasesRoot: kbRoot });
    plan.orphans.push({ path: victim, kb_dir: 'x', source: '/nope', size_bytes: 2 });
    const result = await applyPrefaceGc(plan, { sidecarRoot, withLock: lock });
    expect(result.applied_summary.failed_count).toBe(1);
    expect(await exists(victim)).toBe(true);
  });

  it('returns an empty plan when the sidecar root does not exist', async () => {
    const plan = await planPrefaceGc({ sidecarRoot: path.join(tmp, 'absent'), knowledgeBasesRoot: kbRoot });
    expect(plan.summary.orphan_count).toBe(0);
  });

  describe('kb cache contextual-prefaces', () => {
    function cap(plan = planPrefaceGc, apply = applyPrefaceGc) {
      let stdout = '';
      let stderr = '';
      const deps = {
        planExtractionCachePrune: (() => { throw new Error('unused'); }) as never,
        applyExtractionCachePrune: (() => { throw new Error('unused'); }) as never,
        planPrefaceGc: () => plan({ sidecarRoot, knowledgeBasesRoot: kbRoot }),
        applyPrefaceGc: (p: Parameters<typeof applyPrefaceGc>[0]) => apply(p, { sidecarRoot, withLock: lock }),
        stdout: (t: string) => { stdout += t; },
        stderr: (t: string) => { stderr += t; },
      };
      return { deps, out: () => ({ stdout, stderr }) };
    }

    it('--dry-run (and default) lists orphans with counts and deletes nothing', async () => {
      const f = await fixture();
      const { deps, out } = cap();
      expect(await runCache(['contextual-prefaces', '--dry-run'], deps)).toBe(0);
      expect(out().stdout).toContain('Mode: dry-run');
      expect(out().stdout).toContain('Orphaned (source file gone): 1');
      expect(out().stdout).toContain('skipped KB `shelf`');
      expect(await exists(f.goneSidecar)).toBe(true);
      const d2 = cap();
      expect(await runCache(['contextual-prefaces'], d2.deps)).toBe(0);
      expect(await exists(f.goneSidecar)).toBe(true);
    });

    it('--yes deletes orphans; --format=json is parseable', async () => {
      const f = await fixture();
      const { deps, out } = cap();
      expect(await runCache(['contextual-prefaces', '--yes', '--format=json'], deps)).toBe(0);
      const parsed = JSON.parse(out().stdout);
      expect(parsed.applied_summary.deleted_count).toBe(1);
      expect(await exists(f.goneSidecar)).toBe(false);
      expect(await exists(f.liveSidecar)).toBe(true);
    });

    it('rejects extracted-text-only flags and combined --dry-run/--yes', () => {
      expect(() => parseCacheArgs(['contextual-prefaces', '--max-age-days=3'])).toThrow(/does not accept/);
      expect(() => parseCacheArgs(['contextual-prefaces', '--dry-run', '--yes'])).toThrow(/cannot be combined/);
      expect(parseCacheArgs(['contextual-prefaces', '--yes']).dryRun).toBe(false);
    });
  });
});
