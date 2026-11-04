import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_AUDIT_LOG_MAX_FILES,
  auditEnabled,
  auditLogMaxBytes,
  auditLogMaxFiles,
  auditLogPath,
  recordMutation,
  sha256OfFileOrNull,
  type MutationRecord,
} from './audit-log.js';

const ENV_VAR = 'KB_MUTATION_AUDIT_LOG';
const MAX_BYTES_VAR = 'KB_MUTATION_AUDIT_LOG_MAX_BYTES';
const MAX_FILES_VAR = 'KB_MUTATION_AUDIT_LOG_MAX_FILES';

const SAMPLE_RECORD = {
  surface: 'cli.kb-remember',
  operation: 'create',
  kb: 'work',
  relative_path: 'note.md',
  before_sha256: null,
  after_sha256: 'abc',
  write_performed: true,
  refresh_requested: false,
  refresh_status: null,
  decision_flags: {},
} as const;

async function readJsonLines(file: string): Promise<MutationRecord[]> {
  const text = await fsp.readFile(file, 'utf-8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as MutationRecord);
}

describe('audit-log', () => {
  let tmpDir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-audit-test-'));
    for (const name of [ENV_VAR, MAX_BYTES_VAR, MAX_FILES_VAR]) {
      originalEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(async () => {
    for (const name of [ENV_VAR, MAX_BYTES_VAR, MAX_FILES_VAR]) {
      if (originalEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalEnv[name];
      }
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

  describe('auditLogMaxBytes / auditLogMaxFiles', () => {
    it('returns undefined bytes and default files when both are unset', () => {
      expect(auditLogMaxBytes()).toBeUndefined();
      expect(auditLogMaxFiles()).toBe(DEFAULT_AUDIT_LOG_MAX_FILES);
    });

    it.each(['', '   ', '0', '-5', 'abc'])(
      'treats %p as rotation-disabled (undefined byte cap)',
      (value) => {
        process.env[MAX_BYTES_VAR] = value;
        expect(auditLogMaxBytes()).toBeUndefined();
      },
    );

    it('parses a positive byte cap and floors fractional values', () => {
      process.env[MAX_BYTES_VAR] = '1024';
      expect(auditLogMaxBytes()).toBe(1024);
      process.env[MAX_BYTES_VAR] = '1024.9';
      expect(auditLogMaxBytes()).toBe(1024);
    });

    it.each(['', '   ', '0', '-1', 'abc'])(
      'falls back to the default retained count for %p',
      (value) => {
        process.env[MAX_FILES_VAR] = value;
        expect(auditLogMaxFiles()).toBe(DEFAULT_AUDIT_LOG_MAX_FILES);
      },
    );

    it('parses a valid retained-generation count and floors it', () => {
      process.env[MAX_FILES_VAR] = '3';
      expect(auditLogMaxFiles()).toBe(3);
      process.env[MAX_FILES_VAR] = '2.9';
      expect(auditLogMaxFiles()).toBe(2);
    });
  });

  describe('recordMutation rotation', () => {
    // Each record carries a distinct, equal-length marker in relative_path so a
    // test can assert WHICH record landed in WHICH generation — not merely that
    // a file exists. Equal length keeps every JSONL line the same byte size,
    // which the exact-cap boundary tests rely on.
    const writeRecord = (marker: string) =>
      recordMutation({ ...SAMPLE_RECORD, relative_path: marker });

    async function markersIn(file: string): Promise<(string | null)[]> {
      const records = await readJsonLines(file);
      return records.map((r) => r.relative_path);
    }

    it('appends forever (no rotation) when no byte cap is set', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;
      // No MAX_BYTES_VAR → legacy behavior.

      for (let i = 0; i < 50; i += 1) {
        await writeRecord(`n${String(i).padStart(2, '0')}.md`);
      }

      const records = await readJsonLines(target);
      expect(records).toHaveLength(50);
      // No rolled generation was ever created.
      await expect(fsp.access(`${target}.1`)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rolls the live log to <path>.1, keeping the newest record live', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;
      process.env[MAX_BYTES_VAR] = '1'; // any non-empty file triggers a roll
      process.env[MAX_FILES_VAR] = '3';

      await writeRecord('a0.md'); // first write: file absent, no roll
      await writeRecord('a1.md'); // file now >= cap: rolls a0 → .1, then appends a1

      // Order matters: the newest record stays live, the previous one is in .1.
      expect(await markersIn(target)).toEqual(['a1.md']);
      expect(await markersIn(`${target}.1`)).toEqual(['a0.md']);
    });

    it('shifts generations oldest-first and retains exactly MAX_FILES of them', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;
      process.env[MAX_BYTES_VAR] = '1';
      process.env[MAX_FILES_VAR] = '3';

      // 6 writes: the 1st seeds the live file; each later write rolls once.
      for (let i = 0; i < 6; i += 1) {
        await writeRecord(`n${i}.md`);
      }

      // Newest live; older generations descend by exactly one; n0/n1 dropped
      // past the retained bound of 3. This mapping fails if the shift runs in
      // the wrong direction, drops the wrong generation, or is off by one.
      expect(await markersIn(target)).toEqual(['n5.md']);
      expect(await markersIn(`${target}.1`)).toEqual(['n4.md']);
      expect(await markersIn(`${target}.2`)).toEqual(['n3.md']);
      expect(await markersIn(`${target}.3`)).toEqual(['n2.md']);
      await expect(fsp.access(`${target}.4`)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('honors MAX_FILES=1 (a single retained generation, empty shift loop)', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;
      process.env[MAX_BYTES_VAR] = '1';
      process.env[MAX_FILES_VAR] = '1';

      for (const m of ['a.md', 'b.md', 'c.md']) {
        await writeRecord(m);
      }

      expect(await markersIn(target)).toEqual(['c.md']);
      expect(await markersIn(`${target}.1`)).toEqual(['b.md']);
      await expect(fsp.access(`${target}.2`)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('applies the default retained-generation count through recordMutation', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;
      process.env[MAX_BYTES_VAR] = '1';
      // MAX_FILES unset → DEFAULT_AUDIT_LOG_MAX_FILES, applied via recordMutation
      // (not just the parser), so a hardcoded bound inside rotation is caught.

      for (let i = 0; i < DEFAULT_AUDIT_LOG_MAX_FILES + 3; i += 1) {
        await writeRecord(`n${i}.md`);
      }

      await expect(fsp.access(`${target}.${DEFAULT_AUDIT_LOG_MAX_FILES}`)).resolves.toBeUndefined();
      await expect(
        fsp.access(`${target}.${DEFAULT_AUDIT_LOG_MAX_FILES + 1}`),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rolls when the size reaches the cap exactly', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;

      await writeRecord('a0.md');
      const lineBytes = (await fsp.stat(target)).size;
      // cap == current size → the next write must roll (boundary is `>=`).
      process.env[MAX_BYTES_VAR] = String(lineBytes);
      await writeRecord('a1.md');

      expect(await markersIn(target)).toEqual(['a1.md']);
      expect(await markersIn(`${target}.1`)).toEqual(['a0.md']);
    });

    it('does not roll while the size is one byte below the cap', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;

      await writeRecord('a0.md');
      const lineBytes = (await fsp.stat(target)).size;
      // cap == size + 1 → size is strictly below the cap, so no roll.
      process.env[MAX_BYTES_VAR] = String(lineBytes + 1);
      await writeRecord('a1.md');

      expect(await markersIn(target)).toEqual(['a0.md', 'a1.md']);
      await expect(fsp.access(`${target}.1`)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rolls an already-oversized pre-existing log on the first write', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      // Simulate upgrading a server whose audit log already grew unbounded.
      await fsp.writeFile(target, `${'x'.repeat(5000)}\n`, 'utf-8');
      process.env[ENV_VAR] = target;
      process.env[MAX_BYTES_VAR] = '100';
      process.env[MAX_FILES_VAR] = '3';

      await writeRecord('after.md');

      // The oversized legacy content rolled to .1; only the new record is live.
      expect(await markersIn(target)).toEqual(['after.md']);
      const rolled = await fsp.readFile(`${target}.1`, 'utf-8');
      expect(rolled.startsWith('xxxx')).toBe(true);
    });

    it('does not roll while the log stays under the byte cap', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;
      process.env[MAX_BYTES_VAR] = String(10 * 1024 * 1024); // far above a few small lines

      for (let i = 0; i < 10; i += 1) {
        await writeRecord(`n${i}.md`);
      }

      expect(await readJsonLines(target)).toHaveLength(10);
      await expect(fsp.access(`${target}.1`)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('never drops the record when rotation fails', async () => {
      const target = path.join(tmpDir, 'audit.jsonl');
      process.env[ENV_VAR] = target;
      process.env[MAX_BYTES_VAR] = '1';
      process.env[MAX_FILES_VAR] = '1'; // empty shift loop: rotation's first op is rm(.1)

      await writeRecord('first.md'); // seed the live file so the next write rolls
      // Force rotation to fail with a non-ENOENT error: `.1` is a directory, so
      // the `fsp.rm(target.1)` that opens rotation throws EISDIR (a non-recursive
      // rm of a directory). recordMutation swallows it to a stderr warning.
      await fsp.mkdir(`${target}.1`);

      // A failed rotation must never throw out of recordMutation…
      await expect(writeRecord('second.md')).resolves.toBeUndefined();

      // …and must NOT drop the record: the planted `.1` directory is untouched
      // (the live → .1 rename never ran, so the roll genuinely failed) and both
      // records remain in the live log, so no append was lost to the failed roll.
      expect((await fsp.stat(`${target}.1`)).isDirectory()).toBe(true);
      expect(await markersIn(target)).toEqual(['first.md', 'second.md']);
    });
  });
});
