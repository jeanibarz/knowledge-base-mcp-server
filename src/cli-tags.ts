// `kb tags` — read-only frontmatter-facet browser (issue #752).
//
// `kb search` can *filter* by frontmatter facets (tags, status, type) but
// there is no way to *discover* which values exist in a KB. This command
// walks every `.md` / `.markdown` note under one or all KBs, parses YAML
// frontmatter, and prints each facet's distinct values with per-note
// document counts, so a user or agent can learn the valid filter
// vocabulary before constructing a filtered query. Strictly read-only:
// never touches indexes, sidecars, or notes.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { parseFrontmatter } from './frontmatter.js';
import { listKnowledgeBases, resolveKnowledgeBaseDir } from './kb-fs.js';

export const TAGS_HELP = `kb tags — enumerate frontmatter facet values with counts (read-only)

Usage:
  kb tags [--kb=<name>] [--facet=<name>] [--format=md|json]

Walks every \`.md\` / \`.markdown\` note under one or all KBs, parses YAML
frontmatter, and reports each facet's distinct values with the number of
notes carrying that value (sorted by count, then value). Use it to learn
the valid vocabulary for \`kb search --tags\` / \`--status\` / \`--type\`
filters before constructing a query. Strictly read-only.

By default the taxonomy facets \`tags\`, \`status\`, and \`type\` are reported.
\`--facet=<name>\` narrows the scan to a single frontmatter key (any key,
so you can discover facets beyond the defaults).

Values are counted per note: a note listing a value more than once counts
once, and array-valued facets (e.g. \`tags\`) count each distinct element.

Options:
  --kb=<name>           Scope to one knowledge base. Omit for all KBs.
  --facet=<name>        Report a single frontmatter key instead of the
                        default tags/status/type set.
  --format=md|json      Output format (default: md). \`json\` is a stable
                        shape suitable for agent shells.
  --help, -h            Show this help.

Environment:
  KNOWLEDGE_BASES_ROOT_DIR  Root directory containing one folder per KB.

Exit codes:
  0   facet report printed (may be empty)
  1   runtime error (unreadable KB or note)
  2   argv error (bad flag, --format, or empty --kb / --facet)

Examples:
  kb tags
  kb tags --kb=work
  kb tags --facet=status
  kb tags --format=json
`;

export const TAGS_SCHEMA_VERSION = 'kb.tags.v1';

/** Default facets reported when \`--facet\` is not supplied. */
export const DEFAULT_FACETS = ['tags', 'status', 'type'] as const;

const MARKDOWN_EXTS = new Set(['.md', '.markdown']);

export interface FacetValueCount {
  value: string;
  count: number;
}

export interface FacetAggregation {
  facet: string;
  values: FacetValueCount[];
}

export interface TagsReport {
  kbs: string[];
  notesScanned: number;
  facets: FacetAggregation[];
}

interface TagsArgs {
  kb?: string;
  facets: string[];
  format: 'md' | 'json';
}

