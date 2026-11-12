// RFC 020 §2/§6 — the BEIR dataset registry.
//
// A single dataset is overfittable; the field quotes the multi-dataset mean, so
// the headline metric (M2) is a per-mode mean across the full public BEIR set.
// This registry is the single source of truth for that set: the dataset names,
// their domains, the qrels split the headline reports on, and — per §6 — two
// orthogonal classifications that the generalization machinery consumes:
//
//   * `ciSubset`        — the small, fast, domain-diverse gate subset
//                         (SciFact / NFCorpus / FiQA), mirrored from
//                         `baseline.ts` CI_SUBSET. Runs per-PR.
//   * `generalityRole`  — the Δ_g partition (§6.5):
//                           'tuned'              the dev-tuned datasets (the
//                                                "seen" side of Δ_g; == CI subset)
//                           'unseen-generality'  a reserved set NEVER tuned on,
//                                                distinct from the per-dataset
//                                                test split, drives the Δ_g alarm
//                           'headline-only'      contributes to the multi-domain
//                                                mean but is neither tuned nor
//                                                reserved for the Δ_g gap
//
// Each entry also carries a contamination note (§6.6): public benchmarks leak
// into pretraining corpora, and qrels provenance (expert vs crowdsourced)
// changes how much to trust a delta. The note travels with every reported
// number. Dataset *names* are recorded here for provenance only — they are
// excluded from any LLM-grader/judge prompt (§6.6 contamination control).

export type GeneralityRole = 'tuned' | 'unseen-generality' | 'headline-only';

export type QrelsProvenance = 'expert' | 'crowdsourced' | 'automatic' | 'mixed';

export interface BeirContaminationNote {
  /**
   * Whether the corpus/queries are widely known to appear in LLM pretraining
   * corpora (Wikipedia-derived sets especially). A contaminated set flatters a
   * model that memorized it, so a gain there is weaker evidence than the same
   * gain on an obscure or expert-curated set.
   */
  knownInPretraining: boolean;
  qrels: QrelsProvenance;
  note: string;
}

export interface BeirDatasetRegistryEntry {
  /** Registry key; matches the `DATASET_URLS` keys in `run.ts`. */
  name: string;
  /** Human-facing label for reports. */
  title: string;
  /** Coarse domain bucket — the axis the multi-domain mean averages over. */
  domain: string;
  /** Qrels split the headline reports on. */
  split: string;
  /**
   * Single-zip download URL, or null when the dataset is not a single BEIR zip
   * (CQADupStack is a family of sub-forums fetched separately). A null URL
   * means the dataset must be supplied via `--dataset-dir`.
   */
  url: string | null;
  /** Part of the fast per-PR CI gate subset. */
  ciSubset: boolean;
  /** Δ_g partition role (§6.5). */
  generalityRole: GeneralityRole;
  contamination: BeirContaminationNote;
}

const BEIR_ZIP_BASE = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets';

function zip(name: string): string {
  return `${BEIR_ZIP_BASE}/${name}.zip`;
}

