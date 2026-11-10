// Issue #1180 — the test suite must never touch the developer's real
// knowledge-base root, index directory, home directory or kb configuration.
// jest.global-setup.cjs sandboxes all of them for the whole run; these tests
// fail if that wiring is removed or stops reaching spawned child processes.
import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONTROLLED_PREFIXES, isControlledEnvName } from './config/schema.js';

const globalSetup = require('../jest.global-setup.cjs') as {
  CONTROLLED_ENV_PREFIXES: readonly string[];
};

const tmpRoot = fs.realpathSync(os.tmpdir());
// The account's home from the password database; HOME itself is sandboxed.
const realHome = os.userInfo().homedir;

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, fs.realpathSync(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

describe('test-suite hermeticity (#1180)', () => {
  it('resolves the knowledge-base root and index directory inside the OS temp dir', async () => {
    const { KNOWLEDGE_BASES_ROOT_DIR, FAISS_INDEX_PATH } = await import('./config.js');

    expect(os.homedir()).not.toBe(realHome);
    // A developer may keep TMPDIR under their home; only then is the sandbox
    // legitimately inside it, so the "outside the real home" check is skipped.
    const tmpUnderRealHome = isInside(tmpRoot, realHome);
    for (const resolved of [KNOWLEDGE_BASES_ROOT_DIR, FAISS_INDEX_PATH, os.homedir()]) {
      expect(fs.existsSync(resolved)).toBe(true);
      expect(isInside(resolved, tmpRoot)).toBe(true);
      if (!tmpUnderRealHome) expect(isInside(resolved, realHome)).toBe(false);
    }
  });

  it('hands the sandboxed paths to child processes spawned with the default environment', () => {
    const script =
      'process.stdout.write(JSON.stringify({' +
      'root: process.env.KNOWLEDGE_BASES_ROOT_DIR,' +
      'faiss: process.env.FAISS_INDEX_PATH,' +
      'home: require("os").homedir(),' +
      'logFile: process.env.LOG_FILE ?? null}))';
    const child = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' })) as {
      root: string;
      faiss: string;
      home: string;
      logFile: string | null;
    };

    expect(child.root).toBe(process.env.KNOWLEDGE_BASES_ROOT_DIR);
    expect(child.faiss).toBe(process.env.FAISS_INDEX_PATH);
    expect(child.home).toBe(os.homedir());
    expect(isInside(child.root, tmpRoot)).toBe(true);
    expect(isInside(child.faiss, tmpRoot)).toBe(true);
    expect(child.logFile).toBeNull();
  });

  it('strips inherited kb configuration except the sandbox paths and opt-in test gates', () => {
    const leaked = Object.keys(process.env).filter(
      (name) =>
        isControlledEnvName(name) &&
        name !== 'KNOWLEDGE_BASES_ROOT_DIR' &&
        name !== 'FAISS_INDEX_PATH' &&
        !name.startsWith('KB_RUN_'),
    );
    expect(leaked).toEqual([]);
  });

  it('strips the same env prefixes the config system controls', () => {
    expect([...globalSetup.CONTROLLED_ENV_PREFIXES]).toEqual([...CONTROLLED_PREFIXES]);
  });
});
