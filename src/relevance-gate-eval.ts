// RFC 018 M0 (#369) — relevance-gate validation-harness core.
//
// Pure, LLM-free, I/O-free logic for the "validate before build" gate
// (RFC 018 §"Guiding principle"). M0 runs BEFORE any gate code exists, so
// this module deliberately does NOT import `relevance-gate.ts` (built in
// M0a/#370). It provides:
//
//   - the gate-eval fixture schema + `normalizeGateEvalFixture`
//   - `simulateGate` — the gate SIMULATION via "threshold surgery"
//     (RFC 018: "the gate can be simulated for M0 — e.g. via threshold
//     surgery — since gate code does not exist yet")
//   - `simulateAgentOutcome` — the offline consuming-agent causal model
//   - blinded-grading helpers (`assignBlindLabels`, `parseGraderVerdict`)
//   - `aggregateGateEval` — the pre-registered, per-bucket directional
//     pass criterion plus the three pre-registered numbers (#369)
//   - `formatGateEvalReportMarkdown` — the validation report
//
// The runner (`cli-eval-gate.ts`) wires this to real retrieval and a live
// LLM; this module stays a pure unit so the pre-registered arithmetic is
// testable without infrastructure.

import { computeAutoThreshold } from './search-core.js';

// ---------------------------------------------------------------------------
// Fixture schema
// ---------------------------------------------------------------------------

/** Which production-pollution mode a query exercises (RFC 018 §Problem). */
export type GateEvalBucket = 'has-answer' | 'no-good-answer';

/**
 * `standard` — an ordinary case. `answer-present-but-distant` — a has-answer
 * case whose answer chunk sits FAR from the query in embedding space; the
 * §6 residual-risk class the judge-false-empty metric (#369 report iii)
 * is measured on.
 */
export type GateEvalFixtureClass = 'standard' | 'answer-present-but-distant';

/**
 * One retrieved candidate, as it would arrive at the gate post-retrieval.
 * `denseDistance` is the native FAISS distance (lower = closer); a candidate
 * with no `denseDistance` is lexical-only (RFC 018 §3 — passed through A1).
 */
export interface GateEvalCandidate {
  id: string;
  source: string;
  content: string;
  denseDistance?: number;
  /** A strong BM25 term-overlap hit — the §6 empty-verdict veto signal. */
  lexicalHit: boolean;
}

export interface GateEvalCase {
  name: string;
  kb: string;
  query: string;
  /** Optional task description — present ⇒ the real gate would run Stage B. */
  taskContext?: string;
  bucket: GateEvalBucket;
  fixtureClass: GateEvalFixtureClass;
  /** Human-written expected answer, used by the live LLM grader. */
  referenceAnswer: string;
  /**
   * Candidate `source`s that genuinely contain the answer. Empty for a
   * `no-good-answer` case; non-empty otherwise. The offline consuming-agent
   * model answers correctly iff an answer source survives the gate.
   */
  answerSources: string[];
  candidates: GateEvalCandidate[];
}

export interface GateSimConfig {
  /** A1 absolute floor — drop candidates whose dense distance exceeds it. */
  scoreFloor: number;
  /**
   * The empty-verdict floor: when every dense candidate is farther than
   * this, the simulated gate may emit `no-relevant-context` (RFC 018 §6).
   */
  noGoodAnswerFloor: number;
  /** RFC 018 §5 `KB_GATE_JUDGE_INPUT`. Recorded for parity; not load-bearing here. */
  judgeInputCap: number;
}

export interface GateEvalFixture {
  /** Pre-registered directional effect size for the no-good-answer bucket. */
  epsilon: number;
  /** How far has-answer correctness may fall before it counts as a regression. */
  hasAnswerTolerance: number;
  gateSim: GateSimConfig;
  cases: GateEvalCase[];
}

/** One grader-calibration row: a fixed answer with its human label (#369). */
export interface GraderCalibrationCase {
  name: string;
  query: string;
  referenceAnswer: string;
  answer: string;
  humanLabel: GraderVerdict;
}

export interface GraderCalibrationFixture {
  /** Pre-registered minimum grader/human agreement for an admissible run. */
  admissibilityThreshold: number;
  cases: GraderCalibrationCase[];
}

