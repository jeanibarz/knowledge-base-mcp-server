import {
  IngestSecretDetectedError,
  assertNoIngestSecrets,
  detectSecretsInText,
} from './secret-scanner.js';

describe('ingest secret scanner', () => {
  it('detects curated credential shapes without returning matched payloads', () => {
    const cases = [
      ['aws_access_key', 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
      ['gcp_api_key', 'AIzaSyD-1234567890abcdefghijklmnopqrstu'],
      ['github_token', 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD'],
      [
        'jwt',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.vJ8eQhVZl2w5uXqO78Fpm_4ZcYc8-Ma5zJ5PpQ',
      ],
      ['ssh_private_key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
      ['bearer_token', 'Authorization: Bearer abcDEF1234567890abcDEF1234567890'],
      ['azure_storage_key', 'AccountKey=abcDEF1234567890abcDEF1234567890abcDEF1234567890=='],
      ['key_value_secret', 'password=abcDEF1234567890!'],
    ] as const;

    for (const [category, text] of cases) {
      expect(detectSecretsInText(text)).toEqual(expect.arrayContaining([
        expect.objectContaining({ category, chunkIndex: 0 }),
      ]));
    }
  });

  it('throws only when the feature is enabled and the KB is not bypassed', () => {
    const chunks = ['ordinary runbook text', 'token=abcDEF1234567890!'];

    expect(() => assertNoIngestSecrets(chunks, {
      relativePath: 'alpha/secret.md',
      knowledgeBaseName: 'alpha',
      scanOptions: { enabled: false, bypassKnowledgeBases: [] },
    })).not.toThrow();

    expect(() => assertNoIngestSecrets(chunks, {
      relativePath: 'alpha/secret.md',
      knowledgeBaseName: 'alpha',
      scanOptions: { enabled: true, bypassKnowledgeBases: ['alpha'] },
    })).not.toThrow();

    expect(() => assertNoIngestSecrets(chunks, {
      relativePath: 'alpha/secret.md',
      knowledgeBaseName: 'alpha',
      scanOptions: { enabled: true, bypassKnowledgeBases: [] },
    })).toThrow(IngestSecretDetectedError);
  });

  it('deduplicates categories and reports chunk indexes only', () => {
    try {
      assertNoIngestSecrets(
        ['password=abcDEF1234567890!', 'Bearer abcDEF1234567890abcDEF1234567890'],
        {
          relativePath: 'alpha/secret.md',
          knowledgeBaseName: 'alpha',
          scanOptions: { enabled: true, bypassKnowledgeBases: [] },
        },
      );
      throw new Error('expected scanner to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IngestSecretDetectedError);
      const secretError = error as IngestSecretDetectedError;
      expect(secretError.categories).toEqual(['bearer_token', 'key_value_secret']);
      expect(secretError.chunkIndexes).toEqual([0, 1]);
      expect(secretError.message).not.toContain('abcDEF');
    }
  });
});
