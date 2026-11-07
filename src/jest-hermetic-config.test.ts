import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findProjectConfig } from './config/project-config.js';

// Issue #1092 — the Jest setup file must make user-level config discovery
// find nothing, so a developer's `$XDG_CONFIG_HOME/kb/kb.config.yaml` (or
// `~/.config/kb/...`) cannot change test outcomes.
describe('jest hermeticity: user-level kb config', () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('points XDG_CONFIG_HOME at a directory that does not exist', () => {
    expect(originalXdg).toBeDefined();
    expect(fs.existsSync(originalXdg!)).toBe(false);
  });

  it('finds no user-level config from a clean working directory', () => {
    expect(findProjectConfig(makeTempDir('kb-hermetic-cwd-'))).toBeNull();
  });

  it('still honours an explicit XDG_CONFIG_HOME that a test sets for itself', () => {
    const xdg = makeTempDir('kb-hermetic-xdg-');
    fs.mkdirSync(path.join(xdg, 'kb'));
    const configPath = path.join(xdg, 'kb', 'kb.config.yaml');
    fs.writeFileSync(configPath, 'KB_CHUNK_SIZE: 123\n');
    process.env.XDG_CONFIG_HOME = xdg;

    expect(findProjectConfig(makeTempDir('kb-hermetic-cwd-'))).toBe(configPath);
  });
});
