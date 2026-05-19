export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
export const DEFAULT_RERANK_TOP_N = 40;
export const MAX_RERANK_TOP_N = 1000;

export type RerankOverride = 'on' | 'off' | undefined;

export interface RerankerConfig {
  enabled: boolean;
  model: string;
  topN: number;
}

export interface RerankerEnv {
  [key: string]: string | undefined;
  KB_RERANK?: string;
  KB_RERANK_MODEL?: string;
  KB_RERANK_TOP_N?: string;
}

export function parseRerankFlag(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  if (value === 'on' || value === 'true' || value === '1') return true;
  if (value === 'off' || value === 'false' || value === '0') return false;
  throw new Error(`invalid KB_RERANK=${JSON.stringify(raw)} (expected on/off, true/false, or 1/0)`);
}

export function parseRerankTopN(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RERANK_TOP_N;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`invalid KB_RERANK_TOP_N=${JSON.stringify(raw)} (expected integer 1-${MAX_RERANK_TOP_N})`);
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MAX_RERANK_TOP_N) {
    throw new Error(`invalid KB_RERANK_TOP_N=${JSON.stringify(raw)} (expected integer 1-${MAX_RERANK_TOP_N})`);
  }
  return value;
}

export function resolveRerankerConfig(
  env: RerankerEnv = process.env,
  override?: RerankOverride,
): RerankerConfig {
  const enabled = override === 'on'
    ? true
    : override === 'off'
      ? false
      : parseRerankFlag(env.KB_RERANK);
  const model = env.KB_RERANK_MODEL?.trim() || DEFAULT_RERANK_MODEL;
  const topN = enabled ? parseRerankTopN(env.KB_RERANK_TOP_N) : DEFAULT_RERANK_TOP_N;
  return { enabled, model, topN };
}
