export type TimingValue = number | string | boolean | null;

export type TimingPayload = Record<string, TimingValue | undefined>;

export function nowMs(): number {
  return Date.now();
}

export function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

export function roundedMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value);
}

export function compactTimingPayload(timing: TimingPayload): Record<string, TimingValue> {
  const out: Record<string, TimingValue> = {};
  for (const [key, value] of Object.entries(timing)) {
    if (value !== undefined) out[key] = typeof value === 'number' ? Math.round(value) : value;
  }
  return out;
}

export function formatTimingFooter(label: string, timing: TimingPayload): string {
  const entries = Object.entries(compactTimingPayload(timing))
    .filter(([key]) => key !== 'requested_mode' && key !== 'effective_mode')
    .map(([key, value]) => `${key}=${formatTimingValue(key, value)}`);
  const modeText = formatModeText(timing);
  const body = entries.length > 0 ? entries.join(', ') : 'no timing data';
  return `> _${label}${modeText}: ${body}._`;
}

function formatModeText(timing: TimingPayload): string {
  const requested = timing.requested_mode;
  const effective = timing.effective_mode;
  if (typeof requested !== 'string' || typeof effective !== 'string') return '';
  if (requested === effective) return ` (${effective})`;
  return ` (${requested} -> ${effective})`;
}

function formatTimingValue(key: string, value: TimingValue): string {
  if (typeof value === 'number' && key.endsWith('_ms')) return `${value}ms`;
  return String(value);
}
