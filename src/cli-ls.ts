// `kb ls` — read-only inventory of ingestable, non-quarantined documents.

import * as fsp from 'fs/promises';
import { mapBounded, resolveFsConcurrency } from './bounded-concurrency.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import {
  listKnowledgeBaseDocuments,
  normalizeDocumentPrefix,
  type KnowledgeBaseDocument,
} from './kb-document-listing.js';
import { parseFrontmatter } from './frontmatter.js';

export const LS_SCHEMA_VERSION = 'kb.ls.v1';
// parseFrontmatter bounds JavaScript characters, while this reader bounds UTF-8
// bytes. Four bytes per character covers the maximum UTF-8 width.
const FRONTMATTER_READ_BYTES = 8192 * 4;

export const LS_HELP = `kb ls — list ingestable documents in one or all knowledge bases

Usage:
  kb ls [<kb>] [--prefix=<path>] [--long] [--format=md|json]

Lists one KB-relative path per ingestable, non-quarantined document. Without a
positional KB, paths are prefixed with their knowledge-base name so output from
multiple KBs remains unambiguous. The listing is read-only and follows the same
ingest filters and quarantine state as MCP resources/list. Control characters in
short paths are escaped so each document remains on one output line.

Options:
  --prefix=<path>       Restrict the listing to a KB-relative subtree.
  --long                Include tier, status, type, and filesystem mtime.
  --format=md|json      Output format (default: md). JSON uses the stable
                        kb.ls.v1 shape.
  --help, -h            Show this help.

Environment:
  KNOWLEDGE_BASES_ROOT_DIR  Root directory containing one folder per KB.

Exit codes:
  0   listing printed (possibly empty)
  1   knowledge-base or filesystem error
  2   invalid argument

Examples:
  kb ls work
  kb ls work --prefix=projects/active
  kb ls --long --format=json
`;

export interface LsArgs {
  kb?: string;
  prefix?: string;
  long: boolean;
  format: 'md' | 'json';
}

export interface LsDocument {
  knowledgeBase: string;
  path: string;
  tier?: string | null;
  status?: string | null;
  type?: string | null;
  mtime?: string;
}

export interface LsReport {
  knowledgeBases: string[];
  prefix: string | null;
  scopedKb?: string;
  documents: LsDocument[];
}

export interface CollectLsReportOptions {
  rootDir: string;
  kb?: string;
  prefix?: string;
  long?: boolean;
}

export function parseLsArgs(rest: readonly string[]): LsArgs {
  let kb: string | undefined;
  let prefix: string | undefined;
  let long = false;
  let format: 'md' | 'json' = 'md';

  for (const raw of rest) {
    if (raw === '--long') {
      long = true;
      continue;
    }
    if (raw.startsWith('--prefix=')) {
      const value = raw.slice('--prefix='.length);
      if (value.length === 0) throw new Error('--prefix=<path> requires a non-empty value');
      prefix = normalizeDocumentPrefix(value);
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format value '${value}' (expected md or json)`);
      }
      format = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown option '${raw}'`);
    if (kb !== undefined) throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
    kb = raw;
  }

  return { kb, prefix, long, format };
}

export async function runLs(rest: string[] = []): Promise<number> {
  let parsed: LsArgs;
  try {
    parsed = parseLsArgs(rest);
  } catch (err) {
    process.stderr.write(`kb ls: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    const report = await collectLsReport({
      rootDir: KNOWLEDGE_BASES_ROOT_DIR,
      kb: parsed.kb,
      prefix: parsed.prefix,
      long: parsed.long,
    });
    process.stdout.write(formatLsReport(report, parsed.format));
    return 0;
  } catch (err) {
    process.stderr.write(`kb ls: ${(err as Error).message}\n`);
    return 1;
  }
}

export async function collectLsReport(options: CollectLsReportOptions): Promise<LsReport> {
  const listing = await listKnowledgeBaseDocuments({
    rootDir: options.rootDir,
    ...(options.kb !== undefined ? { kbName: options.kb } : {}),
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    failOnEnumerationError: true,
    skipMissingKb: false,
  });
  const documents = options.long === true
    ? await mapBounded(
      listing.documents,
      resolveFsConcurrency(),
      async (document) => toLongDocument(document),
    )
    : listing.documents.map(toShortDocument);

  return {
    knowledgeBases: listing.knowledgeBases,
    prefix: listing.prefix.length === 0 ? null : listing.prefix,
    ...(options.kb !== undefined ? { scopedKb: options.kb } : {}),
    documents,
  };
}

export function formatLsReport(report: LsReport, format: 'md' | 'json'): string {
  if (format === 'json') {
    return `${JSON.stringify({
      schemaVersion: LS_SCHEMA_VERSION,
      knowledgeBases: report.knowledgeBases,
      prefix: report.prefix,
      documents: report.documents,
    }, null, 2)}\n`;
  }

  if (!hasLongFields(report.documents)) {
    const paths = report.documents.map((document) =>
      escapeLinePath(report.scopedKb === undefined
        ? `${document.knowledgeBase}/${document.path}`
        : document.path),
    );
    return paths.length === 0 ? '' : `${paths.join('\n')}\n`;
  }

  const lines = [
    '| KB | Path | Tier | Status | Type | Modified |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const document of report.documents) {
    lines.push(
      `| ${escapeTableCell(document.knowledgeBase)} | ${escapeTableCell(document.path)} | ` +
      `${escapeTableCell(document.tier ?? '—')} | ${escapeTableCell(document.status ?? '—')} | ` +
      `${escapeTableCell(document.type ?? '—')} | ${escapeTableCell(document.mtime ?? '—')} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function toShortDocument(document: KnowledgeBaseDocument): LsDocument {
  return {
    knowledgeBase: document.kbName,
    path: document.relativePath,
  };
}

async function toLongDocument(document: KnowledgeBaseDocument): Promise<LsDocument> {
  const [stats, frontmatterContent] = await Promise.all([
    fsp.stat(document.absolutePath),
    readFrontmatterPrefix(document.absolutePath),
  ]);
  const frontmatter = parseFrontmatter(frontmatterContent).frontmatter;
  return {
    ...toShortDocument(document),
    tier: frontmatterString(frontmatter.tier),
    status: frontmatterString(frontmatter.status),
    type: frontmatterString(frontmatter.type),
    mtime: stats.mtime.toISOString(),
  };
}

async function readFrontmatterPrefix(filePath: string): Promise<string> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(FRONTMATTER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function frontmatterString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const values = value.filter((entry): entry is string => typeof entry === 'string');
    return values.length === 0 ? null : values.join(', ');
  }
  return null;
}

function hasLongFields(documents: readonly LsDocument[]): boolean {
  return documents.some((document) => document.mtime !== undefined);
}

function escapeTableCell(value: string): string {
  return escapeControlCharacters(value).replaceAll('|', '\\|');
}

function escapeLinePath(value: string): string {
  return escapeControlCharacters(value);
}

function escapeControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/gu, (character) => {
    switch (character) {
      case '\b': return '\\b';
      case '\t': return '\\t';
      case '\n': return '\\n';
      case '\f': return '\\f';
      case '\r': return '\\r';
      default: return `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`;
    }
  });
}
