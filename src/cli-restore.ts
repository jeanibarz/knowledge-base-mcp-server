// `kb restore` — validate a backup, stage it, then atomically swap the index symlink.

import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  manifestFileRel,
  manifestVersionRel,
  modelRootArtifacts,
  readActiveIndexTarget,
  validateBackupDirectory,
  type BackupManifest,
} from './cli-backup.js';

const PENDING_SIDECAR_COMMIT_FILENAME = 'pending-manifest.json';

export const RESTORE_HELP = `kb restore — restore a checksum-validated index directory snapshot

Usage:
  kb restore --from=<dir>

Validates backup-manifest.json and every listed SHA-256 checksum before
touching the live model store. Restore then stages the active version from the
backup, creates a new index.vN directory, and atomically swaps the model's
index symlink. V1 is an offline/local restore path: stop kb serve and other
long-running readers before restoring.

Options:
  --from=<dir>   Backup directory created by kb backup. It must be outside
                 $FAISS_INDEX_PATH.
  --help, -h     Show this help.

Exit codes:
  0   restore applied
  1   validation or filesystem error
  2   invalid arguments
`;

export interface RestoreArgs {
  fromDir: string;
}

export interface RestoreResult {
  modelId: string;
  restoredVersion: string;
  backupVersion: string;
}

export async function runRestore(rest: string[]): Promise<number> {
  let args: RestoreArgs;
  try {
    args = parseRestoreArgs(rest);
  } catch (err) {
    process.stderr.write(`kb restore: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    const result = await restoreBackup(args);
    process.stdout.write(
      `Restore applied for ${result.modelId}: ${result.backupVersion} -> ${result.restoredVersion}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`kb restore: ${(err as Error).message}\n`);
    return 1;
  }
}

export function parseRestoreArgs(rest: readonly string[]): RestoreArgs {
  const out: RestoreArgs = { fromDir: '' };
  for (const raw of rest) {
    if (raw.startsWith('--from=')) {
      const value = raw.slice('--from='.length).trim();
      if (value.length === 0) throw new Error('empty --from value');
      out.fromDir = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  if (out.fromDir === '') throw new Error('--from=<dir> is required');
  return out;
}

export async function restoreBackup(args: RestoreArgs): Promise<RestoreResult> {
  const { FAISS_INDEX_PATH } = await import('./config/paths.js');
  const { modelDir } = await import('./active-model.js');
  const { withWriteLock } = await import('./write-lock.js');
  const fromDir = path.resolve(args.fromDir);
  assertSafeRestoreSource(fromDir, FAISS_INDEX_PATH);

  // Validation before touching live state catches checksum mismatch and
  // partial backups without creating lock directories or staging files.
  const manifest = await validateBackupDirectory(fromDir);
  const modelDirPath = modelDir(manifest.model_id);
  const tempRoot = path.join(modelDirPath, `.restore.tmp.${process.pid}.${Date.now()}`);
  let finalVersionDir: string | null = null;
  let swapped = false;

  try {
    return await withWriteLock(modelDirPath, async () => {
      await assertSafeLiveDestination(manifest.model_id);
      await copyManifestFilesToStaging(fromDir, tempRoot, manifest);
      await verifyStagedFiles(tempRoot, manifest);

      const restoredVersion = await nextAvailableIndexVersion(modelDirPath);
      finalVersionDir = path.join(modelDirPath, restoredVersion);
      const stagedVersion = path.join(
        tempRoot,
        ...manifestVersionRel(manifest.model_id, manifest.active_version).split('/'),
      );
      await fsp.rename(stagedVersion, finalVersionDir);

      await replaceModelRootArtifacts(tempRoot, modelDirPath, manifest);
      await fsp.rm(path.join(modelDirPath, PENDING_SIDECAR_COMMIT_FILENAME), { force: true });
      await swapActiveIndexSymlink(modelDirPath, restoredVersion);
      swapped = true;

      return {
        modelId: manifest.model_id,
        restoredVersion,
        backupVersion: manifest.active_version,
      };
    });
  } catch (err) {
    if (finalVersionDir !== null && !swapped) {
      await fsp.rm(finalVersionDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function assertSafeRestoreSource(fromDir: string, faissIndexPath: string): void {
  const faissRoot = path.resolve(faissIndexPath);
  if (fromDir === faissRoot || fromDir.startsWith(`${faissRoot}${path.sep}`)) {
    throw new Error(`unsafe restore source: --from must be outside $FAISS_INDEX_PATH (${faissRoot})`);
  }
}

async function assertSafeLiveDestination(modelId: string): Promise<void> {
  const { addingSentinelPath, modelDir } = await import('./active-model.js');
  if (await pathExists(addingSentinelPath(modelId))) {
    throw new Error(`unsafe restore destination: model ${modelId} has an .adding sentinel`);
  }
  const symlinkPath = path.join(modelDir(modelId), 'index');
  try {
    await fsp.lstat(symlinkPath);
    await readActiveIndexTarget(modelDir(modelId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function copyManifestFilesToStaging(
  fromDir: string,
  tempRoot: string,
  manifest: BackupManifest,
): Promise<void> {
  await fsp.rm(tempRoot, { recursive: true, force: true });
  await fsp.mkdir(tempRoot, { recursive: true });
  for (const file of manifest.files) {
    const source = path.join(fromDir, ...file.path.split('/'));
    const destination = path.join(tempRoot, ...file.path.split('/'));
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(source, destination);
  }
}

async function verifyStagedFiles(tempRoot: string, manifest: BackupManifest): Promise<void> {
  for (const file of manifest.files) {
    const staged = path.join(tempRoot, ...file.path.split('/'));
    const actual = await calculateSHA256(staged);
    if (actual !== file.sha256) {
      throw new Error(`checksum validation failed while staging ${file.path}: SHA-256 ${actual} does not match manifest ${file.sha256}`);
    }
  }
}

async function replaceModelRootArtifacts(
  tempRoot: string,
  modelDirPath: string,
  manifest: BackupManifest,
): Promise<void> {
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  for (const name of modelRootArtifacts()) {
    const rel = manifestFileRel(manifest.model_id, name);
    const target = path.join(modelDirPath, name);
    if (!manifestPaths.has(rel)) {
      if (name !== 'model_name.txt') await fsp.rm(target, { force: true });
      continue;
    }
    const staged = path.join(tempRoot, ...rel.split('/'));
    await atomicReplaceFile(staged, target);
  }
}

async function atomicReplaceFile(source: string, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.restore.${process.pid}.${Date.now()}.tmp`;
  await fsp.copyFile(source, tmp);
  await fsp.rename(tmp, target);
}

async function swapActiveIndexSymlink(modelDirPath: string, targetVersion: string): Promise<void> {
  const tmpLink = path.join(modelDirPath, `.index.restore.${process.pid}.${Date.now()}.tmp`);
  await fsp.symlink(targetVersion, tmpLink, 'dir');
  await fsp.rename(tmpLink, path.join(modelDirPath, 'index'));
}

async function nextAvailableIndexVersion(modelDirPath: string): Promise<string> {
  let max = -1;
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(modelDirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  for (const entry of entries) {
    const parsed = parseIndexVersionDirName(entry);
    if (parsed !== null) max = Math.max(max, parsed);
  }
  return `index.v${max + 1}`;
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

function parseIndexVersionDirName(name: string): number | null {
  const match = /^index\.v(\d+)$/.exec(name);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}
