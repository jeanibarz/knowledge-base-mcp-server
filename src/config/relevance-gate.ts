export interface RelevanceGateConfig {
  enabled: boolean;
  emptyVerdictEnabled: boolean;
  scoreFloor: number;
  judgeInputLimit: number;
  judgeTimeoutMs: number;
  judgeEndpoint?: string;
  judgeModel?: string;
  minTaskContextTokens: number;
}

export function resolveRelevanceGateConfig(
  env: NodeJS.ProcessEnv = process.env,
): RelevanceGateConfig {
  return {
    enabled: parseOnOff(env.KB_RELEVANCE_GATE, false),
    // RFC 018 M0 (#369) observed a high false-empty rate. Keep the terminal
    // empty verdict opt-in until M1 re-measures it on a human-labeled set.
    emptyVerdictEnabled: parseOnOff(env.KB_GATE_EMPTY_VERDICT, false),
    scoreFloor: parseFinite(env.KB_GATE_SCORE_FLOOR, 0.95),
    judgeInputLimit: parsePositiveInt(env.KB_GATE_JUDGE_INPUT, 10),
    judgeTimeoutMs: parsePositiveInt(env.KB_GATE_LLM_TIMEOUT_MS, 8000),
    judgeEndpoint: firstNonEmpty(env.KB_GATE_LLM_ENDPOINT, env.KB_LLM_ENDPOINT),
    judgeModel: firstNonEmpty(env.KB_GATE_LLM_MODEL, env.KB_LLM_MODEL),
    minTaskContextTokens: parsePositiveInt(env.KB_GATE_MIN_TASK_TOKENS, 8),
  };
}

function parseOnOff(raw: string | undefined, fallback: boolean): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return fallback;
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  return fallback;
}

function parseFinite(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
