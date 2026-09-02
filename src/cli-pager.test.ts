import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  buildDaemonSearchArgs,
  resolveSearchPager,
  writeMaybePagedOutput,
} from './cli-pager.js';

class CaptureStream extends Writable {
  private chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf-8');
  }
}

/** Stands in for %SystemRoot%\\System32: `more.com` and nothing else. */
let fakeSystem32: string;
/** The same, plus a `less.exe` a user installed themselves. */
let fakeSystem32WithLess: string;

beforeAll(async () => {
  fakeSystem32 = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-system32-'));
  await fsp.writeFile(path.join(fakeSystem32, 'more.com'), '');
  fakeSystem32WithLess = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-system32-less-'));
  await fsp.writeFile(path.join(fakeSystem32WithLess, 'more.com'), '');
  await fsp.writeFile(path.join(fakeSystem32WithLess, 'less.exe'), '');
});

afterAll(async () => {
  await fsp.rm(fakeSystem32, { recursive: true, force: true });
  await fsp.rm(fakeSystem32WithLess, { recursive: true, force: true });
});

describe('search pager resolution (#471)', () => {
  it('keeps pager disabled by default', async () => {
    await expect(resolveSearchPager({
      flag: null,
      format: 'md',
      env: { PATH: process.env.PATH },
      stdoutIsTTY: true,
    })).resolves.toBeNull();
  });

  it('uses KB_PAGER as both opt-in and command override', async () => {
    await expect(resolveSearchPager({
      flag: null,
      format: 'md',
      env: { PATH: process.env.PATH, KB_PAGER: `${process.execPath} -e "process.stdin.pipe(process.stdout)"` },
      stdoutIsTTY: true,
    })).resolves.toMatchObject({
      command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
    });
  });

  it('lets --pager fall back to PAGER before less -R', async () => {
    await expect(resolveSearchPager({
      flag: true,
      format: 'compact',
      env: { PATH: process.env.PATH, PAGER: `${process.execPath} -e "process.stdin.pipe(process.stdout)"` },
      stdoutIsTTY: true,
    })).resolves.toMatchObject({
      command: process.execPath,
    });
  });

  it('keeps structured output and non-TTY stdout direct', async () => {
    await expect(resolveSearchPager({
      flag: true,
      format: 'json',
      env: { PATH: process.env.PATH, PAGER: process.execPath },
      stdoutIsTTY: true,
    })).resolves.toBeNull();
    await expect(resolveSearchPager({
      flag: true,
      format: 'md',
      env: { PATH: process.env.PATH, PAGER: process.execPath },
      stdoutIsTTY: false,
    })).resolves.toBeNull();
  });

  it('treats --no-pager, cat, NO_COLOR, and TERM=dumb as direct output', async () => {
    for (const input of [
      { flag: false as const, env: { PATH: process.env.PATH, KB_PAGER: process.execPath } },
      { flag: true as const, env: { PATH: process.env.PATH, PAGER: 'cat' } },
      { flag: true as const, env: { PATH: process.env.PATH, PAGER: process.execPath, NO_COLOR: '1' } },
      { flag: true as const, env: { PATH: process.env.PATH, PAGER: process.execPath, TERM: 'dumb' } },
    ]) {
      await expect(resolveSearchPager({
        ...input,
        format: 'md',
        stdoutIsTTY: true,
      })).resolves.toBeNull();
    }
  });
});

describe('executable lookup on Windows (#934)', () => {
  /**
   * A PATH directory holding `winpager.exe` and a *directory* called `trap`.
   * Windows resolves `winpager` to the .exe through PATHEXT, and must not
   * mistake the directory for a command.
   */
  let binDir: string;

  beforeAll(async () => {
    binDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-pager-'));
    await fsp.writeFile(path.join(binDir, 'winpager.exe'), '');
    await fsp.mkdir(path.join(binDir, 'trap'));
  });

  afterAll(async () => {
    await fsp.rm(binDir, { recursive: true, force: true });
  });

  it('resolves a bare command through PATHEXT', async () => {
    await expect(resolveSearchPager({
      flag: true,
      format: 'md',
      platform: 'win32',
      env: { PATH: binDir, PATHEXT: '.COM;.EXE', KB_PAGER: 'winpager -R' },
      stdoutIsTTY: true,
    })).resolves.toEqual({ command: 'winpager', args: ['-R'] });
  });

  it('resolves an already-qualified command name', async () => {
    await expect(resolveSearchPager({
      flag: true,
      format: 'md',
      platform: 'win32',
      env: { PATH: binDir, PATHEXT: '.COM;.EXE', KB_PAGER: 'winpager.exe' },
      stdoutIsTTY: true,
    })).resolves.toEqual({ command: 'winpager.exe', args: [] });
  });

  it('assumes cmd.exe defaults when PATHEXT is unset, and tolerates quoted PATH entries', async () => {
    await expect(resolveSearchPager({
      flag: true,
      format: 'md',
      platform: 'win32',
      env: { PATH: `"${binDir}"`, KB_PAGER: 'winpager' },
      stdoutIsTTY: true,
    })).resolves.toEqual({ command: 'winpager', args: [] });
  });

  it('does not treat a same-named directory as a pager', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      await expect(resolveSearchPager({
        flag: true,
        format: 'md',
        platform,
        env: { PATH: binDir, PATHEXT: '.COM;.EXE', KB_PAGER: 'trap' },
        stdoutIsTTY: true,
      })).resolves.toBeNull();
    }
  });

  it('keeps PATHEXT off POSIX, where the extensionless name is the whole name', async () => {
    await expect(resolveSearchPager({
      flag: true,
      format: 'md',
      platform: 'linux',
      env: { PATH: binDir, PATHEXT: '.COM;.EXE', KB_PAGER: 'winpager' },
      stdoutIsTTY: true,
    })).resolves.toBeNull();
  });
});

