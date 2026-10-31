import * as fsp from 'fs/promises';
import * as path from 'path';
import { MarkdownTextSplitter } from '@langchain/textsplitters';
import type { FixtureOverrides, ScenarioContext } from '../types.js';
import { generateKnowledgeBaseFixture, type KnowledgeBaseFixture } from '../fixtures/generator.js';
import { resetDirectory } from '../utils.js';

// Issue #1063 — `--fixture=external` promises a run against the operator's real
// corpus at KNOWLEDGE_BASES_ROOT_DIR. The orchestrator marks such runs with
// BENCH_EXTERNAL_CORPUS=1 and points BENCH_KNOWLEDGE_BASES_ROOT_DIR at the real
// directory. Scenarios MUST NOT reset or generate into that directory — the
// corpus is read-only input. The per-leg FAISS path is still reset (it is an
// orchestrator-owned tmpdir in compare runs).
export function isExternalCorpus(): boolean {
  const value = process.env.BENCH_EXTERNAL_CORPUS;
  return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

// Base extension allowlist mirrored from src/ingest-filter.ts — kept inline so
// the bench stays free of src imports (same layering rule as the scenarios).
const INGESTABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.rst', '.html', '.htm']);

// Directories skipped while scanning the real corpus — matches the ingest
// walker's dot-prefix rule plus the per-file hash sidecars KBM tooling writes.
function isSkippedEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === 'vendor';
}

export async function listCorpusFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const shelves = await fsp.readdir(rootDir, { withFileTypes: true });
  for (const shelf of shelves) {
    if (isSkippedEntry(shelf.name)) continue;
    const shelfPath = path.join(rootDir, shelf.name);
    // Shelf-level symlinks are followed (same rule as the ingest walker —
    // dirent.isDirectory() is false for symlinks, so stat the resolved path).
    // Nested symlinks inside a shelf are skipped, matching ingest.
    const shelfStat = await fsp.stat(shelfPath).catch(() => undefined);
    if (!shelfStat?.isDirectory()) continue;
    const stack = [shelfPath];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (isSkippedEntry(entry.name)) continue;
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (entry.isFile() && INGESTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          files.push(entryPath);
        }
      }
    }
  }
  return files.sort();
}

// Pulls a probe query out of the middle of a real document — same shape as the
// synthetic fixture's extractQueryFromMarkdown (tokens 12-32 of the prose).
async function deriveCorpusQuery(files: string[]): Promise<string> {
  for (const filePath of files) {
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const tokens = content.split(/\s+/).filter(Boolean);
      if (tokens.length >= 32) {
        return tokens.slice(12, 32).join(' ');
      }
    } catch {
      // unreadable file — try the next one
    }
  }
  return 'knowledge base retrieval';
}

async function countCorpusChunks(files: string[], chunkSize: number | undefined): Promise<number> {
  const size = chunkSize && chunkSize > 0 ? chunkSize : 1000;
  const splitter = new MarkdownTextSplitter({
    chunkOverlap: Math.floor(size / 5),
    chunkSize: size,
    keepSeparator: false,
  });
  let total = 0;
  for (const filePath of files) {
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      total += (await splitter.createDocuments([content])).length;
    } catch {
      // unreadable file — excluded from the count
    }
  }
  return total;
}

// Returns the index-update manifest the production FaissIndexManager writes
// under <faissIndexPath>/models/<modelId>/last-index-update.json. Compare legs
// hold exactly one model dir; summing keeps the helper correct for multi-model
// trees anyway.
async function readIndexedCounts(faissIndexPath: string): Promise<{ files: number; chunks: number }> {
  let files = 0;
  let chunks = 0;
  const modelsDir = path.join(faissIndexPath, 'models');
  let modelIds: string[] = [];
  try {
    modelIds = await fsp.readdir(modelsDir);
  } catch {
    return { files, chunks };
  }
  for (const modelId of modelIds) {
    try {
      const raw = await fsp.readFile(path.join(modelsDir, modelId, 'last-index-update.json'), 'utf-8');
      const summary = (JSON.parse(raw) as { summary?: { files_scanned?: number; chunks_added?: number } }).summary;
      files += summary?.files_scanned ?? 0;
      chunks += summary?.chunks_added ?? 0;
    } catch {
      // unreadable manifest — skip
    }
  }
  return { files, chunks };
}

export interface PreparedCorpus {
  external: boolean;
  fixture: KnowledgeBaseFixture;
  // Undefined for external corpora — scenarios must call updateIndex() globally
  // so every real shelf is indexed, not just a `default` fixture shelf.
  knowledgeBaseName: string | undefined;
}

// Shared scenario preamble: synthetic fixtures reset both dirs and generate;
// external corpora are reused in place (only the FAISS leg dir is reset).
export async function prepareCorpus(
  context: ScenarioContext,
  fixtureOverrides: FixtureOverrides,
  genOptions: { files?: number; seedOffset: number; targetChunksPerFile?: number },
): Promise<PreparedCorpus> {
  if (isExternalCorpus()) {
    await resetDirectory(context.faissIndexPath);
    context.stubController?.resetCounters();
    const stat = await fsp.stat(context.knowledgeBasesRootDir).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new Error(
        `BENCH_EXTERNAL_CORPUS is set but knowledgeBasesRootDir is not a directory: ${context.knowledgeBasesRootDir}`,
      );
    }
    const files = await listCorpusFiles(context.knowledgeBasesRootDir);
    if (files.length === 0) {
      throw new Error(
        `BENCH_EXTERNAL_CORPUS is set but no ingestable documents were found under ${context.knowledgeBasesRootDir}`,
      );
    }
    return {
      external: true,
      fixture: {
        chunkCount: await countCorpusChunks(files, fixtureOverrides.chunkSize),
        files: files.length,
        knowledgeBaseName: '',
        query: await deriveCorpusQuery(files),
      },
      knowledgeBaseName: undefined,
    };
  }

  await resetDirectory(context.knowledgeBasesRootDir);
  await resetDirectory(context.faissIndexPath);
  context.stubController?.resetCounters();

  const fixture = await generateKnowledgeBaseFixture({
    files: fixtureOverrides.files ?? genOptions.files ?? 100,
    knowledgeBaseName: context.knowledgeBaseName,
    rootDir: context.knowledgeBasesRootDir,
    seed: context.fixtureSeed + genOptions.seedOffset,
    targetChunksPerFile: fixtureOverrides.targetChunksPerFile ?? genOptions.targetChunksPerFile ?? 5,
    chunkSize: fixtureOverrides.chunkSize,
  });
  return { external: false, fixture, knowledgeBaseName: context.knowledgeBaseName };
}

export { readIndexedCounts };
