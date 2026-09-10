import { describe, expect, it } from '@jest/globals';
import {
  REDACTION_PLACEHOLDER,
  combineRedactionSummaries,
  emptyRedactionSummary,
  maybeRedact,
  redactSecrets,
} from './redaction.js';
import { detectSecretsInText, type SecretFindingCategory } from './secret-scanner.js';
import {
  REDACTION_NEGATIVE_CORPUS,
  REDACTION_POSITIVE_CORPUS,
} from './test-support/redaction-corpus.js';

describe('redactSecrets', () => {
  it('redacts common support-bundle secret shapes', () => {
    const input = [
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz',
      'Authorization: Bearer abcdefghijklmnop',
      '{"github_token":"ghp_abcdefghijklmnopqrstuvwxyz"}',
      'https://user:password@example.com/path',
    ].join('\n');

    const result = redactSecrets(input);

    expect(result.text).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(result.text).toContain('Authorization: Bearer [REDACTED]');
    expect(result.text).toContain('"github_token":"[REDACTED]"');
    expect(result.text).toContain('https://[REDACTED]@example.com/path');
    expect(result.summary.total).toBeGreaterThanOrEqual(4);
    expect(result.summary.enabled).toBe(true);
  });

  it.each(REDACTION_POSITIVE_CORPUS.map((entry) => [entry.name, entry] as const))(
    'redacts positive corpus entry: %s',
    (_name, entry) => {
      const result = redactSecrets(entry.payload);
      expect(result.text).toContain(entry.expectedSnippet);
      expect(result.text).not.toContain(entry.secretNeedle);
      expect(result.summary.by_type[entry.expectedType]).toBeGreaterThanOrEqual(1);
      expect(result.summary.total).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(REDACTION_NEGATIVE_CORPUS.map((entry) => [entry.name, entry] as const))(
    'leaves negative corpus entry unchanged: %s',
    (_name, entry) => {
      const result = redactSecrets(entry.payload);
      expect(result.text).toBe(entry.payload);
      expect(result.summary.total).toBe(0);
      expect(result.summary.by_type).toEqual({});
    },
  );

  it('leaves clean text untouched and records no zero-count types', () => {
    const result = redactSecrets('hello world');
    expect(result.text).toBe('hello world');
    expect(result.summary).toEqual({ enabled: true, total: 0, by_type: {} });
  });

  it('preserves the URL scheme capture group and drops userinfo', () => {
    const result = redactSecrets('mirror ftp://alice:s3cretpass@files.example.com/pkg');
    expect(result.text).toBe('mirror ftp://[REDACTED]@files.example.com/pkg');
    expect(result.summary.by_type).toEqual({ credential_url: 1 });
  });

  it('redacts HTTP(S) userinfo case-insensitively', () => {
    const result = redactSecrets('HTTP://Alice:Pass@Example.com');
    expect(result.text).toBe('HTTP://[REDACTED]@Example.com');
    expect(result.summary.by_type).toEqual({ credential_url: 1 });
  });

  it('does not treat a user-only URL as credential userinfo', () => {
    expect(redactSecrets('https://alice@example.com/repo').text).toBe('https://alice@example.com/repo');
  });

  it('redacts Authorization Bearer and Basic, but not Digest', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop').text).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(redactSecrets('authorization: basic dXNlcjpwYXNzd29yZA').text).toBe(
      'authorization: basic [REDACTED]',
    );
    expect(redactSecrets('Authorization: Digest abcdefghijklmnop').text).toBe(
      'Authorization: Digest abcdefghijklmnop',
    );
  });

  it('redacts Cookie and Set-Cookie only at line start, including leading tabs', () => {
    const multiline = ['notes', '\tSet-Cookie: session=abc; Path=/', 'Cookie: extra=1'].join('\n');
    const result = redactSecrets(multiline);
    expect(result.text).toBe(['notes', '\tSet-Cookie: [REDACTED]', 'Cookie: [REDACTED]'].join('\n'));
    expect(result.summary.by_type.cookie_header).toBe(2);

    // Mid-line `Cookie:` is not a header (the header pattern is line-anchored).
    // `key_value_secret` may still scrub it; the header type must not fire.
    expect(redactSecrets('see Cookie: session=abc').summary.by_type.cookie_header).toBeUndefined();
  });

  it('redacts JSON secret keys including prefix/suffix forms and spaced colons', () => {
    expect(redactSecrets('{"prod_api_key_v2" : "visible-value"}').text).toBe(
      '{"prod_api_key_v2" : "[REDACTED]"}',
    );
    expect(redactSecrets('{"client_secret":"visible-value"}').text).toBe(
      '{"client_secret":"[REDACTED]"}',
    );
    expect(redactSecrets('{"session-token":"visible-value"}').text).toBe(
      '{"session-token":"[REDACTED]"}',
    );
    expect(redactSecrets('{"username":"alice"}').text).toBe('{"username":"alice"}');
  });

  it('preserves dotenv quote capture groups and export/whitespace prefixes', () => {
    expect(redactSecrets('  export FOO_SECRET="quoted-value"').text).toBe(
      '  export FOO_SECRET="[REDACTED]"',
    );
    expect(redactSecrets("FOO_PASSWORD='quoted-value'").text).toBe("FOO_PASSWORD='[REDACTED]'");
    expect(redactSecrets('FOO_ACCESS_TOKEN=unquoted').text).toBe('FOO_ACCESS_TOKEN=[REDACTED]');
    expect(redactSecrets('notes\nCLIENT_SECRET=visible-value').text).toBe(
      'notes\nCLIENT_SECRET=[REDACTED]',
    );
  });

  it('skips already-redacted key-value secrets via the negative lookahead', () => {
    const result = redactSecrets('see password=[REDACTED] trailing');
    expect(result.text).toBe('see password=[REDACTED] trailing');
    expect(result.summary.by_type.key_value_secret ?? 0).toBe(0);
  });

  it('redacts key-value secrets with colon or equals mid-line', () => {
    expect(redactSecrets('config api_key: visible-value').text).toBe('config api_key: [REDACTED]');
    expect(redactSecrets('config passwd="visible-value"').text).toBe('config passwd="[REDACTED]"');
  });

  it('enforces the Bearer token 12-character floor and is case-sensitive', () => {
    expect(redactSecrets('use Bearer 12345678901 here').text).toBe('use Bearer 12345678901 here');
    expect(redactSecrets('use Bearer 123456789012 here').text).toBe('use Bearer [REDACTED] here');
    expect(redactSecrets('use bearer abcdefghijklmno here').text).toBe(
      'use bearer abcdefghijklmno here',
    );
  });

  it('enforces provider-token length floors and each alternative', () => {
    expect(redactSecrets('sk-abcdefghijklmnopqrst').text).toBe('[REDACTED]');
    expect(redactSecrets('sk-abcdefghijklmnopqrs').text).toBe('sk-abcdefghijklmnopqrs');
    expect(redactSecrets('sk-proj-abcdefghijklmnopqrst').text).toBe('[REDACTED]');
    expect(redactSecrets('gho_abcdefghijklmnopqrst').text).toBe('[REDACTED]');
    expect(redactSecrets('ghu_abcdefghijklmnopqrst').text).toBe('[REDACTED]');
    expect(redactSecrets('ghs_abcdefghijklmnopqrst').text).toBe('[REDACTED]');
    expect(redactSecrets('ghr_abcdefghijklmnopqrst').text).toBe('[REDACTED]');
    expect(redactSecrets('AKIA0123456789ABCDEF').text).toBe('[REDACTED]');
    expect(redactSecrets('AKIA0123456789ABCDE').text).toBe('AKIA0123456789ABCDE');
    expect(redactSecrets('xoxa-1234567890').text).toBe('[REDACTED]');
    expect(redactSecrets('xoxp-1234567890').text).toBe('[REDACTED]');
    expect(redactSecrets('xoxr-1234567890').text).toBe('[REDACTED]');
    expect(redactSecrets('xoxs-1234567890').text).toBe('[REDACTED]');
    expect(redactSecrets('ASIAIOSFODNN7EXAMPLE').text).toBe('[REDACTED]');
    expect(redactSecrets('AGPAIOSFODNN7EXAMPLE').text).toBe('[REDACTED]');
    expect(redactSecrets('AIDA' + 'IOSFODNN7EXAMPLE').text).toBe('[REDACTED]');
    expect(redactSecrets('AROA' + 'IOSFODNN7EXAMPLE').text).toBe('[REDACTED]');
    expect(redactSecrets('AIPA' + 'IOSFODNN7EXAMPLE').text).toBe('[REDACTED]');
    expect(redactSecrets('ANPA' + 'IOSFODNN7EXAMPLE').text).toBe('[REDACTED]');
    expect(redactSecrets('A3TA' + 'IOSFODNN7EXAMPLE').text).toBe('[REDACTED]');
    expect(redactSecrets('AIzaSyD-1234567890abcdefghijklmnopqrstu').text).toBe('[REDACTED]');
    expect(redactSecrets(`AIzaSy${'B'.repeat(32)}`).text).toContain(`AIzaSy${'B'.repeat(32)}`);
    expect(redactSecrets('AccountKey=abcdefghijklmnopqrstuvwxyz012345').text).toContain(
      'abcdefghijklmnopqrstuvwxyz012345',
    );
  });

  it('redacts JWT triples, Azure account keys, and PEM private-key blocks', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.vJ8eQhVZl2w5uXqO78Fpm_4ZcYc8-Ma5zJ5PpQ';
    expect(redactSecrets(`token ${jwt}`).text).toBe('token [REDACTED]');
    expect(redactSecrets('AccountKey=abcDEF1234567890abcDEF1234567890abcDEF1234567890==').text).toBe(
      'AccountKey=[REDACTED]',
    );
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'abcdefghijklmnopqrstuvwxyzABCDEF',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    expect(redactSecrets(pem).text).toBe('[REDACTED]');
    const truncated = '-----BEGIN PRIVATE KEY-----\nabcdefghijklmnopqrstuvwxyzABCDEF';
    expect(redactSecrets(truncated).text).toBe('[REDACTED]');
  });

  it('replaces every match when a pattern is global', () => {
    const result = redactSecrets('sk-abcdefghijklmnopqrst sk-abcdefghijklmnopqrst');
    expect(result.text).toBe('[REDACTED] [REDACTED]');
    expect(result.summary.by_type).toEqual({ provider_token: 2 });
    expect(result.summary.total).toBe(2);
  });

  it('is text-idempotent even when a later pass can rematch a placeholder', () => {
    const once = redactSecrets('Authorization: Bearer abcdefghijklmnop');
    const twice = redactSecrets(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.text).toBe('Authorization: Bearer [REDACTED]');
  });
});

