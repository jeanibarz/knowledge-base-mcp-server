export function isMetricsExportEnabled(
  raw: string | undefined = process.env.KB_METRICS_EXPORT,
): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'on' || value === 'true' || value === '1' || value === 'yes';
}

export const OPENMETRICS_CONTENT_TYPE =
  'application/openmetrics-text; version=1.0.0; charset=utf-8';