export const DEFAULT_GATE_SIM_CONFIG: GateSimConfig = {
  scoreFloor: 0.95,
  noGoodAnswerFloor: 0.95,
  judgeInputCap: 10,
};

export const DEFAULT_EPSILON = 0.1;
export const DEFAULT_HAS_ANSWER_TOLERANCE = 0;
export const DEFAULT_ADMISSIBILITY_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Fixture normalization
// ---------------------------------------------------------------------------

export function normalizeGateEvalFixture(input: unknown): GateEvalFixture {
  if (!isRecord(input)) {
    throw new Error('gate-eval fixture must be an object');
  }
  const rawCases = input.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error('gate-eval fixture cases must be a non-empty array');
  }
  const cases = rawCases.map((raw, idx) => normalizeCase(raw, idx + 1));

  const kbNames = new Set(cases.map((c) => c.kb));
  if (kbNames.size < 2) {
    throw new Error(
      `gate-eval fixture must span >= 2 structurally different KBs (RFC 018 M0); found ${kbNames.size}`,
    );
  }

  return {
    epsilon: readOptionalPositiveNumber(input, 'epsilon') ?? DEFAULT_EPSILON,
    hasAnswerTolerance:
      readOptionalNonNegativeNumber(input, 'has_answer_tolerance') ?? DEFAULT_HAS_ANSWER_TOLERANCE,
    gateSim: normalizeGateSimConfig(input.gate_sim),
    cases,
  };
}

export function normalizeGraderCalibrationFixture(input: unknown): GraderCalibrationFixture {
  if (!isRecord(input)) {
    throw new Error('grader-calibration fixture must be an object');
  }
  const rawCases = input.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error('grader-calibration fixture cases must be a non-empty array');
  }
  return {
    admissibilityThreshold:
      readOptionalUnitInterval(input, 'admissibility_threshold') ?? DEFAULT_ADMISSIBILITY_THRESHOLD,
    cases: rawCases.map((raw, idx) => normalizeCalibrationCase(raw, idx + 1)),
  };
}

function normalizeGateSimConfig(raw: unknown): GateSimConfig {
  if (raw === undefined) return { ...DEFAULT_GATE_SIM_CONFIG };
  if (!isRecord(raw)) throw new Error('gate_sim must be an object');
  const scoreFloor = readOptionalPositiveNumber(raw, 'score_floor') ?? DEFAULT_GATE_SIM_CONFIG.scoreFloor;
  return {
    scoreFloor,
    noGoodAnswerFloor: readOptionalPositiveNumber(raw, 'no_good_answer_floor') ?? scoreFloor,
    judgeInputCap:
      readOptionalPositiveInteger(raw, 'judge_input_cap') ?? DEFAULT_GATE_SIM_CONFIG.judgeInputCap,
  };
}

function normalizeCase(raw: unknown, n: number): GateEvalCase {
  if (!isRecord(raw)) throw new Error(`case ${n} must be an object`);
  const name = readRequiredString(raw, 'name', `case ${n}`);
  const kb = readRequiredString(raw, 'kb', `case ${n}`);
  const query = readRequiredString(raw, 'query', `case ${n}`);
  const bucket = readBucket(raw.bucket, `case ${n}`);
  const fixtureClass = readFixtureClass(raw.fixture_class, `case ${n}`);
  const referenceAnswer = readRequiredString(raw, 'reference_answer', `case ${n}`);
  const answerSources = readOptionalStringArray(raw, 'answer_sources') ?? [];
  const candidates = normalizeCandidates(raw.candidates, n);

  if (bucket === 'no-good-answer' && answerSources.length > 0) {
    throw new Error(`case ${n} (${name}): a no-good-answer case must have no answer_sources`);
  }
  if (bucket === 'has-answer' && answerSources.length === 0) {
    throw new Error(`case ${n} (${name}): a has-answer case must list answer_sources`);
  }
  const candidateSources = new Set(candidates.map((c) => c.source));
  for (const source of answerSources) {
    if (!candidateSources.has(source)) {
      throw new Error(`case ${n} (${name}): answer_source ${source} is not among the candidates`);
    }
  }
  if (fixtureClass === 'answer-present-but-distant' && bucket !== 'has-answer') {
    throw new Error(`case ${n} (${name}): answer-present-but-distant requires bucket has-answer`);
  }

  return {
    name,
    kb,
    query,
    ...(readOptionalString(raw, 'task_context') !== undefined
      ? { taskContext: readOptionalString(raw, 'task_context') }
      : {}),
    bucket,
    fixtureClass,
    referenceAnswer,
    answerSources,
    candidates,
  };
}

