// `kb tags` — read-only frontmatter-facet browser (issue #752).
//
// `kb search` can *filter* by frontmatter facets (tags, status, type) but
// there is no way to *discover* which values exist in a KB. This command
// walks every `.md` / `.markdown` note under one or all KBs, parses YAML
// frontmatter, and prints each facet's distinct values with per-note
// document counts, so a user or agent can learn the valid filter
// vocabulary before constructing a filtered query. Strictly read-only:
// never touches indexes, sidecars, or notes.
//
// The command-independent scan + aggregation + JSON-payload core lives in
// `facets-core.ts` so the read-only `list_facets` MCP tool (#1151) can reuse
// it without importing this `cli-*` adapter (the non-CLI import boundary,
// #405). This module owns only the argv/stdout/exit-code concerns; the core
// symbols are re-exported below so existing importers keep working.

import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { collectTagsReport, DEFAULT_FACETS, formatTagsReport } from './facets-core.js';

export {
  DEFAULT_FACETS,
  TAGS_SCHEMA_VERSION,
  aggregateFacets,
  buildFacetsJsonPayload,
  collectTagsReport,
  extractFacetValues,
  formatTagsReport,
} from './facets-core.js';
export type {
  CollectTagsOptions,
  FacetAggregation,
  FacetsJsonPayload,
  FacetValueCount,
  TagsReport,
} from './facets-core.js';

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
