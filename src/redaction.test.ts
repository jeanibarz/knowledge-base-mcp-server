import { describe, expect, it } from '@jest/globals';
import { redactSecrets, REDACTION_PLACEHOLDER } from './redaction.js';
import { detectSecretsInText, type SecretFindingCategory } from './secret-scanner.js';

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
  });

  it('scrubs the five newly-covered egress secret categories', () => {
    const gcpKey = `AIzaSy${'B'.repeat(33)}`; // AIza + 35 chars
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const pemKey = [
      '-----BEGIN OPENSSH PRIVATE KEY-----', // pragma: allowlist secret
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
      'c2gtZWQyNTUxOQAAACD7uJ0j9mFq3Lr8sVtWuZ1aBcDeFgHiJkLmNoPqRsTuA==',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const azureKey = 'AccountKey=Xj7Kq2Wm9Rt4Yv6Bn1Zc3Pl5Sd8Fg0Hk2Lw4Qa6Ne8Ui0Op2==';
    const awsSessionKey = 'ASIAIOSFODNN7EXAMPLE'; // ASIA session-key prefix

    const result = redactSecrets(
      [
        `key: ${gcpKey}`,
        `token: ${jwt}`,
        pemKey,
        `conn: ${azureKey}`,
        `aws: ${awsSessionKey}`,
      ].join('\n'),
    );

    expect(result.text).not.toContain(gcpKey);
    expect(result.text).not.toContain(jwt);
    expect(result.text).not.toContain('c2gtZWQyNTUxOQ'); // PEM key body
    expect(result.text).not.toContain('Xj7Kq2Wm9Rt4Yv6Bn1Zc3Pl5Sd8Fg0Hk2Lw4Qa6Ne8Ui0Op2'); // Azure key value
    expect(result.text).not.toContain(awsSessionKey);
    // AccountKey= label is preserved; only the value is scrubbed.
    expect(result.text).toContain(`AccountKey=${REDACTION_PLACEHOLDER}`);
    // Each of the five secrets is replaced by a placeholder (not merely deleted).
    expect(result.text).toContain(REDACTION_PLACEHOLDER);
    expect(result.summary.total).toBeGreaterThanOrEqual(5);
  });

  it('redacts private-key blocks across PEM formats (PKCS#8, encrypted, truncated)', () => {
    // The ingest scanner only keys on the `-----BEGIN-----` header, but egress
    // must scrub the whole block. Cover the bare PKCS#8 header (no algorithm
    // prefix), the encrypted variant, and a truncated block missing its END
    // footer (as clipped in a log) — all previously slipped through.
    const pkcs8Body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ7uJ0j9mFq3Lr8s';
    const encryptedBody = 'MIIFDjBABgkqhkiG9w0BBQ0wMzAbBgkqhkiG9w0BBQwwDgQItruncatedAESkey00';
    const truncatedBody = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQMoreKeyBodyBytes123456';

    const pkcs8 = redactSecrets(`-----BEGIN PRIVATE KEY-----\n${pkcs8Body}\n-----END PRIVATE KEY-----`); // pragma: allowlist secret
    expect(pkcs8.text).not.toContain(pkcs8Body);
    expect(pkcs8.text).toContain(REDACTION_PLACEHOLDER);

    const encrypted = redactSecrets(
      `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${encryptedBody}\n-----END ENCRYPTED PRIVATE KEY-----`, // pragma: allowlist secret
    );
    expect(encrypted.text).not.toContain(encryptedBody);

    // Truncated: header present, END footer clipped. The body must not egress.
    const truncated = redactSecrets(`-----BEGIN OPENSSH PRIVATE KEY-----\n${truncatedBody}`); // pragma: allowlist secret
    expect(truncated.text).not.toContain(truncatedBody);
  });

  it('keeps the full three-segment JWT shape (does not over-redact bare base64)', () => {
    // A lone `eyJ`-prefixed base64 token without the two trailing segments is not
    // a JWT and must survive untouched, per the acceptance criteria.
    const notAJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const result = redactSecrets(`value: ${notAJwt}`);
    expect(result.text).toContain(notAJwt);
  });

  it('does not over-redact a bare high-entropy token with no keyword or shape', () => {
    // Egress redaction intentionally does NOT mirror the ingest scanner's generic
    // high-entropy heuristic (and its bare, un-prefixed `token` keyword): a lone
    // random-looking string with no secret-field keyword and no recognizable
    // provider shape is left intact so ordinary prompt content is not corrupted.
    // This is the documented boundary behind the `high_entropy` non-mirrored case.
    const bareToken = 'aB3xY9zK1mNpQ2rS4tU6vW8dE0fGhIjK';
    const result = redactSecrets(`The build id is ${bareToken} for reference.`);
    expect(result.text).toContain(bareToken);
  });
});

/**
 * Parity gate against the ingest secret scanner.
 *
 * Every category the ingest scanner (`detectSecretsInText`) recognizes must map
 * to an entry here. Because the map is a `Record<SecretFindingCategory, …>`, any
 * category added to or renamed in the scanner's union breaks compilation until
 * it is accounted for — so the egress redactor and the ingest scanner cannot
 * silently drift apart again.
 *
 * Each `mirrored: true` entry carries a canonical sample that the ingest scanner
 * actually detects (asserted below) and that `redactSecrets` must scrub. A
 * `mirrored: false` entry documents a category that is intentionally not
 * mirrored on egress (currently only the generic high-entropy heuristic, which
 * would over-redact arbitrary text in an LLM prompt).
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
      '-----BEGIN RSA PRIVATE KEY-----', // pragma: allowlist secret
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
    // A bare secret field with a shapeless (non-provider) value: the value is
    // scrubbed by the redactor's own `key_value_secret` pattern, not by a
    // coincidental provider-token match — so this genuinely exercises key/value
    // parity. (Only the generic un-prefixed `token` keyword and shapeless
    // high-entropy values remain intentionally un-mirrored; see high_entropy.)
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
      // 1. The canonical sample is genuinely something the ingest scanner flags
      //    for this category (guards against the scanner's pattern drifting).
      const detected = detectSecretsInText(parity.sample).map((finding) => finding.category);
      expect(detected).toContain(category);

      // 2. The egress redactor scrubs that same secret material.
      const { text } = redactSecrets(parity.sample);
      expect(text).not.toContain(parity.secret);
      expect(text).toContain(REDACTION_PLACEHOLDER);
    },
  );
});
