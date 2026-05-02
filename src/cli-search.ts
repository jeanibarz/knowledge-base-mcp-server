import * as fsp from 'fs/promises';
import * as path from 'path';
import { FaissIndexManager } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  resolveActiveModel,
  resolveFaissIndexBinaryPath,
} from './active-model.js';
import {
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config.js';
import { formatRetrievalAsJson, formatRetrievalAsMarkdown } from './formatter.js';
import { listKnowledgeBases } from './kb-fs.js';
import { withWriteLock } from './write-lock.js';
import { getFilesRecursively } from './file-utils.js';
import { filterIngestablePaths } from './ingest-filter.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';

interface SearchArgs {
  query: string | null;
  kb?: string;
  model?: string;
  threshold?: number;
  k: number;
  format: 'md' | 'json';
  refresh: boolean;
  stdin: boolean;
}

interface Staleness {
  indexMtime: string | null;
  modifiedFiles: number;
  newFiles: number;
}

export async function runSearch(rest: string[]): Promise<number> {
  let parsed: SearchArgs;
  try {
    parsed = parseSearchArgs(rest);
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.stdin && parsed.query === null) {
    parsed.query = await readAllStdin();
    if (parsed.query.trim() === '') {
      process.stderr.write('kb search: empty query from stdin\n');
      return 2;
    }
  } else if (parsed.query === null) {
    process.stderr.write('kb search: missing <query> (or use --stdin)\n');
    return 2;
  }

  try {
    await FaissIndexManager.bootstrapLayout();
  } catch (err) {
    process.stderr.write(`kb search: layout bootstrap failed: ${(err as Error).message}\n`);
    return 1;
  }

  let activeModelId: string;
  try {
    activeModelId = await resolveActiveModel({ explicitOverride: parsed.model });
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      process.stderr.write(`kb search: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 1;
  }

  let manager: FaissIndexManager;
  try {
    manager = await loadManagerForModel(activeModelId);
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    if (parsed.refresh) {
      await withWriteLock(manager.modelDir, async () => {
        await manager.initialize();
        await manager.updateIndex(parsed.kb);
      });
    } else {
      await loadWithJsonRetry(manager);
    }
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 1;
  }

  let results;
  try {
    results = await manager.similaritySearch(
      parsed.query,
      parsed.k,
      parsed.threshold,
      parsed.kb,
    );
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 1;
  }

  const staleness = await computeStaleness(activeModelId);

  if (parsed.format === 'json') {
    const body = formatRetrievalAsJson(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE);
    const payload = {
      results: body,
      index_mtime: staleness.indexMtime,
      stale: parsed.refresh ? false : staleness.modifiedFiles + staleness.newFiles > 0,
      modified_files: parsed.refresh ? 0 : staleness.modifiedFiles,
      new_files: parsed.refresh ? 0 : staleness.newFiles,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const md = formatRetrievalAsMarkdown(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE);
    process.stdout.write(md);
    process.stdout.write('\n\n');
    process.stdout.write(formatFreshnessFooter(staleness, parsed.refresh));
    process.stdout.write('\n');
  }

  return 0;
}

function parseSearchArgs(rest: string[]): SearchArgs {
  const out: SearchArgs = {
    query: null,
    k: 10,
    format: 'md',
    refresh: false,
    stdin: false,
  };
  for (const raw of rest) {
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw === '--stdin')   { out.stdin = true; continue; }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--model=')) { out.model = raw.slice('--model='.length); continue; }
    if (raw.startsWith('--threshold=')) {
      const n = Number(raw.slice('--threshold='.length));
      if (!Number.isFinite(n)) throw new Error(`invalid --threshold: ${raw}`);
      out.threshold = n; continue;
    }
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = n; continue;
    }
    if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v !== 'md' && v !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = v; continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    if (out.query === null) { out.query = raw; continue; }
    throw new Error(`unexpected argument: ${raw}`);
  }
  return out;
}

async function computeStaleness(modelId: string): Promise<Staleness> {
  const binaryPath = await resolveFaissIndexBinaryPath(modelId);
  if (binaryPath === null) {
    return { indexMtime: null, modifiedFiles: 0, newFiles: 0 };
  }
  let indexStat;
  try {
    indexStat = await fsp.stat(binaryPath);
  } catch {
    return { indexMtime: null, modifiedFiles: 0, newFiles: 0 };
  }
  const indexMtimeMs = indexStat.mtimeMs;
  const indexMtime = new Date(indexMtimeMs).toISOString();

  let modified = 0;
  let added = 0;
  let kbs: string[];
  try {
    kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  } catch {
    return { indexMtime, modifiedFiles: 0, newFiles: 0 };
  }

  for (const kbName of kbs) {
    const kbDir = path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName);
    let allFiles: string[];
    try {
      allFiles = await getFilesRecursively(kbDir);
    } catch {
      continue;
    }
    const ingestable = await filterIngestablePaths(allFiles, kbDir);

    for (const f of ingestable) {
      try {
        const st = await fsp.stat(f);
        if (st.mtimeMs > indexMtimeMs) modified += 1;
      } catch {
        // file vanished between getFilesRecursively and stat; ignore it
      }
    }

    const sidecarDir = path.join(kbDir, '.index');
    let sidecarCount = 0;
    try {
      const sidecars = await fsp.readdir(sidecarDir);
      sidecarCount = sidecars.length;
    } catch {
      // .index missing; count difference below covers this case
    }
    if (ingestable.length > sidecarCount) {
      added += ingestable.length - sidecarCount;
    }
  }

  return { indexMtime, modifiedFiles: modified, newFiles: added };
}

function formatFreshnessFooter(s: Staleness, refreshed: boolean): string {
  if (s.indexMtime === null) {
    return `> _Index not yet built. Run \`kb search --refresh\` to create it._`;
  }
  if (refreshed) {
    return `> _Index refreshed at ${s.indexMtime}._`;
  }
  if (s.modifiedFiles === 0 && s.newFiles === 0) {
    return `> _Index up-to-date as of ${s.indexMtime}._`;
  }
  return (
    `> _Index may be stale: ${s.modifiedFiles} modified, ${s.newFiles} new ` +
    `file(s) since ${s.indexMtime}. Run \`kb search --refresh\` to update._`
  );
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}
