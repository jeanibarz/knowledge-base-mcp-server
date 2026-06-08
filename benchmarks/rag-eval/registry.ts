// RFC 020 §5/§6 — gold-bearing QA dataset registry for the e2e RAG eval.
//
// The eval is scoped to "objective-ground-truth datasets — short-answer/multi-
// hop QA with gold answers and gold supporting facts, where Tier 1 carries most
// of the weight" (§5 honest-tradeoff note). This registry is the single source
// of truth for that set: HotpotQA (gold supporting sentences), Natural Questions
// (short gold answers), and 2WikiMultiHop (short answers + supporting facts).
//
// Per §6 contamination controls, every dataset records whether it is known to
// be in pretraining corpora and whether its qrels are expert or crowdsourced —
// the note travels with every reported number, and dataset names are excluded
// from any judge prompt (the judge sees only question/answer/contexts).

export type GoldFieldKind = 'short-answer' | 'supporting-facts' | 'both';

export interface RagDatasetEntry {
  /** Registry key; matches the GoldQaItem.dataset field and CLI --datasets. */
  name: string;
  title: string;
  /** Which gold fields the dataset ships (drives Tier-1 coverage). */
  goldFields: GoldFieldKind;
  /** Whether items are multi-hop (route more often to Tier 2/3 on paraphrase). */
  multiHop: boolean;
  contamination: {
    knownInPretraining: boolean;
    expertQrels: boolean;
    note: string;
  };
}

export const RAG_EVAL_REGISTRY: readonly RagDatasetEntry[] = [
  {
    name: 'hotpotqa',
    title: 'HotpotQA',
    goldFields: 'both',
    multiHop: true,
    contamination: {
      knownInPretraining: true,
      expertQrels: false,
      note: 'HotpotQA: public Wikipedia multi-hop QA, crowdsourced; ships gold answer + gold supporting sentences. ' +
        'Known in pretraining — dataset name is excluded from judge prompts to avoid leakage cueing (§6).',
    },
  },
  {
    name: 'nq',
    title: 'Natural Questions',
    goldFields: 'short-answer',
    multiHop: false,
    contamination: {
      knownInPretraining: true,
      expertQrels: false,
      note: 'Natural Questions: real Google queries over Wikipedia; short gold answers, no per-item supporting ' +
        'sentences here (context recall/precision are null for NQ items). Known in pretraining.',
    },
  },
  {
    name: '2wikimultihop',
    title: '2WikiMultiHop',
    goldFields: 'both',
    multiHop: true,
    contamination: {
      knownInPretraining: true,
      expertQrels: false,
      note: '2WikiMultiHop: structured multi-hop QA with short answers + evidence (supporting facts). ' +
        'Public/crowdsourced; name excluded from judge prompts (§6).',
    },
  },
];

const REGISTRY_BY_NAME: ReadonlyMap<string, RagDatasetEntry> = new Map(
  RAG_EVAL_REGISTRY.map((entry) => [entry.name, entry]),
);

export function getRagDataset(name: string): RagDatasetEntry | undefined {
  return REGISTRY_BY_NAME.get(name);
}

export function ragDatasetNames(): string[] {
  return RAG_EVAL_REGISTRY.map((entry) => entry.name);
}

/**
 * Invariant check (tests + defensive runner use): names are unique, every
 * entry carries a non-empty contamination note, and the set is non-empty.
 */
export function assertRagRegistryInvariants(
  registry: readonly RagDatasetEntry[] = RAG_EVAL_REGISTRY,
): void {
  const names = new Set<string>();
  for (const entry of registry) {
    if (names.has(entry.name)) throw new Error(`rag-eval registry: duplicate dataset "${entry.name}"`);
    names.add(entry.name);
    if (entry.contamination.note.trim() === '') {
      throw new Error(`rag-eval registry: dataset "${entry.name}" has no contamination note`);
    }
  }
  if (names.size === 0) throw new Error('rag-eval registry: empty dataset set');
}