function normalizeCandidates(raw: unknown, caseNumber: number): GateEvalCandidate[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`case ${caseNumber} candidates must be a non-empty array`);
  }
  const seen = new Set<string>();
  return raw.map((entry, idx) => {
    if (!isRecord(entry)) throw new Error(`case ${caseNumber} candidate ${idx + 1} must be an object`);
    const id = readRequiredString(entry, 'id', `case ${caseNumber} candidate ${idx + 1}`);
    if (seen.has(id)) throw new Error(`case ${caseNumber}: duplicate candidate id ${id}`);
    seen.add(id);
    const distance = entry.dense_distance;
    if (distance !== undefined && (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0)) {
      throw new Error(`case ${caseNumber} candidate ${id}: dense_distance must be a finite distance >= 0`);
    }
    return {
      id,
      source: readRequiredString(entry, 'source', `case ${caseNumber} candidate ${id}`),
      content: readRequiredString(entry, 'content', `case ${caseNumber} candidate ${id}`),
      ...(distance !== undefined ? { denseDistance: distance } : {}),
      lexicalHit: readOptionalBoolean(entry, 'lexical_hit') ?? false,
    };
  });
}

function normalizeCalibrationCase(raw: unknown, n: number): GraderCalibrationCase {
  if (!isRecord(raw)) throw new Error(`calibration case ${n} must be an object`);
  return {
    name: readRequiredString(raw, 'name', `calibration case ${n}`),
    query: readRequiredString(raw, 'query', `calibration case ${n}`),
    referenceAnswer: readRequiredString(raw, 'reference_answer', `calibration case ${n}`),
    answer: readRequiredString(raw, 'answer', `calibration case ${n}`),
    humanLabel: readGraderVerdict(raw.human_label, `calibration case ${n}`),
  };
}

// ---------------------------------------------------------------------------
// Gate simulation — "threshold surgery" (RFC 018 §"Guiding principle")
// ---------------------------------------------------------------------------

export type GateVariant = 'raw' | 'gated' | 'gated-no-empty';
export type GateVerdict = 'injected' | 'no-relevant-context' | 'empty-index' | 'bypassed';

export interface GateDrop {
  id: string;
  source: string;
  stage: 'A1-floor' | 'A2-knee';
  reason: string;
}

export interface GateSimResult {
  variant: GateVariant;
  verdict: GateVerdict;
  kept: GateEvalCandidate[];
  dropped: GateDrop[];
  /** The simulated gate emitted `no-relevant-context`. */
  emptyFired: boolean;
  /** The §6 low-confidence rescue re-admitted a single best candidate. */
  lowConfidence: boolean;
}

export const GATE_VARIANTS: readonly GateVariant[] = ['raw', 'gated', 'gated-no-empty'];

/**
 * Simulate the relevance gate over a candidate set via threshold surgery.
 *
 *   raw            — gate off; the ungated top-k (`verdict: bypassed`).
 *   gated          — A1 floor + A2 knee + empty verdict + low-confidence rescue.
 *   gated-no-empty — gated with the empty verdict disabled, so per-chunk-drop
 *                    benefit is isolated from empty-verdict benefit (#369 ii).
 *
 * A real cascade branches A2 (no task context) vs Stage B (LLM judge); M0
 * has no judge, so both branches collapse to the A2 distance knee — exactly
 * what "the gate can be simulated via threshold surgery" means.
 */
