// `kb verify` — slow, read-only consistency checks for persisted indexes.

import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  modelDir,
  modelsRoot,
  readModelIndexStorage,
  resolveActiveModel,
} from './active-model.js';
import {
  FAISS_INDEX_PATH,
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config/paths.js';
import {
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
} from './config/ingest.js';
import { calculateSHA256, pathExists } from './file-utils.js';
import {
  INDEX_INTEGRITY_MANIFEST_FILENAME,
  INDEX_INTEGRITY_MANIFEST_SCHEMA_VERSION,
  parseIndexVersionDirName,
  resolveIndexVersionRetention,
  type IndexIntegrityManifest,
} from './faiss-store-layout.js';
import { readChunkManifest } from './file-ingest.js';
import { INGEST_QUARANTINE_FILENAME } from './ingest-quarantine.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';
import { REINDEX_RUN_FILENAME } from './reindex-runner.js';

const STALE_SENTINEL_MS = 60 * 60 * 1000;
const KNOWN_INDEX_LEDGER_FILES = new Set([
  INGEST_QUARANTINE_FILENAME,
  'relevance-feedback.jsonl',
]);

export const VERIFY_HELP = `kb verify — deep consistency checks for persisted KB indexes

Usage:
  kb verify --integrity [--format=md|json] [--all-versions] [--model=<model_id>]

Runs a slow, read-only integrity audit over FAISS version directories,
integrity manifests, docstore JSON, lexical chunk counts, per-file hash
sidecars, chunk manifests, stale sentinels, and retained-version drift.

Options:
  --integrity          Run the cryptographic integrity audit.
  --format=md|json     Output format (default: md).
  --all-versions       Verify every retained index.vN directory for the model
                       instead of only the active version.
  --model=<model_id>   Verify a specific registered model. Defaults to the
                       active model resolution path.
  --help, -h           Show this help.

Exit codes:
  0   clean
  1   drift detected
  2   corruption or invalid arguments
`;

export interface VerifyArgs {
  integrity: boolean;
  format: 'md' | 'json';
  allVersions: boolean;
  modelId: string | null;
}

export type IntegritySeverity = 'drift' | 'corruption';

export interface IntegrityFinding {
  severity: IntegritySeverity;
  code: string;
  path: string | null;
  detail: string;
}

export interface IntegrityVersionReport {
  version: string;
  active: boolean;
  path: string;
  faiss_sha256: string | null;
  docstore_sha256: string | null;
  dense_chunks: number | null;
}

export interface IntegrityReport {
  schema_version: 'kb.verify.integrity.v1';
  status: 'clean' | 'drift' | 'corruption';
  model_id: string | null;
  faiss_root: string;
  knowledge_base_root: string;
  checked_versions: IntegrityVersionReport[];
  lexical_chunks_by_kb: Record<string, number>;
  dense_chunks_by_kb: Record<string, number>;
  findings: IntegrityFinding[];
}

interface VerifyIntegrityOptions {
  allVersions?: boolean;
  modelId?: string | null;
  now?: Date;
}

interface ParsedDocstore {
  total: number;
  byKb: Record<string, number>;
}

export async function runVerify(rest: string[]): Promise<number> {
  let args: VerifyArgs;
  try {
    args = parseVerifyArgs(rest);
  } catch (err) {
    process.stderr.write(`kb verify: ${(err as Error).message}\n`);
    return 2;
  }

  if (!args.integrity) {
    process.stderr.write('kb verify: --integrity is required\n');
    return 2;
  }

  let report: IntegrityReport;
  try {
    report = await verifyIntegrity({
      allVersions: args.allVersions,
      modelId: args.modelId,
    });
  } catch (err) {
    process.stderr.write(`kb verify: ${(err as Error).message}\n`);
    return 2;
  }
  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatIntegrityMarkdown(report));
  }
  return integrityExitCode(report);
}

