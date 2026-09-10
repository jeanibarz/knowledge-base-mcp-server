import {
  IngestSecretDetectedError,
  assertNoIngestSecrets,
  detectSecretsInText,
} from './secret-scanner.js';
import {
  HIGH_ENTROPY_STANDALONE,
  MID_ENTROPY_KEY_VALUE,
  MID_ENTROPY_STANDALONE,
  SECRET_SCANNER_NEGATIVE_CORPUS,
  SECRET_SCANNER_POSITIVE_CORPUS,
} from './test-support/secret-scanner-corpus.js';

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
      expect(secretError.locations).toEqual(['chunk']);
      expect(secretError.message).not.toContain('abcDEF');
    }
  });

  it('can report frontmatter findings without inventing chunk indexes', () => {
    try {
      assertNoIngestSecrets(
        [{ content: '{"api_key":"AKIA1234567890ABCDEF"}', location: 'frontmatter' }],
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
      expect(secretError.categories).toEqual(['aws_access_key']);
      expect(secretError.chunkIndexes).toEqual([]);
      expect(secretError.locations).toEqual(['frontmatter']);
    }
  });

  it.each(SECRET_SCANNER_POSITIVE_CORPUS.map((entry) => [entry.name, entry] as const))(
    'flags positive corpus entry: %s',
    (_name, entry) => {
      expect(detectSecretsInText(entry.payload)).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: entry.expectedCategory, chunkIndex: 0 }),
      ]));
    },
  );

  it.each(SECRET_SCANNER_NEGATIVE_CORPUS.map((entry) => [entry.name, entry] as const))(
    'does not flag negative corpus entry: %s',
    (_name, entry) => {
      expect(detectSecretsInText(entry.payload)).toEqual([]);
    },
  );

  it('detects every AWS access-key prefix and rejects a 15-character remainder', () => {
    const prefixes = ['A3TA', 'AKIA', 'ASIA', 'AGPA', 'AIDA', 'AROA', 'AIPA', 'ANPA'] as const;
    for (const prefix of prefixes) {
      expect(detectSecretsInText(`${prefix}IOSFODNN7EXAMPLE`)).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: 'aws_access_key' }),
      ]));
    }
    expect(detectSecretsInText('AKIAIOSFODNN7EXAMPL')).toEqual([]);
  });

  it('detects every SSH private-key BEGIN variant', () => {
    for (const kind of ['OPENSSH', 'RSA', 'DSA', 'EC', 'PRIVATE'] as const) {
      // The ingest regex is `(?:OPENSSH|RSA|DSA|EC|PRIVATE) PRIVATE KEY`, so the
      // `PRIVATE` alternative is `BEGIN PRIVATE PRIVATE KEY`, not PKCS#8
      // `BEGIN PRIVATE KEY`. Egress redaction covers the latter separately.
      expect(detectSecretsInText(`-----BEGIN ${kind} PRIVATE KEY-----`)).toEqual(
        expect.arrayContaining([expect.objectContaining({ category: 'ssh_private_key' })]),
      );
    }
    expect(detectSecretsInText('-----BEGIN PRIVATE KEY-----')).toEqual([]);
  });

  it('detects gh[opsu]_ tokens of 36+ and ignores a ghr_ token as github_token', () => {
    const body = '1234567890abcdefghijklmnopqrstuvwxyzABCD';
    for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_'] as const) {
      expect(detectSecretsInText(`${prefix}${body}`)).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: 'github_token' }),
      ]));
    }
    const ghrFindings = detectSecretsInText(`ghr_${body}`);
    expect(ghrFindings.some((finding) => finding.category === 'github_token')).toBe(false);
  });

  it('skips shaped secrets whose captured value is below the 3.5 entropy floor', () => {
    expect(detectSecretsInText('password=aaaaaaaaaaaa')).toEqual([]);
    expect(detectSecretsInText('Bearer aaaaaaaaaaaaaaaaaaaaa')).toEqual([]);
    expect(detectSecretsInText(`password=${MID_ENTROPY_KEY_VALUE}`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'key_value_secret' }),
    ]));
  });

  it('applies the 4.2 standalone entropy floor and charset/length gates', () => {
    expect(detectSecretsInText(HIGH_ENTROPY_STANDALONE)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'high_entropy' }),
    ]));
    expect(detectSecretsInText(MID_ENTROPY_STANDALONE)).toEqual([]);
    expect(detectSecretsInText('Aa0.Aa0.Aa0.Aa0.Aa0.Aa0.Aa0.Aa0.Aa0.Aa0x')).toEqual([]);
    expect(detectSecretsInText('abcdefghijklmnopqrstuvwxyz0123456789abc')).toEqual([]);
  });

  it('does not treat hex-only 40+ tokens or missing charset classes as standalone secrets', () => {
    expect(detectSecretsInText('a1b2c3d4e5f6789012345678901234567890abcd')).toEqual([]);
    expect(detectSecretsInText('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD')).toEqual([]);
    expect(detectSecretsInText('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN')).toEqual([]);
  });

  it('resets global regex lastIndex so a second scan of the same text still matches', () => {
    const text = 'AKIAIOSFODNN7EXAMPLE';
    expect(detectSecretsInText(text)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'aws_access_key' }),
    ]));
    expect(detectSecretsInText(text)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'aws_access_key' }),
    ]));
  });

  it('preserves an explicit chunkIndex on structured inputs', () => {
    try {
      assertNoIngestSecrets(
        [{ content: 'password=Abcdefghijk1', chunkIndex: 3, location: 'chunk' }],
        {
          relativePath: 'alpha/secret.md',
          knowledgeBaseName: 'alpha',
          scanOptions: { enabled: true, bypassKnowledgeBases: [] },
        },
      );
      throw new Error('expected scanner to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IngestSecretDetectedError);
      expect((error as IngestSecretDetectedError).chunkIndexes).toEqual([3]);
    }
  });

  it('sorts mixed chunk and frontmatter locations without inventing indexes', () => {
    try {
      assertNoIngestSecrets(
        [
          { content: 'password=Abcdefghijk1', location: 'frontmatter' },
          'Bearer abcDEF1234567890abcDEF1234567890',
        ],
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
      expect(secretError.locations).toEqual(['chunk', 'frontmatter']);
      expect(secretError.chunkIndexes).toEqual([1]);
    }
  });
});
