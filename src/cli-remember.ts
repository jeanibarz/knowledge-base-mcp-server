import * as fsp from 'fs/promises';
import * as path from 'path';
import { ActiveModelResolutionError, resolveActiveModel } from './active-model.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { getFilesRecursively } from './file-utils.js';
import { filterIngestablePaths } from './ingest-filter.js';
import { resolveKbRelativePath, resolveKnowledgeBaseDir } from './kb-fs.js';
import { withWriteLock } from './write-lock.js';
import { loadManagerForModel } from './cli-shared.js';

interface RememberArgs {
  kb?: string;
  title?: string;
  append?: string;
  suggest: boolean;
  stdin: boolean;
  yes: boolean;
  refresh: boolean;
}

interface Suggestion {
  relativePath: string;
  score: number;
  label: string;
}

export async function runRemember(rest: string[]): Promise<number> {
  let parsed: RememberArgs;
  try {
    parsed = parseRememberArgs(rest);
    validateRememberArgs(parsed);
  } catch (err) {
    process.stderr.write(`kb remember: ${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.suggest) {
    try {
      return await runSuggest(parsed.kb!, parsed.title!);
    } catch (err) {
      process.stderr.write(`kb remember: ${(err as Error).message}\n`);
      return 1;
    }
  }

  let content: string;
  try {
    content = await readAllStdin();
  } catch (err) {
    process.stderr.write(`kb remember: failed to read stdin: ${(err as Error).message}\n`);
    return 1;
  }

  let relativePath: string;
  try {
    if (parsed.append !== undefined) {
      relativePath = await appendExistingNote(parsed.kb!, parsed.append, content);
    } else {
      relativePath = await createNewNote(parsed.kb!, parsed.title!, content);
    }
  } catch (err) {
    process.stderr.write(`kb remember: ${(err as Error).message}\n`);
    return 1;
  }

  if (parsed.refresh) {
    try {
      await refreshKnowledgeBase(parsed.kb!);
    } catch (err) {
      if (err instanceof ActiveModelResolutionError) {
        process.stderr.write(`kb remember: ${err.message}\n`);
        return 2;
      }
      process.stderr.write(`kb remember: refresh failed after write: ${(err as Error).message}\n`);
      return 1;
    }
  }

  process.stdout.write(`${JSON.stringify({
    knowledge_base_name: parsed.kb,
    path: relativePath,
    action: parsed.append !== undefined ? 'append' : 'create',
    refreshed: parsed.refresh,
  }, null, 2)}\n`);
  return 0;
}

function parseRememberArgs(rest: string[]): RememberArgs {
  const out: RememberArgs = {
    suggest: false,
    stdin: false,
    yes: false,
    refresh: false,
  };
  for (const raw of rest) {
    if (raw === '--suggest') { out.suggest = true; continue; }
    if (raw === '--stdin') { out.stdin = true; continue; }
    if (raw === '--yes') { out.yes = true; continue; }
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--title=')) { out.title = raw.slice('--title='.length); continue; }
    if (raw.startsWith('--append=')) { out.append = raw.slice('--append='.length); continue; }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${raw}`);
  }
  return out;
}

function validateRememberArgs(args: RememberArgs): void {
  if (args.kb === undefined || args.kb.trim() === '') {
    throw new Error('missing --kb=<name>');
  }
  if (args.suggest) {
    if (args.title === undefined || args.title.trim() === '') {
      throw new Error('missing --title=<title>');
    }
    if (args.append !== undefined) {
      throw new Error('--suggest cannot be combined with --append');
    }
    if (args.stdin) {
      throw new Error('--suggest does not read stdin');
    }
    if (args.yes) {
      throw new Error('--suggest cannot be combined with --yes');
    }
    if (args.refresh) {
      throw new Error('--suggest cannot be combined with --refresh');
    }
    return;
  }

  if (!args.stdin) {
    throw new Error('writes require --stdin');
  }
  if (!args.yes) {
    throw new Error('writes require --yes');
  }
  if (args.append !== undefined) {
    if (args.append.trim() === '') {
      throw new Error('--append must not be empty');
    }
    if (args.title !== undefined) {
      throw new Error('--append cannot be combined with --title');
    }
    return;
  }
  if (args.title === undefined || args.title.trim() === '') {
    throw new Error('missing --title=<title>');
  }
}

