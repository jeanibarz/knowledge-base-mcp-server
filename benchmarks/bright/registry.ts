// RFC 020 §8 (milestone M3) — the BRIGHT task registry.
//
// BRIGHT (Su et al., 2024) is a *reasoning-intensive* retrieval benchmark: the
// query is a real, multi-sentence problem and the relevant documents are the
// passages whose knowledge is *needed to reason to the answer*, not the ones
// that share surface terms. Pure dense retrievers underperform on it and
// rerank / LLM-in-the-loop helps — which is exactly the pipeline this project
// ships (RFC 018/019 + the listwise-rerank roadmap), so BRIGHT is where
// hybrid+rerank should pull clearly ahead of a dense baseline.
//
// This registry is the single source of truth for the BRIGHT task set: the 12
// official tasks grouped by their source domain and reasoning flavour, plus a
// contamination note. BRIGHT is newer and less saturated than BEIR, so its
// leakage risk is lower — but its corpora are still public, so the note travels
// with every reported number (same discipline as the BEIR registry).

export type BrightDomain =
  | 'stackexchange'
  | 'coding'
  | 'competition-math'
  | 'theorem-based';

export interface BrightTaskEntry {
  /** Registry key; matches the BRIGHT task/config name on its dataset host. */
  name: string;
  /** Human-facing label for reports. */
  title: string;
  /** Source-domain bucket the multi-task mean averages over. */
  domain: BrightDomain;
  /** Short description of the reasoning the task demands. */
  reasoning: string;
  contamination: {
    knownInPretraining: boolean;
    note: string;
  };
}

// The 12 official BRIGHT tasks, grouped by domain. Order is the canonical report
// order: the seven StackExchange tasks first, then coding, then the math/theorem
// tasks.
export const BRIGHT_REGISTRY: readonly BrightTaskEntry[] = [
  // --- StackExchange (real-world reasoning) ---
  brightTask('biology', 'Biology', 'stackexchange', 'Biology StackExchange questions needing domain reasoning, not keyword overlap.'),
  brightTask('earth_science', 'Earth Science', 'stackexchange', 'Earth-science questions where the gold passage is causally, not lexically, related.'),
  brightTask('economics', 'Economics', 'stackexchange', 'Economics reasoning questions; relevant docs supply the mechanism, not the terms.'),
  brightTask('psychology', 'Psychology', 'stackexchange', 'Psychology questions requiring conceptual links to the supporting evidence.'),
  brightTask('robotics', 'Robotics', 'stackexchange', 'Robotics problems where the needed passage is a technique, not a term match.'),
  brightTask('stackoverflow', 'StackOverflow', 'stackexchange', 'Programming Q&A where the answer hinges on an underlying concept or API behaviour.'),
  brightTask('sustainable_living', 'Sustainable Living', 'stackexchange', 'Sustainability questions needing applied reasoning over the source material.'),
  // --- Coding ---
  brightTask('leetcode', 'LeetCode', 'coding', 'Coding problems whose relevant docs share an algorithmic idea, not tokens.'),
  brightTask('pony', 'Pony', 'coding', 'Pony-language programming questions over a niche, low-leakage corpus.'),
  // --- Competition / theorem-based math & science ---
  brightTask('aops', 'AoPS', 'competition-math', 'Art-of-Problem-Solving competition math; relevance is a shared solution technique.'),
  brightTask('theoremqa_questions', 'TheoremQA-Questions', 'theorem-based', 'Theorem-application questions; the gold doc states the theorem to apply.'),
  brightTask('theoremqa_theorems', 'TheoremQA-Theorems', 'theorem-based', 'Theorem-retrieval variant; retrieve the theorem(s) a problem depends on.'),
];

function brightTask(
  name: string,
  title: string,
  domain: BrightDomain,
  reasoning: string,
): BrightTaskEntry {
  const lowLeakage = domain === 'coding' || domain === 'theorem-based' || domain === 'competition-math';
  return {
    name,
    title,
    domain,
    reasoning,
    contamination: {
      knownInPretraining: false,
      note: lowLeakage
        ? `${title}: niche/technical corpus released 2024, low pretraining-leakage risk; reasoning task resists memorisation.`
        : `${title}: public StackExchange-derived corpus; some leakage possible, but the gold links are reasoning-based, not lexical.`,
    },
  };
}

const REGISTRY_BY_NAME: ReadonlyMap<string, BrightTaskEntry> = new Map(
  BRIGHT_REGISTRY.map((entry) => [entry.name, entry]),
);

export function getBrightTask(name: string): BrightTaskEntry | undefined {
  return REGISTRY_BY_NAME.get(name);
}

/** All BRIGHT task names, in canonical report order. */
export function brightTaskNames(): string[] {
  return BRIGHT_REGISTRY.map((entry) => entry.name);
}

export function brightDomainOf(name: string): BrightDomain | 'unknown' {
  return getBrightTask(name)?.domain ?? 'unknown';
}

/**
 * Invariant check used by tests and (defensively) the runner: every task name is
 * unique and maps to a known domain bucket. Throws on a misconfigured registry.
 */
export function assertBrightRegistryInvariants(
  registry: readonly BrightTaskEntry[] = BRIGHT_REGISTRY,
): void {
  const names = new Set<string>();
  for (const entry of registry) {
    if (names.has(entry.name)) {
      throw new Error(`bright registry: duplicate task name "${entry.name}"`);
    }
    names.add(entry.name);
    if (entry.reasoning.trim() === '') {
      throw new Error(`bright registry: task "${entry.name}" has no reasoning description`);
    }
  }
  if (names.size === 0) {
    throw new Error('bright registry: empty task set');
  }
}
