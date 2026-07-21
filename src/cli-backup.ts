// `kb backup` — checksum-validated directory snapshots for one model index.

import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { assertSufficientDiskSpace, directorySizeBytes } from './disk-preflight.js';

export const BACKUP_MANIFEST_FILENAME = 'backup-manifest.json';
export const BACKUP_MANIFEST_SCHEMA_VERSION = 'kb.backup.v1';
export const INDEX_INTEGRITY_MANIFEST_FILENAME = 'integrity.json';

const FRESHNESS_MANIFEST_FILE = 'freshness.json';
const METADATA_SIDECAR_FILENAME = 'metadata-sidecar.jsonl';
const PENDING_SIDECAR_COMMIT_FILENAME = 'pending-manifest.json';

/**
 * Multiplier on the active-version footprint for backup preflight (#908).
 * The snapshot is written to a sibling tmp dir then renamed into place;
 * factor ≥1 covers the full copy plus small manifest overhead.
 */
export const BACKUP_DISK_ESTIMATE_FACTOR = 1.5;

export const BACKUP_HELP = `kb backup — create a checksum-validated index directory snapshot

Usage:
  kb backup --output=<dir> [--model=<model_id>]

Copies the selected model's active index.vN directory and model sidecars into
a new backup directory, then writes backup-manifest.json with SHA-256 checksums.
The backup command holds the model write lock during the snapshot.

Disk-space preflight (#908): refuses with INSUFFICIENT_DISK_SPACE before any
snapshot copy when the output volume cannot hold ~1.5× the active version
footprint plus the KB_MIN_FREE_DISK_BYTES margin (default 512 MiB).

Options:
  --output=<dir>      Destination directory. It must not already exist and
                      must be outside $FAISS_INDEX_PATH.
  --model=<model_id>  Snapshot a specific registered model. Defaults to the
                      active model resolution path.
  --help, -h          Show this help.

Exit codes:
  0   backup written
  1   runtime, disk-space preflight, or filesystem error
  2   invalid arguments
`;

const MODEL_ROOT_ARTIFACTS = [
  'model_name.txt',
  'index-type.txt',
  'last-index-update.json',
  FRESHNESS_MANIFEST_FILE,
  METADATA_SIDECAR_FILENAME,
] as const;

export interface BackupManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BackupManifest {
  schema_version: typeof BACKUP_MANIFEST_SCHEMA_VERSION;
  created_at: string;
  source_faiss_root: string;
  model_id: string;
  active_version: string;
  files: BackupManifestFile[];
}

export interface BackupArgs {
  outputDir: string;
  modelId: string | null;
}

export interface BackupResult {
  outputDir: string;
  manifest: BackupManifest;
}

export async function runBackup(rest: string[]): Promise<number> {
  let args: BackupArgs;
  try {
    args = parseBackupArgs(rest);
  } catch (err) {
    process.stderr.write(`kb backup: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    const result = await createBackup(args);
    process.stdout.write(
      `Backup written to ${result.outputDir} (${result.manifest.model_id} ${result.manifest.active_version}, ${result.manifest.files.length} files)\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`kb backup: ${(err as Error).message}\n`);
    return 1;
  }
}

