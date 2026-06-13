import * as fsp from 'fs/promises';
import * as path from 'path';
import { KBError } from './errors.js';

export const KB_WRITE_POLICY_FILENAME = '.kb-policy.json';

export type KbMutationPolicy = 'allow' | 'deny';

export interface KbWritePolicy {
  mutations: KbMutationPolicy;
  policyPath: string;
  present: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function policyShapeError(policyPath: string): KBError {
  return new KBError(
    'VALIDATION',
    `invalid KB write policy at ${policyPath}: expected JSON object with optional ` +
      `"mutations": "allow"|"deny"; writes are denied until the policy file is fixed or removed`,
  );
}

function isPolicyTarget(kbDir: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(kbDir), path.resolve(targetPath));
  return relative.split(path.sep).join('/') === KB_WRITE_POLICY_FILENAME;
}

export async function readKbWritePolicy(kbDir: string): Promise<KbWritePolicy> {
  const policyPath = path.join(kbDir, KB_WRITE_POLICY_FILENAME);
  let raw: string;
  try {
    raw = await fsp.readFile(policyPath, 'utf-8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { mutations: 'allow', policyPath, present: false };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw policyShapeError(policyPath);
  }

  if (!isPlainRecord(parsed)) {
    throw policyShapeError(policyPath);
  }

  const allowedKeys = new Set(['mutations']);
  if (Object.keys(parsed).some((key) => !allowedKeys.has(key))) {
    throw policyShapeError(policyPath);
  }

  const mutations = parsed.mutations ?? 'allow';
  if (mutations !== 'allow' && mutations !== 'deny') {
    throw policyShapeError(policyPath);
  }

  return { mutations, policyPath, present: true };
}

export async function assertKbWritePolicyAllowsMutation(
  kbDir: string,
  targetPath: string,
): Promise<void> {
  if (isPolicyTarget(kbDir, targetPath)) {
    throw new KBError(
      'PERMISSION_DENIED',
      `managed mutation surfaces cannot modify ${KB_WRITE_POLICY_FILENAME}; ` +
        'edit the policy file directly on disk',
    );
  }

  const policy = await readKbWritePolicy(kbDir);
  if (policy.mutations === 'deny') {
    throw new KBError(
      'PERMISSION_DENIED',
      `KB write policy denies mutations for this shelf (${KB_WRITE_POLICY_FILENAME} has ` +
        `"mutations": "deny"). Edit or remove the policy file directly on disk to allow writes.`,
    );
  }
}