export function simulateGate(
  candidates: readonly GateEvalCandidate[],
  config: GateSimConfig,
  variant: GateVariant,
): GateSimResult {
  if (candidates.length === 0) {
    return { variant, verdict: 'empty-index', kept: [], dropped: [], emptyFired: false, lowConfidence: false };
  }
  if (variant === 'raw') {
    return {
      variant,
      verdict: 'bypassed',
      kept: [...candidates],
      dropped: [],
      emptyFired: false,
      lowConfidence: false,
    };
  }

  // Stage A1 — absolute floor. Lexical-only candidates (no dense distance)
  // pass through unfiltered (RFC 018 §3).
  const dropped: GateDrop[] = [];
  const survivorsA1 = candidates.filter((c) => {
    if (c.denseDistance === undefined || c.denseDistance <= config.scoreFloor) return true;
    dropped.push({
      id: c.id,
      source: c.source,
      stage: 'A1-floor',
      reason: `dense distance ${c.denseDistance.toFixed(2)} > floor ${config.scoreFloor}`,
    });
    return false;
  });

  // §6 empty verdict — only the `gated` variant can emit it. It is eligible
  // only when nothing relevant survived A1: no dense candidate within the
  // empty-verdict floor, and no lexical-only candidate (which carries
  // possible relevance the dense legs missed — RFC 018 §3/§6).
  const closeSurvivors = survivorsA1.filter(
    (c) => c.denseDistance === undefined || c.denseDistance <= config.noGoodAnswerFloor,
  );
  if (variant === 'gated' && closeSurvivors.length === 0) {
    if (candidates.some((c) => c.lexicalHit)) {
      // BM25 veto — a lexical hit blocks the empty verdict; re-admit the
      // single best candidate flagged low-confidence (RFC 018 §6).
      return {
        variant,
        verdict: 'injected',
        kept: [bestCandidate(candidates)],
        dropped,
        emptyFired: false,
        lowConfidence: true,
      };
    }
    return { variant, verdict: 'no-relevant-context', kept: [], dropped, emptyFired: true, lowConfidence: false };
  }

  // Stage A2 — distribution knee over the dense survivors (RFC 018 §4).
  const denseSurvivors = survivorsA1
    .filter((c) => c.denseDistance !== undefined)
    .sort((a, b) => (a.denseDistance ?? 0) - (b.denseDistance ?? 0));
  const lexicalSurvivors = survivorsA1.filter((c) => c.denseDistance === undefined);
  const knee = computeAutoThreshold(denseSurvivors.map((c) => c.denseDistance as number));
  const keptDense = denseSurvivors.slice(0, knee.kept);
  for (const c of denseSurvivors.slice(knee.kept)) {
    dropped.push({
      id: c.id,
      source: c.source,
      stage: 'A2-knee',
      reason: `below the distribution knee (kept ${knee.kept}/${denseSurvivors.length})`,
    });
  }
  const kept = [...keptDense, ...lexicalSurvivors];

  // §6 low-confidence rescue — terminal net when the cascade emptied the set.
  if (kept.length === 0) {
    return {
      variant,
      verdict: 'injected',
      kept: [bestCandidate(candidates)],
      dropped,
      emptyFired: false,
      lowConfidence: true,
    };
  }
  return { variant, verdict: 'injected', kept, dropped, emptyFired: false, lowConfidence: false };
}

/** Lowest dense distance wins; lexical-only candidates are the last resort. */
function bestCandidate(candidates: readonly GateEvalCandidate[]): GateEvalCandidate {
  return [...candidates].sort((a, b) => {
    const da = a.denseDistance ?? Number.POSITIVE_INFINITY;
    const db = b.denseDistance ?? Number.POSITIVE_INFINITY;
    return da - db;
  })[0];
}

// ---------------------------------------------------------------------------
// Offline consuming-agent causal model
// ---------------------------------------------------------------------------

/**
 * What the consuming agent does, given the gated candidate set.
 *
 * Offline model (used by `--dry-run` and the unit tests): the agent answers
 * correctly iff an answer-bearing chunk survived the gate; with no answer
 * chunk it either declines (the gate emitted `no-relevant-context`) or
 * anchors on the surviving near-misses. This isolates the gate's keep/drop
 * decision — the recall-negative risk RFC 018 is most worried about — from
 * real-LLM noise robustness, which only the live runner measures.
 */
export type AgentOutcome = 'answered-correct' | 'answered-wrong' | 'declined';

export function simulateAgentOutcome(sim: GateSimResult, fixtureCase: GateEvalCase): AgentOutcome {
  const keptSources = new Set(sim.kept.map((c) => c.source));
  const answerSurvived = fixtureCase.answerSources.some((s) => keptSources.has(s));
  if (fixtureCase.bucket === 'has-answer') {
    if (answerSurvived) return 'answered-correct';
    return sim.verdict === 'no-relevant-context' ? 'declined' : 'answered-wrong';
  }
  // no-good-answer: declining is the only correct move.
  return sim.kept.length === 0 ? 'declined' : 'answered-wrong';
}