// The standard public BEIR set (RFC §2 "BEIR full"). Order is the canonical
// report order: CI subset first (so the gate datasets head every table), then
// the rest grouped loosely by domain. The Δ_g reserved set
// (arguana / scidocs / webis-touche2020) is deliberately spread across distinct
// domains (argumentation / scientific-citation / debate) that the tuned QA/bio/
// finance subset never touches, so a widening Δ_g is a real generality alarm
// rather than an artifact of one domain.
export const BEIR_REGISTRY: readonly BeirDatasetRegistryEntry[] = [
  // --- CI subset / tuned ("seen" side of Δ_g) ---
  {
    name: 'scifact',
    title: 'SciFact',
    domain: 'scientific fact-checking',
    split: 'test',
    url: zip('scifact'),
    ciSubset: true,
    generalityRole: 'tuned',
    contamination: {
      knownInPretraining: false,
      qrels: 'expert',
      note: 'Expert (scientist) claim↔evidence annotations; small corpus, low pretraining-leakage risk.',
    },
  },
  {
    name: 'nfcorpus',
    title: 'NFCorpus',
    domain: 'bio-medical',
    split: 'test',
    url: zip('nfcorpus'),
    ciSubset: true,
    generalityRole: 'tuned',
    contamination: {
      knownInPretraining: false,
      qrels: 'expert',
      note: 'Medical nutrition queries with expert/relevance-graded links; niche corpus, low leakage risk.',
    },
  },
  {
    name: 'fiqa',
    title: 'FiQA-2018',
    domain: 'finance',
    split: 'test',
    url: zip('fiqa'),
    ciSubset: true,
    generalityRole: 'tuned',
    contamination: {
      knownInPretraining: false,
      qrels: 'crowdsourced',
      note: 'Financial opinion QA over StackExchange/forum text; crowdsourced relevance.',
    },
  },
  // --- Reserved unseen-generality set ("unseen" side of Δ_g) ---
  {
    name: 'arguana',
    title: 'ArguAna',
    domain: 'argument retrieval',
    split: 'test',
    url: zip('arguana'),
    ciSubset: false,
    generalityRole: 'unseen-generality',
    contamination: {
      knownInPretraining: false,
      qrels: 'crowdsourced',
      note: 'Counter-argument retrieval; query IS a full argument. Distinct task shape from QA — held out for Δ_g.',
    },
  },
  {
    name: 'scidocs',
    title: 'SciDocs',
    domain: 'scientific citation',
    split: 'test',
    url: zip('scidocs'),
    ciSubset: false,
    generalityRole: 'unseen-generality',
    contamination: {
      knownInPretraining: false,
      qrels: 'automatic',
      note: 'Citation/co-read prediction; relevance derived from citation graph (automatic). Held out for Δ_g.',
    },
  },
  {
    name: 'webis-touche2020',
    title: 'Touché-2020',
    domain: 'argument retrieval',
    split: 'test',
    url: zip('webis-touche2020'),
    ciSubset: false,
    generalityRole: 'unseen-generality',
    contamination: {
      knownInPretraining: false,
      qrels: 'expert',
      note: 'Controversial-topic argument retrieval; expert-graded. Distinct from tuned QA — held out for Δ_g.',
    },
  },
  // --- Headline-only (contribute to the multi-domain mean) ---
  {
    name: 'trec-covid',
    title: 'TREC-COVID',
    domain: 'bio-medical',
    split: 'test',
    url: zip('trec-covid'),
    ciSubset: false,
    generalityRole: 'headline-only',
    contamination: {
      knownInPretraining: false,
      qrels: 'expert',
      note: 'COVID-19 literature; expert TREC pooled judgments, deep per-query relevance.',
    },
  },
  {
    name: 'nq',
    title: 'NQ',
    domain: 'open-domain QA (Wikipedia)',
    split: 'test',
    url: zip('nq'),
    ciSubset: false,
    generalityRole: 'headline-only',
    contamination: {
      knownInPretraining: true,
      qrels: 'crowdsourced',
      note: 'Natural Questions over Wikipedia; Wikipedia is heavily represented in pretraining — leakage risk high.',
    },
  },
  {
    name: 'hotpotqa',
    title: 'HotpotQA',
    domain: 'multi-hop QA (Wikipedia)',
    split: 'test',
    url: zip('hotpotqa'),
    ciSubset: false,
    generalityRole: 'headline-only',
    contamination: {
      knownInPretraining: true,
      qrels: 'crowdsourced',
      note: 'Multi-hop Wikipedia QA with gold supporting facts; Wikipedia leakage risk high.',
    },
  },
  {
    name: 'quora',
    title: 'Quora',
    domain: 'duplicate-question retrieval',
    split: 'test',
    url: zip('quora'),
    ciSubset: false,
    generalityRole: 'headline-only',
    contamination: {
      knownInPretraining: true,
      qrels: 'crowdsourced',
      note: 'Duplicate-question detection; the Quora dataset is widely scraped — leakage risk high.',
    },
  },
  {
    name: 'dbpedia-entity',
    title: 'DBPedia-Entity',
    domain: 'entity retrieval',
    split: 'test',
    url: zip('dbpedia-entity'),
    ciSubset: false,
    generalityRole: 'headline-only',
    contamination: {
      knownInPretraining: true,
      qrels: 'expert',
      note: 'Entity retrieval over DBPedia abstracts (Wikipedia-derived); graded relevance, leakage risk high.',
    },
  },
  {
    name: 'fever',
    title: 'FEVER',
    domain: 'fact verification (Wikipedia)',
    split: 'test',
    url: zip('fever'),
    ciSubset: false,
    generalityRole: 'headline-only',
    contamination: {
      knownInPretraining: true,
      qrels: 'crowdsourced',
      note: 'Wikipedia fact verification; evidence-sentence annotations. Wikipedia leakage risk high.',
    },
  },
  {
    name: 'climate-fever',
    title: 'Climate-FEVER',
    domain: 'fact verification (climate)',
    split: 'test',
    url: zip('climate-fever'),
    ciSubset: false,
    generalityRole: 'headline-only',
    contamination: {
      knownInPretraining: true,
      qrels: 'crowdsourced',
      note: 'Climate-claim verification over Wikipedia; noisier crowdsourced labels, Wikipedia leakage risk high.',
    },
  },
  {
    name: 'cqadupstack',
    title: 'CQADupStack',
    domain: 'community QA (multi-forum)',
    split: 'test',
    // Not a single BEIR zip — a family of 12 StackExchange sub-forums. Supply
    // each sub-forum via --dataset-dir; the registry records it for the matrix
    // and contamination ledger but cannot auto-download it.
    url: null,
    ciSubset: false,
    generalityRole: 'headline-only',
    contamination: {
      knownInPretraining: true,
      qrels: 'crowdsourced',
      note: '12 StackExchange sub-forums (the headline averages them). StackExchange is scraped — leakage risk high. No single-zip download; supply via --dataset-dir.',
    },
  },
];

