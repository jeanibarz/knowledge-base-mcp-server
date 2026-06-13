import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { KBError } from './errors.js';
import {
  KB_WRITE_POLICY_FILENAME,
  assertKbWritePolicyAllowsMutation,
  readKbWritePolicy,
} from './kb-write-policy.js';

describe('KB write policy', () => {
  async function makeKb(): Promise<{ tempDir: string; kbDir: string; targetPath: string }> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-write-policy-'));
    const kbDir = path.join(tempDir, 'alpha');
    const targetPath = path.join(kbDir, 'notes', 'a.md');
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, 'note\n', 'utf-8');
    return { tempDir, kbDir, targetPath };
  }

  it('defaults missing policy files to allow', async () => {
    const { tempDir, kbDir, targetPath } = await makeKb();
    try {
      await expect(readKbWritePolicy(kbDir)).resolves.toMatchObject({
        mutations: 'allow',
        present: false,
      });
      await expect(assertKbWritePolicyAllowsMutation(kbDir, targetPath)).resolves.toBeUndefined();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('denies mutations when the policy says deny', async () => {
    const { tempDir, kbDir, targetPath } = await makeKb();
    try {
      await fsp.writeFile(
        path.join(kbDir, KB_WRITE_POLICY_FILENAME),
        '{"mutations":"deny"}\n',
        'utf-8',
      );

      await expect(assertKbWritePolicyAllowsMutation(kbDir, targetPath)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed for invalid policy JSON with an actionable validation error', async () => {
    const { tempDir, kbDir, targetPath } = await makeKb();
    try {
      await fsp.writeFile(path.join(kbDir, KB_WRITE_POLICY_FILENAME), '{nope', 'utf-8');

      await expect(assertKbWritePolicyAllowsMutation(kbDir, targetPath)).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringContaining('writes are denied until the policy file is fixed or removed'),
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects extra keys so the carrier stays strict', async () => {
    const { tempDir, kbDir } = await makeKb();
    try {
      await fsp.writeFile(
        path.join(kbDir, KB_WRITE_POLICY_FILENAME),
        '{"mutations":"allow","other":true}\n',
        'utf-8',
      );

      await expect(readKbWritePolicy(kbDir)).rejects.toBeInstanceOf(KBError);
      await expect(readKbWritePolicy(kbDir)).rejects.toMatchObject({ code: 'VALIDATION' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('protects the policy file from managed mutation surfaces even when writes are allowed', async () => {
    const { tempDir, kbDir } = await makeKb();
    try {
      const policyPath = path.join(kbDir, KB_WRITE_POLICY_FILENAME);
      await fsp.writeFile(policyPath, '{"mutations":"allow"}\n', 'utf-8');

      await expect(assertKbWritePolicyAllowsMutation(kbDir, policyPath)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
        message: expect.stringContaining('cannot modify .kb-policy.json'),
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
