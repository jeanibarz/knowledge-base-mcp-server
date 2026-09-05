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
    // The identifier prefix before the keyword is optional so that bare fields
    // (`password=…`, `secret: …`, `token=…`), not just prefixed ones
    // (`db_password=…`), are scrubbed — matching the shapes the ingest scanner
    // flags. The leading `\b` still anchors the match to a word boundary.
    /\b([A-Za-z0-9_]*(?:(?:api|access|refresh|auth|session)[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|secret|cookie)[A-Za-z0-9_]*\s*[:=]\s*)(['"]?)(?!\[REDACTED\])([^\s'",}]+)(\2)/gi,
    (_match, prefix, quote, _value, suffix) => `${prefix}${quote}${REDACTION_PLACEHOLDER}${suffix}`,
  );
  apply(
    'bearer_token',
    /\b(Bearer\s+)([A-Za-z0-9._~+/-]{12,})\b/g,
    (_match, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  );
  // Multi-line private-key blocks (PEM / OpenSSH / PKCS#8). Redact the whole
  // block rather than just the header line the ingest scanner keys on, so no key
  // material survives. The algorithm-name prefix (`RSA `, `EC `, `OPENSSH `,
  // `ENCRYPTED `, …) is optional, so bare PKCS#8 headers with no algorithm name
  // are covered too. When the trailing `END` footer line is missing (a
  // truncated key in a log or support bundle), fall back to redacting the header
  // plus its trailing base64 body lines instead of letting them egress.
  apply(
    'ssh_private_key',
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|(?:\r?\n[A-Za-z0-9+/=]{16,})+)/g,
    () => REDACTION_PLACEHOLDER,
  );
  // JSON Web Tokens: match the full three-segment header.payload.signature shape
  // (not just the `eyJ` header) to avoid over-redacting arbitrary base64 text.
  apply(
    'jwt',
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    () => REDACTION_PLACEHOLDER,
  );
  // Azure Storage connection-string secret. Keep the `AccountKey=` label and
  // scrub only the base64 key value, mirroring the field-preserving style of the
  // other secret-field patterns above.
  apply(
    'azure_storage_key',
    /\b(AccountKey=)([A-Za-z0-9+/=]{40,})/gi,
    (_match, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  );
  // Provider API tokens and cloud access-key IDs. The AWS branch mirrors the
  // ingest scanner's full prefix set (including the ASIA/AGPA/AIDA/AROA session
  // and role prefixes) and the GCP branch covers `AIza…` API keys.
  apply(
    'provider_token',
    /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA)[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
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