const REGISTRY_BY_NAME: ReadonlyMap<string, BeirDatasetRegistryEntry> = new Map(
  BEIR_REGISTRY.map((entry) => [entry.name, entry]),
);

export function getRegistryEntry(name: string): BeirDatasetRegistryEntry | undefined {
  return REGISTRY_BY_NAME.get(name);
}

/** All registered dataset names, in canonical report order. */
export function fullMatrixDatasets(): string[] {
  return BEIR_REGISTRY.map((entry) => entry.name);
}

/** Datasets that auto-download (have a single-zip URL) — the runnable matrix. */
export function downloadableDatasets(): string[] {
  return BEIR_REGISTRY.filter((entry) => entry.url !== null).map((entry) => entry.name);
}

export function ciSubsetDatasets(): string[] {
  return BEIR_REGISTRY.filter((entry) => entry.ciSubset).map((entry) => entry.name);
}

export function tunedDatasets(): string[] {
  return BEIR_REGISTRY.filter((entry) => entry.generalityRole === 'tuned').map((entry) => entry.name);
}

export function unseenGeneralityDatasets(): string[] {
  return BEIR_REGISTRY
    .filter((entry) => entry.generalityRole === 'unseen-generality')
    .map((entry) => entry.name);
}

export function domainOf(name: string): string {
  return getRegistryEntry(name)?.domain ?? 'unknown';
}

/**
 * Invariant check used by tests and (defensively) the matrix runner: the Δ_g
 * partition is meaningful only when the tuned and unseen sets are non-empty and
 * disjoint. Throws on a misconfigured registry so a generality report is never
 * silently computed from an empty or overlapping split.
 */
