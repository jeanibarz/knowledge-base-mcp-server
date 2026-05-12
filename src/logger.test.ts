import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('logger', () => {
  const originalEnv = {
    LOG_FILE: process.env.LOG_FILE,
    LOG_LEVEL: process.env.LOG_LEVEL,
    KB_LOG_FORMAT: process.env.KB_LOG_FORMAT,
  };

  afterEach(() => {
    if (originalEnv.LOG_FILE === undefined) {
      delete process.env.LOG_FILE;
    } else {
      process.env.LOG_FILE = originalEnv.LOG_FILE;
    }
    if (originalEnv.LOG_LEVEL === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalEnv.LOG_LEVEL;
    }
    if (originalEnv.KB_LOG_FORMAT === undefined) {
      delete process.env.KB_LOG_FORMAT;
    } else {
      process.env.KB_LOG_FORMAT = originalEnv.KB_LOG_FORMAT;
    }
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('writes log messages to the configured file', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-file-'));
    const logFile = path.join(tempDir, 'logs', 'app.log');
    process.env.LOG_FILE = logFile;
    process.env.LOG_LEVEL = 'debug';

    await jest.isolateModulesAsync(async () => {
      const { logger } = await import('./logger.js');
      logger.info('File target message');
      logger.debug('debug content');
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect((await fsp.stat(path.dirname(logFile))).isDirectory()).toBe(true);
    const fileContents = await fsp.readFile(logFile, 'utf-8');
    expect(fileContents).toContain('File target message');
    expect(fileContents).toContain('[DEBUG] debug content');
  });

  it('falls back to stderr when log file cannot be initialized', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-stderr-'));
    const lockedDir = path.join(tempDir, 'locked');
    await fsp.mkdir(lockedDir, { recursive: true });
    await fsp.chmod(lockedDir, 0o500);

    const logFile = path.join(lockedDir, 'app.log');
    process.env.LOG_FILE = logFile;

    try {
      await jest.isolateModulesAsync(async () => {
        const { logger } = await import('./logger.js');
        logger.info('Fallback message');
        await new Promise((resolve) => setImmediate(resolve));
      });
    } finally {
      await fsp.chmod(lockedDir, 0o700);
    }

    const stderrOutput = stderrSpy.mock.calls.flat().join('');
    expect(stderrOutput).toMatch(/Failed to (initialize|write log)|Log file stream error/);
  });

  it('routes canonical JSON lines without text logs when KB_LOG_FORMAT=canonical', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-canonical-'));
    const logFile = path.join(tempDir, 'logs', 'app.log');
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_FORMAT = 'canonical';

    await jest.isolateModulesAsync(async () => {
      const { logger } = await import('./logger.js');
      logger.info('text should be suppressed');
      logger.canonical('{"schema_version":"kb-canonical.v1"}');
      await new Promise((resolve) => setImmediate(resolve));
    });

    const fileContents = await fsp.readFile(logFile, 'utf-8');
    expect(fileContents).toBe('{"schema_version":"kb-canonical.v1"}\n');
  });

  it('suppresses canonical lines when KB_LOG_FORMAT=text', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-text-'));
    const logFile = path.join(tempDir, 'logs', 'app.log');
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_FORMAT = 'text';

    await jest.isolateModulesAsync(async () => {
      const { logger } = await import('./logger.js');
      logger.info('text remains');
      logger.canonical('{"schema_version":"kb-canonical.v1"}');
      await new Promise((resolve) => setImmediate(resolve));
    });

    const fileContents = await fsp.readFile(logFile, 'utf-8');
    expect(fileContents).toContain('text remains');
    expect(fileContents).not.toContain('kb-canonical.v1');
  });
});
