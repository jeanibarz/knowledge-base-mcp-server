// Prune contextual-preface sidecars whose source file no longer exists (#1203).
//
// Sidecars live at `$FAISS_INDEX_PATH/.contextual-prefaces/<kb>/*.json`, one per
// source file, and nothing else ever removes them. This module offers a
// plan/apply pair (mirroring `extraction-cache.ts`): the plan is read-only and
// lists orphans; apply deletes exactly the planned files under the sidecar lock.
//
// Safety rules (each protects paid-for LLM output):
//   - a sidecar with no recorded `source` is never treated as an orphan;
//   - sidecars of a KB whose directory is missing are skipped and reported
//     (the shelf may be unmounted or the root may have moved);
//   - a source we cannot stat for any reason other than ENOENT/ENOTDIR is kept.
import * as fsp from 'fs/promises';
import * as path from 'path';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { sidecarRootDir } from './contextual-preface.js';
import { withSidecarLock } from './write-lock.js';

export interface PrefaceOrphanEntry {
  /** Absolute path of the sidecar JSON file. */
  path: string;
  /** Sidecar directory name (slugged KB name). */
  kb_dir: string;
  /** Source path recorded inside the sidecar. */
  source: string;
  size_bytes: number;
}

export interface PrefaceGcPlan {
  dry_run: true;
  sidecar_root: string;
  knowledge_bases_root: string;
  inventory: {
    sidecar_count: number;
    total_bytes: number;
    /** Sidecars with no recorded source, unparsable, or with a stat error: kept. */
    kept_unknown_count: number;
  };
  orphans: PrefaceOrphanEntry[];
  summary: { orphan_count: number; orphan_bytes: number };
  /** KBs whose directory is missing; their sidecars were not examined. */
  skipped_kbs: Array<{ kb: string; kb_dir: string; sidecar_count: number }>;
}

export interface PrefaceGcApplyResult extends Omit<PrefaceGcPlan, 'dry_run'> {
  dry_run: false;
  deleted: PrefaceOrphanEntry[];
  failed: Array<{ path: string; message: string }>;
  applied_summary: { deleted_count: number; deleted_bytes: number; failed_count: number };
}

export interface PrefaceGcOptions {
  sidecarRoot?: string;
  knowledgeBasesRoot?: string;
  /** Lock wrapper for apply; defaults to the shared sidecar lock. Injectable for hermetic tests. */
  withLock?: <T>(action: () => Promise<T>) => Promise<T>;
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function planPrefaceGc(options: PrefaceGcOptions = {}): Promise<PrefaceGcPlan> {
  const sidecarRoot = options.sidecarRoot ?? sidecarRootDir();
  const kbRoot = options.knowledgeBasesRoot ?? KNOWLEDGE_BASES_ROOT_DIR;
  const plan: PrefaceGcPlan = {
    dry_run: true,
    sidecar_root: sidecarRoot,
    knowledge_bases_root: kbRoot,
    inventory: { sidecar_count: 0, total_bytes: 0, kept_unknown_count: 0 },
    orphans: [],
    summary: { orphan_count: 0, orphan_bytes: 0 },
    skipped_kbs: [],
  };

  let kbDirs: Array<import('fs').Dirent>;
  try {
    kbDirs = await fsp.readdir(sidecarRoot, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return plan;
    throw err;
  }

  for (const kbDirEntry of kbDirs.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(sidecarRoot, kbDirEntry.name);
    const files = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((f) => f.isFile() && f.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Read every sidecar first; the KB directory is derived from the recorded
    // `knowledge_base` (the on-disk dir name is a lossy slug).
    const loaded: Array<{ file: string; size: number; source?: string; kb?: string }> = [];
    for (const f of files) {
      const file = path.join(dir, f.name);
      const size = (await fsp.stat(file)).size;
      plan.inventory.sidecar_count += 1;
      plan.inventory.total_bytes += size;
      try {
        const parsed = JSON.parse(await fsp.readFile(file, 'utf-8')) as { source?: unknown; knowledge_base?: unknown };
        loaded.push({
          file,
          size,
          source: typeof parsed.source === 'string' && parsed.source !== '' ? parsed.source : undefined,
          kb: typeof parsed.knowledge_base === 'string' && parsed.knowledge_base !== '' ? parsed.knowledge_base : undefined,
        });
      } catch {
        loaded.push({ file, size });
      }
    }

    const kbNames = new Set(loaded.map((l) => l.kb).filter((k): k is string => k !== undefined));
    const kbName = kbNames.size === 1 ? [...kbNames][0] : kbDirEntry.name;
    const kbDirPath = path.join(kbRoot, kbName);
    if (!(await dirExists(kbDirPath))) {
      plan.skipped_kbs.push({ kb: kbName, kb_dir: kbDirPath, sidecar_count: loaded.length });
      continue;
    }

    for (const entry of loaded) {
      if (entry.source === undefined) {
        plan.inventory.kept_unknown_count += 1;
        continue;
      }
      try {
        await fsp.lstat(entry.source);
      } catch (err) {
        if (isMissing(err)) {
          plan.orphans.push({ path: entry.file, kb_dir: kbDirEntry.name, source: entry.source, size_bytes: entry.size });
          plan.summary.orphan_count += 1;
          plan.summary.orphan_bytes += entry.size;
        } else {
          plan.inventory.kept_unknown_count += 1;
        }
      }
    }
  }
  return plan;
}

export async function applyPrefaceGc(plan: PrefaceGcPlan, options: PrefaceGcOptions = {}): Promise<PrefaceGcApplyResult> {
  const sidecarRoot = path.resolve(options.sidecarRoot ?? plan.sidecar_root);
  const deleted: PrefaceOrphanEntry[] = [];
  const failed: Array<{ path: string; message: string }> = [];
  await (options.withLock ?? withSidecarLock)(async () => {
    for (const orphan of plan.orphans) {
      const resolved = path.resolve(orphan.path);
      // Defence in depth: only ever unlink `*.json` files strictly under the sidecar root.
      if (!resolved.endsWith('.json') || !resolved.startsWith(sidecarRoot + path.sep)) {
        failed.push({ path: orphan.path, message: 'refusing to delete path outside the sidecar root' });
        continue;
      }
      try {
        await fsp.unlink(resolved);
        deleted.push(orphan);
      } catch (err) {
        if (isMissing(err)) {
          deleted.push(orphan);
        } else {
          failed.push({ path: orphan.path, message: (err as Error).message });
        }
      }
    }
  });
  return {
    ...plan,
    dry_run: false,
    deleted,
    failed,
    applied_summary: {
      deleted_count: deleted.length,
      deleted_bytes: deleted.reduce((n, e) => n + e.size_bytes, 0),
      failed_count: failed.length,
    },
  };
}