export function parseVerifyArgs(rest: readonly string[]): VerifyArgs {
  const out: VerifyArgs = {
    integrity: false,
    format: 'md',
    allVersions: false,
    modelId: null,
  };
  for (const raw of rest) {
    if (raw === '--integrity') {
      out.integrity = true;
      continue;
    }
    if (raw === '--all-versions') {
      out.allVersions = true;
      continue;
    }
    if (raw.startsWith('--model=')) {
      const value = raw.slice('--model='.length).trim();
      if (value.length === 0) throw new Error('empty --model value');
      out.modelId = value;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format: ${raw}`);
      }
      out.format = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  return out;
}

export async function verifyIntegrity(
  options: VerifyIntegrityOptions = {},
): Promise<IntegrityReport> {
  const findings: IntegrityFinding[] = [];
  const checkedVersions: IntegrityVersionReport[] = [];
  const lexicalChunksByKb: Record<string, number> = {};
  const denseChunksByKb: Record<string, number> = {};
  let modelId = options.modelId ?? null;

  if (modelId === null) {
    try {
      modelId = await resolveActiveModel();
    } catch (err) {
      findings.push({
        severity: 'corruption',
        code: 'ACTIVE_MODEL_UNRESOLVED',
        path: path.join(FAISS_INDEX_PATH, 'active.txt'),
        detail: (err as Error).message,
      });
    }
  }

  if (modelId !== null) {
    const modelPath = modelDir(modelId);
    await verifyModelVersions({
      modelId,
      modelPath,
      allVersions: options.allVersions === true,
      findings,
      checkedVersions,
      denseChunksByKb,
    });
    await verifyMetadataSidecar(modelId, modelPath, denseTotal(denseChunksByKb), findings);
  }

  await verifyLexicalCounts(lexicalChunksByKb, denseChunksByKb, findings);
  await verifyKbSidecars(findings);
  await verifyRetentionDrift(modelId, findings);
  await verifyStaleSentinels(options.now ?? new Date(), findings);

  return {
    schema_version: 'kb.verify.integrity.v1',
    status: summarizeIntegrityStatus(findings),
    model_id: modelId,
    faiss_root: FAISS_INDEX_PATH,
    knowledge_base_root: KNOWLEDGE_BASES_ROOT_DIR,
    checked_versions: checkedVersions,
    lexical_chunks_by_kb: lexicalChunksByKb,
    dense_chunks_by_kb: denseChunksByKb,
    findings,
  };
}

async function verifyModelVersions(args: {
  modelId: string;
  modelPath: string;
  allVersions: boolean;
  findings: IntegrityFinding[];
  checkedVersions: IntegrityVersionReport[];
  denseChunksByKb: Record<string, number>;
}): Promise<void> {
  let storage;
  try {
    storage = await readModelIndexStorage(args.modelId);
  } catch (err) {
    args.findings.push({
      severity: 'corruption',
      code: 'MODEL_STORAGE_UNREADABLE',
      path: args.modelPath,
      detail: (err as Error).message,
    });
    return;
  }

  const selected = storage.versions.filter((version) => args.allVersions || version.active);
  if (selected.length === 0) {
    args.findings.push({
      severity: 'corruption',
      code: 'NO_INDEX_VERSION',
      path: args.modelPath,
      detail: 'no active index.vN directory was found for the selected model',
    });
    return;
  }

  for (const version of selected) {
    const versionPath = path.join(args.modelPath, version.version);
    const result = await verifyVersionDir(args.modelId, version.version, version.active, versionPath, args.findings);
    args.checkedVersions.push(result);
    if (version.active && result.dense_chunks !== null) {
      const docstore = await readDocstore(path.join(versionPath, 'docstore.json'));
      if (docstore !== null) {
        mergeCounts(args.denseChunksByKb, docstore.byKb);
      }
    }
  }
}

async function verifyVersionDir(
  modelId: string,
  version: string,
  active: boolean,
  versionPath: string,
  findings: IntegrityFinding[],
): Promise<IntegrityVersionReport> {
  const faissPath = path.join(versionPath, 'faiss.index');
  const docstorePath = path.join(versionPath, 'docstore.json');
  const manifestPath = path.join(versionPath, INDEX_INTEGRITY_MANIFEST_FILENAME);
  const report: IntegrityVersionReport = {
    version,
    active,
    path: versionPath,
    faiss_sha256: null,
    docstore_sha256: null,
    dense_chunks: null,
  };

  const manifest = await readIntegrityManifest(manifestPath, findings);
  if (manifest === null) {
    findings.push({
      severity: 'drift',
      code: 'INTEGRITY_MANIFEST_MISSING',
      path: manifestPath,
      detail: 'index version has no integrity manifest; rebuild or resave the index to persist cryptographic hashes',
    });
  } else if (manifest.model_id !== modelId) {
    findings.push({
      severity: 'corruption',
      code: 'INTEGRITY_MANIFEST_MODEL_MISMATCH',
      path: manifestPath,
      detail: `manifest model_id=${manifest.model_id} does not match selected model ${modelId}`,
    });
  }

  report.faiss_sha256 = await verifyHashedFile({
    label: 'faiss.index',
    filePath: faissPath,
    expected: manifest?.files['faiss.index'].sha256 ?? null,
    findings,
  });
  report.docstore_sha256 = await verifyHashedFile({
    label: 'docstore.json',
    filePath: docstorePath,
    expected: manifest?.files['docstore.json'].sha256 ?? null,
    findings,
  });

  const docstore = await readDocstore(docstorePath, findings);
  report.dense_chunks = docstore?.total ?? null;
  return report;
}

async function readIntegrityManifest(
  manifestPath: string,
  findings: IntegrityFinding[],
): Promise<IndexIntegrityManifest | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    findings.push({
      severity: 'corruption',
      code: 'INTEGRITY_MANIFEST_UNREADABLE',
      path: manifestPath,
      detail: (err as Error).message,
    });
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isIntegrityManifest(parsed)) {
      findings.push({
        severity: 'corruption',
        code: 'INTEGRITY_MANIFEST_MALFORMED',
        path: manifestPath,
        detail: 'manifest JSON does not match kb.index-integrity.v1',
      });
      return null;
    }
    return parsed;
  } catch (err) {
    findings.push({
      severity: 'corruption',
      code: 'INTEGRITY_MANIFEST_MALFORMED',
      path: manifestPath,
      detail: `manifest is not valid JSON: ${(err as Error).message}`,
    });
    return null;
  }
}

function isIntegrityManifest(value: unknown): value is IndexIntegrityManifest {
  if (!isRecord(value)) return false;
  const files = value.files;
  return (
    value.schema_version === INDEX_INTEGRITY_MANIFEST_SCHEMA_VERSION &&
    typeof value.written_at === 'string' &&
    typeof value.model_id === 'string' &&
    isRecord(files) &&
    isRecord(files['faiss.index']) &&
    typeof files['faiss.index'].sha256 === 'string' &&
    isSha256(files['faiss.index'].sha256) &&
    isRecord(files['docstore.json']) &&
    typeof files['docstore.json'].sha256 === 'string' &&
    isSha256(files['docstore.json'].sha256)
  );
}

async function verifyHashedFile(args: {
  label: string;
  filePath: string;
  expected: string | null;
  findings: IntegrityFinding[];
}): Promise<string | null> {
  let actual: string;
  try {
    actual = await calculateSHA256(args.filePath);
  } catch (err) {
    args.findings.push({
      severity: 'corruption',
      code: 'INDEX_FILE_MISSING',
      path: args.filePath,
      detail: `${args.label} could not be read: ${(err as Error).message}`,
    });
    return null;
  }
  if (args.expected !== null && actual !== args.expected) {
    args.findings.push({
      severity: 'corruption',
      code: 'INDEX_HASH_MISMATCH',
      path: args.filePath,
      detail: `${args.label} SHA-256 ${actual} does not match manifest ${args.expected}`,
    });
  }
  return actual;
}

async function readDocstore(
  docstorePath: string,
  findings?: IntegrityFinding[],
): Promise<ParsedDocstore | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(docstorePath, 'utf-8');
  } catch (err) {
    findings?.push({
      severity: 'corruption',
      code: 'DOCSTORE_UNREADABLE',
      path: docstorePath,
      detail: (err as Error).message,
    });
    return null;
  }
  try {
    return parseDocstore(JSON.parse(raw));
  } catch (err) {
    findings?.push({
      severity: 'corruption',
      code: 'DOCSTORE_MALFORMED',
      path: docstorePath,
      detail: (err as Error).message,
    });
    return null;
  }
}

function parseDocstore(value: unknown): ParsedDocstore {
  const byKb: Record<string, number> = {};
  if (Array.isArray(value)) {
    const entries = value.length === 2 && Array.isArray(value[0]) && isRecord(value[1])
      ? value[0]
      : value;
    for (const entry of entries) {
      const doc = Array.isArray(entry) ? entry[1] : entry;
      const kb = docKnowledgeBase(doc);
      if (kb !== null) byKb[kb] = (byKb[kb] ?? 0) + 1;
    }
    return { total: entries.length, byKb };
  }
  if (isRecord(value)) {
    const docs = isRecord(value._docs) ? Object.values(value._docs) : Object.values(value);
    for (const doc of docs) {
      const kb = docKnowledgeBase(doc);
      if (kb !== null) byKb[kb] = (byKb[kb] ?? 0) + 1;
    }
    return { total: docs.length, byKb };
  }
  throw new Error('docstore JSON must be an array or object');
}

function docKnowledgeBase(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const metadata = value.metadata;
  if (!isRecord(metadata)) return null;
  return typeof metadata.knowledgeBase === 'string' ? metadata.knowledgeBase : null;
}

async function verifyMetadataSidecar(
  modelId: string,
  modelPath: string,
  expectedTotal: number,
  findings: IntegrityFinding[],
): Promise<void> {
  const sidecarPath = path.join(modelPath, 'metadata-sidecar.jsonl');
  if (!(await pathExists(sidecarPath))) return;
  let raw: string;
  try {
    raw = await fsp.readFile(sidecarPath, 'utf-8');
  } catch (err) {
    findings.push({
      severity: 'corruption',
      code: 'METADATA_SIDECAR_UNREADABLE',
      path: sidecarPath,
      detail: (err as Error).message,
    });
    return;
  }
  const [headerLine] = raw.split(/\r?\n/);
  try {
    const header: unknown = JSON.parse(headerLine);
    if (!isRecord(header) || header.schema_version !== 'kb.metadata-sidecar.v1') return;
    if (header.model_id !== modelId) {
      findings.push({
        severity: 'corruption',
        code: 'METADATA_SIDECAR_MODEL_MISMATCH',
        path: sidecarPath,
        detail: `metadata sidecar model_id=${String(header.model_id)} does not match ${modelId}`,
      });
    }
    if (typeof header.total_chunks === 'number' && header.total_chunks !== expectedTotal) {
      findings.push({
        severity: 'drift',
        code: 'METADATA_SIDECAR_CHUNK_COUNT_MISMATCH',
        path: sidecarPath,
        detail: `metadata sidecar total_chunks=${header.total_chunks}, active docstore chunks=${expectedTotal}`,
      });
    }
  } catch (err) {
    findings.push({
      severity: 'corruption',
      code: 'METADATA_SIDECAR_MALFORMED',
      path: sidecarPath,
      detail: `metadata sidecar header is not valid JSON: ${(err as Error).message}`,
    });
  }
}

async function verifyLexicalCounts(
  lexicalChunksByKb: Record<string, number>,
  denseChunksByKb: Record<string, number>,
  findings: IntegrityFinding[],
): Promise<void> {
  const kbNames = await safeListKnowledgeBases();
  for (const kb of kbNames) {
    const indexPath = path.join(FAISS_INDEX_PATH, 'lexical', kb, 'index.json');
    let raw: string;
    try {
      raw = await fsp.readFile(indexPath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      findings.push({
        severity: 'corruption',
        code: 'LEXICAL_INDEX_UNREADABLE',
        path: indexPath,
        detail: (err as Error).message,
      });
      continue;
    }
    try {
      const count = countLexicalChunks(JSON.parse(raw));
      lexicalChunksByKb[kb] = count;
      const dense = denseChunksByKb[kb] ?? 0;
      if (dense !== count) {
        findings.push({
          severity: 'drift',
          code: 'LEXICAL_DENSE_CHUNK_COUNT_MISMATCH',
          path: indexPath,
          detail: `lexical chunks=${count}, dense docstore chunks=${dense} for KB ${kb}`,
        });
      }
    } catch (err) {
      findings.push({
        severity: 'corruption',
        code: 'LEXICAL_INDEX_MALFORMED',
        path: indexPath,
        detail: (err as Error).message,
      });
    }
  }
}

function countLexicalChunks(value: unknown): number {
  if (!isRecord(value) || !isRecord(value.files)) {
    throw new Error('lexical index is missing the files map');
  }
  let count = 0;
  for (const entry of Object.values(value.files)) {
    if (!isRecord(entry) || !Array.isArray(entry.chunks)) {
      throw new Error('lexical index contains a malformed file entry');
    }
    count += entry.chunks.length;
  }
  return count;
}

async function verifyKbSidecars(findings: IntegrityFinding[]): Promise<void> {
  const kbNames = await safeListKnowledgeBases();
  const enumerations = await enumerateIngestableKbFiles(
    KNOWLEDGE_BASES_ROOT_DIR,
    kbNames,
    {
      extraExtensions: INGEST_EXTRA_EXTENSIONS,
      excludePaths: INGEST_EXCLUDE_PATHS,
    },
  );

  for (const entry of enumerations) {
    const expectedSidecars = new Set<string>();
    for (const filePath of entry.filePaths) {
      const relativePath = path.relative(entry.kbPath, filePath);
      const sidecarPath = path.join(
        entry.kbPath,
        '.index',
        path.dirname(relativePath),
        path.basename(filePath),
      );
      const chunkManifestPath = `${sidecarPath}.chunks.json`;
      expectedSidecars.add(path.resolve(sidecarPath));
      expectedSidecars.add(path.resolve(chunkManifestPath));
      await verifyHashSidecar(filePath, sidecarPath, findings);
      await verifyChunkManifest(filePath, chunkManifestPath, findings);
    }
    await verifyOrphanSidecars(entry.kbPath, expectedSidecars, findings);
  }
}

async function verifyHashSidecar(
  sourcePath: string,
  sidecarPath: string,
  findings: IntegrityFinding[],
): Promise<void> {
  let expected: string;
  try {
    expected = (await fsp.readFile(sidecarPath, 'utf-8')).trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    findings.push({
      severity: 'drift',
      code: 'CONTENT_HASH_SIDECAR_MISSING',
      path: sidecarPath,
      detail: code === 'ENOENT' || code === 'ENOTDIR'
        ? `missing content-hash sidecar for ${sourcePath}`
        : (err as Error).message,
    });
    return;
  }
  if (!isSha256(expected)) {
    findings.push({
      severity: 'corruption',
      code: 'CONTENT_HASH_SIDECAR_MALFORMED',
      path: sidecarPath,
      detail: 'content-hash sidecar does not contain a SHA-256 hex digest',
    });
    return;
  }
  const actual = await calculateSHA256(sourcePath);
  if (actual !== expected) {
    findings.push({
      severity: 'drift',
      code: 'CONTENT_HASH_MISMATCH',
      path: sidecarPath,
      detail: `source SHA-256 ${actual} does not match sidecar ${expected}`,
    });
  }
}

async function verifyChunkManifest(
  sourcePath: string,
  manifestPath: string,
  findings: IntegrityFinding[],
): Promise<void> {
  const exists = await pathExists(manifestPath);
  const manifest = await readChunkManifest(manifestPath);
  if (manifest === null) {
    findings.push({
      severity: exists ? 'corruption' : 'drift',
      code: exists ? 'CHUNK_MANIFEST_MALFORMED' : 'CHUNK_MANIFEST_MISSING',
      path: manifestPath,
      detail: exists
        ? 'chunk manifest does not match kb.chunk-manifest.v1'
        : `missing chunk manifest for ${sourcePath}`,
    });
    return;
  }
  const actual = await calculateSHA256(sourcePath);
  if (manifest.source_sha256 !== actual) {
    findings.push({
      severity: 'drift',
      code: 'CHUNK_MANIFEST_SOURCE_HASH_MISMATCH',
      path: manifestPath,
      detail: `manifest source_sha256=${manifest.source_sha256}, source SHA-256=${actual}`,
    });
  }
}

async function verifyOrphanSidecars(
  kbPath: string,
  expected: Set<string>,
  findings: IntegrityFinding[],
): Promise<void> {
  const indexDir = path.join(kbPath, '.index');
  if (!(await pathExists(indexDir))) return;
  const files = await listFiles(indexDir);
  for (const filePath of files) {
    if (expected.has(path.resolve(filePath))) continue;
    if (KNOWN_INDEX_LEDGER_FILES.has(path.basename(filePath))) continue;
    findings.push({
      severity: 'drift',
      code: 'ORPHAN_SIDECAR',
      path: filePath,
      detail: 'sidecar does not correspond to a currently ingestable source file',
    });
  }
}

async function verifyRetentionDrift(
  modelId: string | null,
  findings: IntegrityFinding[],
): Promise<void> {
  if (modelId === null) return;
  const modelPath = modelDir(modelId);
  let active: string | null = null;
  try {
    active = await fsp.readlink(path.join(modelPath, 'index'));
  } catch {
    return;
  }
  const entries = await fsp.readdir(modelPath).catch(() => []);
  const versions = entries
    .filter((entry) => parseIndexVersionDirName(entry) !== null)
    .sort((a, b) => (parseIndexVersionDirName(b) ?? 0) - (parseIndexVersionDirName(a) ?? 0));
  const kept = new Set<string>([active]);
  for (const version of versions) {
    if (version === active) continue;
    if (kept.size >= resolveIndexVersionRetention() + 1) break;
    kept.add(version);
  }
  for (const version of versions) {
    if (kept.has(version)) continue;
    findings.push({
      severity: 'drift',
      code: 'ORPHAN_INDEX_VERSION',
      path: path.join(modelPath, version),
      detail: `index version is outside KB_INDEX_VERSION_RETENTION=${resolveIndexVersionRetention()}`,
    });
  }
}

async function verifyStaleSentinels(
  now: Date,
  findings: IntegrityFinding[],
): Promise<void> {
  await verifyStaleFile(path.join(FAISS_INDEX_PATH, REINDEX_RUN_FILENAME), 'STALE_REINDEX_RUN_SENTINEL', now, findings);
  const modelsDir = modelsRoot();
  let models: string[];
  try {
    models = await fsp.readdir(modelsDir);
  } catch {
    return;
  }
  for (const modelId of models) {
    await verifyStaleFile(path.join(modelsDir, modelId, '.adding'), 'STALE_ADDING_SENTINEL', now, findings);
  }
}

async function verifyStaleFile(
  filePath: string,
  code: string,
  now: Date,
  findings: IntegrityFinding[],
): Promise<void> {
  let st: import('fs').Stats;
  try {
    st = await fsp.stat(filePath);
  } catch (err) {
    const fsCode = (err as NodeJS.ErrnoException).code;
    if (fsCode === 'ENOENT' || fsCode === 'ENOTDIR') return;
    findings.push({
      severity: 'corruption',
      code: `${code}_UNREADABLE`,
      path: filePath,
      detail: (err as Error).message,
    });
    return;
  }
  const ageMs = now.getTime() - st.mtimeMs;
  if (ageMs > STALE_SENTINEL_MS) {
    findings.push({
      severity: 'drift',
      code,
      path: filePath,
      detail: `sentinel is older than ${Math.floor(STALE_SENTINEL_MS / 1000)}s`,
    });
  }
}

function summarizeIntegrityStatus(findings: readonly IntegrityFinding[]): IntegrityReport['status'] {
  if (findings.some((f) => f.severity === 'corruption')) return 'corruption';
  if (findings.some((f) => f.severity === 'drift')) return 'drift';
  return 'clean';
}

export function integrityExitCode(report: IntegrityReport): number {
  if (report.status === 'clean') return 0;
  if (report.status === 'drift') return 1;
  return 2;
}

export function formatIntegrityMarkdown(report: IntegrityReport): string {
  const lines: string[] = [];
  lines.push(`Status: ${report.status.toUpperCase()}`);
  lines.push(`Model: ${report.model_id ?? '<unresolved>'}`);
  lines.push(`FAISS root: ${report.faiss_root}`);
  lines.push(`Knowledge-base root: ${report.knowledge_base_root}`);
  lines.push('');
  lines.push('Checked versions:');
  if (report.checked_versions.length === 0) {
    lines.push('  (none)');
  } else {
    for (const version of report.checked_versions) {
      lines.push(
        `  ${version.active ? '*' : '-'} ${version.version}: ` +
          `${version.dense_chunks ?? '?'} dense chunk(s), ` +
          `faiss_sha=${shortSha(version.faiss_sha256)}, docstore_sha=${shortSha(version.docstore_sha256)}`,
      );
    }
  }
  lines.push('');
  lines.push('Findings:');
  if (report.findings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const finding of report.findings) {
      lines.push(
        `  ${finding.severity.toUpperCase()} ${finding.code}: ` +
          `${finding.path ?? '<none>'} - ${finding.detail}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function shortSha(value: string | null): string {
  return value === null ? '<missing>' : value.slice(0, 12);
}

function denseTotal(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

async function safeListKnowledgeBases(): Promise<string[]> {
  try {
    return await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  } catch {
    return [];
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw err;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) out.push(child);
    }
  }
  await walk(root);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