export function parseTagsArgs(rest: readonly string[]): TagsArgs {
  let kb: string | undefined;
  let facet: string | undefined;
  let format: 'md' | 'json' = 'md';
  for (const raw of rest) {
    if (raw.startsWith('--kb=')) {
      kb = raw.slice('--kb='.length);
      if (kb.length === 0) throw new Error('--kb=<name> requires a non-empty value');
      continue;
    }
    if (raw.startsWith('--facet=')) {
      facet = raw.slice('--facet='.length);
      if (facet.length === 0) throw new Error('--facet=<name> requires a non-empty value');
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
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  const facets = facet !== undefined ? [facet] : [...DEFAULT_FACETS];
  return { kb, facets, format };
}

export async function runTags(rest: string[] = []): Promise<number> {
  let parsed: TagsArgs;
  try {
    parsed = parseTagsArgs(rest);
  } catch (err) {
    process.stderr.write(`kb tags: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    const report = await collectTagsReport({
      rootDir: KNOWLEDGE_BASES_ROOT_DIR,
      kbFilter: parsed.kb,
      facets: parsed.facets,
    });
    process.stdout.write(formatTagsReport(report, parsed.format));
    return 0;
  } catch (err) {
    process.stderr.write(`kb tags: ${(err as Error).message}\n`);
    return 1;
  }
}

export interface CollectTagsOptions {
  rootDir: string;
  kbFilter?: string;
  facets: readonly string[];
}

export async function collectTagsReport(opts: CollectTagsOptions): Promise<TagsReport> {
  const kbs = await selectKbs(opts.rootDir, opts.kbFilter);
  const frontmatters: Record<string, unknown>[] = [];
  for (const kb of kbs) {
    const kbDir = await resolveKnowledgeBaseDir(opts.rootDir, kb);
    const files = await listMarkdownFiles(kbDir);
    for (const notePath of files) {
      const content = await fsp.readFile(notePath, 'utf-8');
      frontmatters.push(parseFrontmatter(content).frontmatter);
    }
  }
  return {
    kbs,
    notesScanned: frontmatters.length,
    facets: aggregateFacets(frontmatters, opts.facets),
  };
}

/**
 * Pure facet aggregation: for each requested facet, count how many of the
 * given frontmatter objects carry each distinct value. Values are counted
 * once per note (a note repeating a value does not double-count), and each
 * distinct element of an array-valued facet contributes to its own bucket.
 * Non-string / empty values are ignored. Results are sorted by descending
 * count, then ascending value for deterministic output.
 */
export function aggregateFacets(
  frontmatters: ReadonlyArray<Record<string, unknown>>,
  facets: readonly string[],
): FacetAggregation[] {
  return facets.map((facet) => {
    const counts = new Map<string, number>();
    for (const frontmatter of frontmatters) {
      const values = new Set(extractFacetValues(frontmatter[facet]));
      for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    const values = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || compareStrings(a.value, b.value));
    return { facet, values };
  });
}

/**
 * Normalize a frontmatter value into the list of facet values it carries.
 * Arrays yield their string elements; a bare string yields itself; anything
 * else yields nothing. All values are trimmed and empties dropped.
 */
export function extractFacetValues(raw: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed.length > 0) out.push(trimmed);
      }
    }
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

export function formatTagsReport(report: TagsReport, format: 'md' | 'json'): string {
  if (format === 'json') {
    const facets: Record<string, FacetValueCount[]> = {};
    for (const aggregation of report.facets) {
      facets[aggregation.facet] = aggregation.values;
    }
    return `${JSON.stringify(
      {
        schemaVersion: TAGS_SCHEMA_VERSION,
        knowledgeBases: report.kbs,
        notesScanned: report.notesScanned,
        facets,
      },
      null,
      2,
    )}\n`;
  }

  const lines: string[] = [];
  for (const aggregation of report.facets) {
    if (aggregation.values.length === 0) {
      lines.push(`${aggregation.facet} — no values found`);
      lines.push('');
      continue;
    }
    lines.push(`${aggregation.facet} — ${aggregation.values.length} distinct value(s)`);
    const width = aggregation.values.reduce((max, v) => Math.max(max, v.value.length), 0);
    for (const { value, count } of aggregation.values) {
      lines.push(`  ${value.padEnd(width)}  ${count}`);
    }
    lines.push('');
  }
  lines.push(
    `Scanned ${report.notesScanned} note(s) across ${report.kbs.length} KB(s).`,
  );
  return `${lines.join('\n')}\n`;
}

async function selectKbs(rootDir: string, kbFilter: string | undefined): Promise<string[]> {
  if (kbFilter !== undefined) {
    // Throws KB_NOT_FOUND if missing; surfaced as a 1-exit error message.
    await resolveKnowledgeBaseDir(rootDir, kbFilter);
    return [kbFilter];
  }
  const all = await listKnowledgeBases(rootDir);
  return all.sort();
}

async function listMarkdownFiles(kbDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof fsp.readdir>> = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (MARKDOWN_EXTS.has(ext)) out.push(full);
      }
    }
  }
  await walk(kbDir);
  return out.sort();
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
