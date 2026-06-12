// `kb backup` — checksum-validated directory snapshots for one model index.

import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  addingSentinelPath,
  modelDir,
  resolveActiveModel,
} from './active-model.js';
import { FAISS_INDEX_PATH } from './config/paths.js';
import { INDEX_INTEGRITY_MANIFEST_FILENAME, parseIndexVersionDirName } from './faiss-store-layout.js';
import { FRESHNESS_MANIFEST_FILE } from './freshness-manifest.js';
import { METADATA_SIDECAR_FILENAME } from './metadata-sidecar.js';
import { PENDING_SIDECAR_COMMIT_FILENAME } from './pending-sidecar-commit.js';
import { calculateSHA256, pathExists } from './file-utils.js';
import { withWriteLock } from './write-lock.js';

export const BACKUP_MANIFEST_FILENAME = 'backup-manifest.json';
export const BACKUP_MANIFEST_SCHEMA_VERSION = 'kb.backup.v1';

export const BACKUP_HELP = `kb backup — create a checksum-validated index directory snapshot

Usage:
  kb backup --output=<dir> [--model=<model_id>]

Copies the selected model's active index.vN directory and model sidecars into
a new backup directory, then writes backup-manifest.json with SHA-256 checksums.
The backup command holds the model write lock during the snapshot.

Options:
  --output=<dir>      Destination directory. It must not already exist and
                      must be outside $FAISS_INDEX_PATH.
  --model=<model_id>  Snapshot a specific registered model. Defaults to the
                      active model resolution path.
  --help, -h          Show this help.

Exit codes:
  0   backup written
  1   runtime or filesystem error
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
  const outputDir = path.resolve(args.outputDir);
  await assertSafeNewOutputDir(outputDir);
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

async function assertSafeNewOutputDir(outputDir: string): Promise<void> {
  const faissRoot = path.resolve(FAISS_INDEX_PATH);
  if (pathsOverlap(outputDir, faissRoot)) {
    throw new Error(`unsafe backup destination: --output must be outside $FAISS_INDEX_PATH (${faissRoot})`);
  }
  if (await pathExists(outputDir)) {
    throw new Error('unsafe backup destination: --output directory already exists; choose a new directory');
  }
}

async function assertNoIncompleteModelState(modelId: string): Promise<void> {
  if (await pathExists(addingSentinelPath(modelId))) {
    throw new Error(`model ${modelId} is incomplete (.adding sentinel exists); refusing to snapshot it`);
  }
  if (await pathExists(path.join(modelDir(modelId), PENDING_SIDECAR_COMMIT_FILENAME))) {
    throw new Error(`model ${modelId} has a pending sidecar commit; run kb verify --integrity before backing it up`);
  }
}

async function assertRequiredModelFiles(modelId: string): Promise<void> {
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