export function assertRegistryInvariants(registry: readonly BeirDatasetRegistryEntry[] = BEIR_REGISTRY): void {
  const names = new Set<string>();
  for (const entry of registry) {
    if (names.has(entry.name)) {
      throw new Error(`registry: duplicate dataset name "${entry.name}"`);
    }
    names.add(entry.name);
  }
  const tuned = registry.filter((e) => e.generalityRole === 'tuned').map((e) => e.name);
  const unseen = registry.filter((e) => e.generalityRole === 'unseen-generality').map((e) => e.name);
  if (tuned.length === 0) throw new Error('registry: no tuned datasets — Δ_g has no "seen" side');
  if (unseen.length === 0) throw new Error('registry: no unseen-generality datasets — Δ_g has no "unseen" side');
  const overlap = tuned.filter((name) => unseen.includes(name));
  if (overlap.length > 0) {
    throw new Error(`registry: tuned/unseen Δ_g groups overlap on ${overlap.join(', ')} — they must be disjoint`);
  }
}

// ---------------------------------------------------------------------------
// NanoBEIR real-geometry dense gate registry (issue #1051)
// ---------------------------------------------------------------------------
//
// NanoBEIR (the official downsized BEIR — ~50 queries/dataset,
// https://huggingface.co/zeta-alpha-ai) powers the real-geometry dense CI gate.
// It is deliberately a SEPARATE registry from BEIR_REGISTRY: these vendored,
// further-capped fixtures are a fast per-PR dense-regression signal, NOT part of
// the headline multi-domain BEIR mean or the Δ_g generalization partition, so
// they must never leak into fullMatrixDatasets()/the matrix runner. Unlike the
// hermetic `fake`-provider fixture (which "has no semantic geometry" — baseline
// README), the NanoBEIR gate runs a REAL embedding model over real text, so it
// catches the dense regressions the fake fixture structurally cannot. The capped
// corpora are vendored under benchmarks/beir/fixtures/nanobeir/<name> (see that
// directory's build script for exact provenance and the downsizing rule).

export interface NanoBeirGateEntry {
  /** Gate dataset key — matches the vendored fixture dir and baseline file stem. */
  name: string;
  /** Upstream NanoBEIR Hugging Face dataset the vendored fixture is derived from. */
  source: string;
  /** Human-facing label for reports. */
  title: string;
  /** Coarse domain bucket. */
  domain: string;
  /** Qrels split the runner reads (NanoBEIR ships a single eval split). */
  split: string;
  contamination: BeirContaminationNote;
}

export const NANOBEIR_REGISTRY: readonly NanoBeirGateEntry[] = [
  {
    name: 'nanobeir-scifact',
    source: 'zeta-alpha-ai/NanoSciFact',
    title: 'NanoSciFact',
    domain: 'scientific fact-checking',
    split: 'test',
    contamination: {
      knownInPretraining: false,
      qrels: 'expert',
      note: 'Downsized SciFact: expert claim↔evidence annotations (binary qrels in NanoBEIR); low pretraining-leakage. Capped fixture — a real-geometry regression signal, not a leaderboard number.',
    },
  },
  {
    name: 'nanobeir-fiqa',
    source: 'zeta-alpha-ai/NanoFiQA2018',
    title: 'NanoFiQA-2018',
    domain: 'finance',
    split: 'test',
    contamination: {
      knownInPretraining: false,
      qrels: 'crowdsourced',
      note: 'Downsized FiQA-2018: financial-opinion QA over forum text, crowdsourced binary qrels. Capped fixture — a real-geometry regression signal, not a leaderboard number.',
    },
  },
];

/** NanoBEIR dense-gate dataset keys, in report order. */
export function nanoBeirGateDatasets(): string[] {
  return NANOBEIR_REGISTRY.map((entry) => entry.name);
}

export function getNanoBeirEntry(name: string): NanoBeirGateEntry | undefined {
  return NANOBEIR_REGISTRY.find((entry) => entry.name === name);
}

