import { Writable } from 'stream';
import { describe, expect, it } from '@jest/globals';
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

  it('falls back to direct stdout when the pager command is not present', async () => {
    const stdout = new CaptureStream();
    await writeMaybePagedOutput('direct output\n', {
      flag: true,
      format: 'md',
      env: { PATH: '/definitely/not/a/real/bin', PAGER: 'missing-kb-pager' },
      stdoutIsTTY: true,
      stdout,
      capturePagerStdout: true,
    });

    expect(stdout.text()).toBe('direct output\n');
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