describe('maybeRedact', () => {
  const secret = 'OPENAI_API_KEY=not-a-provider-shape-value';

  it('returns the original text and a disabled empty summary when off', () => {
    expect(maybeRedact(secret, false)).toEqual({
      text: secret,
      summary: { enabled: false, total: 0, by_type: {} },
    });
  });

  it('redacts when enabled', () => {
    const result = maybeRedact(secret, true);
    expect(result.text).toBe('OPENAI_API_KEY=[REDACTED]');
    expect(result.summary.enabled).toBe(true);
    expect(result.summary.total).toBeGreaterThanOrEqual(1);
  });
});

describe('emptyRedactionSummary', () => {
  it('records the enabled flag and never invents counts', () => {
    expect(emptyRedactionSummary(true)).toEqual({ enabled: true, total: 0, by_type: {} });
    expect(emptyRedactionSummary(false)).toEqual({ enabled: false, total: 0, by_type: {} });
  });
});

describe('combineRedactionSummaries', () => {
  it('returns a disabled empty summary when redaction is off', () => {
    expect(
      combineRedactionSummaries(false, {
        enabled: true,
        total: 4,
        by_type: { provider_token: 4 },
      }),
    ).toEqual({ enabled: false, total: 0, by_type: {} });
  });

  it('sums overlapping type counts and ignores empty input', () => {
    expect(combineRedactionSummaries(true)).toEqual({ enabled: true, total: 0, by_type: {} });
    expect(
      combineRedactionSummaries(
        true,
        { enabled: true, total: 2, by_type: { a: 1, b: 1 } },
        { enabled: true, total: 3, by_type: { b: 2, c: 1 } },
      ),
    ).toEqual({ enabled: true, total: 5, by_type: { a: 1, b: 3, c: 1 } });
  });
});