export function parseBackupArgs(rest: readonly string[]): BackupArgs {
  const out: BackupArgs = { outputDir: '', modelId: null };
  for (const raw of rest) {
    if (raw.startsWith('--output=')) {
      const value = raw.slice('--output='.length).trim();
      if (value.length === 0) throw new Error('empty --output value');
      out.outputDir = value;
      continue;
    }
    if (raw.startsWith('--model=')) {
      const value = raw.slice('--model='.length).trim();
      if (value.length === 0) throw new Error('empty --model value');
      out.modelId = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  if (out.outputDir === '') throw new Error('--output=<dir> is required');
  return out;
}

export async function createBackup(args: BackupArgs): Promise<BackupResult> {
  const { FAISS_INDEX_PATH } = await import('./config/paths.js');
  const { modelDir, resolveActiveModel } = await import('./active-model.js');
  const { withWriteLock } = await import('./write-lock.js');
  const outputDir = path.resolve(args.outputDir);
  await assertSafeNewOutputDir(outputDir, FAISS_INDEX_PATH);
  const parent = path.dirname(outputDir);
  await fsp.mkdir(parent, { recursive: true });
  const tmpDir = path.join(parent, `.${path.basename(outputDir)}.tmp.${process.pid}.${Date.now()}`);

  const modelId = args.modelId ?? await resolveActiveModel();
  const modelDirPath = modelDir(modelId);
  let manifest: BackupManifest | null = null;

  try {
    await withWriteLock(modelDirPath, async () => {
      await assertNoIncompleteModelState(modelId);
      await assertRequiredModelFiles(modelId);
      const activeVersion = await readActiveIndexTarget(modelDirPath);
      const versionDir = path.join(modelDirPath, activeVersion);
      await assertRequiredIndexFiles(versionDir);

      // #908 — disk-space preflight. Backup copies the active version and
      // model-root sidecars into a sibling tmp dir before rename; refuse
      // before mkdir/copy when the output volume cannot hold source
      // footprint × factor plus the margin. Free space is checked on the
      // output parent (same FS as the eventual snapshot).
      const sourceBytes = await estimateBackupSourceBytes(modelDirPath, versionDir);
      await assertSufficientDiskSpace(parent, {
        currentBytes: sourceBytes,
        estimateFactor: BACKUP_DISK_ESTIMATE_FACTOR,
        operation: 'backup',
      });

      await fsp.mkdir(tmpDir, { recursive: true });
      const modelRel = path.posix.join('models', modelId);
      await copyPath(versionDir, path.join(tmpDir, ...modelRel.split('/'), activeVersion));
      for (const name of MODEL_ROOT_ARTIFACTS) {
        const source = path.join(modelDirPath, name);
        if (await pathExists(source)) {
          await copyPath(source, path.join(tmpDir, ...modelRel.split('/'), name));
        }
      }

      const files = await checksumFiles(tmpDir);
      manifest = {
        schema_version: BACKUP_MANIFEST_SCHEMA_VERSION,
        created_at: new Date().toISOString(),
        source_faiss_root: FAISS_INDEX_PATH,
        model_id: modelId,
        active_version: activeVersion,
        files,
      };
      await fsp.writeFile(
        path.join(tmpDir, BACKUP_MANIFEST_FILENAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: 'utf-8', mode: 0o600 },
      );
    });
    await fsp.rename(tmpDir, outputDir);
  } catch (err) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  if (manifest === null) throw new Error('backup manifest was not created');
  return { outputDir, manifest };
}

export async function readBackupManifest(backupDir: string): Promise<BackupManifest> {
  const manifestPath = path.join(backupDir, BACKUP_MANIFEST_FILENAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'));
  } catch (err) {
    throw new Error(`backup manifest is missing or unreadable: ${(err as Error).message}`);
  }
  if (!isBackupManifest(parsed)) {
    throw new Error('backup manifest JSON does not match kb.backup.v1');
  }
  assertManifestFilePathsAreSafe(parsed);
  return parsed;
}

export async function validateBackupDirectory(backupDir: string): Promise<BackupManifest> {
  const manifest = await readBackupManifest(backupDir);
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) throw new Error(`backup manifest contains duplicate file path ${file.path}`);
    seen.add(file.path);
    const filePath = path.join(backupDir, ...file.path.split('/'));
    let st;
    try {
      st = await fsp.stat(filePath);
    } catch (err) {
      throw new Error(`partial backup: listed file is missing: ${file.path} (${(err as Error).message})`);
    }
    if (!st.isFile()) throw new Error(`partial backup: listed path is not a file: ${file.path}`);
    if (st.size !== file.bytes) {
      throw new Error(`checksum validation failed for ${file.path}: size ${st.size} does not match manifest ${file.bytes}`);
    }
    const actual = await calculateSHA256(filePath);
    if (actual !== file.sha256) {
      throw new Error(`checksum validation failed for ${file.path}: SHA-256 ${actual} does not match manifest ${file.sha256}`);
    }
  }
  assertRequiredBackupFiles(manifest);
  return manifest;
}

export function modelRootArtifacts(): readonly string[] {
  return MODEL_ROOT_ARTIFACTS;
}

export function manifestFileRel(modelId: string, name: string): string {
  return path.posix.join('models', modelId, name);
}

export function manifestVersionRel(modelId: string, version: string): string {
  return path.posix.join('models', modelId, version);
}

async function assertSafeNewOutputDir(outputDir: string, faissIndexPath: string): Promise<void> {
  const faissRoot = path.resolve(faissIndexPath);
  if (pathsOverlap(outputDir, faissRoot)) {
    throw new Error(`unsafe backup destination: --output must be outside $FAISS_INDEX_PATH (${faissRoot})`);
  }
  if (await pathExists(outputDir)) {
    throw new Error('unsafe backup destination: --output directory already exists; choose a new directory');
  }
}

/**
 * On-disk footprint of the files `createBackup` will copy: the active
 * index.vN tree plus any present model-root sidecars. Best-effort; missing
 * optional sidecars contribute 0.
 */
async function estimateBackupSourceBytes(modelDirPath: string, versionDir: string): Promise<number> {
  let total = await directorySizeBytes(versionDir);
  for (const name of MODEL_ROOT_ARTIFACTS) {
    try {
      const st = await fsp.stat(path.join(modelDirPath, name));
      if (st.isFile()) total += st.size;
    } catch {
      // optional / missing — not required for the estimate
    }
  }
  return total;
}

