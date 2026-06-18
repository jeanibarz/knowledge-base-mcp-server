import { initializeProjectConfig } from './project-config.js';

initializeProjectConfig();

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

// ---------------------------------------------------------------------------
// Size-based LOG_FILE rotation/retention (#658).
//
// Opt-in: rotation is disabled unless KB_LOG_MAX_BYTES is a positive integer.
// When enabled, the canonical LOG_FILE is rolled (LOG_FILE.1, .2, …) once it
// reaches the byte cap, keeping at most KB_LOG_MAX_FILES generations.
// ---------------------------------------------------------------------------

export const DEFAULT_KB_LOG_MAX_FILES = 5;

/** Parse the rotation byte cap; returns undefined (rotation off) when unset or invalid. */
export function parseKBLogMaxBytes(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

/** Parse the retained-generations bound; defaults to DEFAULT_KB_LOG_MAX_FILES, minimum 1. */
export function parseKBLogMaxFiles(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_KB_LOG_MAX_FILES;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 1) return DEFAULT_KB_LOG_MAX_FILES;
  return Math.floor(value);
}

export const KB_LOG_MAX_BYTES: number | undefined = parseKBLogMaxBytes(process.env.KB_LOG_MAX_BYTES);
export const KB_LOG_MAX_FILES: number = parseKBLogMaxFiles(process.env.KB_LOG_MAX_FILES);
