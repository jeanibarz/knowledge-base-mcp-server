// Curated positive/negative corpus for outbound secret redaction (issue #896).
//
// `redactSecrets` (src/redaction.ts) is the scrubber on every remote-LLM
// prompt. Each positive entry is a shaped secret that must be replaced with
// `[REDACTED]`; each negative entry is high-entropy or secret-shaped-looking
// text that must survive unchanged (git SHAs, credential-less URLs, short
// tokens, ordinary prose). Consumed by both `redaction.test.ts` and
// `__property-tests__/redaction.property.test.ts`.
//
// This file lives under `src/test-support/` (excluded from `tsconfig` build)
// so the fixture strings never ship in `build/`. Values are fake and sized
// to the production regexes; they are not live credentials.

export interface RedactionPositiveEntry {
  readonly name: string;
  readonly payload: string;
  /** `by_type` key `redactSecrets` must record for this isolated payload. */
  readonly expectedType: string;
  /** Substring of the secret that must not appear in the redacted text. */
  readonly secretNeedle: string;
  /** Substring that must appear after redaction. */
  readonly expectedSnippet: string;
}

export interface RedactionNegativeEntry {
  readonly name: string;
  readonly payload: string;
}

export const REDACTION_POSITIVE_CORPUS: readonly RedactionPositiveEntry[] = [
  {
    name: 'credential-url',
    payload: 'clone https://alice:s3cretpass@example.com/repo.git',
    expectedType: 'credential_url',
    secretNeedle: 'alice:s3cretpass',
    expectedSnippet: 'https://[REDACTED]@example.com/repo.git',
  },
  {
    name: 'authorization-basic',
    payload: 'Authorization: Basic dXNlcjpwYXNzd29yZA',
    expectedType: 'authorization_header',
    secretNeedle: 'dXNlcjpwYXNzd29yZA',
    expectedSnippet: 'Authorization: Basic [REDACTED]',
  },
  {
    name: 'cookie-header',
    payload: 'Cookie: sessionid=abc123def456',
    expectedType: 'cookie_header',
    secretNeedle: 'sessionid=abc123def456',
    expectedSnippet: 'Cookie: [REDACTED]',
  },
  {
    name: 'json-api-key',
    payload: '{"api_key":"not-a-provider-shape"}',
    expectedType: 'json_secret',
    secretNeedle: 'not-a-provider-shape',
    expectedSnippet: '"api_key":"[REDACTED]"',
  },
  {
    name: 'dotenv-api-key',
    payload: 'OPENAI_API_KEY=not-a-provider-shape-value',
    expectedType: 'dotenv_secret',
    secretNeedle: 'not-a-provider-shape-value',
    expectedSnippet: 'OPENAI_API_KEY=[REDACTED]',
  },
  {
    name: 'key-value-password',
    payload: 'see password=not-a-provider-shape',
    expectedType: 'key_value_secret',
    secretNeedle: 'not-a-provider-shape',
    expectedSnippet: 'password=[REDACTED]',
  },
  {
    name: 'bare-bearer',
    payload: 'use Bearer abcdefghijklmno for this',
    expectedType: 'bearer_token',
    secretNeedle: 'abcdefghijklmno',
    expectedSnippet: 'Bearer [REDACTED]',
  },
  {
    name: 'openai-sk',
    payload: 'sk-abcdefghijklmnopqrstuvwxyz',
    expectedType: 'provider_token',
    secretNeedle: 'sk-abcdefghijklmnopqrstuvwxyz',
    expectedSnippet: '[REDACTED]',
  },
  {
    name: 'github-pat',
    payload: 'github_pat_abcdefghijklmnopqrstuvwxyz',
    expectedType: 'provider_token',
    secretNeedle: 'github_pat_abcdefghijklmnopqrstuvwxyz',
    expectedSnippet: '[REDACTED]',
  },
  {
    name: 'aws-akia',
    payload: 'AKIAIOSFODNN7EXAMPLE',
    expectedType: 'provider_token',
    secretNeedle: 'AKIAIOSFODNN7EXAMPLE',
    expectedSnippet: '[REDACTED]',
  },
  {
    name: 'slack-xoxb',
    payload: 'xoxb-1234567890-token',
    expectedType: 'provider_token',
    secretNeedle: 'xoxb-1234567890-token',
    expectedSnippet: '[REDACTED]',
  },
  {
    name: 'jwt',
    payload:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.vJ8eQhVZl2w5uXqO78Fpm_4ZcYc8-Ma5zJ5PpQ',
    expectedType: 'jwt',
    secretNeedle:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.vJ8eQhVZl2w5uXqO78Fpm_4ZcYc8-Ma5zJ5PpQ',
    expectedSnippet: '[REDACTED]',
  },
  {
    name: 'ssh-private-key',
    payload: '-----BEGIN OPENSSH PRIVATE KEY-----\nabcdefghijklmnopqrstuvwxyzABCDEF\n-----END OPENSSH PRIVATE KEY-----',
    expectedType: 'ssh_private_key',
    secretNeedle: 'abcdefghijklmnopqrstuvwxyzABCDEF',
    expectedSnippet: '[REDACTED]',
  },
  {
    name: 'azure-account-key',
    payload: 'AccountKey=abcDEF1234567890abcDEF1234567890abcDEF1234567890==',
    expectedType: 'azure_storage_key',
    secretNeedle: 'abcDEF1234567890abcDEF1234567890abcDEF1234567890==',
    expectedSnippet: 'AccountKey=[REDACTED]',
  },
  {
    name: 'gcp-api-key',
    payload: 'AIzaSyD-1234567890abcdefghijklmnopqrstu',
    expectedType: 'provider_token',
    secretNeedle: 'AIzaSyD-1234567890abcdefghijklmnopqrstu',
    expectedSnippet: '[REDACTED]',
  },
];

export const REDACTION_NEGATIVE_CORPUS: readonly RedactionNegativeEntry[] = [
  { name: 'git-sha-40', payload: 'commit a1b2c3d4e5f6789012345678901234567890abcd landed' },
  { name: 'https-url', payload: 'see https://example.com/abcdefghijklmnopqrstuvwxyz0123456789' },
  { name: 'ordinary-prose', payload: 'Deployment notes: restart the worker after migration.' },
  { name: 'short-bearer', payload: 'use Bearer 12345678901 here' },
  { name: 'short-sk', payload: 'sk-shorttokenvalue' },
  { name: 'json-username', payload: '{"username":"alice","count":3}' },
  { name: 'plain-assignment', payload: 'FOO=bar' },
  { name: 'password-in-prose', payload: 'the password is documented in the runbook' },
  { name: 'digest-auth', payload: 'Authorization: Digest abcdefghijklmnop' },
  // Generic high-entropy blob: redaction matches shaped secrets only, not entropy.
  { name: 'high-entropy-blob', payload: 'Aa0.Bb1.Cc2.Dd3.Ee4.Ff5.Gg6.Hh7.Ii8.Jj9k' },
  // Lone `eyJ` header without payload.signature is not a JWT.
  { name: 'bare-eyj-header', payload: 'value: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' },
  { name: 'short-gcp-key', payload: `AIzaSy${'B'.repeat(32)}` },
  { name: 'short-azure-key', payload: 'AccountKey=abcdefghijklmnopqrstuvwxyz012345' },
];
