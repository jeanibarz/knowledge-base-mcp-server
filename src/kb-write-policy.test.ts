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
        message: expect.stringMatching(
          /denies mutations for this shelf.*"mutations": "deny"/s,
        ),
      });
      await expect(readKbWritePolicy(kbDir)).resolves.toMatchObject({
        mutations: 'deny',
        present: true,
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('propagates read errors other than a missing file instead of defaulting to allow', async () => {
    // Only ENOENT/ENOTDIR (a genuinely absent policy) may fall back to allow.
    // Any other read failure must propagate so a transient/permission error
    // is never silently treated as a policy-free (allow) shelf.
    const { tempDir, kbDir } = await makeKb();
    try {
      // Make the policy path a directory so reading it fails with EISDIR.
      await fsp.mkdir(path.join(kbDir, KB_WRITE_POLICY_FILENAME), { recursive: true });

      await expect(readKbWritePolicy(kbDir)).rejects.toMatchObject({ code: 'EISDIR' });
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

  it('reads an explicit allow policy as present and permits mutations', async () => {
    const { tempDir, kbDir, targetPath } = await makeKb();
    try {
      await fsp.writeFile(
        path.join(kbDir, KB_WRITE_POLICY_FILENAME),
        '{"mutations":"allow"}\n',
        'utf-8',
      );

      await expect(readKbWritePolicy(kbDir)).resolves.toMatchObject({
        mutations: 'allow',
        present: true,
      });
      await expect(assertKbWritePolicyAllowsMutation(kbDir, targetPath)).resolves.toBeUndefined();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('defaults an object without a mutations key to allow while marking it present', async () => {
    const { tempDir, kbDir, targetPath } = await makeKb();
    try {
      await fsp.writeFile(path.join(kbDir, KB_WRITE_POLICY_FILENAME), '{}\n', 'utf-8');

      await expect(readKbWritePolicy(kbDir)).resolves.toMatchObject({
        mutations: 'allow',
        present: true,
      });
      await expect(assertKbWritePolicyAllowsMutation(kbDir, targetPath)).resolves.toBeUndefined();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  // A parseable but out-of-enum `mutations` value must fail closed (deny by
  // rejecting the policy) rather than being coerced to allow.
  it.each([
    ['unknown string', '{"mutations":"maybe"}'],
    ['capitalized enum', '{"mutations":"Deny"}'],
    ['boolean true', '{"mutations":true}'],
    ['boolean false', '{"mutations":false}'],
    ['number', '{"mutations":1}'],
    ['empty string', '{"mutations":""}'],
  ])('rejects an invalid mutations value (%s)', async (_label, body) => {
    const { tempDir, kbDir } = await makeKb();
    try {
      await fsp.writeFile(path.join(kbDir, KB_WRITE_POLICY_FILENAME), body, 'utf-8');

      await expect(readKbWritePolicy(kbDir)).rejects.toMatchObject({ code: 'VALIDATION' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('treats an explicit null mutations value as the "allow" default', async () => {
    // `mutations` is read with `?? 'allow'`, so an explicit JSON null is
    // nullish and coerces to the allow default rather than being rejected.
    // Pinned here so a mutation to that operator is caught rather than masked.
    const { tempDir, kbDir } = await makeKb();
    try {
      await fsp.writeFile(
        path.join(kbDir, KB_WRITE_POLICY_FILENAME),
        '{"mutations":null}',
        'utf-8',
      );

      await expect(readKbWritePolicy(kbDir)).resolves.toMatchObject({
        mutations: 'allow',
        present: true,
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  // Well-formed JSON that is not a plain object is not a policy: it must fail
  // closed rather than be treated as an empty (allow) policy.
  it.each([
    ['array', '[]'],
    ['number', '42'],
    ['string', '"deny"'],
    ['null literal', 'null'],
    ['boolean', 'true'],
  ])('rejects non-object JSON (%s)', async (_label, body) => {
    const { tempDir, kbDir } = await makeKb();
    try {
      await fsp.writeFile(path.join(kbDir, KB_WRITE_POLICY_FILENAME), body, 'utf-8');

      await expect(readKbWritePolicy(kbDir)).rejects.toMatchObject({ code: 'VALIDATION' });
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