/** Map the offline outcome onto the bucket's notion of correctness. */
export function outcomeIsCorrect(outcome: AgentOutcome, bucket: GateEvalBucket): boolean {
  return bucket === 'has-answer'
    ? outcome === 'answered-correct'
    : outcome === 'declined';
}

// ---------------------------------------------------------------------------
// Blinded grading
// ---------------------------------------------------------------------------

export type GraderVerdict = 'correct' | 'partial' | 'incorrect';

/** Numeric weight of a verdict for the directional correctness arithmetic. */
export function verdictScore(verdict: GraderVerdict): number {
  if (verdict === 'correct') return 1;
  if (verdict === 'partial') return 0.5;
  return 0;
}

/**
 * Parse a grader reply. Accepts a bare verdict word or a fenced/JSON-ish
 * blob; the first standalone verdict token wins. `\b...\b` anchors mean the
 * `correct` substring inside `incorrect` does not mis-match. Throws on no
 * match so a broken grader is loud, never silently scored 0.
 */
export function parseGraderVerdict(reply: string): GraderVerdict {
  const match = reply.toLowerCase().match(/\b(incorrect|correct|partial)\b/);
  if (match === null) {
    throw new Error(`grader reply contains no verdict token: ${reply.slice(0, 120)}`);
  }
  return match[1] as GraderVerdict;
}

// ---------------------------------------------------------------------------
// Aggregation — the pre-registered M0 report (#369)
// ---------------------------------------------------------------------------

/** One graded condition for one case. */
export interface GradedCondition {
  variant: GateVariant;
  verdict: GraderVerdict;
}

export interface GateEvalCaseResult {
  name: string;
  kb: string;
  bucket: GateEvalBucket;
  fixtureClass: GateEvalFixtureClass;
  /** The simulated gate verdict for the `gated` variant. */
  gatedVerdict: GateVerdict;
  emptyFired: boolean;
  conditions: GradedCondition[];
}

export interface BucketAggregate {
  count: number;
  rawScore: number;
  gatedScore: number;
  gatedNoEmptyScore: number;
}

export interface GraderAdmissibility {
  calibrationCount: number;
  agreement: number;
  threshold: number;
  admissible: boolean;
}

export interface GateEvalAggregate {
  caseCount: number;
  kbNames: string[];
  hasAnswerCount: number;
  noGoodAnswerCount: number;
  /** no-good-answer share of the query set — RFC 018 wants it production-matched. */
  noGoodAnswerRatio: number;
  buckets: { hasAnswer: BucketAggregate; noGoodAnswer: BucketAggregate };
  epsilon: number;
  hasAnswerTolerance: number;
  /** gated − raw correctness, no-good-answer bucket. */
  noGoodAnswerDelta: number;
  /** gated − raw correctness, has-answer bucket (a regression if negative). */
  hasAnswerDelta: number;
  directionalPass: boolean;
  /** #369 report (i) — how often `no-relevant-context` fires. */
  emptyVerdictFireCount: number;
  emptyVerdictFireRate: number;
  /** #369 report (ii) — per-chunk-drop benefit with the empty verdict OFF. */
  perChunkDropNoGoodAnswerDelta: number;
  perChunkDropHasAnswerDelta: number;
  /** #369 report (iii) — false-empty on the answer-present-but-distant class. */
  answerPresentButDistantCount: number;
  judgeFalseEmptyCount: number;
  judgeFalseEmptyRate: number;
  graderAdmissibility: GraderAdmissibility | null;
}

function emptyBucket(): BucketAggregate {
  return { count: 0, rawScore: 0, gatedScore: 0, gatedNoEmptyScore: 0 };
}

function conditionScore(conditions: readonly GradedCondition[], variant: GateVariant): number {
  const found = conditions.find((c) => c.variant === variant);
  return found ? verdictScore(found.verdict) : 0;
}

