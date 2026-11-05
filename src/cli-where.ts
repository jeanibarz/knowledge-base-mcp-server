// `kb where --topic=<query>` — one-shot "which KB and which file should I
// update?" recommendation (issue #141).
//
// Strategy (from the issue body, "cheap path"):
//   1. Run a similarity search across all KBs (no `--kb=` filter).
//   2. Group hits by `metadata.knowledgeBase`. The KB with the highest-scoring
//      top hit is the recommended KB.
//   3. The single file with the highest score within that KB is the
//      recommended existing target.
//   4. Apply a confidence threshold: lower FAISS distance = closer match;
//      a top score below `--threshold` (default 1.0) is "high confidence
//      existing target", otherwise suggest `kb remember --title=...` to
//      create a new note.
//   5. Print the recommendation + a copy-pasteable `kb remember` invocation.
//
// Strictly read-only — same posture as `kb search` without `--refresh`.
//
// Composes with #139 (`--append-section`) and #140 (`kb list --describe`)
// once those land; today the suggestion sticks to flags the CLI accepts.

import { FaissIndexManager } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  resolveActiveModel,
} from './model-resolution.js';
import { loadManagerForModel, loadWithJsonRetry as loadManagerWithJsonRetry } from './cli-shared.js';
import type { ScoredDocument } from './formatter.js';
// The command-independent decision + JSON-serialization core lives in
// `recommend-kb-core.ts` so the read-only `recommend_knowledge_base` MCP tool
// (#1152) can reuse it without importing this `cli-*` adapter (the non-CLI
// import boundary, #405). This module keeps only the argv/stdout/exit-code
// concerns; the core symbols are re-exported below so existing importers keep
// working.
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_K,
  decideWhere,
  toWhereJsonShape,
  type WhereDecision,
} from './recommend-kb-core.js';

export {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_K,
  decideWhere,
  toWhereJsonShape,
} from './recommend-kb-core.js';
export type { WhereDecision } from './recommend-kb-core.js';

export const WHERE_HELP = `kb where — recommend the best KB and file for a topic (read-only)

Usage:
  kb where --topic=<query> [--threshold=<float>] [--k=<int>]
           [--format=md|json] [--model=<id>]

Runs a similarity search across all KBs, picks the KB with the
highest-scoring hit, and recommends the single best existing file inside
it. When the top score is above \`--threshold\` (lower = closer), suggests
\`kb remember --title=...\` to create a new note instead of appending.

Strictly read-only — same posture as \`kb search\` without \`--refresh\`.

Required:
  --topic=<query>       The topic / one-line description to place.

Options:
  --threshold=<float>   Confidence cutoff (default: 1.0). Top scores
                        BELOW this distance are "high confidence existing
                        target"; above it, recommend creating a new note.
  --k=<int>             Top-K results to consider when grouping.
  --format=md|json      Output format (default: md). \`json\` is suitable
                        for agent shells.
  --model=<id>          Override the active model for this call (RFC 013).
  --help, -h            Show this help.

Examples:
  kb where --topic="quarterly retro template"
  kb where --topic="oncall rotation" --threshold=0.8 --format=json
`;

export interface WhereArgs {
  topic: string | null;
  model?: string;
  threshold: number;
  k: number;
  format: 'md' | 'json';
}

type WhereSearchManager = Pick<FaissIndexManager, 'similaritySearch'>;

export interface RunWhereDeps {
  bootstrapLayout: () => Promise<void>;
  resolveActiveModel: (options: { explicitOverride?: string }) => Promise<string>;
  loadManagerForModel: (modelId: string) => Promise<WhereSearchManager>;
  loadWithJsonRetry: (manager: WhereSearchManager) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_WHERE_DEPS: RunWhereDeps = {
  bootstrapLayout: () => FaissIndexManager.bootstrapLayout(),
  resolveActiveModel,
  loadManagerForModel,
  loadWithJsonRetry: (manager) => loadManagerWithJsonRetry(manager as FaissIndexManager),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runWhere(rest: string[], deps: RunWhereDeps = DEFAULT_WHERE_DEPS): Promise<number> {
  let parsed: WhereArgs;
  try {
    parsed = parseWhereArgs(rest);
  } catch (err) {
    deps.stderr(`kb where: ${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.topic === null) {
    deps.stderr('kb where: missing --topic=<query>\n');
    return 2;
  }

  try {
    await deps.bootstrapLayout();
  } catch (err) {
    deps.stderr(`kb where: layout bootstrap failed: ${(err as Error).message}\n`);
    return 1;
  }

  let activeModelId: string;
  try {
    activeModelId = await deps.resolveActiveModel({ explicitOverride: parsed.model });
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      deps.stderr(`kb where: ${err.message}\n`);
      return 2;
    }
    deps.stderr(`kb where: ${(err as Error).message}\n`);
    return 1;
  }

  let manager: WhereSearchManager;
  try {
    manager = await deps.loadManagerForModel(activeModelId);
  } catch (err) {
    deps.stderr(`kb where: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    await deps.loadWithJsonRetry(manager);
  } catch (err) {
    deps.stderr(`kb where: ${(err as Error).message}\n`);
    return 1;
  }

  let results: ScoredDocument[];
  try {
    // No `--kb=` filter — we want the cross-KB ranking.
    results = await manager.similaritySearch(
      parsed.topic,
      parsed.k,
      Number.POSITIVE_INFINITY,
    );
  } catch (err) {
    deps.stderr(`kb where: ${(err as Error).message}\n`);
    return 1;
  }

  const decision = decideWhere(results, parsed.threshold);
  if (decision === null) {
    if (parsed.format === 'json') {
      deps.stdout(`${JSON.stringify({ recommended_kb: null, results: [] }, null, 2)}\n`);
    } else {
      deps.stdout(
        '_No similar notes found. Run `kb search --refresh` if the index is empty or stale._\n',
      );
    }
    return 0;
  }

  if (parsed.format === 'json') {
    deps.stdout(`${JSON.stringify(toWhereJsonShape(decision), null, 2)}\n`);
  } else {
    deps.stdout(formatWhereMarkdown(decision));
    deps.stdout('\n');
  }
  return 0;
}

export function parseWhereArgs(rest: string[]): WhereArgs {
  const out: WhereArgs = {
    topic: null,
    threshold: DEFAULT_CONFIDENCE_THRESHOLD,
    k: DEFAULT_K,
    format: 'md',
  };
  for (const raw of rest) {
    if (raw.startsWith('--topic=')) {
      const v = raw.slice('--topic='.length);
      if (v.length === 0) throw new Error('--topic=<query> requires a non-empty value');
      out.topic = v;
      continue;
    }
    if (raw.startsWith('--model=')) {
      out.model = raw.slice('--model='.length);
      continue;
    }
    if (raw.startsWith('--threshold=')) {
      const n = Number(raw.slice('--threshold='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --threshold: ${raw}`);
      out.threshold = n;
      continue;
    }
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = n;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v !== 'md' && v !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = v;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  return out;
}

export function formatWhereMarkdown(d: WhereDecision): string {
  const target = d.existingTarget ?? '_(none — suggest creating a new note)_';
  const conf = d.confidence.toFixed(2);
  const confLabel = d.existingTarget !== null ? 'high' : 'low';
  return (
    `Recommended KB:        ${d.recommendedKb}\n` +
    `Existing target:       ${target}\n` +
    `Confidence:            ${conf} (${confLabel}; lower distance = closer match)\n` +
    `Suggested invocation:  ${d.suggestedInvocation}`
  );
}