async function runSuggest(kbName: string, title: string): Promise<number> {
  const kbDir = await resolveKnowledgeBaseDir(KNOWLEDGE_BASES_ROOT_DIR, kbName);
  const allFiles = await getFilesRecursively(kbDir);
  const ingestable = filterIngestablePaths(allFiles, kbDir);
  const suggestions = (await Promise.all(
    ingestable.map(async (filePath) => scoreCandidate(kbDir, filePath, title)),
  ))
    .filter((s): s is Suggestion => s !== null)
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, 10);

  if (suggestions.length === 0) {
    process.stdout.write(`No likely existing targets for "${title}" in ${kbName}.\n`);
    return 0;
  }

  process.stdout.write(`Likely existing targets for "${title}" in ${kbName}:\n`);
  for (const s of suggestions) {
    process.stdout.write(`- ${s.relativePath} (${s.label})\n`);
  }
  return 0;
}

async function scoreCandidate(kbDir: string, filePath: string, title: string): Promise<Suggestion | null> {
  const relativePath = path.relative(kbDir, filePath).split(path.sep).join('/');
  const titleTokens = tokenize(title);
  const pathText = relativePath.replace(/\.[^.]+$/, '').replace(/[/_-]+/g, ' ');
  const pathScore = overlapScore(titleTokens, tokenize(pathText));

  let headingScore = 0;
  let heading = '';
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    const firstHeading = content.split(/\r?\n/, 30).find((line) => /^#{1,6}\s+\S/.test(line));
    if (firstHeading !== undefined) {
      heading = firstHeading.replace(/^#{1,6}\s+/, '').trim();
      headingScore = overlapScore(titleTokens, tokenize(heading));
    }
  } catch {
    // A candidate that vanished or is unreadable between walk and score is
    // simply not useful as a suggestion.
    return null;
  }

  const score = Math.max(pathScore, headingScore);
  if (score <= 0) return null;
  return {
    relativePath,
    score,
    label: headingScore >= pathScore && heading !== '' ? `heading: ${heading}` : 'filename match',
  };
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let matches = 0;
  for (const token of a) {
    if (b.has(token)) matches += 1;
  }
  return matches / a.size;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

async function createNewNote(kbName: string, title: string, content: string): Promise<string> {
  const relativePath = `${slugifyTitle(title)}.md`;
  const documentPath = await resolveKbRelativePath(KNOWLEDGE_BASES_ROOT_DIR, kbName, relativePath);
  await fsp.mkdir(path.dirname(documentPath), { recursive: true });
  try {
    const handle = await fsp.open(documentPath, 'wx');
    try {
      await handle.writeFile(content, 'utf-8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`refusing to overwrite existing note: ${relativePath}`);
    }
    throw err;
  }
  return relativePath;
}

async function appendExistingNote(kbName: string, relativePath: string, content: string): Promise<string> {
  rejectAbsoluteOrTraversal(relativePath);
  const documentPath = await resolveKbRelativePath(KNOWLEDGE_BASES_ROOT_DIR, kbName, relativePath);
  const stat = await fsp.stat(documentPath);
  if (!stat.isFile()) {
    throw new Error(`append target is not a file: ${JSON.stringify(relativePath)}`);
  }
  await fsp.appendFile(documentPath, content, 'utf-8');
  return path.relative(await resolveKnowledgeBaseDir(KNOWLEDGE_BASES_ROOT_DIR, kbName), documentPath)
    .split(path.sep)
    .join('/');
}

function rejectAbsoluteOrTraversal(relativePath: string): void {
  const normalized = relativePath.replace(/\\/g, '/');
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(relativePath) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`append path escapes KB root: ${JSON.stringify(relativePath)}`);
  }
}

function slugifyTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug.length > 0 ? slug.slice(0, 80).replace(/-+$/g, '') : 'note';
}

async function refreshKnowledgeBase(kbName: string): Promise<void> {
  await FaissIndexManager.bootstrapLayout();
  const activeModelId = await resolveActiveModel();
  const manager = await loadManagerForModel(activeModelId);
  await withWriteLock(manager.modelDir, async () => {
    await manager.initialize();
    await manager.updateIndex(kbName);
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}