export function aggregateGateEval(
  caseResults: readonly GateEvalCaseResult[],
  options: { epsilon: number; hasAnswerTolerance: number; graderAdmissibility: GraderAdmissibility | null },
): GateEvalAggregate {
  const buckets = { hasAnswer: emptyBucket(), noGoodAnswer: emptyBucket() };
  let emptyVerdictFireCount = 0;
  let answerPresentButDistantCount = 0;
  let judgeFalseEmptyCount = 0;

  for (const result of caseResults) {
    const bucket = result.bucket === 'has-answer' ? buckets.hasAnswer : buckets.noGoodAnswer;
    bucket.count += 1;
    bucket.rawScore += conditionScore(result.conditions, 'raw');
    bucket.gatedScore += conditionScore(result.conditions, 'gated');
    bucket.gatedNoEmptyScore += conditionScore(result.conditions, 'gated-no-empty');
    if (result.emptyFired) emptyVerdictFireCount += 1;
    if (result.fixtureClass === 'answer-present-but-distant') {
      answerPresentButDistantCount += 1;
      if (result.gatedVerdict === 'no-relevant-context') judgeFalseEmptyCount += 1;
    }
  }

  const noGoodAnswerDelta = bucketDelta(buckets.noGoodAnswer, 'gatedScore');
  const hasAnswerDelta = bucketDelta(buckets.hasAnswer, 'gatedScore');
  const directionalPass =
    buckets.noGoodAnswer.count > 0 &&
    noGoodAnswerDelta >= options.epsilon &&
    hasAnswerDelta >= -options.hasAnswerTolerance;

  const caseCount = caseResults.length;
  return {
    caseCount,
    kbNames: [...new Set(caseResults.map((r) => r.kb))].sort(),
    hasAnswerCount: buckets.hasAnswer.count,
    noGoodAnswerCount: buckets.noGoodAnswer.count,
    noGoodAnswerRatio: caseCount === 0 ? 0 : buckets.noGoodAnswer.count / caseCount,
    buckets,
    epsilon: options.epsilon,
    hasAnswerTolerance: options.hasAnswerTolerance,
    noGoodAnswerDelta,
    hasAnswerDelta,
    directionalPass,
    emptyVerdictFireCount,
    emptyVerdictFireRate: caseCount === 0 ? 0 : emptyVerdictFireCount / caseCount,
    perChunkDropNoGoodAnswerDelta: bucketDelta(buckets.noGoodAnswer, 'gatedNoEmptyScore'),
    perChunkDropHasAnswerDelta: bucketDelta(buckets.hasAnswer, 'gatedNoEmptyScore'),
    answerPresentButDistantCount,
    judgeFalseEmptyCount,
    judgeFalseEmptyRate:
      answerPresentButDistantCount === 0 ? 0 : judgeFalseEmptyCount / answerPresentButDistantCount,
    graderAdmissibility: options.graderAdmissibility,
  };
}

function bucketDelta(bucket: BucketAggregate, condition: 'gatedScore' | 'gatedNoEmptyScore'): number {
  if (bucket.count === 0) return 0;
  return (bucket[condition] - bucket.rawScore) / bucket.count;
}