// ---------------------------------------------------------------------------
// CoIR code-retrieval registry (issue #1052)
// ---------------------------------------------------------------------------
//
// CoIR (Code Information Retrieval, arXiv 2407.02883) is BEIR/MTEB-schema
// compatible, so each dataset flows through the same runner once converted to
// the BEIR directory layout (`benchmarks/scripts/fetch_coir_from_hf.py`). The
// knowledge bases this tool serves are mostly code and technical prose, yet
// BEIR has no code dataset — this registry is how retrieval quality gets
// measured on the tool's real content type.
//
// Like NANOBEIR_REGISTRY it is a SEPARATE registry: CoIR is NOT part of the
// headline multi-domain BEIR mean or the Δ_g partition, so it must never leak
// into fullMatrixDatasets()/the matrix runner. Results are grouped by task
// family so a per-family breakdown is a registry lookup, not a naming
// convention.

export type CoirTaskFamily = 'text-to-code' | 'code-to-code' | 'hybrid';

export interface CoirDatasetRegistryEntry {
  /** Registry key; also the `CoIR-Retrieval/<name>` HuggingFace repo name. */
  name: string;
  /** Human-facing label for reports. */
  title: string;
  /** CoIR task family: what the query is and what the corpus holds. */
  family: CoirTaskFamily;
  /** Qrels split the headline reports on. */
  split: string;
  /** One-line shape of a (query, relevant document) pair, for report readers. */
  shape: string;
  contamination: BeirContaminationNote;
}

export const COIR_REGISTRY: readonly CoirDatasetRegistryEntry[] = [
  {
    name: 'cosqa',
    title: 'CoSQA',
    family: 'text-to-code',
    split: 'test',
    shape: 'natural-language web search query → Python function',
    contamination: {
      knownInPretraining: true,
      qrels: 'crowdsourced',
      note: 'Bing queries paired with CodeSearchNet functions, human-annotated; CodeSearchNet is widely present in code-model pretraining corpora.',
    },
  },
  {
    name: 'codetrans-dl',
    title: 'CodeTrans-DL',
    family: 'code-to-code',
    split: 'test',
    shape: 'deep-learning snippet in one framework → equivalent snippet in another',
    contamination: {
      knownInPretraining: false,
      qrels: 'automatic',
      note: 'Framework-translation pairs (TensorFlow ↔ PaddlePaddle) mined from parallel tutorial code; small corpus (816 docs).',
    },
  },
  {
    name: 'codetrans-contest',
    title: 'CodeTrans-Contest',
    family: 'code-to-code',
    split: 'test',
    shape: 'competitive-programming solution in one language → same solution in another',
    contamination: {
      knownInPretraining: true,
      qrels: 'automatic',
      note: 'Cross-language contest solutions (Codeforces-style); contest code is widely scraped into pretraining data.',
    },
  },
  {
    name: 'stackoverflow-qa',
    title: 'StackOverflow-QA',
    family: 'hybrid',
    split: 'test',
    shape: 'StackOverflow question (text + code) → answer (text + code)',
    contamination: {
      knownInPretraining: true,
      qrels: 'crowdsourced',
      note: 'Accepted-answer pairs from StackOverflow; a staple of LLM pretraining corpora, so absolute scores flatter memorizing models.',
    },
  },
];

/** CoIR dataset keys, in report order. */
export function coirDatasets(): string[] {
  return COIR_REGISTRY.map((entry) => entry.name);
}

export function getCoirEntry(name: string): CoirDatasetRegistryEntry | undefined {
  return COIR_REGISTRY.find((entry) => entry.name === name);
}

/** CoIR dataset keys belonging to one task family, in report order. */
export function coirDatasetsByFamily(family: CoirTaskFamily): string[] {
  return COIR_REGISTRY.filter((entry) => entry.family === family).map((entry) => entry.name);
}