describe('redactSecrets — #952 egress categories retained', () => {
  it('scrubs GCP, JWT, PEM, Azure, and AWS-session secrets', () => {
    const gcpKey = `AIzaSy${'B'.repeat(33)}`;
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const pemKey = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
      'c2gtZWQyNTUxOQAAACD7uJ0j9mFq3Lr8sVtWuZ1aBcDeFgHiJkLmNoPqRsTuA==',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const azureKey = 'AccountKey=Xj7Kq2Wm9Rt4Yv6Bn1Zc3Pl5Sd8Fg0Hk2Lw4Qa6Ne8Ui0Op2==';
    const awsSessionKey = 'ASIAIOSFODNN7EXAMPLE';

    const result = redactSecrets(
      [`key: ${gcpKey}`, `token: ${jwt}`, pemKey, `conn: ${azureKey}`, `aws: ${awsSessionKey}`].join('\n'),
    );

    expect(result.text).not.toContain(gcpKey);
    expect(result.text).not.toContain(jwt);
    expect(result.text).not.toContain('c2gtZWQyNTUxOQ');
    expect(result.text).not.toContain('Xj7Kq2Wm9Rt4Yv6Bn1Zc3Pl5Sd8Fg0Hk2Lw4Qa6Ne8Ui0Op2');
    expect(result.text).not.toContain(awsSessionKey);
    expect(result.text).toContain(`AccountKey=${REDACTION_PLACEHOLDER}`);
    expect(result.summary.total).toBeGreaterThanOrEqual(5);
  });

  it('redacts PKCS#8, encrypted, and truncated private-key blocks', () => {
    const pkcs8Body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ7uJ0j9mFq3Lr8s';
    const encryptedBody = 'MIIFDjBABgkqhkiG9w0BBQ0wMzAbBgkqhkiG9w0BBQwwDgQItruncatedAESkey00';
    const truncatedBody = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQMoreKeyBodyBytes123456';

    expect(redactSecrets(`-----BEGIN PRIVATE KEY-----\n${pkcs8Body}\n-----END PRIVATE KEY-----`).text)
      .not.toContain(pkcs8Body);
    expect(redactSecrets(
      `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${encryptedBody}\n-----END ENCRYPTED PRIVATE KEY-----`,
    ).text).not.toContain(encryptedBody);
    expect(redactSecrets(`-----BEGIN OPENSSH PRIVATE KEY-----\n${truncatedBody}`).text)
      .not.toContain(truncatedBody);
  });

  it('keeps a lone eyJ header (not a three-segment JWT)', () => {
    const notAJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    expect(redactSecrets(`value: ${notAJwt}`).text).toContain(notAJwt);
  });

  it('does not over-redact a bare high-entropy token with no keyword or shape', () => {
    const bareToken = 'aB3xY9zK1mNpQ2rS4tU6vW8dE0fGhIjK';
    expect(redactSecrets(`The build id is ${bareToken} for reference.`).text).toContain(bareToken);
  });
});

