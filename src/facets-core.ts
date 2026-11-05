// facets-core.ts
//
// Command-independent frontmatter-facet enumeration behind both the `kb tags`
// CLI adapter (`cli-tags.ts`) and the read-only `list_facets` MCP tool
// (`KnowledgeBaseServer.ts`, issue #1151). Per the repo's non-CLI import
// boundary (issue #405 / `non-cli-import-boundary.test.ts`), the MCP server
// must NOT import a `cli-*` command adapter, so the reusable scan + aggregation
// + JSON-payload logic lives here and both surfaces import it — mirroring the
// `related-core.ts` extraction done for `find_related` (#1133 / PR #1149).
//
// This module owns no process concerns (no argv parsing, no stdout, no exit
// codes): it reads notes under a caller-supplied root and returns a structured
// report, leaving each caller to apply its own transport contract. Strictly
// read-only: it never touches indexes, sidecars, or notes.

import * as fsp from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { listKnowledgeBases, resolveKnowledgeBaseDir } from './kb-fs.js';

/** Stable wire-contract version for the JSON facet report (`kb tags --format=json`). */
export const TAGS_SCHEMA_VERSION = 'kb.tags.v1';

/** Default facets reported when a single facet is not requested. */
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

/** The stable JSON shape returned by `kb tags --format=json` and `list_facets`. */
export interface FacetsJsonPayload {
  schemaVersion: string;
  knowledgeBases: string[];
  notesScanned: number;
  facets: Record<string, FacetValueCount[]>;
}

export interface CollectTagsOptions {
  rootDir: string;
  kbFilter?: string;
  facets: readonly string[];
}

/**
 * Walk every `.md` / `.markdown` note under one or all KBs rooted at
 * `rootDir`, parse YAML frontmatter, and aggregate the requested facets.
 * When `kbFilter` is set, resolves it through `resolveKnowledgeBaseDir`, which
 * throws `KBError('KB_NOT_FOUND', …)` for an unknown name — each caller maps
 * that to its own error contract (CLI exit code 1 / MCP KB_NOT_FOUND).
 */
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

/**
 * Build the stable JSON payload (`kb.tags.v1`) from a report. Shared by the
 * CLI's `--format=json` output and the MCP `list_facets` tool so both surfaces
 * emit byte-identical facet data.
 */
export function buildFacetsJsonPayload(report: TagsReport): FacetsJsonPayload {
  const facets: Record<string, FacetValueCount[]> = {};
  for (const aggregation of report.facets) {
    facets[aggregation.facet] = aggregation.values;
  }
  return {
    schemaVersion: TAGS_SCHEMA_VERSION,
    knowledgeBases: report.kbs,
    notesScanned: report.notesScanned,
    facets,
  };
}

export function formatTagsReport(report: TagsReport, format: 'md' | 'json'): string {
  if (format === 'json') {
    return `${JSON.stringify(buildFacetsJsonPayload(report), null, 2)}\n`;
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
  return all.sort((a, b) => a.localeCompare(b));
}

async function listMarkdownFiles(kbDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[] = [];
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
  return out.sort((a, b) => a.localeCompare(b));
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