/** Grader/human agreement over the calibration set (RFC 018 M0 admissibility). */
export function computeGraderAdmissibility(
  graded: ReadonlyArray<{ humanLabel: GraderVerdict; graderVerdict: GraderVerdict }>,
  threshold: number,
): GraderAdmissibility {
  const agreed = graded.filter((g) => g.humanLabel === g.graderVerdict).length;
  const agreement = graded.length === 0 ? 0 : agreed / graded.length;
  return {
    calibrationCount: graded.length,
    agreement,
    threshold,
    admissible: graded.length > 0 && agreement >= threshold,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface GateEvalReportMeta {
  fixturePath: string;
  mode: 'live' | 'simulation';
  answererModel: string;
  graderModel: string;
  generatedAt: string;
}

export function formatGateEvalReportMarkdown(
  aggregate: GateEvalAggregate,
  meta: GateEvalReportMeta,
): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const signed = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`;
  const rate = (bucket: BucketAggregate, key: 'rawScore' | 'gatedScore' | 'gatedNoEmptyScore'): string =>
    bucket.count === 0 ? 'n/a' : pct(bucket[key] / bucket.count);

  const lines: string[] = [];
  lines.push('# RFC 018 M0 — relevance-gate validation report');
  lines.push('');
  lines.push(`- Generated: ${meta.generatedAt}`);
  lines.push(`- Fixture: \`${meta.fixturePath}\``);
  lines.push(`- Run mode: **${meta.mode}**${meta.mode === 'simulation' ? ' (offline consuming-agent causal model — see Caveats)' : ''}`);
  lines.push(`- Consuming-agent model: \`${meta.answererModel}\``);
  lines.push(`- Grader model: \`${meta.graderModel}\``);
  lines.push('');

  lines.push('## Query set');
  lines.push('');
  lines.push(`- ${aggregate.caseCount} queries across ${aggregate.kbNames.length} KBs: ${aggregate.kbNames.map((k) => `\`${k}\``).join(', ')}`);
  lines.push(`- has-answer: ${aggregate.hasAnswerCount} · no-good-answer: ${aggregate.noGoodAnswerCount} (no-good-answer ratio ${pct(aggregate.noGoodAnswerRatio)})`);
  lines.push(`- answer-present-but-distant fixtures: ${aggregate.answerPresentButDistantCount}`);
  lines.push('');

  lines.push('## Directional pass criterion (pre-registered, per-bucket)');
  lines.push('');
  lines.push('| bucket | raw | gated | delta |');
  lines.push('|---|---|---|---|');
  lines.push(`| no-good-answer | ${rate(aggregate.buckets.noGoodAnswer, 'rawScore')} | ${rate(aggregate.buckets.noGoodAnswer, 'gatedScore')} | ${signed(aggregate.noGoodAnswerDelta)} |`);
  lines.push(`| has-answer | ${rate(aggregate.buckets.hasAnswer, 'rawScore')} | ${rate(aggregate.buckets.hasAnswer, 'gatedScore')} | ${signed(aggregate.hasAnswerDelta)} |`);
  lines.push('');
  lines.push(`- Criterion 1 — no-good-answer correctness trends up by >= ${signed(aggregate.epsilon)}: **${aggregate.noGoodAnswerDelta >= aggregate.epsilon ? 'MET' : 'NOT MET'}**`);
  lines.push(`- Criterion 2 — has-answer correctness does not trend down (>= ${signed(-aggregate.hasAnswerTolerance)}): **${aggregate.hasAnswerDelta >= -aggregate.hasAnswerTolerance ? 'MET' : 'NOT MET'}**`);
  lines.push(`- **Directional verdict: ${aggregate.directionalPass ? 'PASS' : 'NOT MET'}**`);
  lines.push('');

  lines.push('## Pre-registered numbers (#369 — these decide which gate parts ship)');
  lines.push('');
  lines.push(`### (i) Empty-verdict fire rate`);
  lines.push('');
  lines.push(`- \`no-relevant-context\` fired on **${aggregate.emptyVerdictFireCount}/${aggregate.caseCount}** queries (${pct(aggregate.emptyVerdictFireRate)}).`);
  lines.push(`- If near-zero, the gate is effectively A1+A2 tail-trimming (~\`--threshold=auto\`) and most of RFC 018 §6 is dead weight.`);
  lines.push('');
  lines.push(`### (ii) Per-chunk-drop contribution, isolated from the empty verdict`);
  lines.push('');
  lines.push('`gated-no-empty` runs the cascade with the empty verdict disabled (per-chunk drops + low-confidence rescue only):');
  lines.push('');
  lines.push('| bucket | raw | gated-no-empty | delta |');
  lines.push('|---|---|---|---|');
  lines.push(`| no-good-answer | ${rate(aggregate.buckets.noGoodAnswer, 'rawScore')} | ${rate(aggregate.buckets.noGoodAnswer, 'gatedNoEmptyScore')} | ${signed(aggregate.perChunkDropNoGoodAnswerDelta)} |`);
  lines.push(`| has-answer | ${rate(aggregate.buckets.hasAnswer, 'rawScore')} | ${rate(aggregate.buckets.hasAnswer, 'gatedNoEmptyScore')} | ${signed(aggregate.perChunkDropHasAnswerDelta)} |`);
  lines.push('');
  lines.push(`### (iii) Judge false-empty rate (answer-present-but-distant class)`);
  lines.push('');
  if (aggregate.answerPresentButDistantCount === 0) {
    lines.push('- No answer-present-but-distant fixtures in this set — not measured.');
  } else {
    lines.push(`- The gate emitted \`no-relevant-context\` on **${aggregate.judgeFalseEmptyCount}/${aggregate.answerPresentButDistantCount}** answer-present-but-distant fixtures (${pct(aggregate.judgeFalseEmptyRate)}).`);
    lines.push('- Each false-empty here is a real, recoverable answer the gate suppressed — RFC 018 §6 residual risk.');
  }
  lines.push('');

  lines.push('## Grader admissibility (pre-registered first)');
  lines.push('');
  if (aggregate.graderAdmissibility === null) {
    lines.push('- Not evaluated (no grader-calibration fixture supplied).');
  } else {
    const a = aggregate.graderAdmissibility;
    lines.push(`- Grader/human agreement over ${a.calibrationCount} calibration cases: ${pct(a.agreement)} (threshold ${pct(a.threshold)}).`);
    lines.push(`- **Run ${a.admissible ? 'ADMISSIBLE' : 'INADMISSIBLE'}** — ${a.admissible ? 'the grader can resolve the effect.' : 'a grader near the noise floor cannot resolve a small effect; treat the directional verdict as unresolved.'}`);
  }
  lines.push('');

  lines.push('## Configuration handoff to M0a (#370)');
  lines.push('');
  lines.push(gateConfigGuidance(aggregate));
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** Translate the pre-registered numbers into an M0a configuration recommendation. */
export function gateConfigGuidance(aggregate: GateEvalAggregate): string {
  const recs: string[] = [];
  if (aggregate.emptyVerdictFireRate < 0.05) {
    recs.push('- Empty-verdict fire rate is near-zero — ship M0a with the empty verdict **disabled by default** (per-chunk drops + low-confidence rescue only); RFC 018 §6 machinery is not yet earning its keep.');
  } else if (aggregate.judgeFalseEmptyRate > 0.25) {
    recs.push(`- Judge false-empty rate is high (${(aggregate.judgeFalseEmptyRate * 100).toFixed(0)}%) — ship M0a with the empty verdict **disabled by default** until M1 re-measures it on a human-labeled set.`);
  } else {
    recs.push('- Empty-verdict fire rate and false-empty rate are both within range — M0a may ship the empty verdict enabled, still behind `KB_RELEVANCE_GATE=off`.');
  }
  if (aggregate.directionalPass) {
    recs.push('- The directional criterion is met — M0a/M0c proceed as planned; M1 is the powered confirmation.');
  } else {
    recs.push('- The directional criterion is NOT met in this run — RFC 018 says the chain still runs straight through (M0 informs configuration, it does not halt), but flag this loudly to the user before M3 (default-on).');
  }
  recs.push(`- A1 floor used: \`KB_GATE_SCORE_FLOOR\` simulated at the RFC default; M1 re-tunes per corpus.`);
  return recs.join('\n');
}

