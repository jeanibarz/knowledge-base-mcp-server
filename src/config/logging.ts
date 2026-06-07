// ---------------------------------------------------------------------------
// Canonical log line configuration (#216).
// ---------------------------------------------------------------------------

export type KBLogFormat = 'text' | 'canonical' | 'both';

export function parseKBLogFormat(raw: string | undefined): KBLogFormat {
  if (raw === undefined || raw.trim() === '') return 'both';
  const value = raw.trim().toLowerCase();
  if (value === 'text' || value === 'canonical' || value === 'both') {
    return value;
  }
  return 'both';
}

export const KB_LOG_FORMAT: KBLogFormat = parseKBLogFormat(process.env.KB_LOG_FORMAT);

export function parseKBSlowQueryMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

export function readKBSlowQueryMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return parseKBSlowQueryMs(env.KB_SLOW_QUERY_MS);
}

export const KB_SLOW_QUERY_MS: number | undefined = parseKBSlowQueryMs(process.env.KB_SLOW_QUERY_MS);
