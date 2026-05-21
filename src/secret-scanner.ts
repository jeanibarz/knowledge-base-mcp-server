import { resolveIngestSecretScanOptions, type IngestSecretScanOptions } from './config/ingest.js';

export type SecretFindingCategory =
  | 'aws_access_key'
  | 'gcp_api_key'
  | 'github_token'
  | 'jwt'
  | 'ssh_private_key'
  | 'bearer_token'
  | 'azure_storage_key'
  | 'key_value_secret'
  | 'high_entropy';

export type SecretScanLocation = 'chunk' | 'frontmatter';

export interface SecretScanInput {
  content: string;
  chunkIndex?: number;
  location: SecretScanLocation;
}

export interface SecretScanFinding {
  category: SecretFindingCategory;
  chunkIndex?: number;
  location: SecretScanLocation;
}

export class IngestSecretDetectedError extends Error {
  readonly code = 'KB_INGEST_SECRET_DETECTED';
  readonly categories: SecretFindingCategory[];
  readonly chunkIndexes: number[];
  readonly locations: SecretScanLocation[];

  constructor(relativePath: string, findings: readonly SecretScanFinding[]) {
    const categories = uniqueSorted(findings.map((finding) => finding.category));
    const chunkIndexes = uniqueSortedNumbers(
      findings.flatMap((finding) => (
        typeof finding.chunkIndex === 'number' ? [finding.chunkIndex] : []
      )),
    );
    const locations = uniqueSortedStrings(findings.map((finding) => finding.location)) as SecretScanLocation[];
    super(
      `secret-like content detected in ${relativePath} ` +
        `(${categories.join(', ')}); file quarantined before embedding`,
    );
    this.name = 'IngestSecretDetectedError';
    this.categories = categories;
    this.chunkIndexes = chunkIndexes;
    this.locations = locations;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const SECRET_PATTERNS: ReadonlyArray<{
  category: SecretFindingCategory;
  pattern: RegExp;
  entropyCheck?: boolean;
}> = [
  { category: 'aws_access_key', pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA)[A-Z0-9]{16}\b/g },
  { category: 'gcp_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { category: 'github_token', pattern: /\bgh[opsu]_[A-Za-z0-9_]{36,}\b/g },
  { category: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { category: 'ssh_private_key', pattern: /-----BEGIN (?:OPENSSH|RSA|DSA|EC|PRIVATE) PRIVATE KEY-----/g },
  { category: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, entropyCheck: true },
  { category: 'azure_storage_key', pattern: /\bAccountKey=[A-Za-z0-9+/=]{40,}\b/gi, entropyCheck: true },
  {
    category: 'key_value_secret',
    pattern: /\b(?:password|passwd|pwd|api[_-]?key|secret|token)\s*[:=]\s*['"]?([A-Za-z0-9._~+/=-]{12,})/gi,
    entropyCheck: true,
  },
];

const HIGH_ENTROPY_TOKEN = /\b[A-Za-z0-9._~+/=-]{40,}\b/g;
const MIN_SECRET_ENTROPY = 3.5;
const MIN_STANDALONE_ENTROPY = 4.2;

export function detectSecretsInText(
  text: string,
  chunkIndex = 0,
  location: SecretScanLocation = 'chunk',
): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  const seen = new Set<string>();

  for (const { category, pattern, entropyCheck } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[0];
      if (entropyCheck === true && shannonEntropy(value) < MIN_SECRET_ENTROPY) {
        continue;
      }
      addFinding(findings, seen, { category, chunkIndex, location });
      break;
    }
  }

  HIGH_ENTROPY_TOKEN.lastIndex = 0;
  for (const match of text.matchAll(HIGH_ENTROPY_TOKEN)) {
    const token = match[0];
    if (looksLikeStandaloneSecret(token) && shannonEntropy(token) >= MIN_STANDALONE_ENTROPY) {
      addFinding(findings, seen, { category: 'high_entropy', chunkIndex, location });
      break;
    }
  }

  return findings;
}

export function assertNoIngestSecrets(
  chunks: ReadonlyArray<string | SecretScanInput>,
  options: {
    relativePath: string;
    knowledgeBaseName: string;
    scanOptions?: IngestSecretScanOptions;
  },
): void {
  const scanOptions = options.scanOptions ?? resolveIngestSecretScanOptions();
  if (!scanOptions.enabled || scanOptions.bypassKnowledgeBases.includes(options.knowledgeBaseName)) {
    return;
  }

  const findings = chunks.flatMap((chunk, chunkIndex) => {
    if (typeof chunk === 'string') {
      return detectSecretsInText(chunk, chunkIndex, 'chunk');
    }
    const findingsForInput = detectSecretsInText(chunk.content, chunk.chunkIndex ?? 0, chunk.location);
    if (chunk.chunkIndex !== undefined) return findingsForInput;
    return findingsForInput.map((finding) => ({
      category: finding.category,
      location: finding.location,
    }));
  });
  if (findings.length > 0) {
    throw new IngestSecretDetectedError(options.relativePath, findings);
  }
}

function looksLikeStandaloneSecret(token: string): boolean {
  if (/^https?:\/\//i.test(token)) return false;
  if (/^[0-9a-f]{40,}$/i.test(token)) return false;
  return (
    /[a-z]/.test(token) &&
    /[A-Z]/.test(token) &&
    /\d/.test(token) &&
    /[._~+/=-]/.test(token)
  );
}

function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function addFinding(
  findings: SecretScanFinding[],
  seen: Set<string>,
  finding: SecretScanFinding,
): void {
  const key = `${finding.category}:${finding.location}:${finding.chunkIndex ?? 'none'}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

function uniqueSorted(values: readonly SecretFindingCategory[]): SecretFindingCategory[] {
  return Array.from(new Set(values)).sort();
}

function uniqueSortedNumbers(values: readonly number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}
