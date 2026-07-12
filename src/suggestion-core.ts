/** Shared typo-suggestion helpers used by the CLI and KB error diagnostics. */

export interface ClosestSuggestion {
  value: string;
  distance: number;
}

export const MAX_KNOWLEDGE_BASE_SUGGESTIONS = 5;

/**
 * Rank candidate names with the same deterministic ordering used by CLI
 * command and flag suggestions: distance first, then shorter names, then
 * lexicographic order. Duplicate names are removed so filesystem oddities do
 * not duplicate entries in an error message.
 */
export function rankSuggestions(
  input: string,
  candidates: readonly string[],
): ClosestSuggestion[] {
  return [...new Set(candidates)]
    .map((value) => ({ value, distance: levenshteinDistance(input, value) }))
    .sort((a, b) => (
      a.distance - b.distance
      || a.value.length - b.value.length
      || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
    ));
}

export function closestSuggestion(
  input: string,
  candidates: readonly string[],
): ClosestSuggestion | undefined {
  const best = rankSuggestions(input, candidates)[0];
  if (best === undefined || best.distance > suggestionDistanceThreshold(input)) return undefined;
  return best;
}

/**
 * Keep short transposition typos such as "alpah" → "alpha" actionable while
 * retaining a bounded threshold for unrelated names.
 */
export function suggestionDistanceThreshold(input: string): number {
  return Math.max(1, Math.ceil(input.length / 3));
}

export function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + substitutionCost,
      );
    }
  }
  return dp[a.length][b.length];
}

export function formatKnowledgeBaseSuggestions(
  input: string,
  candidates: readonly string[],
): string {
  const ranked = rankSuggestions(input, candidates);
  if (ranked.length === 0) return '';

  const available = ranked
    .slice(0, MAX_KNOWLEDGE_BASE_SUGGESTIONS)
    .map(({ value }) => value)
    .join(', ');
  const suggestion = closestSuggestion(input, candidates);
  return [
    `Available knowledge bases: ${available}.`,
    suggestion === undefined ? null : `Did you mean ${suggestion.value}?`,
  ].filter((line): line is string => line !== null).join('\n');
}