describe('default pager selection (#934)', () => {
  const NO_BIN = { PATH: '/definitely/not/a/real/bin' };

  it('falls back to more on Windows when less is unavailable', async () => {
    await expect(resolveSearchPager({
      flag: true,
      format: 'md',
      platform: 'win32',
      // Only `more` exists, and only as more.com -- the shape of a stock Windows box.
      env: { PATH: fakeSystem32, PATHEXT: '.COM;.EXE' },
      stdoutIsTTY: true,
    })).resolves.toEqual({ command: 'more', args: [] });
  });

  it('prefers less -R over more when both are installed', async () => {
    await expect(resolveSearchPager({
      flag: true,
      format: 'md',
      platform: 'win32',
      env: { PATH: fakeSystem32WithLess, PATHEXT: '.COM;.EXE' },
      stdoutIsTTY: true,
    })).resolves.toEqual({ command: 'less', args: ['-R'] });
  });

  it('never substitutes more for a pager the operator configured', async () => {
    await expect(resolveSearchPager({
      flag: true,
      format: 'md',
      platform: 'win32',
      env: { PATH: fakeSystem32, PATHEXT: '.COM;.EXE', KB_PAGER: 'bat' },
      stdoutIsTTY: true,
    })).resolves.toBeNull();
  });

  it('does not reach for more on POSIX', async () => {
    await expect(resolveSearchPager({
      flag: true,
      format: 'md',
      platform: 'linux',
      env: NO_BIN,
      stdoutIsTTY: true,
    })).resolves.toBeNull();
  });

  it('still honours --no-pager on Windows', async () => {
    await expect(resolveSearchPager({
      flag: false,
      format: 'md',
      platform: 'win32',
      env: { PATH: fakeSystem32, PATHEXT: '.COM;.EXE' },
      stdoutIsTTY: true,
    })).resolves.toBeNull();
  });
});

describe('writeMaybePagedOutput (#471)', () => {
  it('pipes output through the configured pager when enabled on a TTY', async () => {
    const stdout = new CaptureStream();
    await writeMaybePagedOutput('paged output\n', {
      flag: null,
      format: 'md',
      env: { PATH: process.env.PATH, KB_PAGER: `${process.execPath} -e "process.stdin.pipe(process.stdout)"` },
      stdoutIsTTY: true,
      stdout,
      capturePagerStdout: true,
    });

    expect(stdout.text()).toBe('paged output\n');
  });

  it('falls back to direct stdout when the pager command is not present, and says so', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    await writeMaybePagedOutput('direct output\n', {
      flag: true,
      format: 'md',
      env: { PATH: '/definitely/not/a/real/bin', PAGER: 'missing-kb-pager' },
      stdoutIsTTY: true,
      stdout,
      stderr,
      capturePagerStdout: true,
    });

    expect(stdout.text()).toBe('direct output\n');
    expect(stderr.text()).toContain('no pager found on PATH');
    expect(stderr.text()).toContain('"missing-kb-pager"');
  });

  it('stays quiet when paging was never requested', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    await writeMaybePagedOutput('direct output\n', {
      flag: null,
      format: 'md',
      env: { PATH: '/definitely/not/a/real/bin' },
      stdoutIsTTY: true,
      stdout,
      stderr,
      capturePagerStdout: true,
    });

    expect(stdout.text()).toBe('direct output\n');
    expect(stderr.text()).toBe('');
  });

  it('stays quiet when the operator disabled paging with cat', async () => {
    const stderr = new CaptureStream();
    await writeMaybePagedOutput('direct output\n', {
      flag: true,
      format: 'md',
      env: { PATH: process.env.PATH, PAGER: 'cat' },
      stdoutIsTTY: true,
      stdout: new CaptureStream(),
      stderr,
      capturePagerStdout: true,
    });

    expect(stderr.text()).toBe('');
  });

  it('does not fail when the pager exits before consuming stdin', async () => {
    const stdout = new CaptureStream();
    await expect(writeMaybePagedOutput('ignored output\n', {
      flag: null,
      format: 'md',
      env: { PATH: process.env.PATH, KB_PAGER: `${process.execPath} -e "process.exit(0)"` },
      stdoutIsTTY: true,
      stdout,
      capturePagerStdout: true,
    })).resolves.toBeUndefined();
  });
});

describe('daemon search pager args (#471)', () => {
  it('strips pager flags and disables daemon-side env paging', () => {
    expect(buildDaemonSearchArgs(['query', '--pager', '--format=compact'])).toEqual([
      'query',
      '--format=compact',
      '--no-pager',
    ]);
    expect(buildDaemonSearchArgs(['query', '--no-pager'])).toEqual([
      'query',
      '--no-pager',
    ]);
  });
});
