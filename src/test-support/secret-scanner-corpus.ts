// Curated positive/negative corpus for the ingest secret scanner (issue #896).
//
// `detectSecretsInText` (src/secret-scanner.ts) classifies secret-like
// content before embedding. Positive entries must raise the named category;
// negative entries are high-entropy non-secrets (git SHAs, URLs, low-entropy
// repeats, short tokens, ordinary prose) that must stay clean. Consumed by
// both `secret-scanner.test.ts` and `__property-tests__/secret-scanner.property.test.ts`.
//
// This file lives under `src/test-support/` (excluded from `tsconfig` build)
// so the fixture strings never ship in `build/`. Values are fake and sized
// to the production regexes and entropy floors (3.5 for shaped secrets with
// `entropyCheck`, 4.2 for standalone high-entropy tokens).

import type { SecretFindingCategory } from '../secret-scanner.js';

export interface SecretScannerPositiveEntry {
  readonly name: string;
  readonly payload: string;
  readonly expectedCategory: SecretFindingCategory;
}

export interface SecretScannerNegativeEntry {
  readonly name: string;
  readonly payload: string;
}

/** 40-char mixed token, Shannon entropy ~4.61 — above the 4.2 standalone floor. */
export const HIGH_ENTROPY_STANDALONE = 'Aa0.Bb1.Cc2.Dd3.Ee4.Ff5.Gg6.Hh7.Ii8.Jj9k';

/** 40-char mixed token, Shannon entropy ~3.97 — between 3.5 and 4.2. */
export const MID_ENTROPY_STANDALONE = 'ABCDefgh0123._~+ABCDefgh0123._~+ABCDefgh';

/** 12-char value, Shannon entropy ~3.59 — above the 3.5 shaped-secret floor. */
export const MID_ENTROPY_KEY_VALUE = 'Abcdefghijk1';

export const SECRET_SCANNER_POSITIVE_CORPUS: readonly SecretScannerPositiveEntry[] = [
  {
    name: 'aws-access-key',
    payload: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', // pragma: allowlist secret
    expectedCategory: 'aws_access_key',
  },
  {
    name: 'gcp-api-key',
    payload: 'AIzaSyD-1234567890abcdefghijklmnopqrstu', // pragma: allowlist secret
    expectedCategory: 'gcp_api_key',
  },
  {
    name: 'github-token',
    payload: 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD', // pragma: allowlist secret
    expectedCategory: 'github_token',
  },
  {
    name: 'jwt',
    payload:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.vJ8eQhVZl2w5uXqO78Fpm_4ZcYc8-Ma5zJ5PpQ', // pragma: allowlist secret
    expectedCategory: 'jwt',
  },
  {
    name: 'ssh-private-key',
    payload: '-----BEGIN OPENSSH PRIVATE KEY-----', // pragma: allowlist secret
    expectedCategory: 'ssh_private_key',
  },
  {
    name: 'bearer-token',
    payload: 'Authorization: Bearer abcDEF1234567890abcDEF1234567890',
    expectedCategory: 'bearer_token',
  },
  {
    name: 'azure-storage-key',
    payload: 'AccountKey=abcDEF1234567890abcDEF1234567890abcDEF1234567890==', // pragma: allowlist secret
    expectedCategory: 'azure_storage_key',
  },
  {
    name: 'key-value-secret',
    payload: `password=${MID_ENTROPY_KEY_VALUE}`,
    expectedCategory: 'key_value_secret',
  },
  {
    name: 'high-entropy-standalone',
    payload: HIGH_ENTROPY_STANDALONE,
    expectedCategory: 'high_entropy',
  },
];

export const SECRET_SCANNER_NEGATIVE_CORPUS: readonly SecretScannerNegativeEntry[] = [
  { name: 'git-sha-40', payload: 'a1b2c3d4e5f6789012345678901234567890abcd' },
  { name: 'sha256-hex', payload: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  { name: 'https-url', payload: 'https://example.com/abcdefghijklmnopqrstuvwxyz0123456789' },
  { name: 'ordinary-prose', payload: 'Deployment notes: restart the worker after migration.' },
  { name: 'low-entropy-password', payload: 'password=aaaaaaaaaaaa' },
  { name: 'short-password', payload: 'password=short' },
  { name: 'low-entropy-bearer', payload: 'Bearer aaaaaaaaaaaaaaaaaaaaa' },
  { name: 'repeated-char-40', payload: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  { name: 'mid-entropy-standalone', payload: MID_ENTROPY_STANDALONE },
  { name: 'uuid', payload: '550e8400-e29b-41d4-a716-446655440000' },
  { name: 'all-lowercase-40', payload: 'abcdefghijklmnopqrstuvwxyz0123456789abcd' },
];
