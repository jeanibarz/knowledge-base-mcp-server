import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('logger', () => {
  const originalEnv = {
    LOG_FILE: process.env.LOG_FILE,
    LOG_LEVEL: process.env.LOG_LEVEL,
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

    await expect(fsp.stat(path.dirname(logFile))).resolves.toBeTruthy();
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
});
