export interface RedactionSummary {
  enabled: boolean;
  total: number;
  by_type: Record<string, number>;
}

export const REDACTION_PLACEHOLDER = '[REDACTED]';

export function maybeRedact(text: string, enabled: boolean): { text: string; summary: RedactionSummary } {
  if (!enabled) {
    return { text, summary: emptyRedactionSummary(false) };
  }
  return redactSecrets(text);
}

export function redactSecrets(input: string): { text: string; summary: RedactionSummary } {
  let text = input;
  const byType: Record<string, number> = {};

  const apply = (
    type: string,
    pattern: RegExp,
    replacer: (...args: string[]) => string,
  ): void => {
    let count = 0;
    text = text.replace(pattern, (...args: string[]) => {
      count++;
      return replacer(...args);
    });
    if (count > 0) byType[type] = (byType[type] ?? 0) + count;
  };

  apply(
    'credential_url',
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    (_match, scheme) => `${scheme}${REDACTION_PLACEHOLDER}@`,
  );
  apply(
    'authorization_header',
    /\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)([^\s"'`,;]+)/gi,
    (_match, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  );
  apply(
    'cookie_header',
    /^([ \t]*(?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gim,
    (_match, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  );
  apply(
    'json_secret',
    /("[A-Za-z0-9_-]*(?:(?:api|access|refresh|auth|session)[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|secret|cookie|authorization)[A-Za-z0-9_-]*"\s*:\s*")([^"]+)(")/gi,
    (_match, prefix, _value, suffix) => `${prefix}${REDACTION_PLACEHOLDER}${suffix}`,
  );
  apply(
    'dotenv_secret',
    /^([ \t]*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|PRIVATE_KEY|CLIENT_SECRET|SECRET|PASSWORD|PASSWD|COOKIE)[A-Za-z0-9_]*\s*=\s*)(['"]?)([^\r\n'"]+)(\2)/gim,
    (_match, prefix, quote, _value, suffix) => `${prefix}${quote}${REDACTION_PLACEHOLDER}${suffix}`,
  );
  apply(
    'key_value_secret',
    /\b([A-Za-z_][A-Za-z0-9_]*(?:(?:api|access|refresh|auth|session)[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|secret|cookie)[A-Za-z0-9_]*\s*[:=]\s*)(['"]?)(?!\[REDACTED\])([^\s'",}]+)(\2)/gi,
    (_match, prefix, quote, _value, suffix) => `${prefix}${quote}${REDACTION_PLACEHOLDER}${suffix}`,
  );
  apply(
    'bearer_token',
    /\b(Bearer\s+)([A-Za-z0-9._~+/-]{12,})\b/g,
    (_match, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  );
  apply(
    'provider_token',
    /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
    () => REDACTION_PLACEHOLDER,
  );

  return {
    text,
    summary: {
      enabled: true,
      total: Object.values(byType).reduce((sum, count) => sum + count, 0),
      by_type: byType,
    },
  };
}

export function emptyRedactionSummary(enabled: boolean): RedactionSummary {
  return {
    enabled,
    total: 0,
    by_type: {},
  };
}

export function combineRedactionSummaries(
  enabled: boolean,
  ...summaries: RedactionSummary[]
): RedactionSummary {
  if (!enabled) return emptyRedactionSummary(false);

  const byType: Record<string, number> = {};
  for (const summary of summaries) {
    for (const [type, count] of Object.entries(summary.by_type)) {
      byType[type] = (byType[type] ?? 0) + count;
    }
  }

  return {
    enabled: true,
    total: Object.values(byType).reduce((sum, count) => sum + count, 0),
    by_type: byType,
  };
}
