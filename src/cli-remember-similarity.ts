// Pure helpers for the `kb remember` semantic preflight guard (issue #154).
//
// Split out of `cli-remember.ts` so unit tests can import them without
// transitively pulling in `markdown-section.ts` -> `mdast-util-from-markdown`,
// which is pure ESM and breaks ts-jest's CommonJS-by-default loader.

import type { ScoredDocument } from './formatter.js';

export interface SimilarCandidate {
  knowledge_base: string;
  relative_path: string;
  score: number;
  chunk: string;
  suggested_invocation: string;
}

export interface PreflightDecisionHint {
  summary: string;
  recommended_agent_actions: string[];
}

export const DEFAULT_SIMILAR_THRESHOLD = 1.0;
export const DEFAULT_SIMILAR_K = 5;
const CHUNK_EXCERPT_LIMIT = 240;

// Issue #154: dedicated exit code for "blocked by --check-similar guard".
// Distinct from `1` (runtime/index error) and `2` (argv/env error) so shell
// pipelines and agents can detect a guard refusal without parsing JSON.
export const EXIT_BLOCKED_BY_SIMILARITY_GUARD = 3;

export const PREFLIGHT_DECISION_HINT: PreflightDecisionHint = {
  summary: 'Similar KB chunks were found before writing.',
  recommended_agent_actions: [
    'If the proposed content is already represented, do not write a duplicate.',
    'If the proposed content corrects or refines an existing chunk, update that note/section instead.',
    'If the proposed content is related but genuinely new, rerun with --force and explain why.',
  ],
};

export function candidatesFromResults(
  results: readonly ScoredDocument[],
  defaultKb: string,
): SimilarCandidate[] {
  const out: SimilarCandidate[] = [];
  for (const r of results) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const kb = typeof meta.knowledgeBase === 'string' && meta.knowledgeBase.length > 0
      ? meta.knowledgeBase
      : defaultKb;
    const fullRel = typeof meta.relativePath === 'string' && meta.relativePath.length > 0
      ? meta.relativePath
      : null;
    if (fullRel === null) continue;
    // metadata.relativePath is rooted at KNOWLEDGE_BASES_ROOT_DIR, so it
    // includes the KB name segment; strip it for the user-facing path so the
    // suggested invocation is directly usable as `--append=<path>`.
    const kbInternal = stripKbPrefix(fullRel, kb);
    out.push({
      knowledge_base: kb,
      relative_path: kbInternal,
      score: r.score ?? Number.POSITIVE_INFINITY,
      chunk: truncateChunk(r.pageContent),
      suggested_invocation:
        `kb remember --kb=${kb} --append=${kbInternal} --stdin --yes`,
    });
  }
  return out;
}

function stripKbPrefix(relativePath: string, kbName: string): string {
  const prefix = `${kbName}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : relativePath;
}

function truncateChunk(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= CHUNK_EXCERPT_LIMIT) return trimmed;
  return `${trimmed.slice(0, CHUNK_EXCERPT_LIMIT)}…`;
}

export function buildBlockedJson(candidates: readonly SimilarCandidate[]): {
  action: 'similarity-check';
  write_performed: false;
  decision_hint: PreflightDecisionHint;
  candidates: readonly SimilarCandidate[];
} {
  return {
    action: 'similarity-check',
    write_performed: false,
    decision_hint: PREFLIGHT_DECISION_HINT,
    candidates,
  };
}

export function formatBlockedMarkdown(candidates: readonly SimilarCandidate[]): string {
  const header = '# kb remember — blocked by --check-similar guard\n\n' +
    `${PREFLIGHT_DECISION_HINT.summary}\n\n` +
    'Recommended next actions:\n' +
    PREFLIGHT_DECISION_HINT.recommended_agent_actions.map((a) => `- ${a}`).join('\n') +
    '\n\n';
  const body = candidates
    .map((c, idx) => {
      return (
        `## Candidate ${idx + 1}\n\n` +
        `- KB: ${c.knowledge_base}\n` +
        `- Path: ${c.relative_path}\n` +
        `- Score: ${c.score.toFixed(2)} (lower distance = closer match)\n` +
        `- Suggested: \`${c.suggested_invocation}\`\n\n` +
        `\`\`\`\n${c.chunk}\n\`\`\``
      );
    })
    .join('\n\n');
  return `${header}${body}`;
}