// ---------------------------------------------------------------------------
// Small validated readers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(input: Record<string, unknown>, key: string, context: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context} requires non-empty ${key}`);
  }
  return value;
}

function readOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  return value;
}

function readOptionalStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((e) => typeof e !== 'string' || e.trim() === '')) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return value as string[];
}

function readOptionalPositiveNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return value;
}

function readOptionalNonNegativeNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return value;
}

function readOptionalUnitInterval(input: Record<string, unknown>, key: string): number | undefined {
  const value = readOptionalNonNegativeNumber(input, key);
  if (value === undefined) return undefined;
  if (value > 1) throw new Error(`${key} must be within [0, 1]`);
  return value;
}

function readOptionalPositiveInteger(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function readBucket(value: unknown, context: string): GateEvalBucket {
  if (value === 'has-answer' || value === 'no-good-answer') return value;
  throw new Error(`${context} bucket must be "has-answer" or "no-good-answer"`);
}

function readFixtureClass(value: unknown, context: string): GateEvalFixtureClass {
  if (value === undefined || value === 'standard') return 'standard';
  if (value === 'answer-present-but-distant') return value;
  throw new Error(`${context} fixture_class must be "standard" or "answer-present-but-distant"`);
}

function readGraderVerdict(value: unknown, context: string): GraderVerdict {
  if (value === 'correct' || value === 'partial' || value === 'incorrect') return value;
  throw new Error(`${context} human_label must be "correct", "partial", or "incorrect"`);
}