/**
 * Compile-time ingest↔egress parity gate (#952).
 *
 * `Record<SecretFindingCategory, …>` fails typecheck if the scanner grows a
 * category that has no redaction decision. `mirrored: false` documents the
 * intentional high-entropy non-mirror.
 */
type ParityCase =
  | { mirrored: true; sample: string; secret: string }
  | { mirrored: false; reason: string };

const CATEGORY_PARITY: Record<SecretFindingCategory, ParityCase> = {
  aws_access_key: {
    mirrored: true,
    sample: 'ASIAIOSFODNN7EXAMPLE',
    secret: 'ASIAIOSFODNN7EXAMPLE',
  },
  gcp_api_key: {
    mirrored: true,
    sample: `AIzaSy${'B'.repeat(33)}`,
    secret: `AIzaSy${'B'.repeat(33)}`,
  },
  github_token: {
    mirrored: true,
    sample: `ghp_${'a'.repeat(36)}`,
    secret: `ghp_${'a'.repeat(36)}`,
  },
  jwt: {
    mirrored: true,
    sample:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    secret:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  },
  ssh_private_key: {
    mirrored: true,
    sample: [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA7uJ0j9mFq3Lr8sVtWuZ1aBcDeFgHiJkLmNoPqRsTuVwXyZ012',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n'),
    secret: 'MIIEpAIBAAKCAQEA7uJ0j9mFq3Lr8sVtWuZ1aBcDeFgHiJkLmNoPqRsTuVwXyZ012',
  },
  bearer_token: {
    mirrored: true,
    sample: 'Bearer aB3xY9zK1mNpQ2rS4tU6vW8dE0fG',
    secret: 'aB3xY9zK1mNpQ2rS4tU6vW8dE0fG',
  },
  azure_storage_key: {
    mirrored: true,
    sample: 'AccountKey=Xj7Kq2Wm9Rt4Yv6Bn1Zc3Pl5Sd8Fg0Hk2Lw4Qa6Ne8Ui0Op2==',
    secret: 'Xj7Kq2Wm9Rt4Yv6Bn1Zc3Pl5Sd8Fg0Hk2Lw4Qa6Ne8Ui0Op2',
  },
  key_value_secret: {
    mirrored: true,
    sample: 'password=Xq7-Rt2_Vn9.Kw4Zp',
    secret: 'Xq7-Rt2_Vn9.Kw4Zp',
  },
  high_entropy: {
    mirrored: false,
    reason:
      'Generic high-entropy heuristic: no fixed shape to mirror, and redacting arbitrary base64 would corrupt legitimate LLM-prompt content.',
  },
};

describe('redactSecrets / secret-scanner parity', () => {
  const mirrored = Object.entries(CATEGORY_PARITY).filter(
    (entry): entry is [SecretFindingCategory, Extract<ParityCase, { mirrored: true }>] =>
      entry[1].mirrored,
  );

  it.each(mirrored)(
    'ingest scanner detects %s and redactSecrets scrubs it',
    (category, parity) => {
      const detected = detectSecretsInText(parity.sample).map((finding) => finding.category);
      expect(detected).toContain(category);

      const { text } = redactSecrets(parity.sample);
      expect(text).not.toContain(parity.secret);
      expect(text).toContain(REDACTION_PLACEHOLDER);
    },
  );
});
