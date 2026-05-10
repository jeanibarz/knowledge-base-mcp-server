import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  auditEnabled,
  auditLogPath,
  recordMutation,
  sha256OfFileOrNull,
  type MutationRecord,
} from './audit-log.js';

const ENV_VAR = 'KB_MUTATION_AUDIT_LOG';

async function readJsonLines(file: string): Promise<MutationRecord[]> {
  const text = await fsp.readFile(file, 'utf-8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as MutationRecord);
}

describe('audit-log', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-audit-test-'));
    originalEnv = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = originalEnv;
    }
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  describe('auditEnabled / auditLogPath', () => {
    it('returns null / false when KB_MUTATION_AUDIT_LOG is unset', () => {
      expect(auditLogPath()).toBeNull();
      expect(auditEnabled()).toBe(false);
    });

    it('returns the configured path when env is set', () => {
      process.env[ENV_VAR] = path.join(tmpDir, 'audit.jsonl');
      expect(auditLogPath()).toBe(path.join(tmpDir, 'audit.jsonl'));
      expect(auditEnabled()).toBe(true);
    });

    it('treats a whitespace-only env value as unset', () => {
      process.env[ENV_VAR] = '   ';
      expect(auditLogPath()).toBeNull();
      expect(auditEnabled()).toBe(false);
    });
  });

  describe('sha256OfFileOrNull', () => {
    it('returns null for a missing file', async () => {
      const result = await sha256OfFileOrNull(path.join(tmpDir, 'missing.md'));
      expect(result).toBeNull();
    });

    it('returns null for a directory (read error swallowed)', async () => {
      const result = await sha256OfFileOrNull(tmpDir);
      expect(result).toBeNull();
    });

    it('returns hex digest matching a known constant', async () => {
      const file = path.join(tmpDir, 'hello.txt');
      await fsp.writeFile(file, 'hello\n');
      const hash = await sha256OfFileOrNull(file);
      // sha256("hello\n") = 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03
      expect(hash).toBe('5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03');
    });
  });

  describe('recordMutation', () => {
    it('is a no-op when audit is disabled', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      // Env var is unset by beforeEach.
      await recordMutation({
        surface: 'cli.kb-remember',
        operation: 'create',
        kb: 'work',
        relative_path: 'a.md',
        before_sha256: null,
        after_sha256: 'abc',
        write_performed: true,
        refresh_requested: false,
        refresh_status: null,
        decision_flags: {},
      });
      await expect(fsp.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('appends one JSONL line per successful call with required fields', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;

      await recordMutation({
        surface: 'cli.kb-remember',
        operation: 'create',
        kb: 'work',
        relative_path: 'notes/foo.md',
        before_sha256: null,
        after_sha256: 'deadbeef',
        write_performed: true,
        refresh_requested: false,
        refresh_status: null,
        decision_flags: { force: false, lesson: false },
      });
      await recordMutation({
        surface: 'mcp.add_document',
        operation: 'add',
        kb: 'work',
        relative_path: 'notes/bar.md',
        before_sha256: null,
        after_sha256: 'cafe',
        write_performed: true,
        refresh_requested: true,
        refresh_status: 'ok',
        decision_flags: { content_bytes: 42 },
      });

      const records = await readJsonLines(target);
      expect(records).toHaveLength(2);

      const [first, second] = records;
      expect(first.event).toBe('kb.mutation');
      expect(first.surface).toBe('cli.kb-remember');
      expect(first.operation).toBe('create');
      expect(first.kb).toBe('work');
      expect(first.relative_path).toBe('notes/foo.md');
      expect(first.write_performed).toBe(true);
      expect(first.refresh_requested).toBe(false);
      expect(first.refresh_status).toBeNull();
      expect(first.decision_flags).toEqual({ force: false, lesson: false });
      expect(typeof first.timestamp).toBe('string');
      expect(new Date(first.timestamp).toString()).not.toBe('Invalid Date');

      expect(second.surface).toBe('mcp.add_document');
      expect(second.operation).toBe('add');
      expect(second.decision_flags).toEqual({ content_bytes: 42 });
    });

    it('records a failure with an error field when write_performed is false', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;

      await recordMutation({
        surface: 'cli.kb-remember',
        operation: 'append',
        kb: 'work',
        relative_path: 'missing.md',
        before_sha256: null,
        after_sha256: null,
        write_performed: false,
        refresh_requested: false,
        refresh_status: null,
        decision_flags: {},
        error: 'ENOENT: no such file or directory',
      });

      const records = await readJsonLines(target);
      expect(records).toHaveLength(1);
      expect(records[0].write_performed).toBe(false);
      expect(records[0].error).toBe('ENOENT: no such file or directory');
    });

    it('records a failed refresh after a successful write', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;

      await recordMutation({
        surface: 'cli.kb-remember',
        operation: 'append',
        kb: 'work',
        relative_path: 'note.md',
        before_sha256: 'aaaa',
        after_sha256: 'bbbb',
        write_performed: true,
        refresh_requested: true,
        refresh_status: 'failed',
        decision_flags: {},
        error: 'index load failed',
      });

      const records = await readJsonLines(target);
      expect(records[0].write_performed).toBe(true);
      expect(records[0].refresh_status).toBe('failed');
      expect(records[0].error).toBe('index load failed');
    });

    it('creates parent directories for the audit log on first write', async () => {
      const target = path.join(tmpDir, 'nested', 'deep', 'audit.jsonl');
      process.env[ENV_VAR] = target;

      await recordMutation({
        surface: 'cli.kb-capture',
        operation: 'capture',
        kb: 'work',
        relative_path: 'log.md',
        before_sha256: 'aaaa',
        after_sha256: 'bbbb',
        write_performed: true,
        refresh_requested: false,
        refresh_status: null,
        decision_flags: {},
      });

      const records = await readJsonLines(target);
      expect(records).toHaveLength(1);
    });

    it('swallows write errors and never throws', async () => {
      // Point the audit log at a path whose parent is a regular file —
      // mkdir -p will fail with ENOTDIR. recordMutation must catch it.
      const blocker = path.join(tmpDir, 'blocker');
      await fsp.writeFile(blocker, 'i am not a directory');
      process.env[ENV_VAR] = path.join(blocker, 'audit.jsonl');

      await expect(recordMutation({
        surface: 'cli.kb-remember',
        operation: 'create',
        kb: 'work',
        relative_path: 'x.md',
        before_sha256: null,
        after_sha256: 'a',
        write_performed: true,
        refresh_requested: false,
        refresh_status: null,
        decision_flags: {},
      })).resolves.toBeUndefined();
    });
  });
});
