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