async function assertNoIncompleteModelState(modelId: string): Promise<void> {
  const { addingSentinelPath, modelDir } = await import('./active-model.js');
  if (await pathExists(addingSentinelPath(modelId))) {
    throw new Error(`model ${modelId} is incomplete (.adding sentinel exists); refusing to snapshot it`);
  }
  if (await pathExists(path.join(modelDir(modelId), PENDING_SIDECAR_COMMIT_FILENAME))) {
    throw new Error(`model ${modelId} has a pending sidecar commit; run kb verify --integrity before backing it up`);
  }
}

async function assertRequiredModelFiles(modelId: string): Promise<void> {
  const { modelDir } = await import('./active-model.js');
  const filePath = path.join(modelDir(modelId), 'model_name.txt');
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) throw new Error(`${filePath} is not a file`);
  } catch (err) {
    throw new Error(`model ${modelId} is not registered: model_name.txt is missing (${(err as Error).message})`);
  }
}

export async function readActiveIndexTarget(modelDirPath: string): Promise<string> {
  const symlinkPath = path.join(modelDirPath, 'index');
  let st;
  try {
    st = await fsp.lstat(symlinkPath);
  } catch (err) {
    throw new Error(`active index symlink is missing: ${(err as Error).message}`);
  }
  if (!st.isSymbolicLink()) {
    throw new Error(`unsafe model store: ${symlinkPath} is not a symlink`);
  }
  const target = await fsp.readlink(symlinkPath);
  if (parseIndexVersionDirName(target) === null) {
    throw new Error(`unsafe model store: active index symlink target ${JSON.stringify(target)} is not index.vN`);
  }
  return target;
}

async function assertRequiredIndexFiles(versionDir: string): Promise<void> {
  for (const name of ['faiss.index', 'docstore.json', INDEX_INTEGRITY_MANIFEST_FILENAME]) {
    const filePath = path.join(versionDir, name);
    try {
      const st = await fsp.stat(filePath);
      if (!st.isFile()) throw new Error(`${filePath} is not a file`);
    } catch (err) {
      throw new Error(`active index is incomplete: ${name} is missing from ${versionDir}: ${(err as Error).message}`);
    }
  }
}

async function copyPath(source: string, destination: string): Promise<void> {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    dereference: true,
  });
}

async function checksumFiles(root: string): Promise<BackupManifestFile[]> {
  const files: BackupManifestFile[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, child).split(path.sep).join('/');
      if (rel === BACKUP_MANIFEST_FILENAME) continue;
      const st = await fsp.stat(child);
      files.push({
        path: rel,
        sha256: await calculateSHA256(child),
        bytes: st.size,
      });
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function assertRequiredBackupFiles(manifest: BackupManifest): void {
  const paths = new Set(manifest.files.map((file) => file.path));
  const versionRel = manifestVersionRel(manifest.model_id, manifest.active_version);
  for (const rel of [
    manifestFileRel(manifest.model_id, 'model_name.txt'),
    path.posix.join(versionRel, 'faiss.index'),
    path.posix.join(versionRel, 'docstore.json'),
    path.posix.join(versionRel, INDEX_INTEGRITY_MANIFEST_FILENAME),
  ]) {
    if (!paths.has(rel)) throw new Error(`partial backup: required file is missing from manifest: ${rel}`);
  }
}

function assertManifestFilePathsAreSafe(manifest: BackupManifest): void {
  for (const file of manifest.files) {
    if (path.isAbsolute(file.path)) throw new Error(`unsafe backup manifest path: ${file.path}`);
    const parts = file.path.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error(`unsafe backup manifest path: ${file.path}`);
    }
  }
}

function isBackupManifest(value: unknown): value is BackupManifest {
  if (!isRecord(value)) return false;
  return (
    value.schema_version === BACKUP_MANIFEST_SCHEMA_VERSION &&
    typeof value.created_at === 'string' &&
    typeof value.source_faiss_root === 'string' &&
    typeof value.model_id === 'string' &&
    typeof value.active_version === 'string' &&
    parseIndexVersionDirName(value.active_version) !== null &&
    Array.isArray(value.files) &&
    value.files.every(isBackupManifestFile)
  );
}

function isBackupManifestFile(value: unknown): value is BackupManifestFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === 'string' &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathsOverlap(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

async function calculateSHA256(filePath: string): Promise<string> {
  const fileBuffer = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

function parseIndexVersionDirName(name: unknown): number | null {
  if (typeof name !== 'string') return null;
  const match = /^index\.v(\d+)$/.exec(name);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}
